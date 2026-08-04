#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// oc-chat-probe.mjs
//
// Reference driver for opencode-chat.mjs (the chat-model-picker's OpenCode-routed chat answer) —
// measures REAL latency end to end against a REAL local model, through the ACTUAL shipped code
// path (runOpenCodeChatAnswer), and prints a side-by-side comparison against the existing direct
// chat adapter (adapters.mjs's chatCompletion) on the SAME connection. Mirrors tools/oc-api-probe.mjs
// in spirit: zero test-framework dependency, real HTTP, real process, hard assertions, honest
// numbers — not a mock of any kind.
//
// Requires a real `opencode` binary (~/.opencode/bin/opencode by default) AND a real OpenAI-
// compatible model endpoint (default: a local ollama at 127.0.0.1:11434 serving
// "qwen2.5-7b-32k:latest" — override via OC_CHAT_PROBE_* env below). This is NOT part of `npm test`
// (it depends on real local infra that a hermetic suite must not assume) — run it by hand:
//   node tools/oc-chat-probe.mjs
//
// Env overrides:
//   OC_CHAT_PROBE_ENDPOINT   OpenAI-compatible chat/completions endpoint
//   OC_CHAT_PROBE_MODEL      model name at that endpoint
//   OC_CHAT_PROBE_PROVIDER   a label only (used to name the opencode provider block)

import { rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOpenCodeChatAnswer, shutdownAllChatServers } from "../opencode-chat.mjs";
import { chatCompletion } from "../adapters.mjs";
import { OPENCODE_BIN } from "../opencode-adapter.mjs";

const ENDPOINT = process.env.OC_CHAT_PROBE_ENDPOINT || "http://127.0.0.1:11434/v1/chat/completions";
const MODEL = process.env.OC_CHAT_PROBE_MODEL || "qwen2.5-7b-32k:latest";
const PROVIDER = process.env.OC_CHAT_PROBE_PROVIDER || "probe-local";

const CONNECTION = { id: "probe-conn", kind: "byok", provider: PROVIDER, model: MODEL,
  endpoint: ENDPOINT, costSource: "local-compute", funder: "local", contextSize: 32768 };

const QUESTIONS = [
  "What is the capital of France? Answer in one short sentence.",
  "What is the capital of Italy? Answer in one short sentence.",
  "What is the capital of Spain? Answer in one short sentence.",
];

function assert(cond, msg) { if (!cond) { console.error(`ASSERTION FAILED: ${msg}`); process.exitCode = 1; throw new Error(msg); } }

async function timeIt(label, fn) {
  const t0 = Date.now();
  const result = await fn();
  const ms = Date.now() - t0;
  console.log(`${label}: ${ms}ms`);
  return { result, ms };
}

async function main() {
  if (!existsSync(OPENCODE_BIN)) {
    console.error(`opencode binary not found at ${OPENCODE_BIN} — this probe needs a real install. Skipping.`);
    return;
  }
  console.log(`Probing against endpoint=${ENDPOINT} model=${MODEL}\n`);

  // ── 1 · the DIRECT chat adapter (today's path — what every chat reply uses with the flag off) ──
  console.log("── direct adapter (adapters.mjs chatCompletion) ──");
  const direct = [];
  for (const q of QUESTIONS) {
    const { result, ms } = await timeIt(`direct: "${q.slice(0, 40)}…"`, () =>
      chatCompletion({ endpoint: ENDPOINT, model: MODEL, prompt: q, maxTokens: 60, timeoutMs: 60000 }));
    assert(result.content && result.content.trim().length > 0, "direct adapter returned no content");
    direct.push(ms);
  }

  // ── 2 · OpenCode-routed (BO_CE_OPENCODE_SERVER=1 path — opencode-chat.mjs) ───────────────────────
  console.log("\n── OpenCode-routed (opencode-chat.mjs runOpenCodeChatAnswer) ──");
  const workspaceBase = join(tmpdir(), `oc-chat-probe-${Date.now()}`);
  const oc = [];
  for (const [i, q] of QUESTIONS.entries()) {
    const { result, ms } = await timeIt(`opencode ${i === 0 ? "(cold: boot+health+catalog+turn)" : "(warm server, new session)"}: "${q.slice(0, 40)}…"`,
      () => runOpenCodeChatAnswer({ connection: CONNECTION, prompt: q, workspaceBase, timeoutMs: 120000, approvedRoots: [workspaceBase] }));
    assert(result.ok, `opencode chat answer failed: ${result.reason}`);
    assert(result.output && result.output.trim().length > 0, "opencode chat answer returned no output");
    console.log(`   reply: ${JSON.stringify(result.output)}  tokens: ${JSON.stringify(result.tokensDetail)}`);
    oc.push(ms);
  }
  await shutdownAllChatServers();
  try { rmSync(workspaceBase, { recursive: true, force: true }); rmSync(`${workspaceBase}__oc_iso`, { recursive: true, force: true }); } catch { /* best effort */ }

  console.log("\n── summary ──");
  console.log(`direct adapter:      ${direct.map((x) => `${x}ms`).join(", ")}  (avg ${Math.round(direct.reduce((a, b) => a + b, 0) / direct.length)}ms)`);
  console.log(`opencode-routed:     ${oc.map((x) => `${x}ms`).join(", ")}  (cold turn 1, warm turns 2-3)`);
  console.log(`opencode / direct ratio (turn 1, cold): ${(oc[0] / direct[0]).toFixed(1)}x`);
  console.log(`opencode / direct ratio (turn 2+, warm server): ${(oc[1] / direct[1]).toFixed(1)}x`);
  console.log("\nALL ASSERTIONS PASSED.");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
