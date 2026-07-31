// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { healthCheckFree, pickFreeModel, toolProbeFree, freeConnection, FREE_CANDIDATES, FREE_PRIVACY_NOTE } from "./free-models.mjs";

// good: models that answer content · toolModels: models that answer with tool_calls (400 else)
const okFetch = (good = [], seen = [], toolModels = []) => async (url, opts) => {
  const body = JSON.parse(opts.body);
  const model = body.model;
  seen.push(model);
  if (body.tools) {
    if (!toolModels.includes(model)) return { ok: false, status: 400, json: async () => ({}) };
    return { ok: true, json: async () => ({ choices: [{ message: { tool_calls: [{ id: "c1", function: { name: "get_time" } }] } }] }) };
  }
  if (!good.includes(model)) return { ok: false, status: 503, json: async () => ({}) };
  return { ok: true, json: async () => ({ choices: [{ message: { content: "ok" } }] }) };
};

test("health check: a real VISIBLE answer is required — HTTP failures, empty answers and reasoning-only answers are not 'available'", async () => {
  assert.equal((await healthCheckFree("http://x", "a", { fetchImpl: okFetch(["a"]) })).ok, true);
  assert.equal((await healthCheckFree("http://x", "b", { fetchImpl: okFetch(["a"]) })).ok, false);
  const empty = async () => ({ ok: true, json: async () => ({ choices: [{ message: {} }] }) });
  assert.equal((await healthCheckFree("http://x", "a", { fetchImpl: empty })).ok, false);
  const reasoningOnly = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "", reasoning_content: "thinking…" } }] }) });
  const rr = await healthCheckFree("http://x", "a", { fetchImpl: reasoningOnly });
  assert.equal(rr.ok, false);
  assert.match(rr.reason, /reasoning-only/);
  const boom = async () => { throw new Error("offline"); };
  assert.match((await healthCheckFree("http://x", "a", { fetchImpl: boom })).reason, /offline/);
});

test("tool probe: real tool_calls pass; a 400 or a text-only answer means no tool support", async () => {
  assert.equal((await toolProbeFree("http://x", "a", { fetchImpl: okFetch(["a"], [], ["a"]) })).tools, true);
  const noApi = await toolProbeFree("http://x", "b", { fetchImpl: okFetch(["b"], [], ["a"]) });
  assert.equal(noApi.tools, false);
  assert.match(noApi.toolsReason, /400/);
  const textOnly = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "I cannot call tools" } }] }) });
  assert.equal((await toolProbeFree("http://x", "c", { fetchImpl: textOnly })).tools, false);
});

test("pick: tool-capable beats faster chat-only; fastest otherwise; every candidate tried", async () => {
  const seen = [];
  const delay = (base) => async (url, opts) => {
    if (JSON.parse(opts.body).model === "m1") await new Promise((r) => setTimeout(r, 80));
    return base(url, opts);
  };
  // m1 slow but tool-capable; m2 fast chat-only → m1 wins (the product executes work).
  const r1 = await pickFreeModel({ endpoint: "http://x", candidates: ["m1", "m2", "m3"],
    fetchImpl: delay(okFetch(["m1", "m2"], seen, ["m1"])) });
  assert.equal(r1.model, "m1");
  assert.equal(r1.toolSupport, true);
  assert.equal(r1.tried.length, 3);
  // no tool-capable candidate → fastest healthy chat model, honestly flagged
  const r2 = await pickFreeModel({ endpoint: "http://x", candidates: ["m1", "m2"],
    fetchImpl: delay(okFetch(["m1", "m2"], [], [])) });
  assert.equal(r2.model, "m2");
  assert.equal(r2.toolSupport, false);
  // none healthy at all → null, loudly
  const none = await pickFreeModel({ endpoint: "http://x", candidates: ["m1"], fetchImpl: okFetch([]) });
  assert.equal(none.model, null);
});

test("the free connection is honestly labeled and carries probed tool support", () => {
  const c = freeConnection({ model: "mimo-v2.5-free", toolSupport: true });
  assert.equal(c.funder, "free");
  assert.equal(c.costSource, "free");
  assert.equal(c.toolSupport, true);
  assert.match(c.endpoint, /opencode\.ai/);
  assert.throws(() => freeConnection({ model: null }), /health-checked/);
  assert.match(FREE_PRIVACY_NOTE, /improve the model/);
  assert.ok(FREE_CANDIDATES.length >= 5, "never a single hardcoded model");
});
