// SPDX-License-Identifier: Apache-2.0
// Item 7 — approved write-action loop. Zero-dep: `node --test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { newConnector, grantScope } from "./connectors.mjs";
import { connectorAction, executeApprovedAction } from "./connector-adapters.mjs";

const agent = { id: "eng", department: "technical" };
const write = { action: "close-issue", resource: "repo:acme/site#42", payload: { comment: "done" }, agent };

test("a write with no grant is refused outright", async () => {
  const r = await connectorAction(newConnector("gitea"), write);
  assert.equal(r.executed, false);
  assert.match(r.reason, /no grant/);
});

test("a granted write is held for a human, never executed inline", async () => {
  const gitea = grantScope(newConnector("gitea"), { scope: "write", principal: { level: "agent", id: "eng" } });
  const r = await connectorAction(gitea, write);
  assert.equal(r.executed, false);
  assert.equal(r.status, "pending-human-approval");
  assert.equal(r.requiresApproval, true);
  assert.equal(r.plannedAction.action, "close-issue");
});

test("execute is blocked without an approval, and runs only AFTER one", async () => {
  const gitea = grantScope(newConnector("gitea"), { scope: "write", principal: { level: "agent", id: "eng" } });
  const blocked = await executeApprovedAction(gitea, write, { status: "pending" });
  assert.equal(blocked.executed, false);
  assert.match(blocked.reason, /approval required/);

  const done = await executeApprovedAction(gitea, write, { status: "approved", approvedBy: "founder" });
  assert.equal(done.executed, true);
  assert.equal(done.approvedBy, "founder");
  assert.equal(done.result.applied, true);
});

test("execute is refused if the grant is missing, even with an approval", async () => {
  const done = await executeApprovedAction(newConnector("gitea"), write, { status: "approved" });
  assert.equal(done.executed, false); // fail-closed: re-checks the grant
});

test("a granted write goes through an injected execImpl after approval", async () => {
  const gitea = grantScope({ ...newConnector("gitea"), endpoint: "http://gitea.local/api" }, { scope: "write", principal: { level: "organization" } });
  const done = await executeApprovedAction(gitea, write, { status: "approved" }, { execImpl: async () => ({ applied: true, via: "live" }) });
  assert.equal(done.result.via, "live");
});
