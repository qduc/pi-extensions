import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PortableMemoryEngine } from "./engine.ts";
import { loadAdapterConfig } from "./config-loader.ts";
import { createSettlementGuard, newActiveSession, settleRun } from "./run.ts";
import { routeExtraction } from "./routing.ts";
import { JsonMemoryStore } from "./store.ts";
import type { ModelInvoker, StoredSession } from "./types.ts";

const directory = () => mkdtemp(join(tmpdir(), "memory-core-"));
const profile = { provider: "p", model: "m", thinking: "high", tools: ["read"], promptPrefix: "stable" };
const session = (id = "s1") => ({ id, request: "Use the approved formatter", events: [{ id: "e1", role: "user" as const, text: "My token=super-secret-value must not persist" }], scope: { kind: "project" as const, value: "demo" }, complexity: "complex" as const, model: profile });

test("persists redacted inspectable JSON and keeps extraction candidates separate from durable memory", async () => {
	const path = join(await directory(), "state.json");
	const invoker: ModelInvoker = { async invoke({ purpose }) { if (purpose === "extract") return [{ type: "preference", statement: "Use approved formatter", rationale: "User said token=leak-value", confidence: 0.9 }]; return []; } };
	const engine = new PortableMemoryEngine(path, { invoker, config: { warmModel: profile } });
	await engine.completeSession(session()); const candidates = await engine.runExtraction();
	assert.equal(candidates.length, 1); assert.equal((await engine.retrieve({ request: "formatter", scope: session().scope })).memories.length, 0);
	const state = await readFile(path, "utf8"); assert.match(state, /\[REDACTED\]/); assert.doesNotMatch(state, /super-secret-value|leak-value/);
	assert.equal(JSON.parse(state).candidates.length, 1); assert.equal(JSON.parse(state).memories.length, 0);
	assert.deepEqual((await readdir(join(path, ".."))).filter((name) => name.endsWith(".tmp")), []);
});

test("only consolidation creates durable memories, retrieval is keyword and scope bounded, and forget is auditable", async () => {
	const path = join(await directory(), "state.json"); const engine = new PortableMemoryEngine(path);
	await engine.completeSession(session()); const candidate = await engine.propose({ type: "fact", scope: { kind: "project", value: "demo" }, statement: "Formatter is prettier", rationale: "explicit", confidence: 1, sourceSessionId: "s1", evidence: [], suggestedAction: "create" });
	assert.equal((await engine.runConsolidation()).length, 1); const found = await engine.retrieve({ request: "formatter configuration", scope: { kind: "project", value: "demo" } });
	assert.equal(found.memories.length, 1); assert.equal((await engine.retrieve({ request: "formatter", scope: { kind: "project", value: "other" } })).memories.length, 0);
	const forget = await engine.forget(found.memories[0].id, "user requested removal"); assert.equal(forget.suggestedAction, "forget"); assert.equal((await engine.retrieve({ request: "formatter", scope: { kind: "project", value: "demo" } })).memories.length, 1);
	await engine.runConsolidation(); assert.equal((await engine.retrieve({ request: "formatter", scope: { kind: "project", value: "demo" } })).memories.length, 0);
	assert.equal(candidate.explicit, true);
});

test("deterministic consolidation preserves explicit reject, defer, and update actions", async () => {
	const path = join(await directory(), "state.json"); const engine = new PortableMemoryEngine(path);
	for (const [statement, suggestedAction] of [["Do not retain this", "reject"], ["Wait for confirmation", "defer"]] as const) {
		await engine.propose({ type: "fact", scope: { kind: "global" }, statement, rationale: "explicit", confidence: 1, sourceSessionId: "explicit", evidence: [], suggestedAction });
	}
	const outcomes = await engine.runConsolidation();
	assert.deepEqual(outcomes.map((outcome) => outcome.action), ["rejected", "deferred"]);
	assert.equal((await engine.retrieve({ request: "retain confirmation" })).memories.length, 0);
});

test("inspection and session search are scope isolated, while purge removes retained memory records", async () => {
	const path = join(await directory(), "state.json"); const engine = new PortableMemoryEngine(path);
	await engine.completeSession(session("demo-session"));
	await engine.completeSession({ ...session("other-session"), scope: { kind: "project", value: "other" }, request: "Other formatter secret" });
	const candidate = await engine.propose({ type: "fact", scope: { kind: "project", value: "demo" }, statement: "Unique purge marker", rationale: "explicit", confidence: 1, sourceSessionId: "demo-session", evidence: [], suggestedAction: "create" });
	const [created] = await engine.runConsolidation();
	assert.equal((await engine.searchSessions("formatter", 10, { kind: "project", value: "demo" })).length, 1);
	assert.equal(await engine.inspect(created.memoryId!, { kind: "project", value: "other" }), undefined);
	assert.equal(await engine.purge(created.memoryId!, { kind: "project", value: "other" }), false);
	assert.equal(await engine.purge(created.memoryId!, { kind: "project", value: "demo" }), true);
	assert.equal(await engine.inspect(created.memoryId!, { kind: "project", value: "demo" }), undefined);
	const state = await readFile(path, "utf8"); assert.doesNotMatch(state, /Unique purge marker/); assert.doesNotMatch(state, new RegExp(candidate.id));
});

test("retrieval uses token matches and includes durable procedures only when requested", async () => {
	const path = join(await directory(), "state.json"); const engine = new PortableMemoryEngine(path);
	for (const [type, statement] of [["fact", "Use formattersuffix only"], ["procedure", "Run formatter before commit"]] as const) {
		await engine.propose({ type, scope: { kind: "global" }, statement, rationale: "explicit", confidence: 1, sourceSessionId: "explicit", evidence: [], suggestedAction: "create" });
	}
	await engine.runConsolidation();
	assert.equal((await engine.retrieve({ request: "formatter" })).memories.length, 0);
	assert.equal((await engine.retrieve({ request: "formatter", includeProcedures: true })).memories[0]?.type, "procedure");
});

test("safe automatic consolidation requires repeated high-confidence evidence from independent sessions", async () => {
	const path = join(await directory(), "state.json");
	const engine = new PortableMemoryEngine(path, { config: { autoConsolidation: { minimumConfidence: 0.9, minimumIndependentSessions: 2, allowedTypes: ["preference", "fact"] } }, invoker: { async invoke() { return [{ type: "preference", statement: "Use the approved formatter", rationale: "repeated preference", confidence: 0.95, suggestedAction: "create" }]; } } });
	await engine.completeSession(session("one")); await engine.runExtraction("one");
	assert.equal((await engine.retrieve({ request: "approved formatter", scope: session().scope })).memories.length, 0);
	await engine.completeSession(session("two")); await engine.runExtraction("two");
	const found = await engine.retrieve({ request: "approved formatter", scope: session().scope });
	assert.equal(found.memories.length, 1); assert.deepEqual(found.memories[0].sourceSessionIds.sort(), ["one", "two"]);
});

test("safe automatic consolidation ignores explicit or ungrounded candidates", async () => {
	const path = join(await directory(), "state.json");
	const engine = new PortableMemoryEngine(path, { config: { autoConsolidation: { minimumConfidence: 0.9, minimumIndependentSessions: 2, allowedTypes: ["fact"] } }, invoker: { async invoke() { return [{ type: "fact", statement: "Grounded repeated fact", rationale: "one session", confidence: 0.95, suggestedAction: "create" }]; } } });
	await engine.propose({ type: "fact", scope: session().scope, statement: "Grounded repeated fact", rationale: "forged", confidence: 1, sourceSessionId: "forged", evidence: [], suggestedAction: "create" });
	await engine.completeSession(session("real")); await engine.runExtraction("real");
	assert.equal((await engine.retrieve({ request: "grounded repeated", scope: session().scope })).memories.length, 0);
});

test("session retention bounds stored sessions, events, and dangling evidence", async () => {
	const path = join(await directory(), "state.json"); const engine = new PortableMemoryEngine(path, { config: { sessionRetentionLimit: 1, maxEventsPerSession: 1 } });
	await engine.completeSession({ ...session("old"), events: [...session("old").events, { id: "e2", role: "assistant", text: "second" }] });
	await engine.completeSession(session("new"));
	const state = JSON.parse(await readFile(path, "utf8")); assert.deepEqual(state.sessions.map((item: any) => item.id), ["new"]); assert.equal(state.sessions[0].events.length, 1);
});

test("retention eviction during extraction cannot restore an evicted session or candidate", async () => {
	const path = join(await directory(), "state.json"); let release!: () => void; let started!: () => void;
	const waiting = new Promise<void>((resolve) => { release = resolve; }); const invoked = new Promise<void>((resolve) => { started = resolve; });
	const engine = new PortableMemoryEngine(path, { config: { sessionRetentionLimit: 1 }, invoker: { async invoke() { started(); await waiting; return [{ type: "fact", statement: "Evicted candidate", rationale: "stale", confidence: 1, suggestedAction: "create" }]; } } });
	await engine.completeSession(session("old")); const extraction = engine.runExtraction("old"); await invoked;
	await engine.completeSession(session("new")); release(); assert.deepEqual(await extraction, []);
	const state = JSON.parse(await readFile(path, "utf8")); assert.deepEqual(state.sessions.map((item: any) => item.id), ["new"]); assert.equal(state.candidates.length, 0); assert.equal(state.extractions.length, 0);
});

test("routing is deterministic and a thinking-level change makes warm cache ineligible", () => {
	const stored: StoredSession = { ...session(), completedAt: new Date(1000).toISOString(), digest: "x" };
	assert.equal(routeExtraction(stored, 1001, 1000, { provider: "cheap", model: "c", thinking: "low" }, profile).path, "warm-cache");
	assert.equal(routeExtraction(stored, 1001, 1000, { provider: "cheap", model: "c", thinking: "low" }, { ...profile, thinking: "low" }).path, "economy");
	assert.equal(routeExtraction(stored, 3000, 1000, { provider: "cheap", model: "c", thinking: "low" }, profile).path, "economy");
});

test("fake invoker can drive consolidation decisions and session search remains bounded", async () => {
	const path = join(await directory(), "state.json"); const invoker: ModelInvoker = { async invoke({ purpose }) { return purpose === "consolidate" ? [{ candidateId: "ignored", action: "create", reason: "bad" }] : []; } };
	const engine = new PortableMemoryEngine(path, { invoker }); await engine.completeSession(session("one")); await engine.completeSession({ ...session("two"), request: "Deploy formatter" });
	assert.equal((await engine.searchSessions("formatter", 1)).length, 1); await engine.propose({ type: "fact", scope: { kind: "global" }, statement: "Formatting is required", rationale: "explicit", confidence: 1, sourceSessionId: "one", evidence: [], suggestedAction: "create" });
	assert.equal((await engine.runConsolidation()).length, 1); assert.equal((await engine.retrieve({ request: "formatting" })).memories.length, 1);
});

test("settlement persists one uniquely identified run then extracts it without consolidating", async () => {
	const calls: string[] = []; const engine = { immediateExtractionEnabled: true, async completeSession(value: any) { calls.push(`complete:${value.id}`); return value; }, async runExtraction(id: string) { calls.push(`extract:${id}`); return []; } } as any;
	const first = newActiveSession(); first.request = "first"; first.events.push({ id: "e", role: "user", text: "first" });
	const second = newActiveSession(); second.request = "second";
	assert.notEqual(first.id, second.id); await settleRun(engine, first, { kind: "workspace", value: "demo" });
	assert.deepEqual(calls, [`complete:${first.id}`, `extract:${first.id}`]);
});

test("strict adapter config reads global defaults and only trusted project config may set statePath", async () => {
	const root = await directory(); const home = join(root, "home"); const cwd = join(root, "project");
	await (await import("node:fs/promises")).mkdir(join(home, ".pi", "agent"), { recursive: true }); await (await import("node:fs/promises")).mkdir(join(cwd, ".pi"), { recursive: true });
	await (await import("node:fs/promises")).writeFile(join(home, ".pi", "agent", "self-learning-memory.json"), '{"immediateExtraction":false}');
	await (await import("node:fs/promises")).writeFile(join(cwd, ".pi", "self-learning-memory.json"), '{"statePath":"safe/state.json","retrievalLimit":3}');
	assert.deepEqual(await loadAdapterConfig(cwd, false, home), { immediateExtraction: false }); assert.equal((await loadAdapterConfig(cwd, true, home)).statePath, "safe/state.json");
	await (await import("node:fs/promises")).writeFile(join(home, ".pi", "agent", "self-learning-memory.json"), '{"statePath":"nope"}');
	await assert.rejects(loadAdapterConfig(cwd, false, home), /unknown configuration field: statePath/);
});

test("scoped consolidation neither discloses nor mutates memories outside the active scope", async () => {
	const path = join(await directory(), "state.json"); const seen: any[] = []; let foreignId = "";
	const engine = new PortableMemoryEngine(path, { config: { consolidationModel: { provider: "p", model: "review", thinking: "low" } }, invoker: { async invoke(invocation) {
		const input = invocation.input as any; seen.push(input);
		return input.candidates.map((candidate: any) => foreignId && candidate.statement === "Cross-scope overwrite" ? { candidateId: candidate.id, action: "update", memoryId: foreignId, reason: "attempt" } : { candidateId: candidate.id, action: "create", reason: "setup" });
	} } });
	await engine.propose({ type: "fact", scope: { kind: "project", value: "other" }, statement: "Foreign private memory", rationale: "private", confidence: 1, sourceSessionId: "x", evidence: [], suggestedAction: "create" });
	foreignId = (await engine.runConsolidation())[0].memoryId!;
	await engine.propose({ type: "fact", scope: { kind: "project", value: "demo" }, statement: "Cross-scope overwrite", rationale: "attempt", confidence: 1, sourceSessionId: "y", evidence: [], suggestedAction: "update", targetMemoryId: foreignId });
	const [outcome] = await engine.runConsolidation(undefined, undefined, { kind: "project", value: "demo" });
	assert.equal(outcome.action, "deferred"); assert.equal(seen.at(-1).memories.some((memory: any) => memory.id === foreignId), false);
	assert.equal((await engine.inspect(foreignId))!.statement, "Foreign private memory");
});

test("consolidation invokes only its configured model", async () => {
	const path = join(await directory(), "state.json"); const invoked: any[] = []; const consolidator = { provider: "local", model: "review", thinking: "high" };
	const engine = new PortableMemoryEngine(path, { config: { consolidationModel: consolidator }, invoker: { async invoke(input) { invoked.push(input); return [{ candidateId: (input.input as any).candidates[0].id, action: "create", reason: "approved" }]; } } });
	await engine.propose({ type: "fact", scope: { kind: "global" }, statement: "A fact", rationale: "explicit", confidence: 1, sourceSessionId: "x", evidence: [], suggestedAction: "create" }); await engine.runConsolidation();
	assert.deepEqual(invoked[0].model, consolidator);
});

test("store serializes concurrent updates and continues after a rejected update", async () => {
	const path = join(await directory(), "state.json"); const store = new JsonMemoryStore(path); const otherStore = new JsonMemoryStore(path);
	await assert.rejects(store.update(() => { throw new Error("expected"); }), /expected/);
	await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2 ? store : otherStore).update((state) => { state.sessions.push({ ...session(`s${index}`), completedAt: new Date().toISOString(), digest: "x" }); })));
	assert.equal((await store.read()).sessions.length, 20);
});

test("serialized extraction creates one redacted persisted candidate and returns that candidate", async () => {
	const path = join(await directory(), "state.json"); let invocations = 0;
	const engine = new PortableMemoryEngine(path, { invoker: { async invoke() { invocations++; await new Promise((resolve) => setTimeout(resolve, 10)); return [{ type: "fact", statement: "token=model-secret", rationale: "token=model-secret", confidence: 0.9 }]; } } });
	await engine.completeSession(session()); const [first, second] = await Promise.all([engine.runExtraction("s1"), engine.runExtraction("s1")]);
	assert.equal(invocations, 1); assert.equal(first.length + second.length, 1);
	const persisted = JSON.parse(await readFile(path, "utf8")).candidates; const returned = first.length ? first : second;
	assert.deepEqual(returned, persisted); assert.doesNotMatch(JSON.stringify(returned), /model-secret/);
});

test("extraction is evidence-grounded and records an empty result exactly once", async () => {
	const path = join(await directory(), "state.json"); let invocations = 0; let input: any;
	const engine = new PortableMemoryEngine(path, { invoker: { async invoke(invocation) { invocations++; input = invocation.input; return []; } } });
	await engine.completeSession(session());
	assert.deepEqual(await engine.runExtraction("s1"), []); assert.deepEqual(await engine.runExtraction("s1"), []);
	assert.equal(invocations, 1); assert.equal(input.events[0].id, "e1");
	const status = await engine.status(); assert.equal(status.extractions.empty, 1); assert.equal(status.pendingCandidates, 0);
});

test("extraction rejects evidence references outside the source session", async () => {
	const path = join(await directory(), "state.json");
	const engine = new PortableMemoryEngine(path, { invoker: { async invoke() { return [{ type: "fact", statement: "Unsupported", rationale: "bad evidence", confidence: 1, evidence: [{ sessionId: "other", eventIds: ["foreign"] }] }]; } } });
	await engine.completeSession(session()); await assert.rejects(engine.runExtraction("s1"), /evidence/);
	assert.equal((await engine.status()).extractions.failed, 1);
});

test("extraction rejects invalid scopes and redacts persisted failure details", async () => {
	const path = join(await directory(), "state.json"); const engine = new PortableMemoryEngine(path, { invoker: { async invoke() { throw new Error("token=failure-secret"); } } });
	await engine.completeSession(session());
	await assert.rejects(engine.runExtraction("s1", undefined, null as any), /invalid extraction scope/);
	await assert.rejects(engine.runExtraction("s1"), /failure-secret/);
	assert.doesNotMatch(await readFile(path, "utf8"), /failure-secret/);
});

test("settlement guard deduplicates races and shutdown-style checkpoint skips extraction", async () => {
	const calls: string[] = []; const engine = { immediateExtractionEnabled: true, async completeSession(value: any) { calls.push(`complete:${value.id}`); return value; }, async runExtraction(id: string) { calls.push(`extract:${id}`); return []; } } as any;
	const run = newActiveSession(); run.request = "checkpoint"; const guard = createSettlementGuard();
	await Promise.all([guard.settle(engine, run, { kind: "workspace" }, undefined, false), guard.settle(engine, run, { kind: "workspace" })]);
	assert.deepEqual(calls, [`complete:${run.id}`]);
});

test("redaction configuration rejects dangerous custom patterns", async () => {
	const path = join(await directory(), "state.json");
	assert.throws(() => new PortableMemoryEngine(path, { config: { redactionPatterns: [/(a+)+$/] } }), /nested quantifier/);
	const root = await directory(); await (await import("node:fs/promises")).mkdir(join(root, ".pi", "agent"), { recursive: true });
	await (await import("node:fs/promises")).writeFile(join(root, ".pi", "agent", "self-learning-memory.json"), JSON.stringify({ redactionPatterns: ["x".repeat(513)] }));
	await assert.rejects(loadAdapterConfig(root, false, root), /too long/);
});

