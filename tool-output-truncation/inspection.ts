import { lstat, realpath, readFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { TruncationConfig } from "./config.ts";
import { boundInspectionOutput, safeSlice } from "./core.ts";

export type InspectionRequest = { path: string; operation: "head" | "tail" | "characters" | "lines" | "literal" | "regex"; start?: number; end?: number; query?: string };
const ARTIFACT = /^tool-output-[a-z0-9_-]+-[0-9a-f-]{36}\.log$/i;

async function artifactPath(directory: string, requested: string, cwd: string): Promise<string> {
	if (!requested || isAbsolute(requested) || requested.split(/[\\/]/).includes("..") || !ARTIFACT.test(basename(requested))) throw new Error("artifact path must name an extension artifact beneath the configured directory");
	const configuredRoot = resolve(directory);
	const root = await realpath(configuredRoot);
	const candidate = requested === basename(requested) ? resolve(configuredRoot, requested) : resolve(cwd, requested);
	if (relative(configuredRoot, candidate).startsWith("..") || relative(configuredRoot, candidate).includes(`..${sep}`)) throw new Error("artifact path escapes configured directory");
	const stat = await lstat(candidate);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("artifact must be a regular non-symlink file");
	const actual = await realpath(candidate);
	if (actual !== root && !actual.startsWith(`${root}${sep}`)) throw new Error("artifact path escapes configured directory");
	return actual;
}

function range(value: number | undefined, fallback: number): number { return value === undefined ? fallback : Math.max(1, Math.floor(value)); }

export async function inspectToolOutput(directory: string, config: TruncationConfig, request: InspectionRequest, cwd = process.cwd()): Promise<string> {
	const text = await readFile(await artifactPath(directory, request.path, cwd), "utf8");
	let result: string;
	if (request.operation === "head") result = safeSlice(text, 0, config.maxInspectionChars);
	else if (request.operation === "tail") result = safeSlice(text, Math.max(0, text.length - config.maxInspectionChars));
	else if (request.operation === "characters") result = safeSlice(text, range(request.start, 1) - 1, range(request.end, text.length));
	else if (request.operation === "lines") {
		const lines = text.split("\n");
		result = lines.slice(range(request.start, 1) - 1, range(request.end, lines.length)).map((line, i) => `${range(request.start, 1) + i}: ${line}`).join("\n");
	} else {
		if (!request.query) throw new Error("query is required for search");
		let matchesLine: (line: string) => boolean;
		try {
			if (request.operation === "regex") {
				if (request.query.length > 500) throw new Error("regular expression is limited to 500 characters");
				const matcher = new RegExp(request.query);
				matchesLine = (line) => matcher.test(line);
			} else matchesLine = (line) => line.includes(request.query!);
		}
		catch (error) { throw new Error(`invalid regular expression: ${error instanceof Error ? error.message : String(error)}`); }
		const matches = text.split("\n").flatMap((line, index) => matchesLine(line) ? [`${index + 1}: ${line}`] : []);
		const shown: string[] = [];
		for (const match of matches.slice(0, 100)) {
			const candidate = [...shown, match].join("\n");
			if (candidate.length > config.maxInspectionChars - 45) break;
			shown.push(match);
		}
		result = shown.join("\n") || "No matching lines.";
		if (matches.length > shown.length) result += `\nAdditional matches omitted: ${matches.length - shown.length}`;
	}
	return boundInspectionOutput(result, config);
}

