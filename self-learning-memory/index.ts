import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createEngine, memoryInjection, profileFor, scopeFor, type ActiveSession } from "./host.ts";
import { registerMemoryTools } from "./tools.ts";
import type { MemoryEngine, SessionEvent } from "./types.ts";
import { createSettlementGuard, newActiveSession } from "./run.ts";

function textOf(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map((item) => item && typeof item === "object" && (item as { type?: unknown }).type === "text" ? String((item as { text?: unknown }).text ?? "") : "").filter(Boolean).join("\n");
	return "";
}

const MAX_EVENT_TEXT = 8_000;
function eventText(message: any): string { return (textOf(message?.content) || (message?.content ? JSON.stringify(message.content) : "")).slice(0, MAX_EVENT_TEXT); }

/** Pi-facing adapter: event capture and retrieval stay here; durable policy stays portable. */
export default function selfLearningMemory(pi: ExtensionAPI) {
	let engine: MemoryEngine | undefined;
	let active: ActiveSession = newActiveSession();
	const settlements = createSettlementGuard();
	let maintenanceAbort = new AbortController();
	let currentScope = { kind: "workspace" as const, value: undefined as string | undefined };
	const getEngine = () => { if (!engine) throw new Error("Memory engine is not initialized; submit a prompt first."); return engine; };
	const safe = async (ctx: ExtensionContext, work: () => Promise<void>) => {
		try { await work(); } catch (error) { if (ctx.mode === "tui") ctx.ui.notify(`Self-learning memory: ${error instanceof Error ? error.message : String(error)}`, "warning"); }
	};
	const record = (role: SessionEvent["role"], text: string, id = randomUUID()) => { const bounded = text.slice(0, MAX_EVENT_TEXT); const key = `${role}:${id}:${bounded}`; if (bounded && !active.seen.has(key)) { active.seen.add(key); active.events.push({ id, role, text: bounded, timestamp: new Date().toISOString() }); } };
	const checkpoint = (extract: boolean) => {
		if (!engine || !active.request) return Promise.resolve();
		const settled = active; active = newActiveSession();
		return settlements.settle(engine, settled, currentScope, maintenanceAbort.signal, extract);
	};

	pi.on("session_start", async (_event, ctx) => { currentScope = scopeFor(ctx); void checkpoint(false).catch(() => {}); await safe(ctx, async () => { engine = await createEngine(ctx, pi); active = newActiveSession(); maintenanceAbort = new AbortController(); }); });
	pi.on("session_shutdown", () => { void checkpoint(false).catch(() => {}); maintenanceAbort.abort(); });
	pi.on("input", (event) => { if (active.request) void checkpoint(false).catch(() => {}); active.request ||= event.text.slice(0, MAX_EVENT_TEXT); record("user", event.text); });
	pi.on("message_end", (event) => { const role = event.message.role === "toolResult" ? "tool" : event.message.role; if (role === "user" || role === "assistant" || role === "tool") record(role, eventText(event.message)); });
	pi.on("tool_result", (event) => { record("tool", `${event.toolName}: ${textOf(event.content)}`, event.toolCallId); });
	pi.on("before_agent_start", async (event, ctx) => {
		try {
			currentScope = scopeFor(ctx);
			engine ??= await createEngine(ctx, pi);
			active.request ||= event.prompt;
			active.model = profileFor(pi, ctx, event.systemPrompt);
			const found = await engine.retrieve({ request: event.prompt, scope: scopeFor(ctx) });
			return { systemPrompt: `${event.systemPrompt}${memoryInjection(event.prompt, found)}` };
		} catch (error) { await safe(ctx, async () => { throw error; }); return undefined; }
	});
	pi.on("agent_start", () => { record("system", "Pi agent started"); });
	pi.on("agent_end", async (event, ctx) => { await safe(ctx, async () => {
		if (!engine || !active.request) return;
		record("system", "Pi agent ended");
		for (const message of event.messages) { const role = message.role === "toolResult" ? "tool" : message.role; if (role === "user" || role === "assistant" || role === "tool") record(role, eventText(message), `${role}:${eventText(message)}`); }
	}); });
	pi.on("agent_settled", (_event, ctx) => { if (!engine || !active.request) return; record("system", "Pi agent settled"); currentScope = scopeFor(ctx); void checkpoint(true).catch((error) => { if (ctx.mode === "tui") ctx.ui.notify(`Self-learning memory: ${error instanceof Error ? error.message : String(error)}`, "warning"); }); /* Deliberately no automatic consolidation. */ });
	registerMemoryTools(pi, getEngine, () => currentScope);
	pi.registerCommand("memory", { description: "Memory: retrieve, inspect, sessions, extract, consolidate, or forget", handler: async (args, ctx) => {
		const [command = "retrieve", ...rest] = args.trim().split(/\s+/); const value = rest.join(" "); const current = getEngine();
		try {
			if (command === "consolidate" && value && (!/^\d+$/.test(value) || Number(value) < 1)) throw new Error("consolidate limit must be a positive integer");
			if (command === "forget" && !rest[0]) throw new Error("forget requires a nonempty memory id");
			const result = command === "inspect" ? await current.inspect(value) : command === "sessions" ? await current.searchSessions(value) : command === "propose" ? await current.propose({ type: "fact", scope: scopeFor(ctx), statement: value, rationale: "explicit slash command", confidence: 1, sourceSessionId: "explicit-command", evidence: [], suggestedAction: "create" }) : command === "extract" ? await current.runExtraction(value || undefined) : command === "consolidate" ? await current.runConsolidation(value ? Number(value) : undefined) : command === "forget" ? await current.forget(rest[0], rest.slice(1).join(" ") || "slash command") : await current.retrieve({ request: args || "memory", scope: scopeFor(ctx) });
			ctx.ui.notify(JSON.stringify(result, null, 2), "info");
		} catch (error) { ctx.ui.notify(`Self-learning memory: ${error instanceof Error ? error.message : String(error)}`, "warning"); }
	} });
}

