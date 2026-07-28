#!/usr/bin/env node --test
// SPDX-License-Identifier: Apache-2.0
// Tests for the Community Edition onboarding engine. Pure logic; no network. run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectConnections, generateOrg, recommendAssignments, applyOverrides, confirmZeroFunded, buildCompanyConfig, renderAgentView, onboardingModelPaths, payerLabel, capabilityAlternatives } from "./onboarding.mjs";

test("onboardingModelPaths: 'free' is first + only default; the 5 runtimes are present", () => {
  const p = onboardingModelPaths();
  assert.equal(p[0].key, "free");
  assert.equal(p.filter((x) => x.default).length, 1);
  assert.equal(p.find((x) => x.default).key, "free");
  assert.deepEqual(p.map((x) => x.key).sort(), ["byok", "claude-code", "codex", "free", "local"]);
  for (const x of p) assert.ok(x.payer && x.label && x.runtime && x.where); // who pays + where it runs
});

test("payerLabel is plain-language and never implies BrainOutput pays", () => {
  assert.match(payerLabel("free"), /free/i);
  assert.match(payerLabel("local"), /your own computer/i);
  assert.match(payerLabel("user"), /your own/i);
  assert.match(payerLabel("brainoutput"), /not available|never pays/i);
});

test("capabilityAlternatives offers non-paid options and never a BrainOutput fallback", () => {
  const v = capabilityAlternatives("vision", []);
  assert.ok(v.length >= 2);
  for (const a of v) assert.doesNotMatch(a, /paid|brainoutput/i);
  const g = capabilityAlternatives("reasoning-free", []);
  assert.ok(g.length >= 2);
  for (const a of g) assert.doesNotMatch(a, /paid|brainoutput/i);
});

const LOCALS = [
  { name: "qwen2.5-7b-32k:latest", provider: "ollama", contextSize: 32000, coding: true, multilingual: true, vision: false },
  { name: "qwen2.5:3b", provider: "ollama", contextSize: 8192, coding: true, multilingual: true, vision: false },
];

test("detectConnections keeps only user/free/local and drops any funded/founder source", () => {
  const { connections } = detectConnections({ localModels: LOCALS, byokKeys: { "user-anthropic": { present: true, envName: "USER_OWN_ANTHROPIC_KEY", subscription: true, model: "claude-opus-4-8" } } });
  assert.equal(connections.length, 3);                       // 2 local + 1 byok
  assert.ok(connections.every((c) => ["local", "user", "free"].includes(c.funder)));
  const byok = connections.find((c) => c.kind === "byok");
  assert.equal(byok.costSource, "user-subscription");
});

test("generateOrg produces dormant agents only for the selected departments", () => {
  const agents = generateOrg({ companyDoes: "x", departments: ["technical", "finance"] });
  assert.ok(agents.length >= 3);                             // technical(2) + finance(1)
  assert.ok(agents.every((a) => a.activation === "dormant"));
  assert.ok(agents.some((a) => a.department === "technical" && a.role === "architect"));
  assert.ok(agents.some((a) => a.department === "finance" && a.role === "controller"));
  assert.equal(agents.some((a) => a.department === "sales"), false);
});

test("recommendAssignments prefers local/free, never assigns paid, and leaves vision UNCONFIGURED when no vision model", () => {
  const { connections } = detectConnections({ localModels: LOCALS });
  const agents = generateOrg({ companyDoes: "x", departments: ["finance"] }); // finance uses a vision slot
  const rec = recommendAssignments(agents, connections);
  assert.ok(rec.slotsUsed.includes("vision"));
  assert.ok(rec.unassigned.includes("vision"));              // no vision model available → unconfigured
  assert.equal(rec.view["vision"].needsConfiguration, true);
  // every ASSIGNED slot resolves to a local/free/user connection
  for (const connId of Object.values(rec.assignments)) {
    const c = connections.find((x) => x.id === connId);
    assert.ok(["local", "free", "user"].includes(c.funder));
  }
});

test("private-local slot only ever maps to a local connection", () => {
  const byok = [{ id: "byok:x", kind: "byok", provider: "p", model: "m", apiKeyEnv: "K", costSource: "user-api-account", funder: "user" }];
  const { connections } = detectConnections({ localModels: LOCALS });
  const agents = generateOrg({ companyDoes: "x", departments: ["finance"] });
  const rec = recommendAssignments(agents, [...connections, ...byok]);
  if (rec.assignments["private-local"]) {
    const c = [...connections, ...byok].find((x) => x.id === rec.assignments["private-local"]);
    assert.equal(c.funder, "local");
  }
});

test("applyOverrides rejects an override to a BrainOutput-funded connection", () => {
  const conns = [{ id: "ok", kind: "local", provider: "o", model: "m", costSource: "local-compute", funder: "local" },
                 { id: "bad", kind: "x", provider: "p", model: "m", costSource: "free", funder: "brainoutput" }];
  assert.deepEqual(applyOverrides({ "coding-free": "ok" }, { "coding-free": null }, conns), {});
  assert.throws(() => applyOverrides({}, { "coding-free": "bad" }, conns), /brainoutput|not user|funded/i);
});

test("confirmZeroFunded is true for an all-local/free/user plan", () => {
  const { connections } = detectConnections({ localModels: LOCALS });
  const agents = generateOrg({ companyDoes: "x", departments: ["technical", "customer-service"] });
  const rec = recommendAssignments(agents, connections);
  assert.equal(confirmZeroFunded(rec.assignments, connections).ok, true);
});

test("buildCompanyConfig deploys agents dormant; renderAgentView shows models + cost + approvals", () => {
  const { connections } = detectConnections({ localModels: LOCALS });
  const agents = generateOrg({ companyDoes: "Studio", departments: ["finance"] });
  const rec = recommendAssignments(agents, connections);
  const cfg = buildCompanyConfig({ companyDoes: "Studio", departments: ["finance"] }, connections, agents, rec.assignments);
  assert.ok(cfg.agents.every((a) => a.activation === "dormant"));
  const view = renderAgentView(agents[0], rec.assignments, connections);
  assert.equal(view.activation, "dormant");
  assert.ok(Object.keys(view.models).length >= 1);
  assert.ok(Object.keys(view.approvals).includes("payment"));   // finance controller: payment→human
});
