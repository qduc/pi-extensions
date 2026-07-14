import type { CompletedSession, EvidenceRef, StoredSession } from "./types.ts";

export function evidenceFor(session: CompletedSession): EvidenceRef[] {
	return [{ sessionId: session.id, eventIds: session.events.map((event) => event.id) }];
}

export function digestSession(session: Pick<CompletedSession, "request" | "events">): string {
	const useful = session.events.filter((event) => event.role !== "system" && event.text.trim()).slice(-12);
	return ["Goal: " + session.request, ...useful.map((event) => `${event.role}: ${event.text}`)].join("\n").slice(0, 12000);
}

export function searchableSession(session: StoredSession): string { return `${session.request}\n${session.digest}\n${session.events.map((event) => event.text).join("\n")}`.toLowerCase(); }

