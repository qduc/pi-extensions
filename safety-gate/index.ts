import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { evaluateToolAction, type Decision, type GitOperation, type SafetyGateConfig } from "./policy.ts";
import { ApprovalStore, type ApprovalContext } from "./approvals.ts";

const CONFIG_FILE = ".pi/safety-gate.json";
const GIT_OPERATIONS = new Set<GitOperation>([
	"forcePush",
	"hardReset",
	"deleteBranch",
	"rewriteHistory",
	"clean",
	"discardChanges",
]);

function stringArray(value: unknown, field: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error(`${field} must be an array of strings`);
	return value;
}

function validateConfig(value: unknown): SafetyGateConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("configuration must be a JSON object");
	const raw = value as Record<string, unknown>;
	const known = new Set(["protectedPaths", "allowedExternalPaths", "confirmCommands", "blockedCommands", "git"]);
	const unknown = Object.keys(raw).filter((key) => !known.has(key));
	if (unknown.length) throw new Error(`unknown configuration field(s): ${unknown.join(", ")}`);
	const config: SafetyGateConfig = {
		protectedPaths: stringArray(raw.protectedPaths, "protectedPaths"),
		allowedExternalPaths: stringArray(raw.allowedExternalPaths, "allowedExternalPaths"),
		confirmCommands: stringArray(raw.confirmCommands, "confirmCommands"),
		blockedCommands: stringArray(raw.blockedCommands, "blockedCommands"),
	};
	if (raw.git !== undefined) {
		if (!raw.git || typeof raw.git !== "object" || Array.isArray(raw.git)) throw new Error("git must be an object");
		config.git = {};
		for (const [operation, policy] of Object.entries(raw.git as Record<string, unknown>)) {
			if (!GIT_OPERATIONS.has(operation as GitOperation)) throw new Error(`unknown git operation: ${operation}`);
			if (policy !== "confirm" && policy !== "block") throw new Error(`git.${operation} must be \"confirm\" or \"block\"`);
			config.git[operation as GitOperation] = policy;
		}
	}
	return config;
}

async function loadConfig(cwd: string, trusted: boolean): Promise<{ config?: SafetyGateConfig; error?: string }> {
	if (!trusted) return {};
	const path = join(cwd, CONFIG_FILE);
	try {
		return { config: validateConfig(JSON.parse(await readFile(path, "utf8"))) };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		return { error: `Invalid ${CONFIG_FILE}: ${error instanceof Error ? error.message : String(error)}` };
	}
}

function feedback(decision: Decision): string {
	const lines = [
		`Safety gate: ${decision.outcome.toUpperCase()}`,
		`Action: ${decision.action || "(empty action)"}`,
	];
	if (decision.affected) lines.push(`Affected: ${decision.affected}`);
	lines.push(`Why: ${decision.reason}`, `Rule: ${decision.rule}`);
	lines.push(decision.outcome === "risky" ? "Can confirmation allow it? Yes." : "Can confirmation allow it? No.");
	if (decision.alternative) lines.push(`Safer alternative: ${decision.alternative}`);
	return lines.join("\n");
}

export default function safetyGate(pi: ExtensionAPI) {
	const approvals = new ApprovalStore(join(process.env.HOME ?? "", ".pi", "agent", "safety-gate-approvals.json"));
	const approvalContext = (cwd: string, trusted: boolean, toolName: string): ApprovalContext => ({
		toolName, workspace: cwd, trusted,
	});

	pi.registerCommand("safety-approvals", {
		description: "List or revoke remembered safety-gate approvals",
		handler: async (_args, ctx) => {
			const context = approvalContext(ctx.cwd, ctx.isProjectTrusted(), "");
			try {
				const entries = await approvals.list(context);
				if (!entries.length) {
					ctx.ui.notify("No remembered safety-gate approvals for this project.", "info");
					return;
				}
				const clearSession = "Clear all session approvals";
				const clearProject = "Clear all project approvals";
				const cancel = "Cancel";
				const labels = entries.map((entry) => `${entry.scope}: ${entry.rule} — ${entry.action}`);
				const selected = await ctx.ui.select("Safety-gate approvals (select one to revoke)", [...labels, clearSession, clearProject, cancel]);
				if (!selected || selected === cancel) return;
				if (selected === clearSession) await approvals.clear("session", context);
				else if (selected === clearProject) await approvals.clear("project", context);
				else {
					const index = labels.indexOf(selected);
					if (index >= 0) await approvals.revoke(entries[index].id, context);
				}
				ctx.ui.notify("Safety-gate approvals updated.", "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash" && event.toolName !== "write" && event.toolName !== "edit") return undefined;

		const loaded = await loadConfig(ctx.cwd, ctx.isProjectTrusted());
		if (loaded.error) {
			const message = `Safety gate: PROHIBITED\nAction: ${event.toolName}\nWhy: ${loaded.error}\nRule: invalid-config\nCan confirmation allow it? No.`;
			if (ctx.hasUI) ctx.ui.notify(message, "error");
			return { block: true, reason: message };
		}

		let decision: Decision;
		try {
			decision = evaluateToolAction({
				toolName: event.toolName,
				input: event.input as Record<string, unknown>,
				cwd: ctx.cwd,
				home: process.env.HOME,
				env: process.env,
				config: loaded.config,
			});
		} catch (error) {
			decision = {
				outcome: "prohibited",
				rule: "policy-evaluation-error",
				action: event.toolName,
				reason: error instanceof Error ? error.message : String(error),
				alternative: "fix the project safety-gate configuration or use a literal, inspectable action",
			};
		}
		if (decision.outcome === "safe") return undefined;

		const message = feedback(decision);
		if (decision.outcome === "prohibited") {
			if (ctx.hasUI) ctx.ui.notify(message, "error");
			return { block: true, reason: message };
		}

		const context = approvalContext(ctx.cwd, ctx.isProjectTrusted(), event.toolName);
		try {
			if (await approvals.isApproved(decision, context)) return undefined;
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			if (ctx.hasUI) ctx.ui.notify(reason, "error");
			return { block: true, reason };
		}
		if (!ctx.hasUI) return { block: true, reason: `${message}\nConfirmation is unavailable in ${ctx.mode} mode.` };

		const deny = "Deny";
		const once = "Allow once";
		const session = "Allow this exact action for this session";
		const project = "Allow this exact action for this project";
		const options = ctx.isProjectTrusted() ? [deny, once, session, project] : [deny, once, session];
		const selected = await ctx.ui.select(`${message}\n\nChoose approval:`, options);
		if (!selected || selected === deny) return { block: true, reason: `${message}\nDecision: not approved by the user.` };
		try {
			if (selected === session) await approvals.remember(decision, context, "session");
			if (selected === project) await approvals.remember(decision, context, "project");
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return { block: true, reason };
		}
		return undefined;
	});
}
