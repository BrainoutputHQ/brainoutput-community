#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// TIER 0 — the mechanical review gate. Plain code, zero model calls, zero tokens.
//
// Why this exists: a real CTO-review run was observed spending an entire model call to establish
// "the diff is one file" and "no .mjs was modified". Those are shell one-liners. Paying a model to
// run `git diff` is the same category of waste as asking an LLM to perform a topological sort.
//
// The split this enforces:
//   tier 0  did the work happen, and is it in scope?   <- HERE. code. free.
//   tier 1  is it right?                               <- a generic reviewer, on the evidence below
//   tier 2  is it right IN THIS DOMAIN?                <- escalation only (security/money/legal/...)
//
// Run this BEFORE waking any reviewer. A tier-0 failure means no model should be woken at all:
// there is nothing for judgement to add to "the branch is empty" or "it edited files it was told
// not to touch". A tier-0 pass produces an evidence block the reviewer consumes verbatim, so it
// spends its call on judgement instead of re-deriving facts.
//
// Exit codes:  0 = pass (wake the reviewer)   1 = mechanical fail (do NOT wake a reviewer)
//              2 = usage/setup error
//
// Usage:
//   node tools/tier0.mjs --branch <ref> [--base main] [--repo .]
//                        [--expect "docs/**,*.md"] [--forbid "*.mjs,.gitignore"]
//                        [--no-tests] [--json]
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { runTests, detectTestCommand, headTailEvidence, DIFF_MAX_BYTES } from "../work-evidence.mjs";

// ── args ────────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const flag = (name) => argv.includes(`--${name}`);

const REPO = arg("repo", process.cwd());
const BRANCH = arg("branch");
const BASE = arg("base", "main");
const EXPECT = (arg("expect") || "").split(",").map((s) => s.trim()).filter(Boolean);
const FORBID = (arg("forbid") || "").split(",").map((s) => s.trim()).filter(Boolean);
const RUN_TESTS = !flag("no-tests");
const AS_JSON = flag("json");

if (!BRANCH) {
  console.error("tier0: --branch is required.\n  node tools/tier0.mjs --branch <ref> [--base main] [--expect \"docs/**\"] [--forbid \"*.mjs\"]");
  process.exit(2);
}
if (!existsSync(`${REPO}/.git`)) {
  console.error(`tier0: not a git repository: ${REPO}`);
  process.exit(2);
}

const git = (args) => execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

// ── glob matching ───────────────────────────────────────────────────────────────────────────────
// Deliberately tiny: `**` spans separators, `*` does not, `?` is one char. Enough for path rules
// like "docs/**" or "*.mjs" without taking a dependency, and it is anchored so "docs/x" cannot be
// matched by a pattern meant for "src/docs/x".
function globToRe(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") { re += ".*"; i++; if (glob[i + 1] === "/") i++; }
      else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}
const matchesAny = (path, globs) => globs.some((g) => globToRe(g).test(path) || globToRe(g).test(`./${path}`));

// ── checks ──────────────────────────────────────────────────────────────────────────────────────
const checks = [];
const add = (name, ok, detail) => { checks.push({ name, ok, detail }); return ok; };

// 1. both refs must resolve — a typo'd branch must fail loudly, never silently pass.
let baseSha, branchSha;
try { baseSha = git(["rev-parse", "--verify", `${BASE}^{commit}`]).trim(); }
catch { add("base ref resolves", false, `base ref "${BASE}" does not exist`); }
try { branchSha = git(["rev-parse", "--verify", `${BRANCH}^{commit}`]).trim(); }
catch { add("branch ref resolves", false, `branch ref "${BRANCH}" does not exist`); }

let changed = [];
let diffText = "";
let truncated = false;

if (baseSha && branchSha) {
  add("base ref resolves", true, `${BASE} = ${baseSha.slice(0, 8)}`);
  add("branch ref resolves", true, `${BRANCH} = ${branchSha.slice(0, 8)}`);

  // 2. work actually happened. An empty diff is the "exit 0 having done nothing" case — the single
  //    most common silent failure, and no reviewer should ever be asked to judge it.
  // TWO dots, deliberately. `A...B` (three dots) diffs from the MERGE BASE, so it reports every
  // file the branch touched since it diverged — including files whose final state now matches main
  // exactly. That produces false scope violations on any branch cut before an unrelated commit
  // landed (observed immediately: a branch flagged for .gitignore whose net effect on it is zero).
  // Tier 0's question is "what will LAND on main if this merges", and that is `A..B`.
  changed = git(["diff", "--name-only", `${BASE}..${BRANCH}`]).split("\n").filter(Boolean);
  add("the branch changed something", changed.length > 0,
    changed.length ? `${changed.length} file(s): ${changed.join(", ")}` : "EMPTY DIFF — no work was done on this branch");

  // 3. scope. `--expect` is the allow-list; anything outside it is an out-of-scope change. This is
  //    exactly the finding a model spent a full call producing on 2026-08-05.
  if (EXPECT.length && changed.length) {
    const outside = changed.filter((f) => !matchesAny(f, EXPECT));
    add("every changed file is in scope", outside.length === 0,
      outside.length ? `OUT OF SCOPE (expected only ${EXPECT.join(", ")}): ${outside.join(", ")}` : `all within ${EXPECT.join(", ")}`);
  }

  // 4. forbidden paths — a hard deny-list, independent of the allow-list.
  if (FORBID.length && changed.length) {
    const hit = changed.filter((f) => matchesAny(f, FORBID));
    add("no forbidden path touched", hit.length === 0,
      hit.length ? `FORBIDDEN: ${hit.join(", ")}` : `none of ${FORBID.join(", ")}`);
  }

  const raw = git(["diff", `${BASE}..${BRANCH}`]);
  const ev = headTailEvidence(raw, DIFF_MAX_BYTES, "diff");
  diffText = ev.text ?? ev;
  truncated = Boolean(ev.truncated);
}

// 5. tests. The REAL exit code from the repo's own suite — never an assumption that green is likely.
let tests = { ran: false, passed: false, exitCode: null, output: "", command: null };
if (RUN_TESTS && baseSha && branchSha) {
  const cmd = detectTestCommand(REPO);
  if (!cmd) add("tests", true, "no runnable test command detected — not a failure, but nothing was proven either");
  else {
    tests = runTests({ workspace: REPO, command: cmd });
    add("tests pass", tests.passed, `${tests.command} -> exit ${tests.exitCode}`);
  }
}

// ── verdict ─────────────────────────────────────────────────────────────────────────────────────
const failed = checks.filter((c) => !c.ok);
const pass = failed.length === 0;
const verdict = {
  tier: 0, pass, base: BASE, branch: BRANCH,
  changedFiles: changed,
  checks,
  tests: { ran: tests.ran, passed: tests.passed, exitCode: tests.exitCode, command: tests.command },
  diffTruncated: truncated,
  // What tier 1 should spend its call on. When tier 0 fails there is nothing to judge.
  reviewerGuidance: pass
    ? "Mechanical facts below are ESTABLISHED — do not re-derive them. Spend your judgement on whether the change is CORRECT and HONEST."
    : "TIER 0 FAILED — do not wake a reviewer. Send this back to the worker with the failing checks.",
};

if (AS_JSON) { console.log(JSON.stringify({ ...verdict, diff: diffText }, null, 2)); process.exit(pass ? 0 : 1); }

console.log(`\n=== TIER 0 — mechanical gate (no model, no tokens) ===`);
console.log(`${BASE} (${(baseSha || "?").slice(0, 8)})  ->  ${BRANCH} (${(branchSha || "?").slice(0, 8)})\n`);
for (const c of checks) console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name}\n        ${c.detail}`);
console.log(`\n  VERDICT: ${pass ? "PASS — wake the reviewer" : "FAIL — do NOT wake a reviewer"}`);
console.log(`  ${verdict.reviewerGuidance}\n`);
if (pass && diffText) {
  console.log("=== DIFF (evidence for tier 1) ===");
  console.log(diffText);
}
process.exit(pass ? 0 : 1);
