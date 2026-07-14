import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ApprovalStore, type ApprovalContext } from "./approvals.ts";
import type { Decision } from "./policy.ts";

const decision: Decision = {
	outcome: "risky", rule: "recursive-delete", action: "rm -rf build",
	affected: "/repo/build", reason: "recursive deletion",
};
const context: ApprovalContext = { toolName: "bash", workspace: "/repo", trusted: true };

function storePath(): string {
	return join(mkdtempSync(join(tmpdir(), "safety-approvals-")), "approvals.json");
}

test("session approvals match only the exact action and workspace", async () => {
	const store = new ApprovalStore(storePath());
	await store.remember(decision, context, "session");
	assert.equal(await store.isApproved(decision, context), true);
	assert.equal(await store.isApproved({ ...decision, action: "rm -rf dist" }, context), false);
	assert.equal(await store.isApproved(decision, { ...context, workspace: "/other" }), false);
});

test("project approvals survive a new store instance", async () => {
	const path = storePath();
	await new ApprovalStore(path).remember(decision, context, "project");
	assert.equal(await new ApprovalStore(path).isApproved(decision, context), true);
	assert.equal(await new ApprovalStore(path).isApproved(decision, { ...context, trusted: false }), false);
});

test("only risky decisions can be remembered", async () => {
	const store = new ApprovalStore(storePath());
	await assert.rejects(store.remember({ ...decision, outcome: "prohibited" }, context, "session"));
});

test("approvals can be revoked and cleared", async () => {
	const path = storePath();
	const store = new ApprovalStore(path);
	await store.remember(decision, context, "session");
	await store.remember({ ...decision, action: "rm -rf dist", affected: "/repo/dist" }, context, "project");
	const entries = await store.list(context);
	assert.equal(entries.length, 2);
	await store.revoke(entries[0].id, context);
	assert.equal((await store.list(context)).length, 1);
	await store.clear("project", context);
	assert.equal((await store.list(context)).length, 0);
});

test("corrupt persistent storage fails closed", async () => {
	const path = storePath();
	const { writeFile } = await import("node:fs/promises");
	await writeFile(path, "not json");
	await assert.rejects(new ApprovalStore(path).isApproved(decision, context), /Invalid safety-gate approval store/);
});
