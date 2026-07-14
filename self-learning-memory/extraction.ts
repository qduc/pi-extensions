import { randomUUID } from "node:crypto";
import { evidenceFor } from "./evidence.ts";
import { isScope, type MemoryCandidate, type ModelInvoker, type StoredSession } from "./types.ts";

const TYPES = new Set(["preference", "fact", "constraint", "decision", "correction", "lesson", "procedure", "observation"]);
const ACTIONS = new Set(["create", "defer", "reject", "update", "forget"]);
function validEvidence(value: unknown, session: StoredSession): value is MemoryCandidate["evidence"] {
	const eventIds = new Set(session.events.map((event) => event.id));
	return Array.isArray(value) && value.every((ref) => !!ref && typeof ref === "object"
		&& (ref as { sessionId?: unknown }).sessionId === session.id
		&& Array.isArray((ref as { eventIds?: unknown }).eventIds)
		&& (ref as { eventIds: unknown[] }).eventIds.every((id) => typeof id === "string" && eventIds.has(id)));
}
export async function extractCandidates(session: StoredSession, model: { provider: string; model: string; thinking: string }, invoker?: ModelInvoker, signal?: AbortSignal): Promise<MemoryCandidate[]> {
	if (!invoker) return [];
	const response = await invoker.invoke({ purpose: "extract", model, input: { sessionId: session.id, digest: session.digest, events: session.events, scope: session.scope }, signal });
	if (!Array.isArray(response)) throw new Error("extractor must return an array");
	const now = new Date().toISOString();
	return response.map((raw, index) => {
		if (!raw || typeof raw !== "object") throw new Error(`invalid candidate ${index}`);
		const item = raw as Partial<MemoryCandidate>;
		const scope = item.scope ?? session.scope; const evidence = item.evidence ?? evidenceFor(session); const action = item.suggestedAction ?? "defer";
		if (!validEvidence(evidence, session)) throw new Error(`invalid candidate ${index} evidence`);
		if (!item.type || !TYPES.has(item.type) || typeof item.statement !== "string" || typeof item.rationale !== "string" || !Number.isFinite(item.confidence) || !isScope(scope) || !ACTIONS.has(action) || (item.uncertainty !== undefined && typeof item.uncertainty !== "string") || (item.targetMemoryId !== undefined && typeof item.targetMemoryId !== "string")) throw new Error(`invalid candidate ${index}`);
		return Object.freeze({ id: randomUUID(), type: item.type, scope, statement: item.statement.slice(0, 1000), rationale: item.rationale.slice(0, 2000), confidence: Math.max(0, Math.min(1, item.confidence)), sourceSessionId: session.id, evidence, suggestedAction: action, ...(item.targetMemoryId === undefined ? {} : { targetMemoryId: item.targetMemoryId }), ...(item.uncertainty === undefined ? {} : { uncertainty: item.uncertainty }), createdAt: now, explicit: false });
	});
}

