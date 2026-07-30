// SPDX-License-Identifier: Apache-2.0
// BrainOutput Community Edition — Odoo connector: live read-only client (2026-07-30, D6-7).
// Answers from chat like "revenue last quarter?" need real ERP reads: invoices, contacts,
// employees. This client speaks Odoo's JSON-RPC (works on Odoo 14+ community/enterprise,
// self-hosted or Odoo Online — the customer's endpoint). Read-only by design here; writes
// (create an invoice) stay behind the connector permission schema, never silent.
// Credentials resolve at execution time (e.g. store.secretResolver()) — never in the
// exportable company definition. Zero-dep (Node ≥18 fetch).
//
//   const od = odooClient({ endpoint, db, login, password });
//   await odooRead(od, "list-invoices", { limit: 20 });
export const ODOO_ACTIONS = ["list-invoices", "list-contacts", "list-employees"];

export function odooClient({ endpoint, db, login, password, fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  if (!endpoint || !/^https?:\/\//.test(endpoint)) throw new Error("odooClient needs an http(s) endpoint — the customer's Odoo URL");
  if (!db) throw new Error("odooClient needs a database name");
  const base = endpoint.replace(/\/+$/, "");
  let uid = null;

  async function rpc(path, params) {
    const r = await fetchImpl(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "call", id: 1, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) throw new Error(`Odoo ${path} → HTTP ${r.status}`);
    const j = await r.json();
    if (j.error) throw new Error(`Odoo ${path}: ${j.error.data?.message || j.error.message || "rpc error"}`);
    return j.result;
  }

  async function authenticate() {
    if (uid) return uid;
    uid = await rpc("/web/session/authenticate", { db, login, password });
    if (!uid) throw new Error(`Odoo authentication failed for '${login}' on db '${db}' — check the login and password`);
    return uid;
  }

  async function callKw(model, method, args = [], kwargs = {}) {
    const id = await authenticate();
    return rpc("/web/dataset/call_kw", { model, method, args, kwargs: { context: { lang: "en_US" }, ...kwargs } });
  }

  return { authenticate, callKw };
}

const normInvoice = (v) => ({ id: v.id, name: v.name, partner: Array.isArray(v.partner_id) ? v.partner_id[1] : null,
  total: v.amount_total ?? null, state: v.state || null, due: v.invoice_date_due || null });
const normContact = (p) => ({ id: p.id, name: p.name, email: p.email || null, phone: p.phone || null });
const normEmployee = (e) => ({ id: e.id, name: e.name, job: e.job_title || null,
  department: Array.isArray(e.department_id) ? e.department_id[1] : null });

export async function odooRead(od, action, { limit = 20 } = {}) {
  switch (action) {
    case "list-invoices":
      return { invoices: (await od.callKw("account.move", "search_read",
        [[["move_type", "in", ["out_invoice", "in_invoice"]]]],
        { fields: ["name", "partner_id", "amount_total", "state", "invoice_date_due"], limit, order: "invoice_date desc" })).map(normInvoice) };
    case "list-contacts":
      return { contacts: (await od.callKw("res.partner", "search_read", [[]],
        { fields: ["name", "email", "phone"], limit, order: "name asc" })).map(normContact) };
    case "list-employees":
      // HR data is the most sensitive listing here — the connector permission schema gates it
      // by resource upstream; this client just performs the read it was allowed to perform.
      return { employees: (await od.callKw("hr.employee", "search_read", [[]],
        { fields: ["name", "job_title", "department_id"], limit, order: "name asc" })).map(normEmployee) };
    default:
      throw new Error(`unknown Odoo read '${action}' — one of ${ODOO_ACTIONS.join(", ")}`);
  }
}

/**
 * Bridge to the connector permission schema (connector-adapters.mjs): a fetchImpl that performs
 * the requested READ via a live client. `resolveCredentials` yields { login, password } at
 * execution time — the secret never sits in the exportable definition.
 */
export function odooFetchImpl({ endpoint, db, resolveCredentials, fetchImpl = fetch } = {}) {
  return async (connector, req) => {
    const creds = typeof resolveCredentials === "function" ? await resolveCredentials() : resolveCredentials;
    const od = odooClient({ endpoint: endpoint || connector.endpoint, db, login: creds?.login, password: creds?.password, fetchImpl });
    return odooRead(od, req.action, req);
  };
}
