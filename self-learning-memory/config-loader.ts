import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ModelProfile } from "./types.ts";
import { validateRedactionPattern } from "./config.ts";

export interface AdapterConfig { statePath?: string; retrievalLimit?: number; cacheWindowMs?: number; economyModel?: ModelProfile; warmModel?: ModelProfile; consolidationModel?: ModelProfile; immediateExtraction?: boolean; redactionPatterns?: string[]; }
function strictConfig(value: unknown, source: string, allowStatePath: boolean): AdapterConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${source}: configuration must be an object`);
	const config = value as Record<string, unknown>; const known = new Set(["retrievalLimit", "cacheWindowMs", "economyModel", "warmModel", "consolidationModel", "immediateExtraction", "redactionPatterns", ...(allowStatePath ? ["statePath"] : [])]);
	for (const key of Object.keys(config)) if (!known.has(key)) throw new Error(`${source}: unknown configuration field: ${key}`);
	if (config.retrievalLimit !== undefined && (!Number.isInteger(config.retrievalLimit) || (config.retrievalLimit as number) < 1)) throw new Error(`${source}: retrievalLimit must be a positive integer`);
	if (config.cacheWindowMs !== undefined && (!Number.isInteger(config.cacheWindowMs) || (config.cacheWindowMs as number) < 0)) throw new Error(`${source}: cacheWindowMs must be a non-negative integer`);
	if (config.statePath !== undefined && typeof config.statePath !== "string") throw new Error(`${source}: statePath must be a string`);
	if (config.immediateExtraction !== undefined && typeof config.immediateExtraction !== "boolean") throw new Error(`${source}: immediateExtraction must be a boolean`);
	if (config.redactionPatterns !== undefined && (!Array.isArray(config.redactionPatterns) || !config.redactionPatterns.every((pattern) => typeof pattern === "string"))) throw new Error(`${source}: redactionPatterns must be an array of strings`);
	for (const pattern of config.redactionPatterns as string[] ?? []) validateRedactionPattern(pattern);
	for (const key of ["economyModel", "warmModel", "consolidationModel"] as const) { const model = config[key]; if (model === undefined) continue; if (!model || typeof model !== "object" || Array.isArray(model)) throw new Error(`${source}: ${key} must be a model profile`); const fields = model as Record<string, unknown>; for (const field of Object.keys(fields)) if (!new Set(["provider", "model", "thinking", "tools", "promptPrefix"]).has(field)) throw new Error(`${source}: unknown ${key} field: ${field}`); if (![fields.provider, fields.model, fields.thinking].every((field) => typeof field === "string" && field.length > 0) || (fields.tools !== undefined && (!Array.isArray(fields.tools) || !fields.tools.every((tool) => typeof tool === "string"))) || (fields.promptPrefix !== undefined && typeof fields.promptPrefix !== "string")) throw new Error(`${source}: ${key} requires string provider, model, thinking, optional tools, and promptPrefix`); }
	return config as AdapterConfig;
}
async function readConfig(path: string, allowStatePath: boolean): Promise<AdapterConfig> { try { return strictConfig(JSON.parse(await readFile(path, "utf8")), path, allowStatePath); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; } }
export async function loadAdapterConfig(cwd: string, trusted: boolean, home = homedir()): Promise<AdapterConfig> { const global = await readConfig(resolve(home, ".pi", "agent", "self-learning-memory.json"), false); return trusted ? { ...global, ...await readConfig(resolve(cwd, ".pi", "self-learning-memory.json"), true) } : global; }
