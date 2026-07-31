// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { healthCheckFree, pickFreeModel, freeConnection, FREE_CANDIDATES, FREE_PRIVACY_NOTE } from "./free-models.mjs";

const okFetch = (good = [], seen = []) => async (url, opts) => {
  const model = JSON.parse(opts.body).model;
  seen.push(model);
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

test("pick: the FASTEST healthy candidate wins (parallel checks); tried list covers all", async () => {
  const slow = async (url, opts) => {
    if (JSON.parse(opts.body).model === "m1") await new Promise((r) => setTimeout(r, 80));
    return okFetch(["m1", "m2"])(url, opts);
  };
  const r = await pickFreeModel({ endpoint: "http://x", candidates: ["m1", "m2", "m3"], fetchImpl: slow });
  assert.equal(r.model, "m2", "m2 answers instantly (okFetch), m1 answers slowly — fastest wins");
  assert.equal(r.tried.length, 3, "every candidate was checked");

  const none = await pickFreeModel({ endpoint: "http://x", candidates: ["m1"], fetchImpl: okFetch([]) });
  assert.equal(none.model, null);
  assert.equal(none.tried.length, 1);
});

test("the free connection is honestly labeled (free funder, free cost source) and the privacy note exists", () => {
  const c = freeConnection({ model: "deepseek-v4-flash-free" });
  assert.equal(c.funder, "free");
  assert.equal(c.costSource, "free");
  assert.equal(c.provider, "OpenCode Zen");
  assert.match(c.endpoint, /opencode\.ai/);
  assert.throws(() => freeConnection({ model: null }), /health-checked/);
  assert.match(FREE_PRIVACY_NOTE, /improve the model/);
  assert.ok(FREE_CANDIDATES.length >= 5, "never a single hardcoded model");
});
