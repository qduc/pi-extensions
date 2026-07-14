import type { ModelProfile } from "./types.ts";

export interface MemoryConfig { statePath: string; cacheWindowMs: number; retrievalLimit: number; economyModel: ModelProfile; warmModel?: ModelProfile; consolidationModel?: ModelProfile; immediateExtraction: boolean; redactionPatterns?: RegExp[]; }
export const DEFAULT_CONFIG: Omit<MemoryConfig, "statePath"> = {
	cacheWindowMs: 10 * 60 * 1000,
	retrievalLimit: 6,
	economyModel: { provider: "economy", model: "extractor", thinking: "low" },
	immediateExtraction: true,
};

export const validateRedactionPattern = (pattern: RegExp | string): void => {
	const source = typeof pattern === "string" ? pattern : pattern.source;
	if (source.length > 512) throw new Error("redaction pattern is too long");
	if (/\((?:[^()\\]|\\.)*[+*][^()]*\)[+*{]/.test(source)) throw new Error("redaction pattern has an unsafe nested quantifier");
};

export function mergeConfig(statePath: string, value: Partial<Omit<MemoryConfig, "statePath">> = {}): MemoryConfig {
	const known = new Set(["cacheWindowMs", "retrievalLimit", "economyModel", "warmModel", "consolidationModel", "immediateExtraction", "redactionPatterns"]);
	for (const key of Object.keys(value)) if (!known.has(key)) throw new Error(`unknown configuration field: ${key}`);
	const config = { ...DEFAULT_CONFIG, ...value, statePath };
	if (!Number.isInteger(config.cacheWindowMs) || config.cacheWindowMs < 0) throw new Error("cacheWindowMs must be a non-negative integer");
	if (!Number.isInteger(config.retrievalLimit) || config.retrievalLimit < 1) throw new Error("retrievalLimit must be a positive integer");
	if (typeof config.immediateExtraction !== "boolean") throw new Error("immediateExtraction must be a boolean");
	if (config.redactionPatterns && !config.redactionPatterns.every((pattern) => pattern instanceof RegExp)) throw new Error("redactionPatterns must be regular expressions");
	for (const pattern of config.redactionPatterns ?? []) validateRedactionPattern(pattern);
	for (const model of [config.economyModel, config.warmModel]) {
		if (model && (!model.provider || !model.model || !model.thinking)) throw new Error("model profiles require provider, model, and thinking");
	}
	if (config.consolidationModel && (!config.consolidationModel.provider || !config.consolidationModel.model || !config.consolidationModel.thinking)) throw new Error("model profiles require provider, model, and thinking");
	return config;
}

