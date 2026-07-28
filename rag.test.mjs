// SPDX-License-Identifier: Apache-2.0
// Item 6 — read-only RAG/chat knowledge. Zero-dep: `node --test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { connectRagSource, canRead, indexDocuments, searchRag, retentionExpired, pruneRetention, ragActionPlan } from "./rag.mjs";
import { grantScope } from "./connectors.mjs";

const DOCS = [
  { id: "policy", resource: "policy.md", text: "Refunds are available within 30 days of purchase.\n\nStudent discounts are 20% with a valid ID." },
  { id: "hours", resource: "hours.md", text: "Support is open Monday to Friday, 9am to 6pm." },
];

test("a connected source is READ-ONLY and records the selected resources", () => {
  const s = connectRagSource({ id: "kb", kind: "file", resources: ["policy.md", "hours.md"] });
  assert.deepEqual(s.connector.grants, []); // read-only
  assert.deepEqual(s.resources, ["policy.md", "hours.md"]);
  assert.equal(s.kind, "file");
});

test("indexing chunks documents with citation locators; chat uses channel#id", () => {
  const s = indexDocuments(connectRagSource({ id: "kb" }), DOCS);
  assert.ok(s.chunks.length >= 2);
  assert.ok(s.chunks.every((c) => c.locator && c.terms.length));
  const chat = indexDocuments(connectRagSource({ id: "sup", kind: "chat", channels: ["#support"] }),
    [{ id: "m1", channel: "#support", text: "Where is my order?" }]);
  assert.match(chat.chunks[0].locator, /#support#m1/);
});

test("search returns cited results, most relevant first", () => {
  const s = indexDocuments(connectRagSource({ id: "kb", label: "KB" }), DOCS);
  const res = searchRag([s], "refund within days", { agent: { id: "cs" } });
  assert.ok(res.length);
  assert.match(res[0].text, /Refunds/);
  assert.match(res[0].citation, /KB — policy\.md/);
  assert.ok(res[0].score > 0);
});

test("access control: agent-list and department-list gate reading", () => {
  const legalOnly = connectRagSource({ id: "legal", accessControl: { departments: ["legal-compliance"] } });
  assert.equal(canRead(legalOnly, { id: "x", department: "legal-compliance" }), true);
  assert.equal(canRead(legalOnly, { id: "y", department: "sales" }), false);
  const agentOnly = connectRagSource({ id: "hr", accessControl: { agents: ["hr-lead"] } });
  assert.equal(canRead(agentOnly, { id: "hr-lead" }), true);
  assert.equal(canRead(agentOnly, { id: "someone" }), false);
  assert.equal(canRead(connectRagSource({ id: "open" }), { id: "anyone" }), true); // unrestricted
});

test("search skips sources the agent may not read", () => {
  const legal = indexDocuments(connectRagSource({ id: "legal", label: "Legal", accessControl: { departments: ["legal-compliance"] } }),
    [{ id: "nda", resource: "nda.md", text: "This agreement is confidential and binding." }]);
  assert.equal(searchRag([legal], "confidential agreement", { agent: { id: "s", department: "sales" } }).length, 0);
  assert.ok(searchRag([legal], "confidential agreement", { agent: { id: "c", department: "legal-compliance" } }).length);
});

test("retention: expired chunks are excluded from search and pruned", () => {
  const day = 86400000;
  let s = indexDocuments(connectRagSource({ id: "kb", retentionDays: 30 }), DOCS, { now: 0 });
  const now = 40 * day; // 40 days later → past 30-day retention
  assert.equal(retentionExpired(s.chunks[0], s, now), true);
  assert.equal(searchRag([s], "refund", { agent: {}, now }).length, 0);
  s = pruneRetention(s, now);
  assert.equal(s.chunks.length, 0);
});

test("read ≠ draft ≠ send: read/draft allowed; send needs communicate grant + approval", () => {
  let chat = connectRagSource({ id: "sup", kind: "chat", channels: ["#support"] });
  assert.equal(ragActionPlan(chat, { intent: "read", agent: { id: "cs" } }).allowed, true);
  assert.equal(ragActionPlan(chat, { intent: "draft", agent: { id: "cs" } }).allowed, true);
  // sending without a grant → not allowed
  assert.equal(ragActionPlan(chat, { intent: "send", agent: { id: "cs" } }).allowed, false);
  // grant communicate → allowed but needs approval (never silent)
  chat = { ...chat, connector: grantScope(chat.connector, { scope: "communicate", principal: { level: "agent", id: "cs" } }) };
  const send = ragActionPlan(chat, { intent: "send", agent: { id: "cs" } });
  assert.equal(send.allowed, true);
  assert.equal(send.requiresApproval, true);
});
