#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// tools/oc-reviewer-only-probe.mjs — completes the reviewer half of the dogfood evidence chain
// using the REAL diff + REAL test evidence already captured by tools/oc-server-direct-probe.mjs
// (run3-direct.log), without re-running the (slow, ~180s+) coding turn again. Same reviewer
// prompt/parse path web-server.mjs's reportOrReviewSpineTask uses (review-tasks.mjs), same model
// (brainoutput-local/coder over the GB10 gateway) — just a longer timeout budget so we actually
// observe the verdict instead of being killed by an outer shell timeout.
import { chatCompletion } from "/tmp/bo-dogfood-wt/adapters.mjs";
import { reviewTaskPrompt, parseTaskReview } from "/tmp/bo-dogfood-wt/review-tasks.mjs";

const objective = "Create a tiny Node.js ESM utility: write add-lib.mjs exporting a function " +
  "add(a, b) that returns a + b, and write test/add.test.mjs using node:test + node:assert " +
  "asserting add(2, 3) === 5 and add(-1, 1) === 0.";
const criteria = [
  "add-lib.mjs exists and exports a function add(a,b) that returns a+b",
  "test/add.test.mjs exists, uses node:test, and asserts add(2,3)===5 and add(-1,1)===0",
];
// Verbatim from run3-direct.log's real evidence collector output.
const diff = `[diff size: 415 chars, 17 lines]
--- NEW FILE: add-lib.mjs ---
[file size: 46 chars, 4 lines]
export function add(a, b) {
  return a + b;
}


--- NEW FILE: test/add.test.mjs ---
[file size: 239 chars, 9 lines]
import { add } from '../add-lib.mjs';
import { test, expect } from 'node:test';
import assert from 'node:assert';

test('add returns sum of two numbers', () => {
  assert.strictEqual(add(2, 3), 5);
  assert.strictEqual(add(-1, 1), 0);
});`;
const testEvidence = `command: node --test
exit code: 1 (FAILED)

TAP version 13
# file:///tmp/oc-server-direct-probe-root-w4wy57/ws/test/add.test.mjs:2
# import { test, expect } from 'node:test';
#                ^^^^^^
# SyntaxError: The requested module 'node:test' does not provide an export named 'expect'
not ok 1 - test/add.test.mjs
1..1
# tests 1
# pass 0
# fail 1`;

const t0 = Date.now();
const prompt = reviewTaskPrompt({ objective, acceptanceCriteria: criteria,
  resultSummary: "wrote add-lib.mjs, test/add.test.mjs", artifacts: ["opencode:add-lib.mjs,test/add.test.mjs"],
  diff, testEvidence });

console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] calling the REAL reviewer model (brainoutput-local/coder) ...`);
const rr = await chatCompletion({
  endpoint: "http://192.168.1.14:9000/v1/chat/completions", model: "coder",
  prompt, maxTokens: 1600, timeoutMs: 150000,
});
console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] reviewer responded (${rr.tokens} tokens)`);
console.log("\n--- raw reviewer output ---");
console.log(rr.content);
const parsed = parseTaskReview(rr.content, { acceptanceCriteria: criteria, diag: {} });
console.log("\n--- parsed review verdict (parseTaskReview) ---");
console.log(JSON.stringify(parsed, null, 2));
