// SPDX-License-Identifier: Apache-2.0
// Item 5 — connector vertical slice: OSS-alternative catalog, read adapters, free-OSS-company playbook.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CONNECTOR_CATALOG, ossAlternatives, newConnector, grantScope, connectorCatalog, resolvePermission } from "./connectors.mjs";
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

test("read adapter: a read with NO live client refuses instead of returning sample data", async () => {
  const gh = newConnector("gitea");
  // This used to return a hardcoded issue list as `executed: true`. Fabricated data presented as a
  // real read is the failure this codebase refuses everywhere else; it must refuse here too.
  await assert.rejects(() => connectorAction(gh, { action: "list-issues" }), /no live client|Refusing to return sample data/);

  // Sample data is still available, but only on explicit opt-in, and it says what it is.
  const s = await connectorAction(gh, { action: "list-issues" }, { allowSampleData: true });
  assert.equal(s.sample, true);
  assert.equal(s.executed, false, "sample data must never claim it executed");
  assert.ok(s.data.issues.length);

  // A real read works when a client is actually wired.
  const wired = { ...gh, endpoint: "https://gitea.example/api/v1" };
  const live = await connectorAction(wired, { action: "list-issues" },
    { fetchImpl: async () => ({ issues: [{ id: 1, title: "real" }] }) });
  assert.equal(live.executed, true);
  assert.equal(live.readOnly, true);
  assert.equal(live.data.issues[0].title, "real");

  // draft still prepares without sending
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

test("catalog covers calendars, drives and financial accounts with the right scopes", () => {
  for (const k of ["google-calendar", "outlook-calendar", "caldav", "google-drive", "onedrive", "sharepoint", "local-drive"])
    assert.ok(CONNECTOR_CATALOG[k], `missing ${k}`);
  // Banking is READ-ONLY by catalog; crypto exposes sensitive but never write/communicate.
  assert.deepEqual(CONNECTOR_CATALOG.plaid.scopes, ["read"]);
  for (const k of ["coinbase", "binance"]) {
    assert.deepEqual(CONNECTOR_CATALOG[k].scopes, ["read", "sensitive"]);
    assert.ok(!CONNECTOR_CATALOG[k].scopes.includes("write"));
  }
  // a local folder / CalDAV are the open-source alternatives
  assert.equal(CONNECTOR_CATALOG["local-drive"].openSource, true);
  assert.equal(CONNECTOR_CATALOG.caldav.openSource, true);
});

test("a financial connector cannot be granted anything but sensitive/read", () => {
  const c = newConnector("binance");
  assert.throws(() => grantScope(c, { scope: "communicate" }), /does not expose/);
  assert.throws(() => grantScope(newConnector("plaid"), { scope: "sensitive" }), /does not expose/); // Plaid: read only
  const g = grantScope(c, { scope: "sensitive", principal: { level: "agent", id: "fin" } });
  assert.equal(g.grants[0].approval, "human");   // forced human, always
});

test("connectorCatalog surfaces category/openSource/replaces for the picker", () => {
  const cat = connectorCatalog();
  const gitea = cat.find((c) => c.connector === "gitea");
  assert.equal(gitea.openSource, true);
  assert.equal(gitea.category, "dev");
  assert.ok(cat.every((c) => c.readOnlyDefault === true));
});

test("workplace chat connectors: Slack, Discord and an open-source alternative", () => {
  for (const k of ["slack", "discord", "mattermost"]) {
    assert.ok(CONNECTOR_CATALOG[k], `missing ${k}`);
    assert.equal(CONNECTOR_CATALOG[k].category, "chat");
    assert.ok(CONNECTOR_CATALOG[k].scopes.includes("communicate"));
  }
  assert.equal(CONNECTOR_CATALOG.mattermost.openSource, true);
  assert.deepEqual(CONNECTOR_CATALOG.mattermost.altTo, ["slack"]);
  // read is fine by default; posting to a channel is not
  const slack = newConnector("slack");
  assert.equal(resolvePermission(slack, { action: "read-messages" }).allowed, true);
  assert.equal(resolvePermission(slack, { action: "send-message" }).allowed, false);
  const granted = grantScope(slack, { scope: "communicate", principal: { level: "agent", id: "cs" }, resource: "#support" });
  const ok = resolvePermission(granted, { action: "send-message", agent: { id: "cs" }, resource: "#support" });
  assert.equal(ok.allowed, true);
  assert.equal(ok.requiresApproval, true);                       // never silent
  // a different channel is not covered by that grant
  assert.equal(resolvePermission(granted, { action: "send-message", agent: { id: "cs" }, resource: "#exec" }).allowed, false);
});
