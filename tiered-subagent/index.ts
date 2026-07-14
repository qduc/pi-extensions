import { randomUUID } from "node:crypto";
import { relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { loadConfig } from "./config.ts";
import { DELEGATE_MODE_DESCRIPTION, DELEGATE_PROMPT_GUIDELINES } from "./delegate-interface.ts";
import { classifyTask, defaultSafetyGatePath, extensionDirectory, runChild } from "./runner.ts";
import { canonicalize, isInside, resolveScopes, scopesOverlap } from "./scope.ts";
import type { AgentMode, ModelProfile, Tier } from "./types.ts";

interface ActiveRun { id: string; task: string; mode: AgentMode; scopes: string[]; started: number; phase: string; }
const active = new Map<string, ActiveRun>();

function profileName(profile: ModelProfile): string { return `${profile.provider}/${profile.model}`; }
function compactLine(value: unknown, maxLength = 120): string {
	const line = String(value ?? "").replace(/\s+/g, " ").trim();
	return line.length > maxLength ? `${line.slice(0, maxLength - 1)}…` : line;
}
function mutationCommand(command: string): boolean {
	return /(?:^|[;&|\n]\s*|\s)(?:rm|mv|cp|install|rsync|mkdir|touch|truncate|chmod|chown|chgrp|tee|git\s+(?:add|commit|checkout|switch|restore|reset|clean|rebase|merge|cherry-pick|stash|push)|npm\s+(?:install|uninstall)|pnpm\s+(?:install|add|remove)|yarn\s+(?:add|remove))\b|(?:^|[^<])>>?/i.test(command);
}

export default function tieredSubagent(pi: ExtensionAPI) {
	const publish = (ctx: any, run: ActiveRun, phase: string, extra: Record<string, unknown> = {}) => {
		run.phase = phase;
		pi.events.emit("tiered-subagent:lifecycle", { id: run.id, task: run.task, mode: run.mode, phase, elapsedMs: Date.now() - run.started, scopes: run.scopes, ...extra });
		if (ctx.mode === "tui") {
			const rows = [...active.values()].map((item) => `${item.phase} ${item.mode} ${Math.round((Date.now() - item.started) / 1000)}s — ${item.task.slice(0, 60)}`);
			ctx.ui.setWidget("tiered-subagent", rows.length ? rows : undefined, { placement: "belowEditor" });
		}
	};

	pi.on("tool_call", (event, ctx) => {
		if (active.size === 0) return;
		if (event.toolName === "edit" || event.toolName === "write") {
			const rawPath = String((event.input as { path?: unknown }).path ?? "");
			const path = canonicalize(resolve(ctx.cwd, rawPath));
			const owner = [...active.values()].find((run) => run.mode === "worker" && run.scopes.some((scope) => isInside(path, scope)));
			if (owner) return { block: true, reason: `Path is reserved by active delegated task ${owner.id}: ${owner.task}` };
		}
		if (event.toolName === "bash" && mutationCommand(String((event.input as { command?: unknown }).command ?? ""))) {
			const workers = [...active.values()].filter((run) => run.mode === "worker");
			if (workers.length) return { block: true, reason: `Mutating parent shell commands are blocked while ${workers.length} worker(s) hold path reservations.` };
		}
	});

	pi.registerCommand("agents", {
		description: "Show active tiered subagents",
		handler: async (_args, ctx) => {
			if (!active.size) { ctx.ui.notify("No active subagents.", "info"); return; }
			ctx.ui.notify([...active.values()].map((run) => `${run.id.slice(0, 8)} ${run.phase} ${run.mode}: ${run.task}`).join("\n"), "info");
		},
	});

	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description: "Delegate one bounded task to an isolated temporary worker or advisor. Automatic routing uses an LLM and reports the selected tier, model, reasoning, evidence, uncertainty, cost, and latency.",
		promptSnippet: "Delegate a bounded task to an isolated tiered subagent",
		promptGuidelines: [...DELEGATE_PROMPT_GUIDELINES],
		parameters: Type.Object({
			task: Type.String({ description: "A narrowly scoped task" }),
			expectedOutcome: Type.String({ description: "Observable expected result and acceptance evidence" }),
			context: Type.Optional(Type.String({ description: "Only concise context intentionally supplied to the child" })),
			constraints: Type.Optional(Type.String({ description: "Applicable safety, compatibility, and execution constraints" })),
			preferredTier: Type.Optional(StringEnum(["lower", "default", "higher"] as const)),
			mode: Type.Optional(StringEnum(["worker", "advisor"] as const, { description: DELEGATE_MODE_DESCRIPTION })),
			fileScope: Type.Optional(Type.Array(Type.String(), { description: "Paths this worker may inspect or modify" })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const depth = Number(process.env.PI_DELEGATE_DEPTH ?? "0");
			let config;
			try { config = await loadConfig(ctx.cwd, ctx.isProjectTrusted()); }
			catch (error) { throw new Error(`Tiered subagent configuration error: ${error instanceof Error ? error.message : String(error)}`); }
			if (depth >= config.maxDelegationDepth) throw new Error(`Maximum delegation depth ${config.maxDelegationDepth} reached.`);
			if (active.size >= config.maxConcurrentAgents) throw new Error(`Maximum concurrent agents (${config.maxConcurrentAgents}) reached.`);

			const modeHint = params.mode as AgentMode | undefined;
			let scopes: string[];
			try { scopes = resolveScopes(ctx.cwd, params.fileScope ?? [], config.allowedPaths, config.protectedPaths); }
			catch (error) { throw new Error(error instanceof Error ? error.message : String(error)); }
			const provisionalMode: AgentMode = modeHint ?? "worker";
			if (provisionalMode === "worker") {
				const conflict = [...active.values()].find((run) => run.mode === "worker" && scopesOverlap(scopes, run.scopes));
				if (conflict) throw new Error(`Requested file scope overlaps active task ${conflict.id}: ${conflict.task}`);
			}
			const run: ActiveRun = { id: randomUUID(), task: params.task, mode: provisionalMode, scopes, started: Date.now(), phase: "queued" };
			active.set(run.id, run);
			publish(ctx, run, "queued");

			try {
				const available = await ctx.modelRegistry.getAvailable();
				const availableKey = new Set(available.map((model: any) => `${model.provider}/${model.id}`));
				const parentProfile: ModelProfile | undefined = ctx.model ? { provider: ctx.model.provider, model: ctx.model.id, reasoning: pi.getThinkingLevel() } : undefined;
				const resolveProfile = (requested: ModelProfile): { profile: ModelProfile; substitution?: string } => {
					if (requested.model === "gpt-5.6-sol" && requested.reasoning === "max") throw new Error("Hard constraint violation: Sol max is prohibited.");
					if (availableKey.has(profileName(requested))) return { profile: requested };
					if (config.fallbackToParentModel && parentProfile && availableKey.has(profileName(parentProfile))) {
						if (parentProfile.model === "gpt-5.6-sol" && parentProfile.reasoning === "max") parentProfile.reasoning = "xhigh";
						return { profile: parentProfile, substitution: `${profileName(requested)} unavailable; substituted current model ${profileName(parentProfile)}` };
					}
					throw new Error(`Configured model is unavailable: ${profileName(requested)}`);
				};

				let tier: Tier;
				let mode: AgentMode;
				let routeReason: string;
				let category = "explicit";
				if (params.preferredTier) {
					tier = params.preferredTier as Tier; mode = modeHint ?? (tier === "higher" ? "advisor" : "worker");
					routeReason = `Explicit ${tier} tier request took precedence.`;
				} else {
					publish(ctx, run, "routing");
					try {
						const router = resolveProfile(config.router ?? config.tiers.lower);
						const decision = await classifyTask(ctx.cwd, router.profile, { task: params.task, expectedOutcome: params.expectedOutcome, context: params.context ?? "", constraints: params.constraints ?? "", mode: modeHint }, signal, config.timeoutMs);
						tier = decision.tier; mode = decision.mode; routeReason = decision.reason; category = decision.category;
						if (router.substitution) routeReason += ` ${router.substitution}.`;
					} catch (error) {
						tier = "default"; mode = modeHint ?? "worker"; routeReason = `Router failed; conservative default tier selected: ${error instanceof Error ? error.message : String(error)}`;
					}
				}
				run.mode = mode;
				if (mode === "worker") {
					const conflict = [...active.values()].find((other) => other.id !== run.id && other.mode === "worker" && scopesOverlap(scopes, other.scopes));
					if (conflict) throw new Error(`Routed worker scope overlaps active task ${conflict.id}: ${conflict.task}`);
				}
				if (tier === "higher" && config.higherTierRequiresConfirmation) {
					if (!ctx.hasUI || !(await ctx.ui.confirm("Higher-tier delegation", `${params.task}\n\n${routeReason}`))) throw new Error("Higher-tier use was not approved.");
				}
				const selected = resolveProfile(config.tiers[tier]);
				if (selected.substitution) routeReason += ` ${selected.substitution}.`;
				publish(ctx, run, "assigned", { tier, model: profileName(selected.profile), reasoning: selected.profile.reasoning, routeReason });
				const child = await runChild({
					cwd: ctx.cwd, extensionDir: extensionDirectory, safetyGatePath: defaultSafetyGatePath, profile: selected.profile, mode,
					task: params.task, expectedOutcome: params.expectedOutcome, context: params.context ?? "", constraints: params.constraints ?? "",
					scopes, protectedPaths: config.protectedPaths, tools: [...new Set([...config.workerTools, "submit_delegation_result"])],
					timeoutMs: config.timeoutMs, signal,
					onUpdate: (partial) => { publish(ctx, run, String((partial.details as any)?.phase ?? "running")); onUpdate?.(partial); },
				});
				publish(ctx, run, child.result.status, { tier, model: child.model, cost: child.usage.cost });
				const metadata = { delegationId: run.id, tier, mode, category, routeReason, model: child.model, reasoning: child.reasoning, tokenUse: child.usage, cost: child.usage.cost, latencyMs: child.latencyMs, scopes: scopes.map((path) => relative(ctx.cwd, path) || "."), exitCode: child.exitCode, stderr: child.stderr };
				let text = JSON.stringify({ ...child.result, metadata }, null, 2);
				if (Buffer.byteLength(text, "utf8") > config.maxOutputBytes) text = `${text.slice(0, config.maxOutputBytes)}\n[Result truncated; full structured result remains in tool details.]`;
				return { content: [{ type: "text", text }], details: { result: child.result, metadata } };
			} finally {
				active.delete(run.id);
				publish(ctx, run, "settled");
			}
		},
		renderCall(args, theme) {
			const routing = `${args.preferredTier ?? "auto"}/${args.mode ?? "auto"}`;
			return new Text(`${theme.fg("toolTitle", theme.bold("delegate "))}${theme.fg("dim", `${routing} · `)}${theme.fg("accent", compactLine(args.task))}`, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "delegating…"), 0, 0);
			const details = result.details as any;
			if (!details?.result) {
				const fallback = result.content[0]?.type === "text" ? result.content[0].text : "No result";
				return new Text(theme.fg("error", compactLine(fallback)), 0, 0);
			}
			const r = details.result; const m = details.metadata;
			const color = r.status === "completed" ? "success" : r.status === "failed" ? "error" : "warning";
			const summary = `${theme.fg(color, r.status)} ${theme.fg("toolOutput", compactLine(r.outcome))}`;
			if (!expanded) return new Text(summary, 0, 0);
			const metadata = `${m.tier} · ${m.model}:${m.reasoning} · $${Number(m.cost).toFixed(4)} · ${(m.latencyMs / 1000).toFixed(1)}s`;
			return new Text(`${theme.fg(color, r.status)} ${theme.fg("toolOutput", String(r.outcome ?? ""))}\n${theme.fg("dim", metadata)}`, 0, 0);
		},
	});
}
