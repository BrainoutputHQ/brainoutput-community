// SPDX-License-Identifier: Apache-2.0
// Connector framework + permission schema (item 4). Zero-dep: `node --test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONNECTOR_MECHANISMS, SCOPES, ELEVATED_SCOPES, CONNECTOR_CATALOG,
  actionScope, newConnector, grantScope, resolvePermission, connectorCatalog,
} from "./connectors.mjs";

test("catalog covers the initial targets + generic connectors", () => {
  for (const k of ["github", "jira", "odoo", "zendesk", "twilio", "generic-mcp", "generic-openapi", "generic-rag", "generic-chat"])
    assert.ok(CONNECTOR_CATALOG[k], `missing connector ${k}`);
  assert.deepEqual(SCOPES, ["read", "draft", "write", "communicate", "sensitive"]);
  for (const m of ["oauth", "api-key-local", "mcp", "openapi", "webhook", "database", "file-rag", "chat"])
    assert.ok(CONNECTOR_MECHANISMS.includes(m));
});

test("actionScope maps verbs; unknown mutating verb is write; financial/permission → sensitive", () => {
  assert.equal(actionScope("read-ticket"), "read");
  assert.equal(actionScope("draft-reply"), "draft");
  assert.equal(actionScope("update-issue"), "write");
  assert.equal(actionScope("send-reply"), "communicate");
  assert.equal(actionScope("delete-record"), "sensitive");
  assert.equal(actionScope("refund-payment"), "sensitive");
  assert.equal(actionScope("grant-permission"), "sensitive");
  assert.equal(actionScope("frobnicate"), "write"); // unknown mutating → write, never read
});

test("a newly connected system is READ-ONLY (no grants)", () => {
  const z = newConnector("zendesk");
  assert.deepEqual(z.grants, []);
  assert.equal(resolvePermission(z, { action: "read-ticket" }).allowed, true);
  assert.equal(resolvePermission(z, { action: "draft-reply" }).allowed, true);
  assert.equal(resolvePermission(z, { action: "draft-reply" }).requiresApproval, false);
  // elevated denied without a grant
  assert.equal(resolvePermission(z, { action: "send-reply" }).allowed, false);
  assert.equal(resolvePermission(z, { action: "update-ticket" }).allowed, false);
  assert.equal(resolvePermission(z, { action: "delete-ticket" }).allowed, false);
});

test("elevated scopes require an explicit, separate grant + human approval", () => {
  let z = newConnector("zendesk");
  z = grantScope(z, { scope: "communicate", principal: { level: "agent", id: "cs-agent" } });
  const send = resolvePermission(z, { action: "send-reply", agent: { id: "cs-agent" } });
  assert.equal(send.allowed, true);
  assert.equal(send.requiresApproval, true); // never silent
  // a DIFFERENT agent is not covered by that grant
  assert.equal(resolvePermission(z, { action: "send-reply", agent: { id: "other" } }).allowed, false);
  // granting communicate did NOT also grant write (separately granted)
  assert.equal(resolvePermission(z, { action: "update-ticket", agent: { id: "cs-agent" } }).allowed, false);
});

test("sensitive/financial/permission-changing ALWAYS need approval, even if granted", () => {
  let gh = newConnector("github");
  gh = grantScope(gh, { scope: "sensitive", principal: { level: "organization" }, approval: "none" }); // try to waive
  const del = resolvePermission(gh, { action: "delete-branch", agent: { id: "eng" } });
  assert.equal(del.allowed, true);
  assert.equal(del.requiresApproval, true); // sensitive forces human regardless of grant.approval
});

test("permission scoping: org ⊇ department ⊇ agent", () => {
  let od = newConnector("odoo");
  od = grantScope(od, { scope: "write", principal: { level: "department", id: "finance" } });
  assert.equal(resolvePermission(od, { action: "update-invoice", agent: { id: "x", department: "finance" } }).allowed, true);
  assert.equal(resolvePermission(od, { action: "update-invoice", agent: { id: "y", department: "sales" } }).allowed, false);

  let od2 = grantScope(newConnector("odoo"), { scope: "write", principal: { level: "organization" } });
  assert.equal(resolvePermission(od2, { action: "update-invoice", agent: { id: "anyone", department: "whatever" } }).allowed, true);
});

test("grants can be narrowed to a resource/channel and an action", () => {
  let gh = newConnector("github");
  gh = grantScope(gh, { scope: "write", principal: { level: "agent", id: "eng" }, resource: "repo:acme/site", action: "update-pr" });
  assert.equal(resolvePermission(gh, { action: "update-pr", resource: "repo:acme/site", agent: { id: "eng" } }).allowed, true);
  assert.equal(resolvePermission(gh, { action: "update-pr", resource: "repo:acme/secret", agent: { id: "eng" } }).allowed, false); // wrong resource
  assert.equal(resolvePermission(gh, { action: "merge-pr", resource: "repo:acme/site", agent: { id: "eng" } }).allowed, false); // wrong action
});

test("cannot grant a scope the connector does not expose", () => {
  assert.throws(() => grantScope(newConnector("twilio"), { scope: "write" }), /does not expose/);
  assert.throws(() => grantScope(newConnector("generic-rag"), { scope: "write" }), /does not expose/); // RAG is read-only
});

test("read-only RAG connector: read allowed, everything else unavailable", () => {
  const rag = newConnector("generic-rag");
  assert.equal(resolvePermission(rag, { action: "search-docs" }).allowed, true);
  const write = resolvePermission(rag, { action: "write-doc" });
  assert.equal(write.allowed, false); // connector doesn't expose write
});

test("connectorCatalog lists the targets, all read-only by default", () => {
  const cat = connectorCatalog();
  assert.ok(cat.length >= 9);
  for (const c of cat) assert.equal(c.readOnlyDefault, true);
});
