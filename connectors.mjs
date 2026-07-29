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

// Connector targets. Each declares mechanism · exposed scopes · category · whether it is open-source ·
// what SaaS it can replace (`altTo`) · whether it typically needs image generation (social posting).
const RWS = ["read", "draft", "write", "sensitive"];               // read/manage records
const RWCS = ["read", "draft", "write", "communicate", "sensitive"]; // + send externally
export const CONNECTOR_CATALOG = {
  // — Developer / project management —
  "github":  { label: "GitHub",  mechanism: "oauth",         category: "dev", openSource: false, worksWith: "GitHub",  scopes: RWS },
  "gitea":   { label: "Gitea",   mechanism: "api-key-local", category: "dev", openSource: true,  altTo: ["github"], worksWith: "Gitea", scopes: RWS },
  "jira":    { label: "Jira",    mechanism: "oauth",         category: "pm",  openSource: false, worksWith: "Jira",    scopes: RWS },
  "plane":   { label: "Plane",   mechanism: "api-key-local", category: "pm",  openSource: true,  altTo: ["jira"], worksWith: "Plane", scopes: RWS },
  // — Customer support —
  "zendesk": { label: "Zendesk", mechanism: "oauth",         category: "support", openSource: false, worksWith: "Zendesk",  scopes: RWCS },
  "chatwoot":{ label: "Chatwoot",mechanism: "api-key-local", category: "support", openSource: true,  altTo: ["zendesk"], worksWith: "Chatwoot", scopes: RWCS },
  // — ERP / commerce / finance —
  "odoo":    { label: "Odoo (Community)", mechanism: "api-key-local", category: "erp", openSource: true, worksWith: "Odoo", scopes: RWS },
  "erpnext": { label: "ERPNext", mechanism: "api-key-local", category: "erp", openSource: true, altTo: ["sap", "odoo"], worksWith: "ERPNext", scopes: RWS },
  "shopify": { label: "Shopify", mechanism: "oauth",         category: "commerce", openSource: false, worksWith: "Shopify", scopes: RWS },
  "medusa":  { label: "Medusa",  mechanism: "api-key-local", category: "commerce", openSource: true, altTo: ["shopify"], worksWith: "Medusa", scopes: RWS },
  "stripe":  { label: "Stripe",  mechanism: "api-key-local", category: "payments", openSource: false, worksWith: "Stripe", scopes: ["read", "sensitive"] },
  "lago":    { label: "Lago",    mechanism: "api-key-local", category: "billing",  openSource: true, altTo: ["stripe-billing"], worksWith: "Lago", scopes: ["read", "write", "sensitive"] },
  // — Workplace chat —
  "microsoft-teams": { label: "Microsoft Teams", mechanism: "oauth", category: "chat", openSource: false, worksWith: "Microsoft Teams", scopes: ["read", "draft", "write", "communicate", "sensitive"] },
  "slack":   { label: "Slack",    mechanism: "oauth",         category: "chat", openSource: false, worksWith: "Slack", scopes: ["read", "draft", "write", "communicate", "sensitive"] },
  "discord": { label: "Discord",  mechanism: "api-key-local", category: "chat", openSource: false, worksWith: "Discord", scopes: ["read", "draft", "write", "communicate", "sensitive"] },
  "mattermost": { label: "Mattermost", mechanism: "api-key-local", category: "chat", openSource: true, altTo: ["slack"], worksWith: "Mattermost", scopes: ["read", "draft", "write", "communicate", "sensitive"] },
  // — Messaging / social (posting typically needs image generation) —
  "twilio":  { label: "Twilio",  mechanism: "api-key-local", category: "messaging", openSource: false, worksWith: "Twilio", scopes: ["read", "communicate"] },
  "mastodon":{ label: "Mastodon",mechanism: "api-key-local", category: "social", openSource: true, altTo: ["x-twitter"], needsImageGen: true, worksWith: "Mastodon", scopes: ["read", "draft", "communicate"] },
  "x-twitter":{label: "X (Twitter)", mechanism: "oauth",    category: "social", openSource: false, needsImageGen: true, worksWith: "X", scopes: ["read", "draft", "communicate"], approval: "X API v2 — posting and most reads are on PAID tiers" },
  "linkedin":{ label: "LinkedIn",mechanism: "oauth",         category: "social", openSource: false, needsImageGen: true, worksWith: "LinkedIn", scopes: ["read", "draft", "communicate"], approval: "LinkedIn app + Marketing Developer Platform review before posting" },
  "facebook":{ label: "Facebook", mechanism: "oauth",        category: "social", openSource: false, needsImageGen: true, worksWith: "Facebook", scopes: ["read", "draft", "communicate"], approval: "Meta app review; Page posting needs pages_manage_posts" },
  "instagram":{label: "Instagram",mechanism: "oauth",        category: "social", openSource: false, needsImageGen: true, worksWith: "Instagram", scopes: ["read", "draft", "communicate"], approval: "Meta app review; publishing requires an Instagram BUSINESS account",
    // Founder decision 2026-07-29: BYOK now, hosted later. The credential lives in the CUSTOMER's
    // sealed store and a deterministic connector signs the call — an agent only ever drafts.
    // See social-publishing.mjs for the enforcement and its tests.
    connectionModes: ["own-meta-app", "brainoutput-app"], deterministicPublish: true, agentSeesCredential: false },
  "tiktok":{   label: "TikTok",   mechanism: "oauth",        category: "social", openSource: false, needsImageGen: true, worksWith: "TikTok", scopes: ["read", "draft", "communicate"], approval: "TikTok Content Posting API audit before unaudited drafts can go public" },
  "youtube":{  label: "YouTube",  mechanism: "oauth",        category: "social", openSource: false, needsImageGen: true, worksWith: "YouTube", scopes: ["read", "draft", "communicate"], approval: "Google OAuth verification for the YouTube Data API scopes" },
  // — Banking / crypto (value-moving actions are ALWAYS sensitive + human-approved) —
  "plaid":   { label: "Plaid",    mechanism: "api-key-local", category: "banking", openSource: false, worksWith: "Plaid", scopes: ["read"] },
  "coinbase":{ label: "Coinbase", mechanism: "api-key-local", category: "crypto",  openSource: false, worksWith: "Coinbase", scopes: ["read", "sensitive"] },
  "binance": { label: "Binance",  mechanism: "api-key-local", category: "crypto",  openSource: false, worksWith: "Binance", scopes: ["read", "sensitive"] },
  // — Calendars & drives —
  "google-calendar": { label: "Google Calendar", mechanism: "oauth", category: "calendar", openSource: false, worksWith: "Google Calendar", scopes: ["read", "draft", "write"] },
  "outlook-calendar":{ label: "Outlook Calendar",mechanism: "oauth", category: "calendar", openSource: false, worksWith: "Microsoft 365", scopes: ["read", "draft", "write"] },
  "caldav":  { label: "CalDAV",   mechanism: "api-key-local", category: "calendar", openSource: true, altTo: ["google-calendar"], worksWith: "any CalDAV server", scopes: ["read", "draft", "write"] },
  "google-drive": { label: "Google Drive", mechanism: "oauth", category: "files", openSource: false, worksWith: "Google Drive", scopes: ["read", "draft", "write", "sensitive"] },
  "onedrive": { label: "OneDrive", mechanism: "oauth", category: "files", openSource: false, worksWith: "OneDrive", scopes: ["read", "draft", "write", "sensitive"] },
  "sharepoint": { label: "SharePoint", mechanism: "oauth", category: "files", openSource: false, worksWith: "SharePoint", scopes: ["read", "draft", "write", "sensitive"] },
  "local-drive": { label: "A folder on this computer", mechanism: "file-rag", category: "files", openSource: true, altTo: ["google-drive", "onedrive"], worksWith: "your filesystem", scopes: ["read"] },

  // — Knowledge / files —
  "nextcloud":{label: "Nextcloud",mechanism: "api-key-local",category: "files", openSource: true, altTo: ["google-drive", "sharepoint"], worksWith: "Nextcloud", scopes: ["read", "write"] },
  // — Generic —
  "generic-mcp":     { label: "Generic MCP",     mechanism: "mcp",     category: "generic", openSource: null, worksWith: "any MCP server",   scopes: [...SCOPES] },
  "generic-openapi": { label: "Generic OpenAPI", mechanism: "openapi", category: "generic", openSource: null, worksWith: "any OpenAPI/REST", scopes: [...SCOPES] },
  "generic-rag":     { label: "Generic RAG/file",mechanism: "file-rag",category: "generic", openSource: null, worksWith: "documents & files", scopes: ["read"] },
  "generic-chat":    { label: "Chat knowledge",  mechanism: "chat",    category: "generic", openSource: null, worksWith: "a chat source",     scopes: ["read", "draft", "communicate"] },
};

/** OSS connectors grouped by what SaaS they can replace — for the "build it free" playbook. */
export function ossAlternatives() {
  return Object.entries(CONNECTOR_CATALOG)
    .filter(([, c]) => c.openSource === true)
    .map(([key, c]) => ({ connector: key, label: c.label, category: c.category, replaces: c.altTo || [], needsImageGen: !!c.needsImageGen }));
}

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
    category: c.category, openSource: c.openSource, replaces: c.altTo || [], needsImageGen: !!c.needsImageGen,
    readOnlyDefault: true,
  }));
}
