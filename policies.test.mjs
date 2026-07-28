// SPDX-License-Identifier: Apache-2.0
// Policy-binding + reviewer-context + human-minimized escalation (product architecture 2026-07-27).
// The reviewer/validator loads the POLICIES relevant to what it validates — not the worker's raw
// instructions — and a human is pulled in ONLY when the agent reviewer can't clear it, with a
// maximum-information brief. Zero-dep: `node --test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectPolicies, planGraph, reviewContextFor, resolveApprovalGate, escalationBrief, routeTask } from "./ce-core.mjs";
import { executePlan } from "./adapters.mjs";

const POLICIES = {
  "legal-copy-review": {
    appliesTo: { departments: ["marketing"], tags: ["publish-copy"] },
    criteria: ["claims honest & verifiable", "no signed wording altered"],
    escalation: "human", autoApproveWhenClear: true,
  },
  "company-wide-safety": { criteria: ["no secrets in output"] }, // no appliesTo → binds to everything
};

test("selectPolicies: binds by department", () => {
  const got = selectPolicies({ department: "marketing" }, POLICIES).map((p) => p.id);
  assert.ok(got.includes("legal-copy-review"));
  assert.ok(got.includes("company-wide-safety")); // company-wide always binds
});

test("selectPolicies: binds by task tag even from another department", () => {
  const got = selectPolicies({ department: "engineering", tags: ["publish-copy"] }, POLICIES).map((p) => p.id);
  assert.ok(got.includes("legal-copy-review")); // tag match binds it
});

test("selectPolicies: a scoped policy does NOT bind to unrelated work (only company-wide does)", () => {
  const got = selectPolicies({ department: "finance", tags: ["reconcile"] }, POLICIES).map((p) => p.id);
  assert.deepEqual(got, ["company-wide-safety"]);
});

test("planGraph: bound policies add a reviewer carrying their criteria + a conditional briefed gate", () => {
  const g = planGraph({ policies: [POLICIES["legal-copy-review"] && { id: "legal-copy-review", ...POLICIES["legal-copy-review"] }] });
  const reviewer = g.nodes.find((n) => n.node === "reviewer");
  const gate = g.nodes.find((n) => n.gate);
  assert.equal(g.shape, "agent-approval-action");
  assert.deepEqual(reviewer.reviewCriteria, ["claims honest & verifiable", "no signed wording altered"]);
  assert.deepEqual(reviewer.policies, ["legal-copy-review"]);
  assert.equal(gate.conditional, true); // human-minimized: auto-clearable
  assert.equal(gate.brief, true);
});

test("planGraph: no policies → unchanged (no reviewer unless risk requires)", () => {
  const g = planGraph({});
  assert.equal(g.shape, "single");
  assert.equal(g.nodes.find((n) => n.node === "reviewer"), undefined);
  assert.equal(g.nodes.find((n) => n.gate), undefined);
});

test("reviewContextFor: exposes exactly the loaded policy criteria", () => {
  const g = planGraph({ policies: [{ id: "legal-copy-review", ...POLICIES["legal-copy-review"] }] });
  const ctx = reviewContextFor(g.nodes.find((n) => n.node === "reviewer"));
  assert.deepEqual(ctx.policies, ["legal-copy-review"]);
  assert.equal(ctx.criteria.length, 2);
});

test("resolveApprovalGate: conditional + clean review → auto-cleared, NO human", () => {
  const g = resolveApprovalGate({ review: { pass: true, flags: [] }, node: { gate: true, conditional: true, brief: true } });
  assert.equal(g.humanRequired, false);
  assert.equal(g.status, "auto-cleared-by-reviewer");
});

test("resolveApprovalGate: conditional + flagged review → escalate to human with a brief", () => {
  const brief = { decision: "x" };
  const g = resolveApprovalGate({ review: { pass: false, flags: ["bad claim"] }, node: { gate: true, conditional: true, brief: true }, brief });
  assert.equal(g.humanRequired, true);
  assert.equal(g.status, "pending-human-approval");
  assert.deepEqual(g.flags, ["bad claim"]);
  assert.deepEqual(g.brief, brief);
});

test("resolveApprovalGate: a hard real-world gate (not conditional) ALWAYS needs a human", () => {
  const g = resolveApprovalGate({ review: { pass: true, flags: [] }, node: { gate: true } });
  assert.equal(g.humanRequired, true);
});

test("escalationBrief: is a complete, decision-ready package for the human", () => {
  const b = escalationBrief({
    task: { summary: "publish claim", department: "marketing" },
    artifact: "the #1 tool",
    review: { pass: false, flags: ["'#1' unverifiable"], notes: "n", recommendation: "hold" },
    policies: [{ id: "legal-copy-review", criteria: ["claims honest"] }],
  });
  assert.equal(b.what, "publish claim");
  assert.equal(b.artifact, "the #1 tool");
  assert.deepEqual(b.policiesChecked, ["legal-copy-review"]);
  assert.equal(b.criteria[0].policy, "legal-copy-review");
  assert.equal(b.reviewer.verdict, "flagged");
  assert.deepEqual(b.reviewer.flags, ["'#1' unverifiable"]);
  assert.match(b.escalatedBecause, /1 flag/);
});

test("routeTask: binds company policies by work-type + reviewer node carries their criteria", () => {
  const ctx = {
    agents: [{ id: "mkt", department: "marketing", role: "copywriter", capabilities: { worker: "multilingual", reviewer: "high-trust-review" } }],
    assignments: { multilingual: "c1", "high-trust-review": "c1" },
    connections: [{ id: "c1", kind: "local", provider: "ollama", model: "qwen2.5:3b", costSource: "local-compute", funder: "local" }],
    policies: POLICIES,
  };
  const r = routeTask({ department: "marketing", role: "copywriter", task: { summary: "publish", tags: ["publish-copy"] } }, ctx);
  assert.ok(r.ok);
  assert.ok(r.policies.includes("legal-copy-review"));
  const reviewer = r.plan.find((n) => n.node === "reviewer");
  assert.ok(reviewer.reviewCriteria.length >= 2);
  assert.equal(r.zeroBrainOutputFunded, true);
});

test("executePlan: human-minimized — clean verdict auto-clears the gate; $0 funded", async () => {
  const plan = planGraph({ policies: [{ id: "legal-copy-review", ...POLICIES["legal-copy-review"] }] })
    .nodes.map((n) => ({ ...n, model: n.gate ? null : { connection: { model: "local", provider: "ollama", costSource: "local-compute", funder: "local" } } }));
  const out = await executePlan(plan, {}, { dryRun: true, reviewVerdict: { pass: true, flags: [] }, boundPolicies: [{ id: "legal-copy-review", criteria: ["x"] }], task: { summary: "t" } });
  const gate = out.find((r) => r.gate);
  assert.equal(gate.humanRequired, false);
  assert.equal(gate.status, "auto-cleared-by-reviewer");
});

test("executePlan: flagged verdict escalates the gate to a human WITH a brief", async () => {
  const plan = planGraph({ policies: [{ id: "legal-copy-review", ...POLICIES["legal-copy-review"] }] })
    .nodes.map((n) => ({ ...n, model: n.gate ? null : { connection: { model: "local", provider: "ollama", costSource: "local-compute", funder: "local" } } }));
  const out = await executePlan(plan, {}, { dryRun: true, reviewVerdict: { pass: false, flags: ["false MIT claim"] }, boundPolicies: [{ id: "legal-copy-review", criteria: ["x"] }], task: { summary: "t" } });
  const gate = out.find((r) => r.gate);
  assert.equal(gate.humanRequired, true);
  assert.ok(gate.brief && gate.brief.reviewer.flags.includes("false MIT claim"));
});
