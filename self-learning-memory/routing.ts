import type { ModelProfile, StoredSession } from "./types.ts";

export type ExtractionRoute = { path: "warm-cache"; model: ModelProfile } | { path: "economy"; model: ModelProfile };

function sameCacheProfile(a: ModelProfile, b: ModelProfile): boolean {
	return a.provider === b.provider && a.model === b.model && a.thinking === b.thinking && a.promptPrefix === b.promptPrefix && JSON.stringify(a.tools ?? []) === JSON.stringify(b.tools ?? []);
}

export function routeExtraction(session: StoredSession, now: number, cacheWindowMs: number, economyModel: ModelProfile, warmModel?: ModelProfile): ExtractionRoute {
	const warm = warmModel && session.model && sameCacheProfile(session.model, warmModel) && now - Date.parse(session.completedAt) <= cacheWindowMs;
	const valuable = session.complexity === "complex" || session.complexity === "high-value";
	return warm && valuable ? { path: "warm-cache", model: warmModel } : { path: "economy", model: economyModel };
}

