import { randomUUID } from "node:crypto";
import { mergeConfig, type MemoryConfig } from "./config.ts";
import { consolidate } from "./consolidation.ts";
import { digestSession } from "./evidence.ts";
import { extractCandidates } from "./extraction.ts";
import { redact } from "./redaction.ts";
import { retrieveMemories } from "./retrieval.ts";
import { routeExtraction } from "./routing.ts";
import { JsonMemoryStore } from "./store.ts";
import { isScope, type CompletedSession, type MemoryCandidate, type MemoryEngine, type ModelInvoker, type RetrievalRequest, type RetrievalResult, type StoredSession, type DurableMemory, type CandidateOutcome, type Scope, type MemoryStatus } from "./types.ts";

function visibleFrom(resource: Scope, active?: Scope): boolean {
	return !active || resource.kind === "global" || (resource.kind === active.kind && resource.value === active.value);
}

export class PortableMemoryEngine implements MemoryEngine {
	private readonly config: MemoryConfig; private readonly store: JsonMemoryStore; private readonly now: () => number;
	private extraction: Promise<void> = Promise.resolve();
	constructor(statePath: string, options: { config?: Partial<Omit<MemoryConfig, "statePath">>; invoker?: ModelInvoker; now?: () => number } = {}) { this.config = mergeConfig(statePath, options.config); this.store = new JsonMemoryStore(statePath); this.invoker = options.invoker; this.now = options.now ?? Date.now; }
	private readonly invoker?: ModelInvoker;
	get immediateExtractionEnabled(): boolean { return this.config.immediateExtraction; }
	async completeSession(input: CompletedSession): Promise<StoredSession> {
		if (input.scope !== undefined && !isScope(input.scope)) throw new Error("invalid session scope");
		const clean = redact(input, this.config.redactionPatterns); const session: StoredSession = { id: clean.id, request: clean.request, events: clean.events.slice(-this.config.maxEventsPerSession), scope: clean.scope ?? { kind: "global" }, completedAt: clean.completedAt ?? new Date(this.now()).toISOString(), complexity: clean.complexity ?? "routine", model: clean.model, digest: "" }; session.digest = digestSession(session);
		await this.store.update((state) => {
			const existing = state.sessions.findIndex((item) => item.id === session.id); if (existing >= 0) state.sessions[existing] = session; else state.sessions.push(session);
			if (state.sessions.length > this.config.sessionRetentionLimit) {
				state.sessions.sort((a, b) => a.completedAt.localeCompare(b.completedAt)); const removed = new Set(state.sessions.slice(0, -this.config.sessionRetentionLimit).map((item) => item.id));
				state.sessions = state.sessions.slice(-this.config.sessionRetentionLimit); state.extractions = state.extractions.filter((item) => !removed.has(item.sessionId));
				for (const candidate of state.candidates) candidate.evidence = candidate.evidence.filter((ref) => !removed.has(ref.sessionId));
				for (const memory of state.memories) { memory.evidence = memory.evidence.filter((ref) => !removed.has(ref.sessionId)); memory.sourceSessionIds = memory.sourceSessionIds.filter((id) => !removed.has(id)); }
			}
		}); return session;
	}
	async retrieve(request: RetrievalRequest): Promise<RetrievalResult> { if (request.scope !== undefined && !isScope(request.scope)) throw new Error("invalid retrieval scope"); return retrieveMemories((await this.store.read()).memories, { ...request, limit: request.limit ?? this.config.retrievalLimit }); }
	async inspect(id: string, scope?: Scope): Promise<DurableMemory | undefined> { if (scope !== undefined && !isScope(scope)) throw new Error("invalid inspection scope"); return (await this.store.read()).memories.find((memory) => memory.id === id && visibleFrom(memory.scope, scope)); }
	async searchSessions(query: string, limit = 10, scope?: Scope): Promise<StoredSession[]> { if (scope !== undefined && !isScope(scope)) throw new Error("invalid session search scope"); const terms = query.toLowerCase().match(/[a-z0-9_-]{3,}/g) ?? []; return (await this.store.read()).sessions.filter((session) => visibleFrom(session.scope, scope) && terms.every((term) => `${session.request}\n${session.digest}`.toLowerCase().includes(term))).slice(0, limit); }
	async propose(input: Omit<MemoryCandidate, "id" | "createdAt">): Promise<MemoryCandidate> { if (!isScope(input.scope)) throw new Error("invalid proposal scope"); const candidate = Object.freeze(redact({ ...input, id: randomUUID(), createdAt: new Date(this.now()).toISOString(), explicit: true }, this.config.redactionPatterns)); await this.store.update((state) => state.candidates.push(candidate)); return candidate; }
	async forget(memoryId: string, reason: string, scope?: Scope): Promise<MemoryCandidate> { const memory = await this.inspect(memoryId, scope); if (!memory) throw new Error("memory not found"); return this.propose({ type: "correction", scope: memory.scope, statement: memory.statement, rationale: reason, confidence: 1, sourceSessionId: "explicit-forget", evidence: [], suggestedAction: "forget", targetMemoryId: memoryId, uncertainty: undefined, explicit: true }); }
	async purge(memoryId: string, scope?: Scope): Promise<boolean> {
		if (scope !== undefined && !isScope(scope)) throw new Error("invalid purge scope");
		return this.store.update((state) => {
			const memory = state.memories.find((item) => item.id === memoryId && visibleFrom(item.scope, scope));
			if (!memory) return false;
			const candidateIds = new Set(state.outcomes.filter((outcome) => outcome.memoryId === memoryId).map((outcome) => outcome.candidateId));
			for (const candidate of state.candidates) if (candidate.targetMemoryId === memoryId) candidateIds.add(candidate.id);
			state.memories = state.memories.filter((item) => item.id !== memoryId);
			state.candidates = state.candidates.filter((candidate) => !candidateIds.has(candidate.id));
			state.outcomes = state.outcomes.filter((outcome) => outcome.memoryId !== memoryId && !candidateIds.has(outcome.candidateId));
			return true;
		});
	}
	async status(): Promise<MemoryStatus> {
		const state = await this.store.read(); const decided = new Set(state.outcomes.map((outcome) => outcome.candidateId));
		return {
			sessions: state.sessions.length,
			durableMemories: state.memories.filter((memory) => !memory.archived).length,
			pendingCandidates: state.candidates.filter((candidate) => !decided.has(candidate.id)).length,
			stateBytes: Buffer.byteLength(JSON.stringify(state)),
			extractions: {
				completed: state.extractions.filter((item) => item.status === "completed").length,
				empty: state.extractions.filter((item) => item.status === "empty").length,
				failed: state.extractions.filter((item) => item.status === "failed").length,
			},
		};
	}
	async pendingCandidates(limit = 50, scope?: Scope): Promise<MemoryCandidate[]> {
		if (scope !== undefined && !isScope(scope)) throw new Error("invalid candidate scope");
		const state = await this.store.read(); const decided = new Set(state.outcomes.map((outcome) => outcome.candidateId));
		return state.candidates.filter((candidate) => !decided.has(candidate.id) && visibleFrom(candidate.scope, scope)).slice(0, limit);
	}
	private async runSafeAutoConsolidation(scope?: Scope): Promise<void> {
		const policy = this.config.autoConsolidation; if (!policy) return;
		await this.store.update(async (state) => {
			const decided = new Set(state.outcomes.map((outcome) => outcome.candidateId)); const groups = new Map<string, MemoryCandidate[]>(); const sessions = new Map(state.sessions.map((session) => [session.id, session]));
			for (const candidate of state.candidates) {
				const source = sessions.get(candidate.sourceSessionId); const eventIds = new Set(source?.events.map((event) => event.id) ?? []);
				const grounded = candidate.explicit !== true && !!source && candidate.evidence.some((ref) => ref.sessionId === source.id && ref.eventIds.length > 0 && ref.eventIds.every((id) => eventIds.has(id)));
				if (!grounded || decided.has(candidate.id) || !visibleFrom(candidate.scope, scope) || candidate.suggestedAction !== "create" || candidate.confidence < policy.minimumConfidence || !(policy.allowedTypes as string[]).includes(candidate.type)) continue;
				const normalized = candidate.statement.toLowerCase().replace(/\s+/g, " ").trim(); const key = `${candidate.type}\0${candidate.scope.kind}\0${candidate.scope.value ?? ""}\0${normalized}`;
				groups.set(key, [...(groups.get(key) ?? []), candidate]);
			}
			for (const candidates of groups.values()) {
				const sourceIds = [...new Set(candidates.map((candidate) => candidate.sourceSessionId))];
				if (sourceIds.length < policy.minimumIndependentSessions) continue;
				const representative = candidates.sort((a, b) => b.confidence - a.confidence || a.createdAt.localeCompare(b.createdAt))[0];
				const existing = state.memories.find((memory) => !memory.archived && memory.type === representative.type && memory.scope.kind === representative.scope.kind && memory.scope.value === representative.scope.value && memory.statement.toLowerCase().replace(/\s+/g, " ").trim() === representative.statement.toLowerCase().replace(/\s+/g, " ").trim());
				let memoryId = existing?.id;
				if (!existing) memoryId = (await consolidate(state, [representative], undefined, undefined, undefined, scope))[0]?.memoryId;
				const memory = state.memories.find((item) => item.id === memoryId); if (!memory) continue;
				memory.sourceSessionIds = [...new Set([...memory.sourceSessionIds, ...sourceIds])];
				memory.evidence = [...memory.evidence, ...candidates.flatMap((candidate) => candidate.evidence)].filter((ref, index, refs) => refs.findIndex((item) => item.sessionId === ref.sessionId && item.eventIds.join("\0") === ref.eventIds.join("\0")) === index);
				memory.confidence = Math.max(memory.confidence, ...candidates.map((candidate) => candidate.confidence));
				const now = new Date(this.now()).toISOString();
				for (const candidate of candidates) if (!state.outcomes.some((outcome) => outcome.candidateId === candidate.id)) state.outcomes.push({ candidateId: candidate.id, action: "merged", memoryId, reason: "safe automatic consolidation from repeated independent sessions", decidedAt: now });
			}
		});
	}
	async runExtraction(sessionId?: string, signal?: AbortSignal, scope?: Scope): Promise<MemoryCandidate[]> {
		if (scope !== undefined && !isScope(scope)) throw new Error("invalid extraction scope");
		const operation = this.extraction.then(async () => {
			const state = await this.store.read();
			const finished = new Set(state.extractions.filter((item) => item.status !== "failed").map((item) => item.sessionId));
			const sessions = state.sessions.filter((session) => visibleFrom(session.scope, scope) && (!sessionId || session.id === sessionId) && !finished.has(session.id) && !state.candidates.some((candidate) => candidate.sourceSessionId === session.id));
			const all: MemoryCandidate[] = [];
			for (const session of sessions) {
				if (signal?.aborted) break;
				const attemptedAt = new Date(this.now()).toISOString();
				try {
					const route = routeExtraction(session, this.now(), this.config.cacheWindowMs, this.config.economyModel, this.config.warmModel);
					const persisted = redact(await extractCandidates(session, route.model, this.invoker, signal), this.config.redactionPatterns).map((candidate) => Object.freeze(candidate));
					const retained = await this.store.update((next) => {
						if (!next.sessions.some((item) => item.id === session.id && visibleFrom(item.scope, scope))) return false;
						if (persisted.length) next.candidates.push(...persisted);
						next.extractions = next.extractions.filter((item) => item.sessionId !== session.id);
						next.extractions.push({ sessionId: session.id, status: persisted.length ? "completed" : "empty", attemptedAt, candidateCount: persisted.length });
						return true;
					});
					if (retained) all.push(...persisted);
				} catch (error) {
					await this.store.update((next) => {
						if (!next.sessions.some((item) => item.id === session.id && visibleFrom(item.scope, scope))) return;
						next.extractions = next.extractions.filter((item) => item.sessionId !== session.id);
						const message = error instanceof Error ? error.message : String(error);
						next.extractions.push({ sessionId: session.id, status: "failed", attemptedAt, candidateCount: 0, error: redact(message.slice(0, 500), this.config.redactionPatterns) });
					});
					throw error;
				}
			}
			if (all.length) await this.runSafeAutoConsolidation(scope);
			return all;
		});
		this.extraction = operation.then(() => undefined, () => undefined);
		return operation;
	}
	async runConsolidation(limit = 50, signal?: AbortSignal, scope?: Scope): Promise<CandidateOutcome[]> {
		if (scope !== undefined && !isScope(scope)) throw new Error("invalid consolidation scope");
		return this.store.update(async (state) => {
			const decided = new Set(state.outcomes.map((outcome) => outcome.candidateId));
			return consolidate(state, state.candidates.filter((candidate) => !decided.has(candidate.id) && visibleFrom(candidate.scope, scope)).slice(0, limit), this.invoker, this.config.consolidationModel, signal, scope);
		});
	}
}

