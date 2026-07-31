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

test("health check: a real completion is required — HTTP failures and empty answers are not 'available'", async () => {
  assert.equal((await healthCheckFree("http://x", "a", { fetchImpl: okFetch(["a"]) })).ok, true);
  assert.equal((await healthCheckFree("http://x", "b", { fetchImpl: okFetch(["a"]) })).ok, false);
  const empty = async () => ({ ok: true, json: async () => ({ choices: [{ message: {} }] }) });
  assert.equal((await healthCheckFree("http://x", "a", { fetchImpl: empty })).ok, false);
  const boom = async () => { throw new Error("offline"); };
  assert.match((await healthCheckFree("http://x", "a", { fetchImpl: boom })).reason, /offline/);
});

test("pick: first HEALTHY candidate wins, never a hardcoded one; tried list is kept", async () => {
  const seen = [];
  const r = await pickFreeModel({ endpoint: "http://x", candidates: ["m1", "m2", "m3"], fetchImpl: okFetch(["m2"], seen) });
  assert.equal(r.model, "m2");
  assert.deepEqual(seen, ["m1", "m2"], "stops at the first healthy");
  assert.equal(r.tried.length, 2);

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
