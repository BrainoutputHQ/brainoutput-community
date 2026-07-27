#!/usr/bin/env node --test
// Tests for the Community Edition core: capability slots, connection validation (zero
// BrainOutput-funded inference), free catalog, smallest execution graph, model selection with
// no-paid-fallback, and routing. Pure logic — no network, no model calls. run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { CAPABILITY_SLOTS, validateConnection, makeCatalog, planGraph, selectModel, routeTask, assertZeroFunded, costReport, executionSummary } from "./ce-core.mjs";

const LOCAL = { id: "local-a", kind: "local", provider: "ollama", model: "qwen2.5:7b", costSource: "local-compute", funder: "local" };
const FREE = { id: "free-a", kind: "opencode-free", provider: "opencode-free", model: "some-free", costSource: "free", funder: "free" };
const USER = { id: "byok", kind: "byok", provider: "user-anthropic", model: "claude-opus-4-8", apiKeyEnv: "USER_KEY", costSource: "user-subscription", funder: "user" };

test("capability slots are the fixed logical set", () => {
  for (const s of ["reasoning-premium", "coding-free", "vision", "private-local", "high-trust-review"]) assert.ok(CAPABILITY_SLOTS.includes(s));
});

test("validateConnection: user/free/local OK; BrainOutput-funded and paid-credential FORBIDDEN", () => {
  assert.equal(validateConnection(LOCAL).ok, true);
  assert.equal(validateConnection(FREE).ok, true);
  assert.equal(validateConnection(USER).ok, true);                       // a user's OWN premium model (BYOK) is allowed
  assert.equal(validateConnection({ ...LOCAL, funder: "brainoutput" }).ok, false);
  assert.equal(validateConnection({ ...LOCAL, usesFounderCredential: true }).ok, false);
  // BrainOutput's dev model name may NOT back a non-user (free/local) connection
  assert.equal(validateConnection({ ...FREE, model: "kimi-for-coding/k3-256k" }).ok, false);
});

test("free catalog returns only available/healthy free models, else null (never paid)", () => {
  const cat = makeCatalog([
    { provider: "p", model: "m1", available: false, health: "ok", funder: "free", codingCategory: "good" },
    { provider: "p", model: "m2", available: true, health: "ok", funder: "free", codingCategory: "good", toolSupport: true },
  ]);
  assert.equal(cat.pickFree({ coding: true }).model, "m2");
  assert.equal(makeCatalog([]).pickFree({ coding: true }), null);
});

test("planGraph picks the SMALLEST sufficient shape", () => {
  assert.equal(planGraph({ complexity: "low" }).shape, "single");
  assert.equal(planGraph({ complexity: "high", decompose: true }).shape, "planner-worker");
  assert.equal(planGraph({ complexity: "high", decompose: true, parallelWorkers: 3 }).shape, "planner-parallel-workers");
  assert.equal(planGraph({ risk: "high" }).shape, "worker-reviewer");
  assert.equal(planGraph({ tool: "reconcile" }).shape, "agent-tool");
  assert.equal(planGraph({ mutatesRealWorld: true }).shape, "agent-approval-action");
  // a clear task gets NO planner and NO reviewer
  assert.equal(planGraph({ complexity: "low" }).nodes.some((n) => n.node === "planner" || n.node === "reviewer"), false);
});

test("selectModel: assignment → connection; unassigned slot → needsConfiguration (NEVER paid)", () => {
  const ctx = { assignments: { "coding-free": "local-a" }, connections: [LOCAL], catalog: makeCatalog([]) };
  assert.equal(selectModel("coding-free", ctx).model, "qwen2.5:7b");
  const v = selectModel("vision", ctx);                                   // unassigned, not a *-free slot, empty catalog
  assert.equal(v.needsConfiguration, true);
  assert.deepEqual(v.options, ["free", "byok", "local", "stop"]);
});

test("selectModel: a *-free slot with no assignment falls back to the FREE catalog, not paid", () => {
  const ctx = { assignments: {}, connections: [], catalog: makeCatalog([{ provider: "p", model: "free-x", available: true, health: "ok", funder: "free", codingCategory: "good" }]) };
  const r = selectModel("coding-free", ctx);
  assert.equal(r.funder, "free");
  assert.equal(r.model, "free-x");
});

test("routeTask identifies the agent, builds the smallest graph, and is zero-funded", () => {
  const agents = [{ id: "eng", department: "technical", role: "architect", capabilities: { planner: "reasoning-free", worker: "coding-free" } }];
  const ctx = { agents, assignments: { "reasoning-free": "local-a", "coding-free": "local-a" }, connections: [LOCAL], catalog: makeCatalog([]) };
  const r = routeTask({ department: "technical", task: { complexity: "high", decompose: true } }, ctx);
  assert.equal(r.ok, true);
  assert.equal(r.agent, "eng");
  assert.equal(r.shape, "planner-worker");
  assert.equal(r.zeroBrainOutputFunded, true);
  assert.equal(r.plan.every((n) => ["local", "free", "user"].includes(n.model.funder ?? "local") || n.model.deterministic || n.gate), true);
});

test("routeTask THROWS if an assignment would use BrainOutput-funded inference", () => {
  const agents = [{ id: "x", department: "d", role: "r", capabilities: { worker: "coding-free" } }];
  const bad = { id: "b", kind: "x", provider: "p", model: "m", costSource: "free", funder: "brainoutput" };
  const ctx = { agents, assignments: { "coding-free": "b" }, connections: [bad], catalog: makeCatalog([]) };
  assert.throws(() => routeTask({ department: "d", task: { complexity: "low", workerSlot: "coding-free" } }, ctx), /brainoutput|forbidden|funded|not user/i);
});

test("executionSummary: a local $0 run is zeroFundedOk with no BrainOutput-funded tokens", () => {
  const results = [
    { node: "worker", tokens: 120, costSource: "local-compute", funder: "local", artifact: "diff.patch", changedFiles: ["ce-core.mjs"] },
    { node: "tool", tokens: 0, costSource: "local-compute", funder: "local" },
  ];
  const before = JSON.stringify(results);
  const s = executionSummary(results);
  assert.equal(JSON.stringify(results), before);                          // input not mutated
  assert.equal(s.tokens, 120);
  assert.equal(s.byCostSource["local-compute"], 120);
  assert.deepEqual(s.fundersUsed, ["local"]);
  assert.equal(s.brainoutputFundedTokens, 0);
  assert.equal(s.zeroFundedOk, true);
  assert.deepEqual(s.artifacts, ["diff.patch", "ce-core.mjs"]);
});

test("executionSummary: a funder:'brainoutput' record makes zeroFundedOk false", () => {
  const s = executionSummary([{ node: "worker", tokens: 50, costSource: "free", funder: "brainoutput" }]);
  assert.equal(s.brainoutputFundedTokens, 50);
  assert.equal(s.zeroFundedOk, false);
});

test("assertZeroFunded + costReport keep BrainOutput-funded tokens at 0", () => {
  const results = [
    { node: "worker", model: "qwen", provider: "ollama", costSource: "local-compute", funder: "local", tokens: 120 },
    { node: "tool", deterministic: true, tokens: 0 },
    { node: "approval", gate: true, tokens: 0 },
  ];
  assert.equal(assertZeroFunded(results.map((r) => ({ node: r.node, model: r }))), true);
  const rep = costReport(results);
  assert.equal(rep.brainoutputFundedTokens, 0);
  assert.equal(rep.byCostSource["local-compute"], 120);
});
