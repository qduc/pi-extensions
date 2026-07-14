import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Pi adapter registers the required lifecycle and model-facing interfaces", async () => {
	const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
	for (const event of ["input", "message_end", "tool_result", "before_agent_start", "agent_start", "agent_end", "agent_settled", "session_start", "session_shutdown"]) assert.match(source, new RegExp(`pi\\.on\\(\\"${event}\\"`));
	for (const tool of ["memory_retrieve", "memory_inspect", "memory_search_sessions", "memory_propose", "memory_forget", "memory_extract", "memory_consolidate"]) assert.match(await readFile(new URL("./tools.ts", import.meta.url), "utf8"), new RegExp(`name: \\"${tool}\\"`));
	assert.match(source, /registerCommand\("memory"/);
	assert.match(source, /registerMemoryTools\(pi, getEngine, \(\) => currentScope\)/);
	assert.match(source, /agent_settled[\s\S]*checkpoint\(true\)/);
	assert.match(source, /session_shutdown[\s\S]*checkpoint\(false\)/);
	assert.match(source, /createSettlementGuard/);
});

