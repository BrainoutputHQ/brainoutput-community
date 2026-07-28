// SPDX-License-Identifier: Apache-2.0
// Runtimes + Regular/Advanced onboarding (product architecture 2026-07-28). Zero-dep: `node --test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RUNTIME_KINDS, runtimeConnection, describeLocation, validateRuntime, runtimeCards, runtimeToConnection } from "./runtimes.mjs";
import { onboardingModelPaths, regularOnboardingSteps, advancedOnboardingFields, applyAdvancedAgentConfig, onboardingExample } from "./onboarding.mjs";
import { validateConnection } from "./ce-core.mjs";

const REQUIRED = ["runtime", "provider", "model", "authSource", "costSource", "location", "capabilities", "contextLimit", "toolSupport", "health"];

test("every runtime connection records the 10 surfaced fields", () => {
  for (const k of RUNTIME_KINDS) {
    const rec = runtimeConnection({ runtime: k, provider: "p", model: "m" });
    for (const f of REQUIRED) assert.ok(f in rec, `${k} missing ${f}`);
  }
});

test("a locally-running CLI is distinguished from a fully-local model", () => {
  const cc = runtimeConnection({ runtime: "claude-code", authSource: "user-subscription" });
  assert.equal(cc.location.cliLocal, true);
  assert.equal(cc.location.modelLocation, "cloud");
  assert.match(describeLocation(cc), /local CLI, cloud model/);

  const local = runtimeConnection({ runtime: "local-openai", authSource: "local" });
  assert.equal(local.location.modelLocation, "local");
  assert.match(describeLocation(local), /fully local/);
});

test("runtime auth maps to a user/free/local funder — never BrainOutput", () => {
  assert.equal(runtimeConnection({ runtime: "claude-code", authSource: "user-subscription" }).funder, "user");
  assert.equal(runtimeConnection({ runtime: "local-openai", authSource: "local" }).funder, "local");
  assert.equal(runtimeConnection({ runtime: "generic-llm", authSource: "free" }).funder, "free");
});

test("runtimeConnection fails closed on unknown runtime / unsupported auth", () => {
  assert.throws(() => runtimeConnection({ runtime: "nope" }), /unknown runtime/);
  assert.throws(() => runtimeConnection({ runtime: "local-openai", authSource: "user-subscription" }), /does not support/);
});

test("validateRuntime rejects a BrainOutput-funded runtime, accepts user/free/local", () => {
  assert.equal(validateRuntime(runtimeConnection({ runtime: "codex", authSource: "user-api-account" })).ok, true);
  assert.equal(validateRuntime({ runtime: "claude-code", funder: "brainoutput" }).ok, false);
  assert.equal(validateRuntime({ runtime: "codex", funder: "user", usesFounderCredential: true }).ok, false);
});

test("runtimeToConnection bridges to a valid ce-core connection (and fails closed on founder cred)", () => {
  const rec = runtimeConnection({ runtime: "claude-code", provider: "anthropic", model: "claude", authSource: "user-subscription" });
  const conn = runtimeToConnection(rec, { id: "c1" });
  assert.equal(conn.id, "c1");
  assert.equal(conn.kind, "claude-code");
  assert.equal(conn.funder, "user");
  assert.equal(conn.costSource, "user-subscription");
  assert.equal(validateConnection(conn).ok, true);
  assert.throws(() => runtimeToConnection({ runtime: "codex", funder: "brainoutput" }), /cannot connect runtime/);
});

test("runtimeCards surfaces all five first-class runtimes with Works-with labels", () => {
  const cards = runtimeCards();
  assert.equal(cards.length, 5);
  const labels = cards.map((c) => c.label);
  for (const l of ["OpenCode", "Claude Code", "Codex", "Local / OpenAI-compatible", "Generic LLM agent"]) assert.ok(labels.includes(l));
});

test("REGULAR mode: step 1 offers 5 runtimes; 8 steps total", () => {
  const paths = onboardingModelPaths();
  assert.equal(paths.length, 5);
  const keys = paths.map((p) => p.key);
  for (const k of ["free", "claude-code", "codex", "byok", "local"]) assert.ok(keys.includes(k));
  assert.equal(regularOnboardingSteps().length, 8);
});

test("ADVANCED mode exposes the separable per-agent knobs", () => {
  const f = advancedOnboardingFields();
  for (const k of ["planner model", "worker model", "reviewer model", "fallbacks", "context limits", "reasoning settings", "privacy classification", "cost limits", "permissions", "approval rules"])
    assert.ok(f.includes(k), `missing advanced field ${k}`);
});

test("applyAdvancedAgentConfig attaches per-stage runtimes + advanced settings", () => {
  const base = { id: "a", capabilities: {}, permissions: ["read"], approvalThresholds: {} };
  const out = applyAdvancedAgentConfig(base, {
    stages: { planner: runtimeConnection({ runtime: "claude-code", authSource: "user-subscription" }), worker: runtimeConnection({ runtime: "local-openai", authSource: "local" }) },
    contextLimits: 32000, reasoning: "high", privacy: "confidential", costLimit: 5, permissions: ["read", "draft"], approvals: { publish: "human" },
  });
  assert.equal(out.stageRuntimes.planner.runtime, "claude-code");
  assert.equal(out.stageRuntimes.worker.runtime, "local-openai");
  assert.equal(out.advanced.privacy, "confidential");
  assert.equal(out.advanced.costLimit, 5);
  assert.deepEqual(out.permissions, ["read", "draft"]);
  assert.deepEqual(out.approvalThresholds, { publish: "human" });
});

test("onboarding EXAMPLE: four agents, four different runtimes, all user/free/local, dormant", () => {
  const ex = onboardingExample();
  assert.equal(ex.agents.length, 4);
  const byId = Object.fromEntries(ex.agents.map((a) => [a.id, a]));
  assert.equal(byId["technical-architect"].runtime.runtime, "claude-code");
  assert.equal(byId["software-engineer"].runtime.runtime, "codex");
  assert.equal(byId["legal-clerk"].runtime.runtime, "local-openai");
  assert.equal(byId["customer-support-agent"].runtime.runtime, "generic-llm");
  // four DISTINCT runtimes
  assert.equal(new Set(ex.agents.map((a) => a.runtime.runtime)).size, 4);
  for (const a of ex.agents) {
    assert.equal(a.activation, "dormant");
    assert.equal(validateRuntime(a.runtime).ok, true); // never BrainOutput-funded
  }
});

test("EXAMPLE: legal clerk is fully local + private RAG; support has Zendesk READ-ONLY", () => {
  const ex = onboardingExample();
  const legal = ex.agents.find((a) => a.id === "legal-clerk");
  assert.equal(legal.runtime.location.modelLocation, "local");
  assert.equal(legal.rag.access, "read-only");
  const support = ex.agents.find((a) => a.id === "customer-support-agent");
  assert.equal(support.connectors[0].system, "zendesk");
  assert.equal(support.connectors[0].access, "read-only");
  assert.equal(support.approvalThresholds["send-reply"], "human"); // sending needs approval
});
