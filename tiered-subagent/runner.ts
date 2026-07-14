import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AgentMode, DelegationResult, ModelProfile, Tier, UsageStats } from "./types.ts";

export interface RouteDecision { tier: Tier; mode: AgentMode; reason: string; category: string; }
export interface RunUpdate { phase: string; text: string; model?: string; reasoning?: string; elapsedMs: number; }
export interface ChildRunResult {
	result: DelegationResult;
	usage: UsageStats;
	model: string;
	reasoning: string;
	latencyMs: number;
	exitCode: number;
	stderr: string;
}

type Update = (partial: AgentToolResult<Record<string, unknown>>) => void;

function invocation(args: string[]): { command: string; args: string[] } {
	const script = process.argv[1];
	if (script && !script.startsWith("/$bunfs/root/") && existsSync(script)) return { command: process.execPath, args: [script, ...args] };
	const executable = basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(executable)) return { command: process.execPath, args };
	return { command: "pi", args };
}

function textOf(message: Message): string {
	if (message.role !== "assistant") return "";
	return message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
	const candidates = [text, text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1], text.match(/\{[\s\S]*\}/)?.[0]].filter(Boolean) as string[];
	for (const candidate of candidates) {
		try {
			const value = JSON.parse(candidate.trim());
			if (value && typeof value === "object" && !Array.isArray(value)) return value;
		} catch { /* try the next representation */ }
	}
	return undefined;
}

async function runProcess(options: {
	args: string[]; cwd: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs: number;
	onMessage?: (message: Message) => void; onToolResult?: (message: Message) => void;
}): Promise<{ exitCode: number; stderr: string; timedOut: boolean }> {
	const call = invocation(options.args);
	return new Promise((resolvePromise) => {
		const child = spawn(call.command, call.args, { cwd: options.cwd, env: options.env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let settled = false;
		let timedOut = false;
		const stop = () => {
			child.kill("SIGTERM");
			setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); }, 3000).unref();
		};
		const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs);
		const abort = () => stop();
		options.signal?.addEventListener("abort", abort, { once: true });
		const processLine = (line: string) => {
			if (!line.trim()) return;
			try {
				const event = JSON.parse(line);
				if (event.type === "message_end" && event.message) {
					const message = event.message as Message;
					options.onMessage?.(message);
					if (message.role === "toolResult") options.onToolResult?.(message);
				}
				if (event.type === "tool_result_end" && event.message) options.onToolResult?.(event.message as Message);
			} catch { /* JSON mode may still receive non-event diagnostics */ }
		};
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
			const lines = stdout.split("\n");
			stdout = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});
		child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
		const finish = (code: number) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
			if (stdout.trim()) processLine(stdout);
			resolvePromise({ exitCode: code, stderr, timedOut });
		};
		child.on("close", (code) => finish(code ?? 1));
		child.on("error", (error) => { stderr += error.message; finish(1); });
	});
}

export async function classifyTask(
	cwd: string, profile: ModelProfile, input: { task: string; expectedOutcome: string; context: string; constraints: string; mode?: AgentMode },
	signal: AbortSignal | undefined, timeoutMs: number,
): Promise<RouteDecision> {
	let finalText = "";
	const prompt = `Classify a delegated software-engineering task. Choose the least expensive reliable tier. Do not choose higher merely because the description is long.\n\nTiers:\n- lower: mechanical, bounded, directly verifiable\n- default: normal exploration, implementation, tests, review, synthesis\n- higher: contradictory evidence, risky diagnosis, architecture, critical consultation\n\nReturn only JSON: {"tier":"lower|default|higher","mode":"worker|advisor","category":"short category","reason":"one concise inspectable reason"}.\nRequested mode, if supplied, must be preserved.\n\nTask: ${input.task}\nExpected outcome: ${input.expectedOutcome}\nContext: ${input.context}\nConstraints: ${input.constraints}\nRequested mode: ${input.mode ?? "automatic"}`;
	const args = ["--mode", "json", "-p", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-context-files", "--model", `${profile.provider}/${profile.model}`, "--thinking", profile.reasoning, prompt];
	const run = await runProcess({ args, cwd, signal, timeoutMs: Math.min(timeoutMs, 120_000), onMessage: (message) => { const text = textOf(message); if (text) finalText = text; } });
	if (run.exitCode !== 0) throw new Error(`Router failed: ${run.stderr || `exit ${run.exitCode}`}`);
	const parsed = parseJsonObject(finalText);
	if (!parsed || !["lower", "default", "higher"].includes(String(parsed.tier)) || !["worker", "advisor"].includes(String(parsed.mode))) throw new Error("Router returned an invalid decision");
	return { tier: parsed.tier as Tier, mode: (input.mode ?? parsed.mode) as AgentMode, category: String(parsed.category ?? "general"), reason: String(parsed.reason ?? "LLM router selection") };
}

function normalizeResult(value: Record<string, unknown>): DelegationResult {
	const array = (key: string) => Array.isArray(value[key]) ? (value[key] as unknown[]).filter((item): item is string => typeof item === "string") : [];
	return {
		status: String(value.status) as DelegationResult["status"], outcome: String(value.outcome ?? ""),
		importantFindings: array("importantFindings"), filesInspected: array("filesInspected"), filesChanged: array("filesChanged"),
		commandsRun: array("commandsRun"), verification: String(value.verification ?? ""), unresolvedRisks: array("unresolvedRisks"),
		uncertainty: String(value.uncertainty ?? ""), escalationRecommendation: String(value.escalationRecommendation ?? ""),
		suggestedNextAction: String(value.suggestedNextAction ?? ""),
	};
}

export async function runChild(options: {
	cwd: string; extensionDir: string; safetyGatePath?: string; profile: ModelProfile; mode: AgentMode;
	task: string; expectedOutcome: string; context: string; constraints: string; scopes: string[]; protectedPaths: string[];
	tools: string[]; timeoutMs: number; signal?: AbortSignal; onUpdate?: Update;
}): Promise<ChildRunResult> {
	const started = Date.now();
	const usage: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
	let submitted: DelegationResult | undefined;
	let finalText = "";
	let actualModel = `${options.profile.provider}/${options.profile.model}`;
	const args = ["--mode", "json", "-p", "--no-session", "--no-extensions", "-e", join(options.extensionDir, "child-runtime.ts"), "--model", actualModel, "--thinking", options.profile.reasoning];
	if (options.safetyGatePath && existsSync(options.safetyGatePath)) args.push("-e", options.safetyGatePath);
	if (options.mode === "advisor") args.push("--tools", "submit_delegation_result");
	else args.push("--tools", options.tools.join(","));
	const prompt = `You are an ephemeral ${options.mode} subagent. Stay strictly within the delegated scope. Do not delegate. Do not broaden the task. Lower-cost execution must report uncertainty rather than guess. Call submit_delegation_result exactly once with concise evidence when done or blocked.\n\nTASK\n${options.task}\n\nEXPECTED OUTCOME\n${options.expectedOutcome}\n\nEXPLICIT CONTEXT\n${options.context || "(none)"}\n\nCONSTRAINTS\n${options.constraints || "(none)"}\n\nALLOWED FILE SCOPE\n${options.scopes.join("\n")}`;
	args.push(prompt);
	options.onUpdate?.({ content: [{ type: "text", text: `started ${actualModel}:${options.profile.reasoning}` }], details: { phase: "started", model: actualModel, reasoning: options.profile.reasoning, elapsedMs: 0 } });
	const run = await runProcess({
		args, cwd: options.cwd, signal: options.signal, timeoutMs: options.timeoutMs,
		env: { ...process.env, PI_DELEGATE_DEPTH: String(Number(process.env.PI_DELEGATE_DEPTH ?? "0") + 1), PI_DELEGATE_ALLOWED_PATHS: JSON.stringify(options.scopes), PI_DELEGATE_PROTECTED_PATHS: JSON.stringify(options.protectedPaths) },
		onMessage: (message) => {
			if (message.role !== "assistant") return;
			usage.turns++;
			usage.input += message.usage?.input ?? 0; usage.output += message.usage?.output ?? 0;
			usage.cacheRead += message.usage?.cacheRead ?? 0; usage.cacheWrite += message.usage?.cacheWrite ?? 0;
			usage.cost += message.usage?.cost?.total ?? 0;
			if (message.model) actualModel = `${message.provider}/${message.model}`;
			const text = textOf(message); if (text) finalText = text;
			options.onUpdate?.({ content: [{ type: "text", text: text || "running" }], details: { phase: "running", model: actualModel, reasoning: options.profile.reasoning, elapsedMs: Date.now() - started } });
		},
		onToolResult: (message) => {
			if (message.role === "toolResult" && message.toolName === "submit_delegation_result" && message.details && typeof message.details === "object") submitted = normalizeResult(message.details as Record<string, unknown>);
		},
	});
	if (!submitted) {
		const aborted = options.signal?.aborted;
		submitted = {
			status: aborted ? "cancelled" : run.timedOut ? "failed" : "failed",
			outcome: aborted ? "Subagent was cancelled." : run.timedOut ? "Subagent timed out." : `Subagent exited without a structured result.${finalText ? ` Last output: ${finalText}` : ""}`,
			importantFindings: [], filesInspected: [], filesChanged: [], commandsRun: [], verification: "Not verified.", unresolvedRisks: [],
			uncertainty: run.stderr || "No structured completion was received.", escalationRecommendation: "Parent should inspect the failure before retrying.", suggestedNextAction: "Review diagnostics and rerun or handle directly.",
		};
	}
	return { result: submitted, usage, model: actualModel, reasoning: options.profile.reasoning, latencyMs: Date.now() - started, exitCode: run.exitCode, stderr: run.stderr };
}

export const defaultSafetyGatePath = join(homedir(), ".pi", "agent", "extensions", "safety-gate", "index.ts");
export const extensionDirectory = dirname(new URL(import.meta.url).pathname);
