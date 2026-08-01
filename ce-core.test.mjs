#!/usr/bin/env node --test
// SPDX-License-Identifier: Apache-2.0
// Tests for the Community Edition core: capability slots, connection validation (zero
// BrainOutput-funded inference), free catalog, smallest execution graph, model selection with
// no-paid-fallback, and routing. Pure logic — no network, no model calls. run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { CAPABILITY_SLOTS, validateConnection, makeCatalog, planGraph, selectModel, routeTask, assertZeroFunded, costReport, executionSummary, validateCompanyConfig } from "./ce-core.mjs";

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

const VALID_CFG = {
  company: { name: "T", brainoutputFundedInference: "forbidden" },
  agents: [{ id: "a1", department: "technical", role: "architect", capabilities: { planner: "reasoning-free", worker: "coding-free" } }],
  modelConnections: [LOCAL, FREE],
  modelAssignments: { "reasoning-free": "free-a", "coding-free": "local-a" },
};

test("validateCompanyConfig: a valid minimal config passes with no errors", () => {
  const v = validateCompanyConfig(VALID_CFG);
  assert.equal(v.ok, true);
  assert.deepEqual(v.errors, []);
});

test("validateCompanyConfig: rejects non-object / missing required sections", () => {
  assert.equal(validateCompanyConfig(null).ok, false);
  assert.equal(validateCompanyConfig([]).ok, false);
  const v = validateCompanyConfig({ company: { name: "x" } });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /agents/.test(e)));
  assert.ok(v.errors.some((e) => /modelConnections/.test(e)));
  assert.ok(v.errors.some((e) => /modelAssignments/.test(e)));
});

test("validateCompanyConfig: fail-closed on BrainOutput-funded or credential-abusing connections", () => {
  const bad = { ...FREE, id: "evil", funder: "brainoutput" };
  const v = validateCompanyConfig({ ...VALID_CFG, modelConnections: [LOCAL, bad] });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /evil.*(brainoutput|forbidden|not user)/i.test(e)));
  const v2 = validateCompanyConfig({ ...VALID_CFG, company: { name: "x", brainoutputFundedInference: "allowed" } });
  assert.equal(v2.ok, false);
  assert.ok(v2.errors.some((e) => /forbidden/.test(e)));
});

test("validateCompanyConfig: unknown slots, dangling assignments, and duplicate ids are errors", () => {
  const v = validateCompanyConfig({
    ...VALID_CFG,
    agents: [...VALID_CFG.agents, { ...VALID_CFG.agents[0], capabilities: { worker: "not-a-slot" } }],
    modelConnections: [LOCAL, FREE, { ...LOCAL }],
    modelAssignments: { "coding-free": "ghost", "made-up-slot": "local-a" },
  });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /duplicate agent id/.test(e)));
  assert.ok(v.errors.some((e) => /unknown slot 'not-a-slot'/.test(e)));
  assert.ok(v.errors.some((e) => /duplicate connection id/.test(e)));
  assert.ok(v.errors.some((e) => /unknown connection 'ghost'/.test(e)));
  assert.ok(v.errors.some((e) => /unknown capability slot 'made-up-slot'/.test(e)));
});

test("validateCompanyConfig: agent outside declared departments is an error", () => {
  const v = validateCompanyConfig({ ...VALID_CFG, departments: ["sales"] });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /'a1'.*not a declared department/.test(e)));
  // without an explicit departments array it derives from agents (no error)
  assert.equal(validateCompanyConfig({ ...VALID_CFG, departments: undefined }).ok, true);
});

test("validateCompanyConfig: unassigned referenced slot is a WARNING, not an error (never paid)", () => {
  const cfg = { ...VALID_CFG, modelAssignments: {}, agents: [{ ...VALID_CFG.agents[0], capabilities: { worker: "vision" } }] };
  const v = validateCompanyConfig(cfg);
  assert.equal(v.ok, true);
  assert.ok(v.warnings.some((w) => /'vision' unassigned.*needConfiguration/.test(w)));
  const v2 = validateCompanyConfig({ ...VALID_CFG, modelAssignments: {} }); // *-free slots
  assert.equal(v2.ok, true);
  assert.ok(v2.warnings.some((w) => /'coding-free' unassigned — free-catalog fallback/.test(w)));
});

test("validateCompanyConfig: the shipped demo/company.json passes preflight", async () => {
  const { readFileSync } = await import("node:fs");
  const cfg = JSON.parse(readFileSync(new URL("./demo/company.json", import.meta.url), "utf8"));
  const v = validateCompanyConfig(cfg);
  assert.equal(v.ok, true, v.errors.join("; "));
  assert.ok(v.warnings.some((w) => /'vision' unassigned/.test(w)));      // demo C relies on this
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

test("privacy posture: full-private floors every non-local stage to local/stop — never a silent cloud call", () => {
  const connections = [
    { id: "free1", kind: "opencode-free", provider: "zen", model: "free-x", costSource: "free", funder: "free" },
    { id: "loc1", kind: "local", provider: "ollama", model: "qwen", costSource: "local-compute", funder: "local" },
  ];
  const agents = [{ id: "eng", department: "technical", role: "engineer", capabilities: { worker: "coding-free" } }];
  const base = { agents, assignments: { "coding-free": "free1" }, connections, catalog: null, departments: {}, policies: {} };
  const open = routeTask({ department: "technical", task: { summary: "x" } }, base);
  assert.equal(open.plan[0].model.funder, "free", "open posture lets the assigned free model run");
  const priv = routeTask({ department: "technical", task: { summary: "x" } }, { ...base, settings: { privacy: "private" } });
  assert.equal(priv.plan[0].model.needsConfiguration, true, "private posture blocks the free model");
  assert.deepEqual(priv.plan[0].model.options, ["local", "stop"]);
  assert.match(priv.plan[0].model.reason, /full-private/);
  const localOk = routeTask({ department: "technical", task: { summary: "x" } },
    { ...base, assignments: { "coding-free": "loc1" }, settings: { privacy: "private" } });
  assert.equal(localOk.plan[0].model.funder, "local", "local models still run under full-private");
  assert.throws(() => PRIVACY_POSTURES && routeTask({ department: "technical", task: { summary: "x" } },
    { ...base, settings: { privacy: "private" }, connections: connections.filter((c) => c.id === "free1") }), null, "no local model needed for the check to fail closed");
});
