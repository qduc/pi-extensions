import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { MemoryState } from "./types.ts";

export const emptyState = (): MemoryState => ({ version: 1, sessions: [], candidates: [], outcomes: [], memories: [] });

export class JsonMemoryStore {
	private readonly path: string;
	/** One queue per file serializes all instances in this process; failures must not poison later work. */
	private static readonly updates = new Map<string, Promise<void>>();
	constructor(path: string) { this.path = path; }
	async read(): Promise<MemoryState> {
		try {
			const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
			if (!parsed || typeof parsed !== "object" || (parsed as { version?: unknown }).version !== 1) throw new Error("unsupported memory state");
			const state = parsed as MemoryState;
			if (![state.sessions, state.candidates, state.outcomes, state.memories].every(Array.isArray)) throw new Error("invalid memory state arrays");
			return state;
		} catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState(); throw error; }
	}
	async write(state: MemoryState): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
		const temporary = `${this.path}.${randomUUID()}.tmp`;
		await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
		await rename(temporary, this.path);
	}
	async update<T>(change: (state: MemoryState) => T | Promise<T>): Promise<T> {
		const previous = JsonMemoryStore.updates.get(this.path) ?? Promise.resolve();
		const operation = previous.then(async () => { const state = await this.read(); const result = await change(state); await this.write(state); return result; });
		const next = operation.then(() => undefined, () => undefined);
		JsonMemoryStore.updates.set(this.path, next);
		next.then(() => { if (JsonMemoryStore.updates.get(this.path) === next) JsonMemoryStore.updates.delete(this.path); });
		return operation;
	}
}

