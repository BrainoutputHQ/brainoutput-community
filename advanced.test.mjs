// SPDX-License-Identifier: Apache-2.0
// Advanced mode — per-stage model overrides actually change execution, and privacy is fail-closed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyStageOverrides, routeTask, makeCatalog } from "./ce-core.mjs";
import { applyAdvancedAgentConfig } from "./onboarding.mjs";

const CONNS = [
  { id: "local-small", kind: "local", provider: "ollama", model: "qwen2.5:3b", costSource: "local-compute", funder: "local" },
  { id: "local-big", kind: "local", provider: "ollama", model: "qwen2.5-7b-32k", costSource: "local-compute", funder: "local" },
  { id: "byok-premium", kind: "byok", provider: "user-anthropic", model: "claude-opus-4-8", costSource: "user-subscription", funder: "user" },
];
const ctx = (agents) => ({ agents, assignments: { "coding-free": "local-small", "reasoning-free": "local-small", "high-trust-review": "local-big" },
  connections: CONNS, catalog: makeCatalog([]) });

test("a stage override changes THAT stage's model, provider and cost source", () => {
  const agent = applyAdvancedAgentConfig(
    { id: "eng", department: "technical", capabilities: { planner: "reasoning-free", worker: "coding-free" } },
    { stages: { planner: "byok-premium" } });
  const r = routeTask({ department: "technical", task: { complexity: "high", decompose: true } }, ctx([agent]));
  const planner = r.plan.find((n) => n.node === "planner");
  const worker = r.plan.find((n) => n.node.startsWith("worker"));
  assert.equal(planner.model.model, "claude-opus-4-8");        // overridden
  assert.equal(planner.model.costSource, "user-subscription");
  assert.equal(planner.model.override, true);
  assert.equal(worker.model.model, "qwen2.5:3b");              // untouched
});

test("privacy confidential/restricted is FAIL-CLOSED: a cloud model is never silently used", () => {
  const agent = applyAdvancedAgentConfig(
    { id: "legal", department: "legal-compliance", capabilities: { worker: "coding-free" } },
    { stages: { worker: "byok-premium" }, privacy: "confidential" });
  const r = routeTask({ department: "legal-compliance", task: {} }, ctx([agent]));
  const w = r.plan.find((n) => n.node === "worker");
  assert.equal(w.model.needsConfiguration, true);              // blocked, not downgraded
  assert.equal(w.model.privacyBlocked, "confidential");
  assert.deepEqual(w.model.options, ["local", "stop"]);
  assert.deepEqual(r.needsConfiguration, ["coding-free"]);
});

test("privacy allows a LOCAL model through unchanged", () => {
  const agent = applyAdvancedAgentConfig(
    { id: "legal", department: "legal-compliance", capabilities: { worker: "coding-free" } },
    { stages: { worker: "local-big" }, privacy: "restricted" });
  const r = routeTask({ department: "legal-compliance", task: {} }, ctx([agent]));
  assert.equal(r.plan[0].model.model, "qwen2.5-7b-32k");
  assert.equal(r.zeroBrainOutputFunded, true);
});

test("an override to an invalid (non user/free/local) connection is rejected", () => {
  const bad = [{ id: "nope", kind: "hosted", provider: "x", model: "y", costSource: "free", funder: "brainoutput" }];
  const agent = { id: "a", department: "technical", capabilities: { worker: "coding-free" }, stageRuntimes: { worker: "nope" } };
  assert.throws(() => applyStageOverrides([{ node: "worker", slot: "coding-free", model: {} }], agent, bad), /stage override/);
});

test("Regular mode is untouched — no advanced config means no overrides", () => {
  const agent = { id: "plain", department: "technical", capabilities: { worker: "coding-free" } };
  const plan = [{ node: "worker", slot: "coding-free", model: { model: "qwen2.5:3b", funder: "local" } }];
  assert.deepEqual(applyStageOverrides(plan, agent, CONNS), plan);
});

test("a partial advanced update merges — it never silently erases other settings", () => {
  let a = applyAdvancedAgentConfig({ id: "x" }, { contextLimits: 32000, privacy: "confidential", costLimit: 5 });
  a = applyAdvancedAgentConfig(a, { stages: { worker: "local-big" } });   // partial: says nothing about budgets
  assert.equal(a.advanced.contextLimits, 32000);   // preserved
  assert.equal(a.advanced.privacy, "confidential");
  assert.equal(a.advanced.costLimit, 5);
  assert.equal(a.stageRuntimes.worker, "local-big");
  const cleared = applyAdvancedAgentConfig(a, { costLimit: null });        // explicit null clears
  assert.equal(cleared.advanced.costLimit, null);
});
