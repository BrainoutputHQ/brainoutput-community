// SPDX-License-Identifier: Apache-2.0
// Deterministic work evidence: the diff and the test exit code are what the reviewer judges.
// The cases below are the real failure modes observed against OpenCode 1.18.7 — a headless run
// that exits 0 having written nothing, and a run pointed at the wrong project by a stale $PWD.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectDiff, detectTestCommand, runTests, detectNoWork, collectWorkEvidence, testEvidenceText, DIFF_MAX_BYTES } from "./work-evidence.mjs";

const dirs = [];
function repo({ withTests = false } = {}) {
  const d = mkdtempSync(join(tmpdir(), "bo-eviterm-"));
  dirs.push(d);
  mkdirSync(join(d, "src"), { recursive: true });
  writeFileSync(join(d, "src", "existing.js"), "export const a = 1;\n");
  writeFileSync(join(d, "package.json"), JSON.stringify({ name: "t", type: "module",
    ...(withTests ? { scripts: { test: "node --test" } } : {}) }));
  execFileSync("git", ["-C", d, "init", "-q"]);
  execFileSync("git", ["-C", d, "add", "-A"]);
  execFileSync("git", ["-C", d, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "pre"]);
  return d;
}
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

test("collectDiff shows a NEW file's content — untracked work is reviewable, not invisible", () => {
  const d = repo();
  writeFileSync(join(d, "src", "added.js"), "export const brandNew = 42;\n");
  const diff = collectDiff({ workspace: d });
  assert.equal(diff.available, true);
  assert.equal(diff.empty, false);
  assert.ok(diff.text.includes("NEW FILE: src/added.js"), "names the new file");
  assert.ok(diff.text.includes("brandNew = 42"), "carries its actual content");
  assert.ok(diff.files.includes("src/added.js"));
});

test("collectDiff shows a MODIFIED file as a real diff", () => {
  const d = repo();
  writeFileSync(join(d, "src", "existing.js"), "export const a = 999;\n");
  const diff = collectDiff({ workspace: d });
  assert.ok(diff.text.includes("-export const a = 1;"), "the removed line");
  assert.ok(diff.text.includes("+export const a = 999;"), "the added line");
  assert.equal(diff.empty, false);
});

test("collectDiff on an UNTOUCHED workspace is empty — the evidence of no work", () => {
  const diff = collectDiff({ workspace: repo() });
  assert.equal(diff.empty, true);
  assert.equal(diff.text, "");
  assert.deepEqual(diff.files, []);
});

test("collectDiff ignores the adapter's own opencode.json (config is not the worker's work)", () => {
  const d = repo();
  writeFileSync(join(d, "opencode.json"), '{"permission":{"edit":"allow"}}');
  const diff = collectDiff({ workspace: d });
  assert.equal(diff.empty, true, "a workspace whose only change is the injected config did no work");
  assert.ok(!diff.files.includes("opencode.json"));
});

test("collectDiff truncation is DECLARED, never silent", () => {
  const d = repo();
  writeFileSync(join(d, "src", "big.js"), "// x".repeat(40000));
  const diff = collectDiff({ workspace: d, maxBytes: 500 });
  assert.equal(diff.truncated, true);
  assert.ok(diff.text.length <= 500 + 200, "bounded");
  assert.ok(/TRUNCATED/.test(diff.text) && /INCOMPLETE/.test(diff.text), "the reviewer is told the evidence is partial");
});

test("collectDiff on a non-repo path reports unavailable rather than pretending it is empty", () => {
  const diff = collectDiff({ workspace: join(tmpdir(), "bo-not-a-repo-xyz") });
  assert.equal(diff.available, false);
});

test("detectTestCommand finds real tests and refuses the npm placeholder", () => {
  assert.deepEqual(detectTestCommand(repo({ withTests: true })), { cmd: "npm", args: ["test", "--silent"] });
  const bare = mkdtempSync(join(tmpdir(), "bo-evit-bare-")); dirs.push(bare);
  mkdirSync(join(bare, "test"), { recursive: true });
  writeFileSync(join(bare, "test", "x.test.js"), "");
  assert.deepEqual(detectTestCommand(bare), { cmd: "node", args: ["--test"] }, "bare --test: a directory arg would die as a module path");
  const d = mkdtempSync(join(tmpdir(), "bo-evit-ph-")); dirs.push(d);
  writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
  assert.equal(detectTestCommand(d), null, "the placeholder script proves nothing");
  assert.equal(detectTestCommand(join(tmpdir(), "bo-nope-xyz")), null);
});

// Explicit `node --test` rather than the detected `npm test`: identical exit-code semantics
// without the npm bootstrap, so this file stays cheap and never slows the rest of the suite.
const NODE_TEST = { cmd: "node", args: ["--test"] };

// Exit-code semantics are proven with the cheapest possible child (~50ms). A full `node --test`
// spawn per assertion measurably slows the PARALLEL suite and pushes other files past their
// stage-retry threshold — one real suite run is exercised in the integration test below instead.
test("runTests reports the REAL exit code — green and red are both honest", () => {
  const d = repo({ withTests: true });
  const green = runTests({ workspace: d, command: { cmd: "node", args: ["-e", "console.log('all good')"] } });
  assert.equal(green.ran, true);
  assert.equal(green.exitCode, 0);
  assert.equal(green.passed, true);
  assert.match(green.output, /all good/, "captures output for the reviewer");

  const red = runTests({ workspace: d, command: { cmd: "node", args: ["-e", "console.error('boom');process.exit(1)"] } });
  assert.equal(red.passed, false, "a failing suite is never reported as passing");
  assert.equal(red.exitCode, 1);
  assert.match(red.output, /boom/, "the failure output reaches the reviewer");
});

test("runTests strips NODE_TEST_CONTEXT — an inherited runner context makes failures exit 0", async () => {
  const { cleanTestEnv } = await import("./work-evidence.mjs");
  const e = cleanTestEnv({ PATH: "/usr/bin", NODE_TEST_CONTEXT: "child-v8", NODE_OPTIONS: "--x", KEEP: "1" });
  assert.equal(e.NODE_TEST_CONTEXT, undefined, "the child must not inherit the runner context");
  assert.equal(e.NODE_OPTIONS, undefined);
  assert.equal(e.KEEP, "1", "unrelated env is preserved");
});

test("runTests reports ran:false when there is nothing to run — never fakes green", () => {
  const r = runTests({ workspace: repo() });
  assert.equal(r.ran, false);
  assert.equal(r.passed, false, "no tests is NOT a pass");
  assert.equal(testEvidenceText(r), null, "and contributes no evidence block");
});

test("detectNoWork catches the exit-0-did-nothing run: permission rejection", () => {
  const g = detectNoWork({ exitCode: 0, changedFiles: [],
    log: "Error: The user rejected permission to use this specific tool call." });
  assert.equal(g.noWork, true);
  assert.match(g.reason, /REJECTED a tool permission/);
});

test("detectNoWork catches the stale-$PWD wrong-project run", () => {
  const g = detectNoWork({ exitCode: 0, changedFiles: [],
    log: "No AGENTS.md exists in this workspace (searched recursively), so there were no conventions." });
  assert.equal(g.noWork, true);
  assert.match(g.reason, /WRONG project directory/);
});

test("detectNoWork: exit 0 with zero changed files is NOT success", () => {
  const g = detectNoWork({ exitCode: 0, changedFiles: [], log: "all good, nothing to change" });
  assert.equal(g.noWork, true);
  assert.match(g.reason, /changed NO files/);
});

test("detectNoWork passes a run that actually changed something", () => {
  const g = detectNoWork({ exitCode: 0, changedFiles: ["src/a.js"], log: "wrote src/a.js" });
  assert.equal(g.noWork, false);
  assert.equal(g.reason, null);
});

test("detectNoWork surfaces a non-zero exit", () => {
  assert.match(detectNoWork({ exitCode: 137, changedFiles: ["a.js"] }).reason, /exited 137/);
});

test("collectWorkEvidence skips the test run when there was no work (no wasted execution)", () => {
  const d = repo({ withTests: true });
  const ev = collectWorkEvidence({ workspace: d, exitCode: 0, changedFiles: [], log: "" });
  assert.equal(ev.guard.noWork, true);
  assert.equal(ev.tests.ran, false, "nothing to test when nothing was written");
  assert.equal(ev.diff.empty, true);
});

test("collectWorkEvidence bundles a real diff + real tests for a run that did work", () => {
  const d = repo({ withTests: true });
  mkdirSync(join(d, "test"), { recursive: true });
  writeFileSync(join(d, "src", "added.js"), "export const v = 7;\n");
  writeFileSync(join(d, "test", "ok.test.js"),
    'import test from "node:test";import assert from "node:assert/strict";test("t",()=>{assert.equal(1,1)});\n');
  const ev = collectWorkEvidence({ workspace: d, exitCode: 0, changedFiles: ["src/added.js"], log: "", testCommand: NODE_TEST });
  assert.equal(ev.guard.noWork, false);
  assert.ok(ev.diff.text.includes("v = 7"));
  assert.equal(ev.tests.ran, true);
  assert.equal(ev.tests.passed, true);
  const ev_text = testEvidenceText(ev.tests);
  assert.match(ev_text, /exit code: 0 \(PASSED\)/, "the reviewer sees the real exit code");
});
