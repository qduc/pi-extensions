import assert from "node:assert/strict";
import test from "node:test";
import { DELEGATE_MODE_DESCRIPTION, DELEGATE_PROMPT_GUIDELINES } from "./delegate-interface.ts";

test("delegate tells the parent which modes can access repository tools", () => {
	const guidance = DELEGATE_PROMPT_GUIDELINES.join("\n");
	assert.match(guidance, /worker.*inspect files.*configured tools.*fileScope/i);
	assert.match(guidance, /advisor.*only.*context.*no repository tools/i);
	assert.match(guidance, /file review.*worker mode/i);
	assert.match(guidance, /higher.*defaults to advisor/i);

	assert.match(DELEGATE_MODE_DESCRIPTION, /worker.*repository tools/i);
	assert.match(DELEGATE_MODE_DESCRIPTION, /advisor.*no repository tools/i);
});
