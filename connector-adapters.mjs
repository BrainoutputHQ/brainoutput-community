// SPDX-License-Identifier: Apache-2.0
// BrainOutput Community Edition — connector read adapters (item 5 vertical slice, 2026-07-28).
// Performs (or REFUSES) a connector action under the permission schema (connectors.mjs). read/draft
// execute now; write/communicate/sensitive are NEVER executed silently — they return the decision and
// a pending human approval so the gate can act. Deterministic sample reads make the slice demonstrable
// without live credentials; a real deployment injects opts.fetchImpl to hit the system's read endpoint.
import { resolvePermission } from "./connectors.mjs";

// Representative read shapes per connector (open-source and SaaS targets).
const SAMPLE_READS = {
  github:   () => ({ issues: [{ id: 42, title: "Flaky CI test", state: "open" }] }),
  gitea:    () => ({ issues: [{ id: 7, title: "Add dark mode", state: "open" }] }),
  jira:     () => ({ issues: [{ key: "OPS-12", summary: "Rotate keys", status: "To Do" }] }),
  plane:    () => ({ issues: [{ id: "PLN-3", name: "Launch checklist", state: "started" }] }),
  zendesk:  () => ({ tickets: [{ id: 100, subject: "Refund request", status: "open" }] }),
  chatwoot: () => ({ conversations: [{ id: 5, subject: "Where is my order?", status: "open" }] }),
  odoo:     () => ({ invoices: [{ id: "INV/2026/001", amount: 1200, state: "posted" }] }),
  erpnext:  () => ({ sales_orders: [{ name: "SO-0001", grand_total: 4200, status: "To Deliver" }] }),
  shopify:  () => ({ orders: [{ id: 111, total: 120, financial_status: "paid" }] }),
  medusa:   () => ({ orders: [{ id: "order_1", total: 89, status: "pending" }] }),
  stripe:   () => ({ charges: [{ id: "ch_1", amount: 2000, status: "succeeded" }] }),
  lago:     () => ({ invoices: [{ lago_id: "li_1", total_amount_cents: 5000, status: "finalized" }] }),
  mastodon: () => ({ notifications: [{ id: 1, type: "mention", note: "loved your post" }] }),
  nextcloud:() => ({ files: [{ path: "/legal/policy.md", size: 3400 }] }),
  "generic-rag":  () => ({ chunks: [{ source: "policy.md", text: "Refunds within 30 days.", score: 0.82 }] }),
  "generic-chat": () => ({ messages: [{ author: "customer", text: "Is there a student discount?" }] }),
};

export async function connectorAction(connector, req = {}, opts = {}) {
  const decision = resolvePermission(connector, req);
  const scope = decision.scope;
  const base = { connector: connector.connector, action: req.action, scope };
  if (!decision.allowed) return { ...base, executed: false, requiresApproval: false, reason: decision.reason };

  if (scope === "read") {
    const data = opts.fetchImpl && connector.endpoint
      ? await opts.fetchImpl(connector, req)
      : (SAMPLE_READS[connector.connector] || (() => ({ note: "no sample for this connector" })))(req);
    return { ...base, executed: true, requiresApproval: false, readOnly: true, data };
  }
  if (scope === "draft")
    return { ...base, executed: true, requiresApproval: false, draft: req.draft || "(prepared, not sent)" };

  // write / communicate / sensitive — granted, but NEVER executed here. Hand to the human gate.
  return { ...base, executed: false, requiresApproval: decision.requiresApproval, status: "pending-human-approval",
    reason: decision.reason, plannedAction: { action: req.action, resource: req.resource || req.channel || null, payload: req.payload || null } };
}
