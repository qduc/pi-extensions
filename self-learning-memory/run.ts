import { randomUUID } from "node:crypto";
import type { ActiveSession } from "./host.ts";
import type { MemoryEngine } from "./types.ts";

export function newActiveSession(): ActiveSession { return { id: randomUUID(), request: "", events: [], seen: new Set() }; }
export async function settleRun(engine: MemoryEngine, run: ActiveSession, scope: { kind: "workspace"; value?: string }, signal?: AbortSignal, extract = true): Promise<void> {
	if (!run.request) return;
	await engine.completeSession({ id: run.id, request: run.request, events: run.events, scope, model: run.model });
	if (extract && (engine as { immediateExtractionEnabled?: boolean }).immediateExtractionEnabled !== false) try { await engine.runExtraction(run.id, signal); } catch { /* maintenance failures never affect the foreground run */ }
}

/** Deduplicates lifecycle races while allowing a failed settlement to be retried later. */
export function createSettlementGuard() {
	const inFlight = new Map<string, Promise<void>>();
	return { settle(engine: MemoryEngine, run: ActiveSession, scope: { kind: "workspace"; value?: string }, signal?: AbortSignal, extract = true): Promise<void> {
		if (!run.request) return Promise.resolve();
		const prior = inFlight.get(run.id); if (prior) return prior;
		const job = settleRun(engine, run, scope, signal, extract).finally(() => inFlight.delete(run.id));
		inFlight.set(run.id, job); return job;
	} };
}
