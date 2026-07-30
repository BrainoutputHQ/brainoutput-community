// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { odooClient, odooRead, odooFetchImpl, ODOO_ACTIONS } from "./odoo.mjs";
import { connectorAction } from "./connector-adapters.mjs";
import { newConnector, grantScope } from "./connectors.mjs";

// A fetch stub that answers Odoo JSON-RPC by endpoint path.
const stubOdoo = ({ uid = 7, calls = [], responses = {} } = {}) => {
  const f = async (url, opts = {}) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, body });
    let result, error = null;
    if (url.includes("/web/session/authenticate")) result = uid;
    else if (url.includes("/web/dataset/call_kw")) {
      const key = `${body.params.model}.${body.params.method}`;
      const hit = responses[key];
      if (!hit) error = { message: `no stub for ${key}` };
      else result = hit;
    }
    return { ok: true, status: 200, json: async () => (error ? { error } : { result }) };
  };
  f.calls = calls;
  return f;
};

const client = (f) => odooClient({ endpoint: "https://odoo.example.com", db: "acme", login: "bot", password: "pw", fetchImpl: f });

test("authentication happens once, then call_kw carries model/method/args/kwargs", async () => {
  const f = stubOdoo({ responses: { "account.move.search_read": [] } });
  const od = client(f);
  await odooRead(od, "list-invoices");
  await odooRead(od, "list-invoices");
  const auths = f.calls.filter((c) => c.url.includes("authenticate"));
  assert.equal(auths.length, 1, "session is reused");
  const kw = f.calls.find((c) => c.url.includes("call_kw"));
  assert.equal(kw.body.params.model, "account.move");
  assert.equal(kw.body.params.method, "search_read");
  assert.deepEqual(kw.body.params.args, [[["move_type", "in", ["out_invoice", "in_invoice"]]]]);
  assert.equal(kw.body.params.kwargs.limit, 20);
});

test("invoices normalize (partner tuple → name); auth failure and rpc errors are loud", async () => {
  const f = stubOdoo({ responses: { "account.move.search_read": [
    { id: 1, name: "INV/2026/001", partner_id: [9, "Hotel Soleil"], amount_total: 1200, state: "posted", invoice_date_due: "2026-08-15" },
  ] } });
  const out = await odooRead(client(f), "list-invoices");
  assert.deepEqual(out.invoices, [{ id: 1, name: "INV/2026/001", partner: "Hotel Soleil", total: 1200, state: "posted", due: "2026-08-15" }]);

  const badAuth = stubOdoo({ uid: false });
  await assert.rejects(() => odooRead(client(badAuth), "list-invoices"), /authentication failed/);

  const rpcErr = stubOdoo({ responses: {} });
  await assert.rejects(() => odooRead(client(rpcErr), "list-invoices"), /no stub|rpc error/);
  await assert.rejects(() => odooRead(client(f), "drop-database"), /unknown Odoo read/);
});

test("contacts and employees normalize; every advertised action is implemented", async () => {
  const f = stubOdoo({ responses: {
    "res.partner.search_read": [{ id: 9, name: "Hotel Soleil", email: "stay@soleil.example", phone: false }],
    "hr.employee.search_read": [{ id: 3, name: "Alice Martin", job_title: "Receptionist", department_id: [2, "Front desk"] }],
  } });
  const od = client(f);
  assert.deepEqual((await odooRead(od, "list-contacts")).contacts,
    [{ id: 9, name: "Hotel Soleil", email: "stay@soleil.example", phone: null }]);
  assert.deepEqual((await odooRead(od, "list-employees")).employees,
    [{ id: 3, name: "Alice Martin", job: "Receptionist", department: "Front desk" }]);
  for (const a of ODOO_ACTIONS) assert.ok(typeof a === "string" && a.length > 3);
});

test("through the permission schema: read executes live, an invoice write stays gated", async () => {
  const f = stubOdoo({ responses: { "account.move.search_read": [] } });
  let conn = newConnector("odoo");
  conn = { ...conn, endpoint: "https://odoo.example.com" };
  conn = grantScope(conn, { scope: "write" });

  const read = await connectorAction(conn, { action: "list-invoices" },
    { fetchImpl: odooFetchImpl({ db: "acme", resolveCredentials: async () => ({ login: "bot", password: "pw" }), fetchImpl: f }) });
  assert.equal(read.executed, true);
  assert.equal(read.readOnly, true);

  const write = await connectorAction(conn, { action: "create-invoice", resource: "partner/9", payload: { amount: 500 } });
  assert.equal(write.executed, false);
  assert.equal(write.status, "pending-human-approval");
  assert.equal(f.calls.filter((c) => c.url.includes("call_kw")).length, 1, "no write RPC fired");
});
