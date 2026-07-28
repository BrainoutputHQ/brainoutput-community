// SPDX-License-Identifier: Apache-2.0
// Item 5 — connector vertical slice: OSS-alternative catalog, read adapters, free-OSS-company playbook.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CONNECTOR_CATALOG, ossAlternatives, newConnector, grantScope, connectorCatalog } from "./connectors.mjs";
import { connectorAction } from "./connector-adapters.mjs";
import { ossCompanyPlaybook, validatePlaybook, listPlaybooks } from "./playbooks.mjs";
import { CAPABILITY_SLOTS } from "./ce-core.mjs";

test("catalog carries OSS alternatives, social (image-gen), Stripe/ERPNext", () => {
  for (const k of ["gitea", "plane", "chatwoot", "erpnext", "medusa", "stripe", "lago", "mastodon", "x-twitter", "linkedin", "nextcloud"])
    assert.ok(CONNECTOR_CATALOG[k], `missing ${k}`);
  assert.equal(CONNECTOR_CATALOG.gitea.openSource, true);
  assert.deepEqual(CONNECTOR_CATALOG.chatwoot.altTo, ["zendesk"]);
  assert.deepEqual(CONNECTOR_CATALOG.medusa.altTo, ["shopify"]);
  assert.equal(CONNECTOR_CATALOG.mastodon.needsImageGen, true);
  assert.equal(CONNECTOR_CATALOG.stripe.openSource, false);
});

test("ossAlternatives lists open-source connectors + what they replace", () => {
  const oss = ossAlternatives();
  const byKey = Object.fromEntries(oss.map((o) => [o.connector, o]));
  assert.ok(byKey.chatwoot && byKey.chatwoot.replaces.includes("zendesk"));
  assert.ok(byKey.erpnext && byKey.erpnext.replaces.includes("odoo"));
  assert.ok(byKey.mastodon.needsImageGen);
  assert.ok(!oss.some((o) => o.connector === "stripe")); // Stripe is not OSS
});

test("image-gen is a capability slot (for social posting)", () => {
  assert.ok(CAPABILITY_SLOTS.includes("image-gen"));
});

test("read adapter: read executes with data; draft prepares but does not send", async () => {
  const gh = newConnector("gitea");
  const r = await connectorAction(gh, { action: "list-issues" });
  assert.equal(r.executed, true);
  assert.equal(r.readOnly, true);
  assert.ok(r.data.issues.length);
  const d = await connectorAction(gh, { action: "draft-reply", draft: "Thanks!" });
  assert.equal(d.executed, true);
  assert.equal(d.scope, "draft");
});

test("read adapter: elevated actions are NEVER executed silently", async () => {
  let z = newConnector("chatwoot");
  // ungranted write → refused
  const w0 = await connectorAction(z, { action: "update-conversation", agent: { id: "cs" } });
  assert.equal(w0.executed, false);
  // grant communicate → still not executed here; pending human approval
  z = grantScope(z, { scope: "communicate", principal: { level: "agent", id: "cs" } });
  const send = await connectorAction(z, { action: "send-reply", agent: { id: "cs" }, payload: "Hi" });
  assert.equal(send.executed, false);
  assert.equal(send.requiresApproval, true);
  assert.equal(send.status, "pending-human-approval");
  assert.equal(send.plannedAction.action, "send-reply");
});

test("read adapter: live reads go through an injected fetchImpl", async () => {
  const c = { connector: "gitea", availableScopes: ["read"], endpoint: "http://gitea.local/api", grants: [] };
  const r = await connectorAction(c, { action: "list-issues" }, { fetchImpl: async () => ({ issues: [{ id: 1, title: "live" }] }) });
  assert.equal(r.data.issues[0].title, "live");
});

test("OSS company playbook: 5 depts, all free/local + OSS + read-only + dormant", () => {
  const pb = ossCompanyPlaybook();
  assert.equal(pb.agents.length, 5);
  const v = validatePlaybook(pb);
  assert.equal(v.ok, true, v.errors.join("; "));
  // every connector in the stack is open-source
  for (const a of pb.agents)
    for (const c of a.connectors)
      assert.equal(CONNECTOR_CATALOG[c.connector].openSource, true, `${c.connector} not OSS`);
  // marketing has image generation
  const mkt = pb.agents.find((a) => a.department === "marketing");
  assert.equal(mkt.capabilities["image-gen"], "image-gen");
  assert.ok(pb.stack.includes("Gitea") && pb.stack.includes("ERPNext"));
  assert.equal(listPlaybooks()[0].key, "oss-company");
});

test("connectorCatalog surfaces category/openSource/replaces for the picker", () => {
  const cat = connectorCatalog();
  const gitea = cat.find((c) => c.connector === "gitea");
  assert.equal(gitea.openSource, true);
  assert.equal(gitea.category, "dev");
  assert.ok(cat.every((c) => c.readOnlyDefault === true));
});
