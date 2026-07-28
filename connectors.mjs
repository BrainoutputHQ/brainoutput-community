// SPDX-License-Identifier: Apache-2.0
// BrainOutput Community Edition — connector framework + permission schema (2026-07-28, item 4).
// A CONNECTOR links an agent to a business system through EXPLICIT, scoped permissions. Pure logic;
// zero-dep. The invariant: a newly connected system is READ-ONLY. Writes, communication, destructive,
// financial and permission-changing actions each need a SEPARATE explicit grant AND (by risk policy)
// human approval. Community Edition may support writes — but never silently.

// Connection MECHANISMS the schema supports.
export const CONNECTOR_MECHANISMS = ["oauth", "api-key-local", "mcp", "openapi", "webhook", "database", "file-rag", "chat"];

// Standardized SCOPES, in increasing capability/risk. read/draft are non-mutating (safe by default);
// write/communicate/sensitive are ELEVATED — separately granted + approval-gated.
export const SCOPES = ["read", "draft", "write", "communicate", "sensitive"];
const SCOPE_RANK = { read: 0, draft: 1, write: 2, communicate: 3, sensitive: 4 };
export const SAFE_SCOPES = ["read", "draft"];
export const ELEVATED_SCOPES = ["write", "communicate", "sensitive"];

// Initial connector targets. Each declares its mechanism + the scopes it can expose.
export const CONNECTOR_CATALOG = {
  "github":          { label: "GitHub",          mechanism: "oauth",         worksWith: "GitHub",             scopes: ["read", "draft", "write", "sensitive"] },
  "jira":            { label: "Jira",            mechanism: "oauth",         worksWith: "Jira",               scopes: ["read", "draft", "write", "sensitive"] },
  "odoo":            { label: "Odoo",            mechanism: "api-key-local", worksWith: "Odoo",               scopes: ["read", "draft", "write", "sensitive"] },
  "zendesk":         { label: "Zendesk",         mechanism: "oauth",         worksWith: "Zendesk",            scopes: ["read", "draft", "write", "communicate", "sensitive"] },
  "twilio":          { label: "Twilio",          mechanism: "api-key-local", worksWith: "Twilio",             scopes: ["read", "communicate"] },
  "generic-mcp":     { label: "Generic MCP",     mechanism: "mcp",           worksWith: "any MCP server",      scopes: [...SCOPES] },
  "generic-openapi": { label: "Generic OpenAPI", mechanism: "openapi",       worksWith: "any OpenAPI/REST",    scopes: [...SCOPES] },
  "generic-rag":     { label: "Generic RAG/file",mechanism: "file-rag",      worksWith: "documents & files",   scopes: ["read"] },
  "generic-chat":    { label: "Chat knowledge",  mechanism: "chat",          worksWith: "a chat source",       scopes: ["read", "draft", "communicate"] },
};

/** Map an action verb to the SCOPE it requires. Fail-safe: an unknown mutating verb is `write`, never read. */
export function actionScope(action = "") {
  const a = String(action).toLowerCase();
  if (/(delete|remove|drop|destroy|purge|refund|payment|\bpay\b|transfer|grant|revoke|permission|deactivate)/.test(a)) return "sensitive";
  if (/^(send|reply|message|notify|email|sms|call|post-comment|dm)/.test(a)) return "communicate";
  if (/^(read|get|list|search|fetch|view|show|find)/.test(a)) return "read";
  if (/^(draft|prepare|compose|preview)/.test(a)) return "draft";
  return "write"; // create/update/edit/close/merge/assign/set/… — any other mutating action
}

/**
 * Create a connector, DEFAULTED TO READ-ONLY (no elevated grants). `auth` references a locally-stored
 * secret (e.g. an env-var name) — never a copied credential value. Pure.
 */
export function newConnector(key, { id, resources = [], auth = {} } = {}) {
  const cat = CONNECTOR_CATALOG[key];
  if (!cat) throw new Error(`unknown connector '${key}'`);
  return {
    id: id || `connector:${key}`, connector: key, label: cat.label, mechanism: cat.mechanism,
    worksWith: cat.worksWith, availableScopes: cat.scopes, resources,
    grants: [],            // no elevated grants → READ-ONLY by default
    auth,                  // { type, ref } — ref is a local secret name, not the secret itself
  };
}

/** True iff a grant's principal covers this request's agent. org ⊇ department ⊇ agent. */
function principalMatches(principal, agent = {}) {
  if (!principal || principal.level === "organization") return true;
  if (principal.level === "department") return principal.id === agent.department;
  if (principal.level === "agent") return principal.id === agent.id;
  return false;
}

/**
 * Grant an ELEVATED scope on a connector to a principal (org/department/agent), optionally narrowed to
 * a tool/action/resource/channel. Enforces: the connector must expose the scope; elevated grants
 * default to `approval: "human"`. A `read`/`draft` "grant" is unnecessary (allowed by default) but
 * accepted. Returns a NEW connector (immutable). This is the "separately granted" requirement.
 */
export function grantScope(connector, grant) {
  if (!SCOPES.includes(grant.scope)) throw new Error(`unknown scope '${grant.scope}'`);
  if (!connector.availableScopes.includes(grant.scope))
    throw new Error(`connector '${connector.connector}' does not expose scope '${grant.scope}'`);
  const g = {
    scope: grant.scope,
    principal: grant.principal || { level: "organization" },
    tool: grant.tool || null, action: grant.action || null,
    resource: grant.resource || grant.channel || null,
    // sensitive is ALWAYS human; other elevated default human; safe scopes need no approval.
    approval: grant.scope === "sensitive" ? "human"
      : ELEVATED_SCOPES.includes(grant.scope) ? (grant.approval || "human") : "none",
  };
  return { ...connector, grants: [...(connector.grants || []), g] };
}

/**
 * Decide whether an agent may perform an action on a connector resource, and whether it needs human
 * approval. read/draft are allowed by default (read-only-safe). write/communicate/sensitive require a
 * matching explicit grant; sensitive ALWAYS needs approval; a granted write/communicate needs approval
 * unless the grant explicitly set approval:"none". Pure — returns a decision, never executes.
 */
export function resolvePermission(connector, req = {}) {
  const scope = req.scope || actionScope(req.action);
  if (!connector.availableScopes.includes(scope))
    return { allowed: false, scope, requiresApproval: false, reason: `connector '${connector.connector}' does not expose '${scope}'` };
  if (SAFE_SCOPES.includes(scope))
    return { allowed: true, scope, requiresApproval: false, reason: `${scope} is allowed by default (read-only-safe)` };
  // elevated → need a grant for EXACTLY this scope (scopes are separate capabilities, not a hierarchy:
  // granting "communicate" never implies "write"). Principal must cover the agent.
  const match = (connector.grants || []).find((gr) =>
    gr.scope === scope &&
    principalMatches(gr.principal, req.agent) &&
    (!gr.tool || gr.tool === req.tool) &&
    (!gr.action || gr.action === req.action) &&
    (!gr.resource || gr.resource === (req.resource || req.channel)));
  if (!match)
    return { allowed: false, scope, requiresApproval: false,
      reason: `no grant for '${scope}' on ${connector.connector} — writes/communication/sensitive need an explicit, separate grant` };
  const requiresApproval = scope === "sensitive" || match.approval === "human";
  return { allowed: true, scope, requiresApproval,
    grantedBy: match.principal, reason: requiresApproval ? `granted; needs human approval (${scope})` : `granted (${scope})` };
}

/** Display catalog for the connector picker (item 5 UI). */
export function connectorCatalog() {
  return Object.entries(CONNECTOR_CATALOG).map(([key, c]) => ({
    connector: key, label: c.label, mechanism: c.mechanism, worksWith: c.worksWith, scopes: c.scopes,
    readOnlyDefault: true,
  }));
}
