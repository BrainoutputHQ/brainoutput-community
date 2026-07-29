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
  "microsoft-teams": () => ({ channel: "General", team: "Sales", messages: [{ user: "Robin Kline", text: "Can we confirm the Q3 renewal terms before Friday?" }] }),
  slack:    () => ({ channel: "#sales", messages: [{ user: "@dana", ts: "1753651200.0", text: "Can we confirm the Q3 renewal terms before Friday?" }] }),
  discord:  () => ({ channel: "#support", messages: [{ user: "kai#4417", text: "The installer fails on step 3 — any workaround?" }] }),
  mattermost: () => ({ channel: "~ops", messages: [{ user: "@sam", text: "Deploy window moved to Thursday." }] }),
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

/**
 * Execute an elevated action ONLY after a human approval. Re-checks the grant (fail-closed) and
 * requires an approved approval when the action needs one — a write/communicate/sensitive action can
 * never run without both an explicit grant AND approval. Optional execImpl performs the live write.
 */
export async function executeApprovedAction(connector, req = {}, approval = null, opts = {}) {
  const decision = resolvePermission(connector, req);
  const base = { connector: connector.connector, action: req.action, scope: decision.scope };
  if (!decision.allowed) return { ...base, executed: false, reason: `not permitted: ${decision.reason}` };
  if (decision.requiresApproval && !(approval && approval.status === "approved"))
    return { ...base, executed: false, requiresApproval: true, reason: "blocked — human approval required and not granted" };
  const result = opts.execImpl && connector.endpoint
    ? await opts.execImpl(connector, req)
    : { applied: true, action: req.action, resource: req.resource || req.channel || null, echo: req.payload ?? null };
  return { ...base, executed: true, approvedBy: (approval && (approval.approvedBy || approval.id)) || "human", result };
}
