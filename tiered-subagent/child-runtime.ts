import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const STATUSES = [
	"completed", "completed with uncertainty", "blocked", "needs clarification",
	"recommend higher tier", "failed", "cancelled",
] as const;

function canonicalize(input: string): string {
	let current = input;
	const missing: string[] = [];
	while (!existsSync(current)) {
		const parent = dirname(current);
		if (parent === current) break;
		missing.unshift(current.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
		current = parent;
	}
	try { return join(realpathSync.native(current), ...missing); }
	catch { return input; }
}

function inside(path: string, root: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function configuredPaths(cwd: string, envName: string, fallback: string[]): string[] {
	let values = fallback;
	if (process.env[envName]) {
		try {
			const parsed = JSON.parse(process.env[envName]!);
			if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) values = parsed;
			else throw new Error(`${envName} must contain a JSON string array`);
		} catch (error) { throw new Error(`Invalid ${envName}: ${error instanceof Error ? error.message : String(error)}`); }
	}
	return values.map((path) => canonicalize(resolve(cwd, path)));
}

// With a narrow file reservation, shell mutations cannot be attributed reliably.
function appearsToMutate(command: string): boolean {
	return /(?:^|[;&|\n]\s*|\s)(?:rm|mv|cp|install|rsync|mkdir|touch|truncate|chmod|chown|chgrp|tee|sed\s+-[^\s]*i|perl\s+-[^\s]*i|git\s+(?:add|commit|checkout|switch|restore|reset|clean|rebase|merge|cherry-pick|stash|push)|npm\s+(?:install|uninstall)|pnpm\s+(?:install|add|remove)|yarn\s+(?:add|remove))\b|(?:^|[^<])>>?/i.test(command);
}

export default function childRuntime(pi: ExtensionAPI) {
	pi.on("tool_call", (event, ctx) => {
		if (!["read", "write", "edit", "bash"].includes(event.toolName)) return;
		let allowed: string[];
		let protectedPaths: string[];
		try {
			allowed = configuredPaths(ctx.cwd, "PI_DELEGATE_ALLOWED_PATHS", ["."]);
			protectedPaths = configuredPaths(ctx.cwd, "PI_DELEGATE_PROTECTED_PATHS", [".git"]);
		} catch (error) {
			return { block: true, reason: error instanceof Error ? error.message : String(error) };
		}
		if (event.toolName === "bash") {
			const narrow = !allowed.some((root) => root === canonicalize(resolve(ctx.cwd)));
			if (narrow && appearsToMutate(String((event.input as { command?: unknown }).command ?? ""))) {
				return { block: true, reason: "Delegation scope: mutating shell commands are blocked for narrowly scoped workers; use edit/write on reserved paths or escalate." };
			}
			return;
		}
		const rawPath = String((event.input as { path?: unknown }).path ?? "");
		const target = canonicalize(resolve(ctx.cwd, rawPath));
		if (!allowed.some((root) => inside(target, root))) return { block: true, reason: `Delegation scope: ${target} is outside the worker's allowed paths.` };
		if ((event.toolName === "write" || event.toolName === "edit") && protectedPaths.some((root) => inside(target, root))) {
			return { block: true, reason: `Delegation scope: ${target} is protected.` };
		}
	});

	pi.registerTool({
		name: "submit_delegation_result",
		label: "Submit delegation result",
		description: "Submit the final structured result to the parent. Call exactly once when the delegated task is complete, blocked, uncertain, or failed.",
		parameters: Type.Object({
			status: StringEnum(STATUSES),
			outcome: Type.String(),
			importantFindings: Type.Optional(Type.Array(Type.String())),
			filesInspected: Type.Optional(Type.Array(Type.String())),
			filesChanged: Type.Optional(Type.Array(Type.String())),
			commandsRun: Type.Optional(Type.Array(Type.String())),
			verification: Type.String(),
			unresolvedRisks: Type.Optional(Type.Array(Type.String())),
			uncertainty: Type.String(),
			escalationRecommendation: Type.Optional(Type.String()),
			suggestedNextAction: Type.Optional(Type.String()),
		}),
		async execute(_id, params) {
			return {
				content: [{ type: "text", text: `${params.status}: ${params.outcome}` }],
				details: {
					...params,
					importantFindings: params.importantFindings ?? [], filesInspected: params.filesInspected ?? [],
					filesChanged: params.filesChanged ?? [], commandsRun: params.commandsRun ?? [],
					unresolvedRisks: params.unresolvedRisks ?? [], escalationRecommendation: params.escalationRecommendation ?? "",
					suggestedNextAction: params.suggestedNextAction ?? "",
				},
				terminate: true,
			};
		},
	});
}
