// The guided add-app builder: specs, guides, config validation, connector records, build plans —
// and the mission-side plan preview (the "plan to approve" that was missing).
import { test } from "node:test";
import assert from "node:assert/strict";
import { draftConnectorSpec, connectorGuide, missingConfig, toConnectorRecord, connectorBuildPlan } from "./connector-builder.mjs";
import { resolvePermission } from "./connectors.mjs";
import { newConversation, addMessage, draftMissionSpec } from "./chat.mjs";

test("a custom connector spec is read-only with a config+secret schema and honest auth modes", () => {
  const s = draftConnectorSpec({ name: "Lodgify", baseUrl: "https://api.lodgify.com/v2", auth: "api-key" });
  assert.equal(s.id, "custom-lodgify");
  assert.deepEqual(s.scopes, ["read"], "custom connectors are read-only, period");
  assert.equal(s.status, "needs-config");
  assert.equal(s.secretFields[0].key, "apiKey");
  assert.match(s.secretFields[0].how, /sealed/);
  const oauth = draftConnectorSpec({ name: "X", auth: "oauth" });
  assert.equal(oauth.mechanism, "oauth");
  assert.ok(oauth.configFields.some((f) => f.key === "tokenUrl"));
  assert.throws(() => draftConnectorSpec({ name: "" }), /name/);
  assert.throws(() => draftConnectorSpec({ name: "x", auth: "magic" }), /unknown auth/);
});

test("the guide tells the user where to get credentials and what the security rules are", () => {
  const g = connectorGuide(draftConnectorSpec({ name: "Lodgify", auth: "api-key" }));
  assert.match(g, /API key/);
  assert.match(g, /sealed/);
  assert.match(g, /READ-ONLY/i);
  const go = connectorGuide(draftConnectorSpec({ name: "Lodgify", auth: "oauth" }));
  assert.match(go, /OAuth app/);
  assert.match(go, /never holds a shared one/);
});

test("missingConfig blocks ready until required fields + secret exist", () => {
  const s = draftConnectorSpec({ name: "Lodgify", auth: "api-key" });
  assert.deepEqual(missingConfig(s, {}, false), ["baseUrl", "apiKey"]);
  assert.deepEqual(missingConfig(s, { baseUrl: "https://x" }, false), ["apiKey"]);
  assert.deepEqual(missingConfig(s, { baseUrl: "https://x" }, true), []);
  const open = draftConnectorSpec({ name: "Public", auth: "none" });
  assert.deepEqual(missingConfig(open, { baseUrl: "https://x" }, false), []);
});

test("the record plugs into the standard permission schema (read-only by default)", () => {
  const rec = toConnectorRecord(draftConnectorSpec({ name: "Lodgify" }));
  assert.equal(rec.connector, "generic-openapi");
  const read = resolvePermission(rec, { action: "read", agent: { id: "a" } });
  assert.equal(read.allowed, true);
  const write = resolvePermission(rec, { action: "write", agent: { id: "a" } });
  assert.equal(write.allowed, false, "no elevated scope without an explicit grant");
});

test("the build plan is concrete: files, test, registration, guided credentials, probe", () => {
  const plan = connectorBuildPlan(draftConnectorSpec({ name: "Lodgify" }));
  assert.equal(plan.length, 4);
  assert.match(plan[0], /REAL FILES/);
  assert.match(plan[3], /verification probe/);
});

test("a connector mission gets a planner, a reviewer, a coding worker — and a visible plan", () => {
  let conv = newConversation({ scope: "company", id: "c1" });
  conv = addMessage(conv, { role: "user", text: "i would like to create a lodgify connector to get room reservation details", mode: "plan", at: 1 });
  const spec = draftMissionSpec(conv, { department: "technical" });
  assert.ok(spec.task.tags.includes("connector-builder"));
  assert.equal(spec.task.complexity, "high", "a build plans first");
  assert.equal(spec.task.requireReview, true);
  assert.equal(spec.task.workerSlot, "coding-free", "the coding slot writes real files");
  assert.ok(spec.graph.nodes.includes("planner"), "planner in the graph");
  assert.ok(spec.graph.nodes.some((n) => String(n).startsWith("reviewer")), "reviewer in the graph");
  assert.ok(spec.planPreview.length >= 4);
  assert.match(spec.planPreview[0], /REAL FILES/);
  assert.ok(spec.acceptanceCriteria.some((c) => /sealed secrets/.test(c)));
  // …while a simple question mission stays lean
  let c2 = newConversation({ scope: "company", id: "c2" });
  c2 = addMessage(c2, { role: "user", text: "summarize our cancellation policy", mode: "plan", at: 1 });
  const plain = draftMissionSpec(c2, { department: "operations" });
  assert.ok(!plain.graph.nodes.includes("planner"), "no planner theater for simple work");
  assert.ok(plain.planPreview.length >= 1, "every mission still shows its plan");
});

test("a GOAL ('assistant answering the phone automatically') gets a planner — not a bare approve button", () => {
  let conv = newConversation({ scope: "company", id: "c9" });
  conv = addMessage(conv, { role: "user", text: "need to have an assistant to answer the phone and messages automatically", mode: "plan", at: 1 });
  const spec = draftMissionSpec(conv, { department: "technical" });
  assert.equal(spec.task.complexity, "high");
  assert.ok(spec.graph.nodes.includes("planner"), "the graph plans");
  assert.match(spec.planPreview[0], /^Plan:/);
  // a small clear task still stays lean
  let c2 = newConversation({ scope: "company", id: "c10" });
  c2 = addMessage(c2, { role: "user", text: "draft a refund reply in Spanish", mode: "plan", at: 1 });
  assert.notEqual(draftMissionSpec(c2, { department: "operations" }).task.complexity, "high");
});
