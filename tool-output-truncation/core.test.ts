import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfig, mergeConfig, validateConfig } from "./config.ts";
import { FileArtifactWriter, truncateToolOutput } from "./core.ts";
import { inspectToolOutput } from "./inspection.ts";

const config = { ...DEFAULT_CONFIG, maxChars: 512, headChars: 150, tailChars: 150, maxInspectionChars: 512 };
const temp = () => mkdtemp(join(tmpdir(), "pi-output-"));

test("leaves empty, below-limit, and exact-limit text unchanged", async () => {
	for (const text of ["", "short", "x".repeat(config.maxChars)]) {
		const result = await truncateToolOutput(text, config, { writer: { async write() { throw new Error("must not write"); } } });
		assert.equal(result.text, text); assert.equal(result.truncated, false);
	}
});

test("stores exact oversized output and reports mechanical retained ranges", async () => {
	const dir = await temp(); const original = "a".repeat(300) + "MIDDLE" + "z".repeat(300);
	const result = await truncateToolOutput(original, config, { label: "bash", writer: new FileArtifactWriter(dir, dir) });
	assert.equal(result.truncated, true); assert.ok(result.text.length <= config.maxChars); assert.match(result.text, /Observed: 606 characters/);
	assert.match(result.text, /Retained: characters 1-/); assert.ok(result.artifactPath);
	assert.equal(await readFile(join(dir, result.artifactPath!), "utf8"), original);
	assert.ok(result.text.startsWith("a")); assert.ok(result.text.endsWith("z"));
});

test("discloses when the observed output was already truncated upstream", async () => {
	const result = await truncateToolOutput("x".repeat(600), config, {
		observedUpstreamTruncated: true,
		writer: { async write() { return "tool-output-read-00000000-0000-0000-0000-000000000000.log"; } },
	});
	assert.match(result.text, /already truncated upstream/);
	assert.match(result.text, /artifact is not complete\/exact/);
});

test("does not split a surrogate pair and discloses failed artifact writes", async () => {
	const result = await truncateToolOutput("A".repeat(250) + "😀" + "Z".repeat(400), config, { writer: { async write() { throw new Error("disk full"); } } });
	assert.ok(result.text.length <= 512); assert.match(result.text, /not saved: disk full/); assert.equal(/[\uD800-\uDBFF]$/.test(result.text), false);
	assert.equal(/[\uDC00-\uDFFF]/.test(result.text[0] ?? ""), false);
});

test("uses collision-resistant artifact names", async () => {
	const dir = await temp(); const writer = new FileArtifactWriter(dir, dir);
	const [one, two] = await Promise.all([writer.write("one", "bash"), writer.write("two", "bash")]);
	assert.notEqual(one, two); assert.equal(await readFile(join(dir, one), "utf8"), "one");
});

test("inspection bounds ranges, reports omitted matches, and rejects escapes", async () => {
	const dir = await temp(); const writer = new FileArtifactWriter(dir, dir);
	const name = await writer.write(Array.from({ length: 130 }, (_, i) => `hit ${i} ${"x".repeat(20)}`).join("\n"), "bash");
	const search = await inspectToolOutput(dir, config, { path: name, operation: "literal", query: "hit" });
	assert.ok(search.length <= config.maxInspectionChars); assert.match(search, /Additional matches omitted: \d+/);
	const chars = await inspectToolOutput(dir, config, { path: name, operation: "characters", start: 1, end: 1000 });
	assert.ok(chars.length <= config.maxInspectionChars);
	const relativePath = `.pi/artifacts/tool-output/${name}`;
	const cwd = await temp();
	const nested = join(cwd, ".pi", "artifacts", "tool-output");
	await mkdir(nested, { recursive: true });
	await writeFile(join(nested, name), "shown path works");
	assert.equal(await inspectToolOutput(nested, config, { path: relativePath, operation: "head" }, cwd), "shown path works");
	await assert.rejects(() => inspectToolOutput(dir, config, { path: "../secret.log", operation: "head" }));
	await writeFile(join(dir, "outside"), "secret");
	const link = "tool-output-bash-00000000-0000-0000-0000-000000000000.log";
	await symlink(join(dir, "outside"), join(dir, link));
	await assert.rejects(() => inspectToolOutput(dir, config, { path: link, operation: "head" }));
});

test("configuration rejects unknown and inconsistent values", async () => {
	assert.throws(() => validateConfig({ extra: true }), /unknown/);
	assert.throws(() => mergeConfig({ maxChars: 511 }), /at least 512/);
	assert.throws(() => mergeConfig({ maxChars: 512, headChars: 300, tailChars: 300 }), /must not exceed/);
});

test("trusted project configuration overrides global configuration", async () => {
	const home = await temp(); const cwd = await temp();
	await mkdir(join(home, ".pi", "agent"), { recursive: true }); await mkdir(join(cwd, ".pi"), { recursive: true });
	await writeFile(join(home, ".pi", "agent", "tool-output-truncation.json"), JSON.stringify({ maxChars: 700, headChars: 200, tailChars: 200 }));
	await writeFile(join(cwd, ".pi", "tool-output-truncation.json"), JSON.stringify({ maxChars: 800 }));
	assert.equal((await loadConfig(cwd, true, home)).maxChars, 800);
	assert.equal((await loadConfig(cwd, false, home)).maxChars, 700);
});

