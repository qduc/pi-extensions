import type { DurableMemory, RetrievalRequest, RetrievalResult, Scope } from "./types.ts";

function words(text: string): string[] { return [...new Set((text.toLowerCase().match(/[a-z0-9_-]{3,}/g) ?? []))]; }
function scopeMatches(memory: Scope, active?: Scope): boolean { return memory.kind === "global" || (!!active && memory.kind === active.kind && memory.value === active.value); }

export function retrieveMemories(memories: DurableMemory[], request: RetrievalRequest): RetrievalResult {
	const query = words(request.request); const phrase = query.join(" "); const limit = request.limit ?? 6;
	const scored = memories
		.filter((memory) => !memory.archived && scopeMatches(memory.scope, request.scope) && (request.includeProcedures || memory.type !== "procedure"))
		.map((memory) => {
			const text = `${memory.statement} ${memory.rationale}`.toLowerCase(); const tokens = new Set(words(text));
			const tokenScore = query.reduce((score, word) => score + (tokens.has(word) ? 1 : 0), 0);
			const phraseScore = query.length > 1 && text.includes(phrase) ? 1 : 0;
			const scopeScore = request.scope && memory.scope.kind === request.scope.kind && memory.scope.value === request.scope.value ? 0.25 : 0;
			return { memory, score: tokenScore + phraseScore + scopeScore + memory.confidence * 0.1 };
		})
		.filter(({ score }) => score >= 1)
		.sort((a, b) => b.score - a.score || Date.parse(b.memory.confirmedAt) - Date.parse(a.memory.confirmedAt) || a.memory.id.localeCompare(b.memory.id))
		.slice(0, limit);
	return { memories: scored.map(({ memory }) => memory), references: scored.map(({ memory }) => memory.id) };
}
