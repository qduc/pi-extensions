import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PortableMemoryEngine } from "./engine.ts";
import { PiModelInvoker } from "./model-invoker.ts";
import { loadAdapterConfig } from "./config-loader.ts";
import { retrievalPrompt } from "./prompts.ts";
import type { MemoryConfig } from "./config.ts";
import type { ModelProfile, Scope, SessionEvent } from "./types.ts";

export interface ActiveSession { id: string; request: string; events: SessionEvent[]; model?: ModelProfile; seen: Set<string>; }

export function scopeFor(ctx: ExtensionContext): Scope { return { kind: "workspace", value: ctx.cwd }; }
export function profileFor(pi: ExtensionAPI, ctx: ExtensionContext, systemPrompt = ""): ModelProfile | undefined {
	if (!ctx.model) return undefined;
	const tools = (pi as unknown as { getActiveTools?: () => unknown[] }).getActiveTools?.() ?? [];
	const toolNames = tools.map((tool) => typeof tool === "string" ? tool : tool && typeof tool === "object" ? String((tool as { name?: unknown }).name ?? "") : "").filter(Boolean).sort();
	return { provider: ctx.model.provider, model: ctx.model.id, thinking: pi.getThinkingLevel(), tools: toolNames, promptPrefix: createHash("sha256").update(systemPrompt.slice(0, 2048)).digest("hex").slice(0, 16) };
}

export async function createEngine(ctx: ExtensionContext, pi: ExtensionAPI): Promise<PortableMemoryEngine> {
	const config = await loadAdapterConfig(ctx.cwd, ctx.isProjectTrusted());
	const fallback = profileFor(pi, ctx);
	const economyModel = config.economyModel ?? fallback;
	if (!economyModel) throw new Error("Configure economyModel or select a Pi model before extraction.");
	const redactionPatterns = config.redactionPatterns?.map((value) => new RegExp(value, "gi"));
	const memoryConfig: Partial<Omit<MemoryConfig, "statePath">> = { economyModel };
	if (config.retrievalLimit !== undefined) memoryConfig.retrievalLimit = config.retrievalLimit;
	if (config.cacheWindowMs !== undefined) memoryConfig.cacheWindowMs = config.cacheWindowMs;
	if (config.warmModel !== undefined) memoryConfig.warmModel = config.warmModel;
	if (config.consolidationModel !== undefined) memoryConfig.consolidationModel = config.consolidationModel;
	if (config.immediateExtraction !== undefined) memoryConfig.immediateExtraction = config.immediateExtraction;
	if (redactionPatterns !== undefined) memoryConfig.redactionPatterns = redactionPatterns;
	const statePath = config.statePath ? resolve(ctx.cwd, config.statePath) : resolve(homedir(), ".pi", "agent", "self-learning-memory", "state.json");
	return new PortableMemoryEngine(statePath, { invoker: new PiModelInvoker(ctx.modelRegistry), config: memoryConfig });
}

export function memoryInjection(request: string, result: Awaited<ReturnType<PortableMemoryEngine["retrieve"]>>): string {
	return retrievalPrompt(result.memories.map((memory) => `[${memory.id}] ${memory.statement}`).slice(0, 20));
}

