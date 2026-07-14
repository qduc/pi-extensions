import assert from "node:assert/strict";
import test from "node:test";
import { DELEGATE_MODE_DESCRIPTION, DELEGATE_PROMPT_GUIDELINES, EXPLORER_TOOLS } from "./delegate-interface.ts";

test("delegate tells the parent which modes can access repository tools", () => {
	const guidance = DELEGATE_PROMPT_GUIDELINES.join("\n");
	assert.match(guidance, /worker.*inspect files.*configured tools.*fileScope/i);
	assert.match(guidance, /advisor.*only.*context.*no repository tools/i);
	assert.match(guidance, /file review.*worker mode/i);
	assert.match(guidance, /higher.*defaults to advisor/i);

	assert.match(DELEGATE_MODE_DESCRIPTION, /worker.*repository tools/i);
	assert.match(DELEGATE_MODE_DESCRIPTION, /advisor.*no repository tools/i);
});

test("explorer is a lower-tier read-only repository search role", () => {
	const guidance = DELEGATE_PROMPT_GUIDELINES.join("\n");
	assert.match(guidance, /agentType explorer.*repository search.*lower tier.*read-only/i);
	assert.deepEqual(EXPLORER_TOOLS, ["read", "grep", "find", "ls", "submit_delegation_result"]);
	assert.ok(!EXPLORER_TOOLS.some((tool) => ["bash", "edit", "write"].includes(tool)));
});
