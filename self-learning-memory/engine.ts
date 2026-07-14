import { randomUUID } from "node:crypto";
import { mergeConfig, type MemoryConfig } from "./config.ts";
import { consolidate } from "./consolidation.ts";
import { digestSession } from "./evidence.ts";
import { extractCandidates } from "./extraction.ts";
import { redact } from "./redaction.ts";
import { retrieveMemories } from "./retrieval.ts";
import { routeExtraction } from "./routing.ts";
import { JsonMemoryStore } from "./store.ts";
import { isScope, type CompletedSession, type MemoryCandidate, type MemoryEngine, type ModelInvoker, type RetrievalRequest, type RetrievalResult, type StoredSession, type DurableMemory, type CandidateOutcome } from "./types.ts";

export class PortableMemoryEngine implements MemoryEngine {
	private readonly config: MemoryConfig; private readonly store: JsonMemoryStore; private readonly now: () => number;
	private extraction: Promise<void> = Promise.resolve();
	constructor(statePath: string, options: { config?: Partial<Omit<MemoryConfig, "statePath">>; invoker?: ModelInvoker; now?: () => number } = {}) { this.config = mergeConfig(statePath, options.config); this.store = new JsonMemoryStore(statePath); this.invoker = options.invoker; this.now = options.now ?? Date.now; }
	private readonly invoker?: ModelInvoker;
	get immediateExtractionEnabled(): boolean { return this.config.immediateExtraction; }
	async completeSession(input: CompletedSession): Promise<StoredSession> {
		if (input.scope !== undefined && !isScope(input.scope)) throw new Error("invalid session scope");
		const clean = redact(input, this.config.redactionPatterns); const session: StoredSession = { id: clean.id, request: clean.request, events: clean.events, scope: clean.scope ?? { kind: "global" }, completedAt: clean.completedAt ?? new Date(this.now()).toISOString(), complexity: clean.complexity ?? "routine", model: clean.model, digest: "" }; session.digest = digestSession(session);
		await this.store.update((state) => { const existing = state.sessions.findIndex((item) => item.id === session.id); if (existing >= 0) state.sessions[existing] = session; else state.sessions.push(session); }); return session;
	}
	async retrieve(request: RetrievalRequest): Promise<RetrievalResult> { if (request.scope !== undefined && !isScope(request.scope)) throw new Error("invalid retrieval scope"); return retrieveMemories((await this.store.read()).memories, { ...request, limit: request.limit ?? this.config.retrievalLimit }); }
	async inspect(id: string): Promise<DurableMemory | undefined> { return (await this.store.read()).memories.find((memory) => memory.id === id); }
	async searchSessions(query: string, limit = 10): Promise<StoredSession[]> { const terms = query.toLowerCase().match(/[a-z0-9_-]{3,}/g) ?? []; return (await this.store.read()).sessions.filter((session) => terms.every((term) => `${session.request}\n${session.digest}`.toLowerCase().includes(term))).slice(0, limit); }
	async propose(input: Omit<MemoryCandidate, "id" | "createdAt">): Promise<MemoryCandidate> { if (!isScope(input.scope)) throw new Error("invalid proposal scope"); const candidate = Object.freeze(redact({ ...input, id: randomUUID(), createdAt: new Date(this.now()).toISOString(), explicit: true }, this.config.redactionPatterns)); await this.store.update((state) => state.candidates.push(candidate)); return candidate; }
	async forget(memoryId: string, reason: string): Promise<MemoryCandidate> { const memory = await this.inspect(memoryId); if (!memory) throw new Error("memory not found"); return this.propose({ type: "correction", scope: memory.scope, statement: memory.statement, rationale: reason, confidence: 1, sourceSessionId: "explicit-forget", evidence: [], suggestedAction: "forget", targetMemoryId: memoryId, uncertainty: undefined, explicit: true }); }
	async runExtraction(sessionId?: string, signal?: AbortSignal): Promise<MemoryCandidate[]> {
		const operation = this.extraction.then(async () => {
			const state = await this.store.read(); const sessions = state.sessions.filter((session) => (!sessionId || session.id === sessionId) && !state.candidates.some((candidate) => candidate.sourceSessionId === session.id)); const candidates: MemoryCandidate[] = [];
			for (const session of sessions) { if (signal?.aborted) break; const route = routeExtraction(session, this.now(), this.config.cacheWindowMs, this.config.economyModel, this.config.warmModel); candidates.push(...await extractCandidates(session, route.model, this.invoker, signal)); }
			const persisted = redact(candidates, this.config.redactionPatterns).map((candidate) => Object.freeze(candidate));
			if (persisted.length) await this.store.update((next) => next.candidates.push(...persisted)); return persisted;
		});
		this.extraction = operation.then(() => undefined, () => undefined);
		return operation;
	}
	async runConsolidation(limit = 50, signal?: AbortSignal): Promise<CandidateOutcome[]> {
		return this.store.update(async (state) => {
			const decided = new Set(state.outcomes.map((outcome) => outcome.candidateId));
			return consolidate(state, state.candidates.filter((candidate) => !decided.has(candidate.id)).slice(0, limit), this.invoker, this.config.consolidationModel, signal);
		});
	}
}

