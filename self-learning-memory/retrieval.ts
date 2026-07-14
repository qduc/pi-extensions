import type { DurableMemory, RetrievalRequest, RetrievalResult, Scope } from "./types.ts";

function words(text: string): string[] { return [...new Set((text.toLowerCase().match(/[a-z0-9_-]{3,}/g) ?? []))]; }
function scopeMatches(memory: Scope, active?: Scope): boolean { return memory.kind === "global" || (!!active && memory.kind === active.kind && memory.value === active.value); }

export function retrieveMemories(memories: DurableMemory[], request: RetrievalRequest): RetrievalResult {
	const query = words(request.request); const limit = request.limit ?? 6;
	const scored = memories.filter((memory) => !memory.archived && scopeMatches(memory.scope, request.scope)).map((memory) => {
		const haystack = `${memory.statement} ${memory.rationale}`.toLowerCase();
		return { memory, score: query.reduce((score, word) => score + (haystack.includes(word) ? 1 : 0), 0) + memory.confidence / 1000 };
	}).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score || a.memory.id.localeCompare(b.memory.id)).slice(0, limit);
	return { memories: scored.map(({ memory }) => memory), references: scored.map(({ memory }) => memory.id) };
}

