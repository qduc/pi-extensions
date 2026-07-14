import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { TIERS, type ExtensionConfig, type ModelProfile, type Tier } from "./types.ts";

export const DEFAULT_CONFIG: ExtensionConfig = {
	tiers: {
		lower: { provider: "openai-codex", model: "gpt-5.6-luna", reasoning: "high" },
		default: { provider: "openai-codex", model: "gpt-5.6-luna", reasoning: "xhigh" },
		higher: { provider: "openai-codex", model: "gpt-5.6-sol", reasoning: "high" },
	},
	router: { provider: "openai-codex", model: "gpt-5.6-luna", reasoning: "high" },
	maxConcurrentAgents: 4,
	timeoutMs: 20 * 60 * 1000,
	maxOutputBytes: 50 * 1024,
	maxDelegationDepth: 1,
	workerTools: ["read", "grep", "find", "ls", "bash", "edit", "write", "submit_delegation_result"],
	allowedPaths: ["."],
	protectedPaths: [".git", ".pi/safety-gate.json"],
	higherTierRequiresConfirmation: false,
	fallbackToParentModel: true,
};

const REASONING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function profile(value: unknown, field: string): ModelProfile {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
	const raw = value as Record<string, unknown>;
	if (typeof raw.provider !== "string" || !raw.provider) throw new Error(`${field}.provider must be a string`);
	if (typeof raw.model !== "string" || !raw.model) throw new Error(`${field}.model must be a string`);
	if (typeof raw.reasoning !== "string" || !REASONING.has(raw.reasoning)) throw new Error(`${field}.reasoning is invalid`);
	if (raw.model === "gpt-5.6-sol" && raw.reasoning === "max") throw new Error("gpt-5.6-sol max is prohibited");
	return raw as unknown as ModelProfile;
}

function stringArray(value: unknown, field: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error(`${field} must be an array of strings`);
	return value;
}

export function mergeConfig(base: ExtensionConfig, value: unknown): ExtensionConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("configuration must be an object");
	const raw = value as Record<string, unknown>;
	const known = new Set([
		"tiers", "router", "maxConcurrentAgents", "timeoutMs", "maxOutputBytes", "maxDelegationDepth",
		"workerTools", "allowedPaths", "protectedPaths", "higherTierRequiresConfirmation", "fallbackToParentModel",
	]);
	const unknown = Object.keys(raw).filter((key) => !known.has(key));
	if (unknown.length) throw new Error(`unknown configuration field(s): ${unknown.join(", ")}`);
	const next: ExtensionConfig = { ...base, tiers: { ...base.tiers } };
	if (raw.tiers !== undefined) {
		if (!raw.tiers || typeof raw.tiers !== "object" || Array.isArray(raw.tiers)) throw new Error("tiers must be an object");
		for (const [name, value] of Object.entries(raw.tiers as Record<string, unknown>)) {
			if (!TIERS.includes(name as Tier)) throw new Error(`unknown tier: ${name}`);
			next.tiers[name as Tier] = profile(value, `tiers.${name}`);
		}
	}
	if (raw.router !== undefined) next.router = profile(raw.router, "router");
	for (const key of ["maxConcurrentAgents", "timeoutMs", "maxOutputBytes", "maxDelegationDepth"] as const) {
		if (raw[key] !== undefined) {
			if (!Number.isInteger(raw[key]) || (raw[key] as number) < 1) throw new Error(`${key} must be a positive integer`);
			(next[key] as number) = raw[key] as number;
		}
	}
	for (const key of ["workerTools", "allowedPaths", "protectedPaths"] as const) {
		const parsed = stringArray(raw[key], key);
		if (parsed) next[key] = parsed;
	}
	for (const key of ["higherTierRequiresConfirmation", "fallbackToParentModel"] as const) {
		if (raw[key] !== undefined) {
			if (typeof raw[key] !== "boolean") throw new Error(`${key} must be a boolean`);
			next[key] = raw[key];
		}
	}
	return next;
}

async function loadJson(path: string): Promise<unknown | undefined> {
	try { return JSON.parse(await readFile(path, "utf8")); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error(`Invalid ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export async function loadConfig(cwd: string, projectTrusted: boolean): Promise<ExtensionConfig> {
	let config = DEFAULT_CONFIG;
	const globalValue = await loadJson(join(homedir(), ".pi", "agent", "tiered-subagent.json"));
	if (globalValue) config = mergeConfig(config, globalValue);
	if (projectTrusted) {
		const projectValue = await loadJson(join(cwd, CONFIG_DIR_NAME, "tiered-subagent.json"));
		if (projectValue) config = mergeConfig(config, projectValue);
	}
	return config;
}
