import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalize, resolveScopes, scopesOverlap } from "./scope.ts";

const root = mkdtempSync(join(tmpdir(), "tiered-subagent-"));
const workspace = join(root, "workspace");
const outside = join(root, "outside");
mkdirSync(workspace); mkdirSync(outside); mkdirSync(join(workspace, "src")); mkdirSync(join(workspace, ".git"));
symlinkSync(outside, join(workspace, "escape"));

test("accepts scopes inside configured roots", () => {
	assert.deepEqual(resolveScopes(workspace, ["src"], ["."], [".git"]), [canonicalize(join(workspace, "src"))]);
});

test("rejects lexical and symlink workspace escapes", () => {
	assert.throws(() => resolveScopes(workspace, ["../outside"], ["."], [".git"]), /not allowed/);
	assert.throws(() => resolveScopes(workspace, ["escape"], ["."], [".git"]), /not allowed/);
});

test("rejects protected scopes", () => {
	assert.throws(() => resolveScopes(workspace, [".git"], ["."], [".git"]), /protected/);
});

test("detects parent-child and exact overlap but not siblings", () => {
	assert.equal(scopesOverlap([join(workspace, "src")], [join(workspace, "src/auth")]), true);
	assert.equal(scopesOverlap([join(workspace, "src/auth")], [join(workspace, "src/billing")]), false);
});
