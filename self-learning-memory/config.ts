import type { ModelProfile } from "./types.ts";

export interface AutoConsolidationConfig { minimumConfidence: number; minimumIndependentSessions: number; allowedTypes: Array<"preference" | "fact" | "constraint" | "decision" | "lesson" | "procedure">; }
export interface MemoryConfig { statePath: string; cacheWindowMs: number; retrievalLimit: number; economyModel: ModelProfile; warmModel?: ModelProfile; consolidationModel?: ModelProfile; immediateExtraction: boolean; redactionPatterns?: RegExp[]; autoConsolidation?: AutoConsolidationConfig; sessionRetentionLimit: number; maxEventsPerSession: number; }
export const DEFAULT_CONFIG: Omit<MemoryConfig, "statePath"> = {
	cacheWindowMs: 10 * 60 * 1000,
	retrievalLimit: 6,
	economyModel: { provider: "economy", model: "extractor", thinking: "low" },
	immediateExtraction: true,
	sessionRetentionLimit: 500,
	maxEventsPerSession: 200,
};

export const validateRedactionPattern = (pattern: RegExp | string): void => {
	const source = typeof pattern === "string" ? pattern : pattern.source;
	if (source.length > 512) throw new Error("redaction pattern is too long");
	if (/\((?:[^()\\]|\\.)*[+*][^()]*\)[+*{]/.test(source)) throw new Error("redaction pattern has an unsafe nested quantifier");
};

export function mergeConfig(statePath: string, value: Partial<Omit<MemoryConfig, "statePath">> = {}): MemoryConfig {
	const known = new Set(["cacheWindowMs", "retrievalLimit", "economyModel", "warmModel", "consolidationModel", "immediateExtraction", "redactionPatterns", "autoConsolidation", "sessionRetentionLimit", "maxEventsPerSession"]);
	for (const key of Object.keys(value)) if (!known.has(key)) throw new Error(`unknown configuration field: ${key}`);
	const config = { ...DEFAULT_CONFIG, ...value, statePath };
	if (!Number.isInteger(config.cacheWindowMs) || config.cacheWindowMs < 0) throw new Error("cacheWindowMs must be a non-negative integer");
	if (!Number.isInteger(config.retrievalLimit) || config.retrievalLimit < 1) throw new Error("retrievalLimit must be a positive integer");
	if (typeof config.immediateExtraction !== "boolean") throw new Error("immediateExtraction must be a boolean");
	if (!Number.isInteger(config.sessionRetentionLimit) || config.sessionRetentionLimit < 1) throw new Error("sessionRetentionLimit must be a positive integer");
	if (!Number.isInteger(config.maxEventsPerSession) || config.maxEventsPerSession < 1) throw new Error("maxEventsPerSession must be a positive integer");
	if (config.redactionPatterns && !config.redactionPatterns.every((pattern) => pattern instanceof RegExp)) throw new Error("redactionPatterns must be regular expressions");
	if (config.autoConsolidation) {
		const auto = config.autoConsolidation;
		if (!Number.isFinite(auto.minimumConfidence) || auto.minimumConfidence < 0 || auto.minimumConfidence > 1) throw new Error("autoConsolidation.minimumConfidence must be between 0 and 1");
		if (!Number.isInteger(auto.minimumIndependentSessions) || auto.minimumIndependentSessions < 2) throw new Error("autoConsolidation.minimumIndependentSessions must be at least 2");
		if (!Array.isArray(auto.allowedTypes) || !auto.allowedTypes.length || !auto.allowedTypes.every((type) => ["preference", "fact", "constraint", "decision", "lesson", "procedure"].includes(type))) throw new Error("autoConsolidation.allowedTypes contains an unsupported type");
	}
	for (const pattern of config.redactionPatterns ?? []) validateRedactionPattern(pattern);
	for (const model of [config.economyModel, config.warmModel]) {
		if (model && (!model.provider || !model.model || !model.thinking)) throw new Error("model profiles require provider, model, and thinking");
	}
	if (config.consolidationModel && (!config.consolidationModel.provider || !config.consolidationModel.model || !config.consolidationModel.thinking)) throw new Error("model profiles require provider, model, and thinking");
	return config;
}

