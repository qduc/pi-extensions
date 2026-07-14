import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface TruncationConfig {
	maxChars: number;
	headChars: number;
	tailChars: number;
	artifactDirectory: string;
	maxInspectionChars: number;
}

export const DEFAULT_CONFIG: TruncationConfig = {
	maxChars: 40000,
	headChars: 19000,
	tailChars: 19000,
	artifactDirectory: ".pi/artifacts/tool-output",
	maxInspectionChars: 20000,
};

const KEYS = new Set<keyof TruncationConfig>(["maxChars", "headChars", "tailChars", "artifactDirectory", "maxInspectionChars"]);
const MIN_BOUNDED_RESULT_CHARS = 512;

export function validateConfig(value: unknown): Partial<TruncationConfig> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("configuration must be a JSON object");
	const raw = value as Record<string, unknown>;
	const unknown = Object.keys(raw).filter((key) => !KEYS.has(key as keyof TruncationConfig));
	if (unknown.length) throw new Error(`unknown configuration field(s): ${unknown.join(", ")}`);
	for (const key of ["maxChars", "headChars", "tailChars", "maxInspectionChars"] as const) {
		if (raw[key] !== undefined && (!Number.isSafeInteger(raw[key]) || (raw[key] as number) <= 0)) throw new Error(`${key} must be a positive safe integer`);
	}
	for (const key of ["maxChars", "maxInspectionChars"] as const) {
		if (raw[key] !== undefined && (raw[key] as number) < MIN_BOUNDED_RESULT_CHARS) throw new Error(`${key} must be at least ${MIN_BOUNDED_RESULT_CHARS} characters so truncation can be disclosed`);
	}
	if (raw.artifactDirectory !== undefined && (typeof raw.artifactDirectory !== "string" || !raw.artifactDirectory)) throw new Error("artifactDirectory must be a non-empty string");
	return raw as Partial<TruncationConfig>;
}

export function mergeConfig(...parts: Array<Partial<TruncationConfig>>): TruncationConfig {
	const config = Object.assign({}, DEFAULT_CONFIG, ...parts);
	validateConfig(config);
	if (config.headChars + config.tailChars > config.maxChars) throw new Error("headChars + tailChars must not exceed maxChars");
	return config;
}

async function readConfig(path: string): Promise<Partial<TruncationConfig>> {
	try { return validateConfig(JSON.parse(await readFile(path, "utf8"))); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw new Error(`Invalid ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export async function loadConfig(cwd: string, trusted: boolean, home = process.env.HOME ?? ""): Promise<TruncationConfig> {
	const global = await readConfig(join(home, ".pi", "agent", "tool-output-truncation.json"));
	const project = trusted ? await readConfig(join(cwd, ".pi", "tool-output-truncation.json")) : {};
	return mergeConfig(global, project);
}

