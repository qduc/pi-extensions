import { randomUUID } from "node:crypto";
import type { CandidateOutcome, ConsolidationDecision, DurableMemory, MemoryCandidate, MemoryState, ModelInvoker, ModelProfile, Scope } from "./types.ts";

function fallback(candidate: MemoryCandidate): ConsolidationDecision {
	const action = candidate.suggestedAction === "create"
		? (candidate.explicit || candidate.confidence >= 0.8 ? "create" : "defer")
		: candidate.suggestedAction;
	return { candidateId: candidate.id, action, reason: "deterministic conservative policy" };
}
const ACTIONS = new Set(["create", "merge", "update", "reject", "defer", "forget"]);
const DURABLE_TYPES = new Set(["preference", "fact", "constraint", "decision", "lesson", "procedure"]);
function validDecision(value: unknown, candidate: MemoryCandidate | undefined): value is ConsolidationDecision {
	if (!value || typeof value !== "object" || !candidate) return false;
	const item = value as Partial<ConsolidationDecision>; const target = item.memoryId ?? candidate.targetMemoryId;
	if (typeof item.candidateId !== "string" || !ACTIONS.has(item.action ?? "") || typeof item.reason !== "string" || (item.memoryId !== undefined && typeof item.memoryId !== "string")) return false;
	return !["update", "merge", "forget"].includes(item.action) || (typeof target === "string" && target.length > 0 && (item.action === "forget" || DURABLE_TYPES.has(candidate.type)));
}
function visibleFrom(resource: Scope, active?: Scope): boolean { return !active || resource.kind === "global" || (resource.kind === active.kind && resource.value === active.value); }
export async function consolidate(state: MemoryState, candidates: MemoryCandidate[], invoker?: ModelInvoker, model?: ModelProfile, signal?: AbortSignal, scope?: Scope): Promise<CandidateOutcome[]> {
	let decisions = candidates.map(fallback);
	if (invoker && model && candidates.length) {
		const result = await invoker.invoke({ purpose: "consolidate", model, input: { candidates, memories: state.memories.filter((memory) => visibleFrom(memory.scope, scope)) }, signal });
		if (!Array.isArray(result)) throw new Error("consolidator must return an array");
		const valid = new Map(candidates.map((candidate) => [candidate.id, candidate]));
		decisions = result.filter((item): item is ConsolidationDecision => validDecision(item, valid.get((item as { candidateId?: string }).candidateId ?? "")));
		for (const candidate of candidates) if (!decisions.some((decision) => decision.candidateId === candidate.id)) decisions.push(fallback(candidate));
	}
	const now = new Date().toISOString(); const outcomes: CandidateOutcome[] = [];
	for (const decision of decisions) {
		const candidate = candidates.find((item) => item.id === decision.candidateId)!; let memoryId = decision.memoryId ?? candidate.targetMemoryId;
		if (decision.action === "create") {
			if (!DURABLE_TYPES.has(candidate.type)) { outcomes.push({ candidateId: candidate.id, action: "deferred", reason: "non-durable candidate type", decidedAt: now }); continue; }
			memoryId = randomUUID(); const memory: DurableMemory = { id: memoryId, type: candidate.type as DurableMemory["type"], scope: candidate.scope, statement: candidate.statement, rationale: candidate.rationale, confidence: candidate.confidence, createdAt: now, confirmedAt: now, sourceSessionIds: [candidate.sourceSessionId], evidence: candidate.evidence, revisions: [] }; state.memories.push(memory);
		} else if (decision.action === "update" || decision.action === "merge") {
			if (!DURABLE_TYPES.has(candidate.type)) { outcomes.push({ candidateId: candidate.id, action: "deferred", reason: "non-durable candidate type", decidedAt: now }); continue; }
			const target = state.memories.find((memory) => memory.id === memoryId && !memory.archived && visibleFrom(memory.scope, scope));
			if (!target) { outcomes.push({ candidateId: candidate.id, action: "deferred", reason: "target memory not found", decidedAt: now }); continue; }
			target.revisions.push({ at: now, statement: target.statement, reason: decision.reason }); if (decision.action === "update") target.statement = candidate.statement; target.confirmedAt = now; target.confidence = Math.max(target.confidence, candidate.confidence); target.sourceSessionIds.push(candidate.sourceSessionId); target.evidence.push(...candidate.evidence);
		} else if (decision.action === "forget") { const target = state.memories.find((memory) => memory.id === memoryId && !memory.archived && visibleFrom(memory.scope, scope)); if (!target) { outcomes.push({ candidateId: candidate.id, action: "deferred", reason: "target memory not found", decidedAt: now }); continue; } target.archived = true; target.revisions.push({ at: now, statement: target.statement, reason: decision.reason }); }
		outcomes.push({ candidateId: candidate.id, action: decision.action === "create" ? "created" : decision.action === "merge" ? "merged" : decision.action === "update" ? "updated" : decision.action === "forget" ? "forgotten" : decision.action === "reject" ? "rejected" : "deferred", memoryId, reason: decision.reason, decidedAt: now });
	}
	state.outcomes.push(...outcomes); return outcomes;
}

