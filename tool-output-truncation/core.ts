import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, relative } from "node:path";
import type { TruncationConfig } from "./config.ts";

export interface ArtifactWriter { write(text: string, label: string): Promise<string>; }
export interface TruncationOptions { label?: string; observedUpstreamTruncated?: boolean; writer?: ArtifactWriter; }
export interface TruncationResult {
	text: string; truncated: boolean; originalChars: number; returnedChars: number; artifactPath?: string; artifactError?: string;
}

function safeEnd(text: string, end: number): number { return end > 0 && end < text.length && /[\uDC00-\uDFFF]/.test(text[end]) && /[\uD800-\uDBFF]/.test(text[end - 1]) ? end - 1 : end; }
function safeStart(text: string, start: number): number { return start > 0 && start < text.length && /[\uDC00-\uDFFF]/.test(text[start]) && /[\uD800-\uDBFF]/.test(text[start - 1]) ? start + 1 : start; }
export function safeSlice(text: string, start: number, end = text.length): string { return text.slice(safeStart(text, start), safeEnd(text, end)); }
export function excerpt(text: string, head: number, tail: number): { head: string; tail: string; headEnd: number; tailStart: number } {
	const headEnd = safeEnd(text, Math.min(head, text.length));
	const tailStart = safeStart(text, Math.max(headEnd, text.length - tail));
	return { head: text.slice(0, headEnd), tail: text.slice(tailStart), headEnd, tailStart };
}

export class FileArtifactWriter implements ArtifactWriter {
	private readonly directory: string;
	private readonly cwd: string;
	constructor(directory: string, cwd = process.cwd()) { this.directory = directory; this.cwd = cwd; }
	async write(text: string, label: string): Promise<string> {
		await mkdir(this.directory, { recursive: true });
		const name = `tool-output-${label.replace(/[^a-z0-9_-]/gi, "-").slice(0, 40) || "result"}-${randomUUID()}.log`;
		const path = `${this.directory}/${name}`;
		await writeFile(path, text, "utf8");
		return relative(this.cwd, path) || basename(path);
	}
}

function notice(original: number, returned: number, headEnd: number, tailStart: number, artifact: string | undefined, error: string | undefined, upstream: boolean): string {
	const storage = artifact ? `Full observed output: ${artifact}` : `Full observed output was not saved: ${(error ?? "artifact write failed").slice(0, 180)}`;
	return ["[Tool output truncated]", `Observed: ${original} characters${upstream ? " (already truncated upstream; artifact is not complete/exact)" : ""}`, `Returned: ${returned} characters`, `Retained: characters 1-${headEnd} and ${tailStart + 1}-${original}`, `Omitted: ${tailStart - headEnd} characters`, storage].join("\n");
}

function bounded(text: string, config: TruncationConfig, artifact?: string, error?: string, upstream = false): string {
	let head = config.headChars, tail = config.tailChars;
	for (;;) {
		const part = excerpt(text, head, tail);
		let returned = 0;
		let result = "";
		for (let attempt = 0; attempt < 4; attempt++) {
			const middle = notice(text.length, returned, part.headEnd, part.tailStart, artifact, error, upstream);
			result = `${part.head}\n\n${middle}\n\n${part.tail}`;
			if (result.length === returned) break;
			returned = result.length;
		}
		if (result.length <= config.maxChars) return result;
		if (!head && !tail) {
			const compact = `[Truncated: observed ${text.length}; ${artifact ? `saved ${artifact}` : `not saved: ${(error ?? "write failed").slice(0, 60)}`}${upstream ? "; upstream-truncated" : ""}]`;
			return compact.length <= config.maxChars ? compact : text.slice(0, safeEnd(text, config.maxChars));
		}
		const excess = result.length - config.maxChars;
		const reduceHead = Math.min(head, Math.ceil(excess / 2));
		head -= reduceHead;
		tail -= Math.min(tail, excess - reduceHead);
		if (reduceHead === 0 && tail === 0) head = 0;
	}
}

export async function truncateToolOutput(output: string, config: TruncationConfig, options: TruncationOptions = {}): Promise<TruncationResult> {
	if (output.length <= config.maxChars) return { text: output, truncated: false, originalChars: output.length, returnedChars: output.length };
	let artifactPath: string | undefined;
	let artifactError: string | undefined;
	try { artifactPath = await (options.writer ?? new FileArtifactWriter(config.artifactDirectory)).write(output, options.label ?? "result"); }
	catch (error) { artifactError = error instanceof Error ? error.message : String(error); }
	const text = bounded(output, config, artifactPath, artifactError, options.observedUpstreamTruncated);
	return { text, truncated: true, originalChars: output.length, returnedChars: text.length, artifactPath, artifactError };
}

export function boundInspectionOutput(text: string, config: TruncationConfig): string {
	if (text.length <= config.maxInspectionChars) return text;
	return bounded(text, { ...config, maxChars: config.maxInspectionChars }, undefined, "inspection output is bounded");
}

