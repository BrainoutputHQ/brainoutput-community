#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// tools/oc-server-direct-probe.mjs — SUPPLEMENTARY probe (2026-08-04 dogfood pass).
//
// WHY THIS EXISTS: driving the real product HTTP loop (tools/oc-dogfood.mjs) found that every
// coding task launched through web-server.mjs with BO_CE_OPENCODE_SERVER=1 crashes before the
// model is ever called — opencode-adapter.mjs's runOpenCode() defaults `task` to `null`, and
// opencode-server.mjs's resolveRoutingDirectives() reads `task.skills` with NO null-guard (only
// a default *parameter*, which does not fire for an explicitly-passed `null`). See
// docs/DOGFOOD_2026-08-04.md for the full write-up and exact repro.
//
// This script does NOT modify any product file. It calls opencode-server.mjs's OWN exported
// runOpenCodeServer() directly, passing `task: {}` (a value the function's own default already
// implies is valid) instead of going through the broken web-server.mjs call sites. This answers
// one question ONLY: once that specific crash is not in the way, does the rest of the
// server-backed runtime (real session, real file writes, real git diff, live-session registry,
// review evidence) actually work? It does NOT re-verify the CE HTTP loop (already confirmed
// broken by oc-dogfood.mjs) and does NOT run inside the CE server process, so it cannot exercise
// GET /api/session/{id}/live (that route lives in web-server.mjs's own process/registry).
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

const { runOpenCodeServer } = await import(join(ROOT, "opencode-server.mjs"));
const { collectWorkEvidence, testEvidenceText } = await import(join(ROOT, "work-evidence.mjs"));
const { chatCompletion } = await import(join(ROOT, "adapters.mjs"));
const { reviewTaskPrompt, parseTaskReview } = await import(join(ROOT, "review-tasks.mjs"));

const t0 = Date.now();
const log = (...a) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(2)}s]`, ...a);

const WORKSPACES_ROOT = mkdtempSync(join(tmpdir(), "oc-server-direct-probe-root-"));
const WS = join(WORKSPACES_ROOT, "ws");
const connection = {
  provider: "brainoutput-local", model: "coder",
  endpoint: "http://192.168.1.14:9000/v1/chat/completions",
  funder: "local", costSource: "local-compute",
};

const objective = "Create a tiny Node.js ESM utility: write add-lib.mjs exporting a function " +
  "add(a, b) that returns a + b, and write test/add.test.mjs using node:test + node:assert " +
  "asserting add(2, 3) === 5 and add(-1, 1) === 0. Use the write tool to create the file(s) with " +
  "RELATIVE paths in the current directory, then stop.";

async function main() {
  log(`workspace: ${WS}`);
  log("calling runOpenCodeServer() directly with task:{} (bypassing the broken web-server.mjs call sites) ...");
  const oc = await runOpenCodeServer({
    connection, prompt: objective, workspace: WS, timeoutMs: 180000,
    requestTimeoutMs: 20000, modelCatalogTimeoutMs: 20000, registryTimeoutMs: 20000,
    approvedRoots: [WORKSPACES_ROOT],
    task: {}, // <-- the workaround: an explicit {} instead of the null the real call sites pass
    onSessionStart: (id) => log(`onSessionStart fired: ${id}`),
  });
  console.log("\n=== runOpenCodeServer() result ===");
  console.log(JSON.stringify({ ...oc, log: (oc.log || "").slice(-800) }, null, 2));

  const libPath = join(WS, "add-lib.mjs");
  const testPath = join(WS, "test", "add.test.mjs");
  console.log(`\nadd-lib.mjs exists: ${existsSync(libPath)}`);
  if (existsSync(libPath)) console.log(readFileSync(libPath, "utf8"));
  console.log(`test/add.test.mjs exists: ${existsSync(testPath)}`);
  if (existsSync(testPath)) console.log(readFileSync(testPath, "utf8"));

  console.log("\n=== collectWorkEvidence() — the SAME deterministic evidence collector the reviewer sees ===");
  const evidence = collectWorkEvidence({ workspace: WS, exitCode: oc.exitCode ?? 0, changedFiles: oc.changedFiles || [], log: oc.log || "" });
  console.log(JSON.stringify({ guard: evidence.guard, testsRan: evidence.tests.ran, testsPassed: evidence.tests.passed, testCommand: evidence.tests.command, diffAvailable: evidence.diff.available, diffEmpty: evidence.diff.empty }, null, 2));
  console.log("\n--- real diff/new-file evidence text (head) ---");
  console.log((evidence.diff.text || "").slice(0, 1500));
  console.log("\n--- real test evidence text ---");
  console.log(testEvidenceText(evidence.tests));

  if (!evidence.guard.noWork) {
    console.log("\n=== reviewer pass — a REAL model call judging the REAL diff + REAL test evidence ===");
    const criteria = [
      "add-lib.mjs exists and exports a function add(a,b) that returns a+b",
      "test/add.test.mjs exists, uses node:test, and asserts add(2,3)===5 and add(-1,1)===0",
    ];
    const prompt = reviewTaskPrompt({
      objective, acceptanceCriteria: criteria, resultSummary: oc.changedFiles?.length ? `wrote ${oc.changedFiles.join(", ")}` : "(no files)",
      artifacts: oc.changedFiles?.length ? [`opencode:${oc.changedFiles.join(",")}`] : [],
      diff: evidence.diff.available ? evidence.diff.text : null,
      testEvidence: testEvidenceText(evidence.tests),
    });
    const rr = await chatCompletion({ endpoint: connection.endpoint, model: connection.model, prompt, maxTokens: 1600, timeoutMs: 60000 });
    console.log("\n--- raw reviewer output ---");
    console.log(rr.content);
    const parsed = parseTaskReview(rr.content, { acceptanceCriteria: criteria, diag: {} });
    console.log("\n--- parsed review verdict ---");
    console.log(JSON.stringify(parsed, null, 2));
  } else {
    console.log(`\nno-work guard tripped (${evidence.guard.reason}) — reviewer would never be called (matches product's own deterministic gate)`);
  }
}

main()
  .catch((e) => { console.error("PROBE CRASHED:", e && e.stack ? e.stack : e); process.exitCode = 1; })
  .finally(() => { try { rmSync(WORKSPACES_ROOT, { recursive: true, force: true }); } catch {} });
