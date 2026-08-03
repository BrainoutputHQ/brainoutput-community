// SPDX-License-Identifier: Apache-2.0
// BrainOutput Community Edition — DETERMINISTIC work evidence (2026-08-03).
//
// Why this exists: the per-task reviewer used to judge the worker's own prose ("wrote a.js, b.js")
// against the acceptance criteria. A worker can report success having produced nothing — a headless
// OpenCode run whose write permission resolves to "ask" auto-REJECTS it and still exits 0. Prose is
// a CLAIM; the diff and the test exit code are EVIDENCE. Both are produced here by plain code at
// zero token cost, then handed to the reviewer as its primary material.
//
// Everything is bounded and truncation is always DECLARED — a reviewer that cannot see the whole
// change must know that, so it fails closed instead of passing on a partial read. Over-cap diffs
// are bounded HEAD+TAIL (task-pm-21): a plain head-cut amputated the end of the evidence and a
// reviewer failed real, present work it could not see; head+tail keeps both ends visible.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const DIFF_MAX_BYTES = 12000;      // bounded reviewer context
export const TEST_TAIL_BYTES = 3000;      // enough for a node:test summary + the first failures
const UNTRACKED_FILE_MAX = 4000;

const git = (ws, args) => execFileSync("git", ["-C", ws, ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });

/** Bounded, honest truncation: never silently drops evidence — the marker tells the reviewer. */
function clamp(text, max, label) {
  const s = String(text || "");
  if (s.length <= max) return { text: s, truncated: false };
  return { text: `${s.slice(0, max)}\n… [TRUNCATED — ${label} exceeded ${max} chars; evidence is INCOMPLETE]`, truncated: true };
}

// Headroom reserved for the elision marker + the metadata line, so head+tail stays within max.
const HT_RESERVE = 160;

/**
 * Truncation-AWARE bounding (task-pm-21): a head-cut diff used to amputate the TAIL of the
 * evidence — a reviewer then failed a real criterion ("the diff is TRUNCATED mid-way through
 * the second room card… I cannot confirm the page contains 3 rooms") although the file on disk
 * was complete. When `text` exceeds `max`, keep the FIRST lines AND the LAST lines (each ~half
 * the budget, aligned to line boundaries — no half-lines) joined by an explicit elision marker
 * carrying the REAL counts, so head (file start) and tail (file end) both reach the reviewer.
 * The last line of the original text is NEVER silently dropped. Every non-empty result carries
 * an unconditional metadata line with the true total size (chars + lines); under-cap text gets
 * NO elision marker and its content stays byte-identical.
 */
export function headTailEvidence(text, max, label = "diff") {
  const s = String(text || "");
  if (!s) return { text: "", truncated: false };
  const meta = `[${label} size: ${s.length} chars, ${s.split("\n").length} lines]`;
  if (s.length <= max) return { text: `${meta}\n${s}`, truncated: false };
  const budget = Math.max(2, max - HT_RESERVE);
  const headBudget = Math.ceil(budget / 2), tailBudget = Math.floor(budget / 2);
  const lines = s.split("\n");
  let head = "", hi = 0;
  for (const l of lines) {
    const next = head ? head.length + 1 + l.length : l.length;
    if (next > headBudget) break;
    head = head ? `${head}\n${l}` : l; hi++;
  }
  // A single over-long line (a no-newline blob) cannot align to a line boundary — bound it by chars.
  if (hi === 0 && lines.length) { head = lines[0].slice(0, headBudget); hi = 1; }
  let tail = "";
  for (let i = lines.length - 1; i >= hi; i--) {
    const l = lines[i];
    const next = tail ? tail.length + 1 + l.length : l.length;
    if (next > tailBudget) { if (!tail) tail = l.slice(-tailBudget); break; }
    tail = tail ? `${l}\n${tail}` : l;
  }
  if (!tail && s.length > head.length) tail = s.slice(-tailBudget);   // single-line blob: keep its end too
  const elided = Math.max(0, s.length - head.length - tail.length);
  const marker = `\n… [TRUNCATED head+tail — elided ${elided} of ${s.length} total chars; the middle is omitted, evidence is INCOMPLETE; the file is complete on disk] …\n`;
  return { text: `${meta}\n${head}${marker}${tail}`, truncated: true };
}

/**
 * The real change the worker made, read from the workspace git repo (the adapter git-inits it and
 * makes a "pre" commit before the run, so `diff HEAD` is exactly this task's work).
 * Returns { text, files, truncated, empty } — `empty:true` means the worker changed NOTHING.
 */
export function collectDiff({ workspace, maxBytes = DIFF_MAX_BYTES } = {}) {
  const ws = String(workspace || "");
  if (!ws || !existsSync(join(ws, ".git"))) return { text: "", files: [], truncated: false, empty: true, available: false };
  let tracked = "", untrackedNames = [];
  try { tracked = git(ws, ["diff", "HEAD", "--", ".", ":(exclude)opencode.json"]); } catch { tracked = ""; }
  try {
    untrackedNames = git(ws, ["ls-files", "--others", "--exclude-standard"]).split("\n")
      .filter(Boolean).filter((f) => f !== "opencode.json" && !f.startsWith(".oc-iso"));
  } catch { untrackedNames = []; }
  // Untracked files have no diff — show their content so "new file" work is reviewable too.
  // Head+tail per file (task-pm-21): a silent head-cut at the per-file cap is exactly how a
  // 6KB room-page lost its 3rd room + footer before the reviewer ever saw it.
  const newFiles = [];
  for (const f of untrackedNames) {
    let content = "";
    try { content = headTailEvidence(readFileSync(join(ws, f), "utf8"), UNTRACKED_FILE_MAX, "file").text; }
    catch { content = "(unreadable)"; }
    newFiles.push(`--- NEW FILE: ${f} ---\n${content}`);
  }
  const body = [tracked.trim(), newFiles.join("\n\n").trim()].filter(Boolean).join("\n\n");
  const changed = [...new Set([
    ...tracked.split("\n").filter((l) => l.startsWith("+++ b/")).map((l) => l.slice(6)),
    ...untrackedNames,
  ])].filter(Boolean);
  const { text, truncated } = headTailEvidence(body, maxBytes, "diff");
  return { text, files: changed, truncated, empty: !body, available: true };
}

/**
 * The repo's own test command, detected — never guessed into existence. Returns null when the
 * workspace has no runnable tests, so the caller reports "no tests" honestly instead of faking green.
 */
export function detectTestCommand(workspace) {
  const ws = String(workspace || "");
  if (!ws || !existsSync(ws)) return null;
  const pkgPath = join(ws, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      const t = pkg?.scripts?.test;
      // `npm test` on the default placeholder script proves nothing — treat it as no tests.
      if (t && !/no test specified/i.test(t)) return { cmd: "npm", args: ["test", "--silent"] };
    } catch {}
  }
  const testDir = join(ws, "test");
  if (existsSync(testDir)) {
    try {
      if (readdirSync(testDir).some((f) => f.endsWith(".test.js") || f.endsWith(".test.mjs")))
        // Bare `--test` (auto-discovery). NOT `--test test/` — on Node 22 a directory argument is
        // resolved as a MODULE and the run dies with "Cannot find module", which would report a
        // non-zero exit for every task and fail honest work.
        return { cmd: "node", args: ["--test"] };
    } catch {}
  }
  return null;
}

/**
 * Strip the Node test-runner context from the child environment. This is load-bearing, not
 * hygiene: with `NODE_TEST_CONTEXT` inherited, a child `node --test` whose assertions FAIL exits
 * **0** — the reviewer would be handed fake-green evidence, which is the exact lie this module
 * exists to remove. Also drops NODE_OPTIONS, which can inject reporters that change the exit code.
 */
export function cleanTestEnv(base = process.env) {
  const env = { ...base };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  return env;
}

/**
 * Run the workspace's tests and capture the REAL exit code. Deterministic, zero model calls.
 * Returns { ran, exitCode, passed, output, command } — `ran:false` when there is nothing to run.
 * Note: this executes code produced by the worker, inside the same sandboxed workspace the coding
 * runtime already has bash access to — it widens no trust boundary.
 */
export function runTests({ workspace, command = null, timeoutMs = 120000 } = {}) {
  const ws = String(workspace || "");
  const c = command || detectTestCommand(ws);
  if (!c) return { ran: false, exitCode: null, passed: false, output: "", command: null };
  let out = "", code = 0;
  try {
    out = execFileSync(c.cmd, c.args, { cwd: ws, encoding: "utf8", timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], env: cleanTestEnv() });
  } catch (e) {
    // Non-zero exit, timeout, or missing binary — all are honest failures, never swallowed.
    code = typeof e.status === "number" ? e.status : 1;
    out = `${e.stdout || ""}${e.stderr || ""}` || String(e.message || e);
  }
  const tail = clamp(String(out).slice(-TEST_TAIL_BYTES * 2), TEST_TAIL_BYTES, "test output");
  return { ran: true, exitCode: code, passed: code === 0, output: tail.text, command: `${c.cmd} ${c.args.join(" ")}` };
}

/**
 * The exit-0-did-nothing guard. A headless coding run can return 0 having written nothing —
 * OpenCode auto-rejects a permission that resolves to "ask", and a stale $PWD can point the agent
 * at the wrong project entirely ("no AGENTS.md in this workspace … nothing to change"). Both look
 * like success. This turns them into an explicit, deterministic failure BEFORE any reviewer token
 * is spent. Returns { noWork, reason } — reason is null when the run genuinely did something.
 */
export function detectNoWork({ exitCode = 0, changedFiles = [], log = "" } = {}) {
  const text = String(log || "");
  const files = Array.isArray(changedFiles) ? changedFiles.filter(Boolean) : [];
  if (/rejected permission to use this specific tool call/i.test(text))
    return { noWork: true, reason: "the coding runtime REJECTED a tool permission — the run exited without writing (check the workspace permission grant)" };
  if (/no AGENTS\.md exists in this workspace/i.test(text) && !files.length)
    return { noWork: true, reason: "the coding runtime resolved the WRONG project directory (stale $PWD) — it inspected another tree and changed nothing" };
  if (exitCode !== 0) return { noWork: true, reason: `the coding runtime exited ${exitCode}` };
  if (!files.length) return { noWork: true, reason: "the run reported success but changed NO files" };
  return { noWork: false, reason: null };
}

/**
 * Assemble the reviewer's evidence bundle for one finished task. Pure orchestration over the
 * deterministic collectors above; costs zero tokens.
 */
export function collectWorkEvidence({ workspace, exitCode = 0, changedFiles = [], log = "",
                                      runTestsToo = true, testCommand = null, timeoutMs = 120000 } = {}) {
  const diff = collectDiff({ workspace });
  const guard = detectNoWork({ exitCode, changedFiles: changedFiles.length ? changedFiles : diff.files, log });
  // No work → no point running tests or a reviewer; the caller blocks on the deterministic reason.
  const tests = guard.noWork || !runTestsToo
    ? { ran: false, exitCode: null, passed: false, output: "", command: null }
    : runTests({ workspace, command: testCommand, timeoutMs });
  return { diff, tests, guard };
}

/** Render the test result as the reviewer's TEST EVIDENCE block — or null when nothing ran. */
export function testEvidenceText(tests) {
  if (!tests || !tests.ran) return null;
  return `command: ${tests.command}\nexit code: ${tests.exitCode} (${tests.passed ? "PASSED" : "FAILED"})\n\n${tests.output}`;
}
