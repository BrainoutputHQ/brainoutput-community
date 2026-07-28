// SPDX-License-Identifier: Apache-2.0
// BrainOutput Community Edition — Work Twin (2026-07-28).
//
// A WORK TWIN is a dedicated agent bound to ONE human employee and that person's authorized workplace
// context. It is distinct from a departmental agent: it represents a person, never a function.
//
// Three permission modes, in increasing capability:
//   mirror   — read, search, summarize, explain. No external modification whatsoever.
//   copilot  — additionally PREPARE drafts, tasks, briefs and proposed actions. Never sends.
//   delegate — additionally EXECUTE explicitly granted actions, within scoped permissions + approvals.
//
// Two invariants that never bend:
//   1. NO SILENT IMPERSONATION — every draft or action records who is represented, by which twin, on
//      which model/runtime and account, under which permission and approval, with its sources.
//   2. THE MAILBOX IS NOT CONTEXT — only information relevant to the current request is retrieved, and
//      what leaves is a compact, source-referenced packet. Never the whole mailbox, never a transcript.
//
// Work Twins are DORMANT: nothing here polls. Work happens on a user request, a connector event, or
// deterministic indexing. Pure logic; zero-dep.
import { newConversation, addMessage, pin, draftMissionSpec } from "./chat.mjs";
import { resolvePermission } from "./connectors.mjs";

export const WORK_TWIN_MODES = ["mirror", "copilot", "delegate"];

// A mode grants a set of connector SCOPES. Elevated scopes still require an explicit grant and the
// applicable approval — the mode is a ceiling, never a bypass.
const MODE_SCOPES = {
  mirror:   ["read"],
  copilot:  ["read", "draft"],
  delegate: ["read", "draft", "write", "communicate"],   // "sensitive" is never granted by mode alone
};
export function modeScopes(mode) { return [...(MODE_SCOPES[mode] || [])]; }

// Work-source kinds sharing one connection abstraction.
export const WORK_SOURCE_KINDS = [
  "google-workspace", "microsoft-365", "imap", "local-mail",
  "calendar", "drive", "onedrive", "sharepoint", "workplace-chat", "connector", "rag",
];

const tokenize = (s) => (String(s).toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w.length > 2);

// ── Profile ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Create a Work Twin for one employee. Starts in MIRROR mode and DORMANT, with no connected accounts
 * and no elevated grants — the safe default a new user should land on.
 */
export function createWorkTwin({ id, employee, name = null, modelPolicy = null } = {}) {
  if (!employee || !employee.id) throw new Error("work twin: an employee identity is required");
  return {
    id: id || `twin-${employee.id}`,
    kind: "work-twin",
    name: name || `${employee.name || employee.id}'s Work Twin`,
    employee: { id: employee.id, name: employee.name || employee.id, email: employee.email || null },
    mode: "mirror",
    modelPolicy: modelPolicy || { mode: "regular", stages: {} },   // advanced may set per-stage models
    accounts: [],          // connected work sources
    resources: [],         // permitted folders/labels/mailboxes/channels
    grants: [],            // explicit elevated grants (beyond the mode ceiling)
    approvalPolicy: { send: "human", delete: "human", "permission-change": "human", financial: "human" },
    preferences: {},       // retained preferences (tone, signature, working hours…)
    knowledgeSources: [],  // RAG/company knowledge the twin may read
    taskHistory: [],
    audit: [],
    index: [],             // deterministic message index (headers + snippets) — NOT full bodies
    activation: "dormant",
  };
}

/** A twin safe to send over the wire: no secrets, no index bodies. */
export function publicTwin(twin) {
  return { ...twin, index: undefined, indexSize: (twin.index || []).length,
    accounts: (twin.accounts || []).map(({ secret, config, ...a }) => ({ ...a,
      config: config ? { ...config, password: undefined } : undefined, hasSecret: !!secret })) };
}

export function setMode(twin, mode) {
  if (!WORK_TWIN_MODES.includes(mode)) throw new Error(`unknown Work Twin mode '${mode}'`);
  return { ...twin, mode };
}

/** Connect a work source. ALWAYS lands in mirror-safe state: read-only, no elevated grants. */
export function connectWorkSource(twin, { kind, account, label = null, resources = [], connector = null, config = {}, secret = null } = {}) {
  if (!WORK_SOURCE_KINDS.includes(kind)) throw new Error(`unknown work source '${kind}'`);
  if (!account) throw new Error("work source: an account identifier is required");
  const acc = {
    id: `${kind}:${account}`, kind, account, label: label || account,
    resources: [...resources],       // permitted folders/labels/mailboxes/channels
    scope: "read",                   // new connections default to READ-ONLY (Mirror)
    connector,                       // optional connectors.mjs connector for elevated actions
    // How to reconnect later. NEVER holds a credential value: a password lives in `secret` (kept
    // local and stripped from every API response) or, preferably, in `config.passwordEnv`.
    config: { ...config },
    secret: secret || null,
    connectedAt: null,
  };
  return { ...twin, accounts: [...twin.accounts, acc], resources: [...twin.resources, ...resources] };
}

/** Grant an elevated scope explicitly (beyond the mode ceiling). Sensitive is always human-approved. */
export function grantTwinScope(twin, { scope, action = null, resource = null, approval = null }) {
  if (!["draft", "write", "communicate", "sensitive"].includes(scope))
    throw new Error(`cannot grant '${scope}' — elevated scopes only`);
  const g = { scope, action: action ? canonicalAction(action) : null, resource,
    approval: scope === "sensitive" ? "human" : approval || "human" };
  return { ...twin, grants: [...twin.grants, g] };
}

// ── Permission resolution ───────────────────────────────────────────────────────────────────────

// Read-only capability names the Work Twin exposes. Anything not listed and not obviously read is
// treated as WRITE — fail-safe: an unknown verb never silently counts as reading.
const READ_ACTIONS = new Set([
  "priority-summary", "unanswered", "search-mail", "commitments", "meeting-brief", "follow-ups",
  "explain", "inspect", "email-to-mission", "delegate",
]);
// Different surfaces name the same act differently ("send-draft" in the API, "send-email" inside).
// Canonicalize so a grant the user creates for what they SEE always matches what is checked.
const CANONICAL_ACTION = { "send-draft": "send-email", "send-reply": "send-email", "send": "send-email",
  "reply-send": "send-email", "forward": "send-email" };
export const canonicalAction = (a) => CANONICAL_ACTION[String(a || "").toLowerCase()] || String(a || "");

const SCOPE_OF_ACTION = (action = "") => {
  const a = canonicalAction(action).toLowerCase();
  if (/(delete|purge|archive-all|revoke|grant-permission|permission-change|payment|refund|transfer|wire)/.test(a)) return "sensitive";
  if (/^(send|reply-send|forward|email-send|notify|invite|schedule-send)/.test(a)) return "communicate";
  if (READ_ACTIONS.has(a)) return "read";
  if (/^(read|search|list|open|fetch|inspect|explain|summar)/.test(a)) return "read";
  if (/^(draft|prepare|compose|propose|brief)/.test(a)) return "draft";
  return "write";
};

/**
 * May this twin perform `action`? The MODE is a ceiling; elevated actions additionally need an explicit
 * grant; sensitive always needs a human. Where a real connector backs the account, its permission
 * schema is consulted too — the twin can never exceed the connector's grants.
 */
export function twinPermission(twin, { action, resource = null, accountId = null } = {}) {
  const scope = SCOPE_OF_ACTION(action);
  const allowedByMode = modeScopes(twin.mode).includes(scope);
  const base = { action, scope, mode: twin.mode };

  if (!allowedByMode)
    return { ...base, allowed: false, requiresApproval: false,
      reason: scope === "sensitive"
        ? `'${action}' is a sensitive action — it needs an explicit grant and human approval`
        : `Work Twin is in ${twin.mode} mode, which cannot ${scope}. Switch mode and grant '${scope}'.` };

  if (scope === "read" || scope === "draft") {
    // Copilot drafts are internal artifacts: allowed, never sent.
    return { ...base, allowed: true, requiresApproval: false, reason: `${scope} is permitted in ${twin.mode} mode` };
  }

  // write / communicate: mode allows it, but an explicit grant is still required.
  const act = canonicalAction(action);
  const grant = (twin.grants || []).find((g) => g.scope === scope &&
    (!g.action || canonicalAction(g.action) === act) && (!g.resource || g.resource === resource));
  if (!grant)
    return { ...base, allowed: false, requiresApproval: false,
      reason: `no explicit grant for '${scope}' — delegate mode still requires a scoped grant` };

  // If a real connector backs this account, it has the final say (a twin never bypasses it).
  const acc = accountId ? (twin.accounts || []).find((a) => a.id === accountId) : null;
  if (acc?.connector) {
    const d = resolvePermission(acc.connector, { action, resource, agent: { id: twin.id } });
    if (!d.allowed) return { ...base, allowed: false, requiresApproval: false, reason: `connector denied: ${d.reason}` };
    return { ...base, allowed: true, requiresApproval: d.requiresApproval || approvalRequired(twin, action), reason: d.reason };
  }
  return { ...base, allowed: true, requiresApproval: approvalRequired(twin, action), reason: `granted '${scope}' in ${twin.mode} mode` };
}

function approvalRequired(twin, action) {
  const p = twin.approvalPolicy || {};
  const act = canonicalAction(action);
  const scope = SCOPE_OF_ACTION(act);
  if (scope === "sensitive") return true;
  if (scope === "communicate") return (p.send || "human") === "human";
  return p[act] === "human" || false;
}

// ── Identity & audit — no silent impersonation ──────────────────────────────────────────────────

/**
 * Record exactly who did what, on whose behalf, with which model and account, under which permission
 * and approval, from which sources. Every draft and every action produces one of these.
 */
export function auditRecord(twin, { action, permission, approval = "not-required", model = null, runtime = null,
  accountId = null, sources = [], result = null, at = null } = {}) {
  return {
    at,
    representedEmployee: { id: twin.employee.id, name: twin.employee.name, email: twin.employee.email },
    workTwin: { id: twin.id, name: twin.name, mode: twin.mode },
    model, runtime, account: accountId,
    action, permission, approval,
    sources: sources.map((s) => (typeof s === "string" ? s : s.ref || s.citation || s.id)).filter(Boolean),
    result,
  };
}
export function withAudit(twin, record) { return { ...twin, audit: [...(twin.audit || []), record] }; }

/**
 * Attribution carried by every draft: it is prepared BY the Work Twin ON BEHALF OF the employee, and
 * it is never presented as written by the human. Sending is a separate, approved step.
 */
export function draftAttribution(twin, { model = null, runtime = null } = {}) {
  return {
    preparedBy: { workTwin: twin.id, name: twin.name },
    onBehalfOf: { id: twin.employee.id, name: twin.employee.name, email: twin.employee.email },
    model, runtime,
    disclosure: `Drafted by ${twin.name} on behalf of ${twin.employee.name}. Not sent — review and approve first.`,
    sent: false,
  };
}

// ── Context discipline: index + retrieve, never the whole mailbox ───────────────────────────────

/**
 * Deterministic index of message METADATA and a short snippet — never full bodies. This is what makes
 * retrieval cheap and keeps the mailbox out of the model's context.
 */
export function indexMessages(twin, messages = [], { snippetChars = 240 } = {}) {
  const entries = messages.map((m) => ({
    id: m.id,
    accountId: m.accountId || null,
    threadId: m.threadId || m.id,
    from: m.from || null,
    to: m.to || [],
    subject: m.subject || "",
    date: m.date ?? null,
    unread: !!m.unread,
    folder: m.folder || null,
    labels: m.labels || [],
    attachments: (m.attachments || []).map((a) => (typeof a === "string" ? a : a.name)),
    snippet: String(m.body || m.snippet || "").slice(0, snippetChars),
    ref: `${m.accountId || "mail"}:${m.id}`,
    terms: tokenize(`${m.subject || ""} ${m.from || ""} ${(m.attachments || []).map((a) => (typeof a === "string" ? a : a.name)).join(" ")} ${String(m.body || m.snippet || "").slice(0, snippetChars)}`),
  }));
  return { ...twin, index: [...(twin.index || []), ...entries] };
}

/** Only the resources the twin is permitted to see. */
function permittedIndex(twin) {
  const allowed = new Set(twin.resources || []);
  if (!allowed.size) return twin.index || [];
  return (twin.index || []).filter((e) => !e.folder || allowed.has(e.folder) || (e.labels || []).some((l) => allowed.has(l)));
}

/**
 * Retrieve ONLY what is relevant to this request, as compact, source-referenced items. This is the
 * boundary: the mailbox never becomes context — this small set does.
 */
export function retrieveForRequest(twin, query, { k = 5 } = {}) {
  const q = new Set(tokenize(query));
  return permittedIndex(twin)
    .map((e) => {
      const tf = {};
      for (const t of e.terms) tf[t] = (tf[t] || 0) + 1;
      let score = 0;
      for (const t of q) if (tf[t]) score += 1 + Math.log(1 + tf[t]);
      return { e, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || (b.e.date || 0) - (a.e.date || 0))
    .slice(0, k)
    .map((x) => ({ ref: x.e.ref, subject: x.e.subject, from: x.e.from, date: x.e.date,
      snippet: x.e.snippet, citation: `${x.e.from || "unknown"} — ${x.e.subject || "(no subject)"}` }));
}

// ── Core capabilities (deterministic; a model only writes prose) ─────────────────────────────────

/** Unread + priority summary. Priority is explainable, not a black box. */
export function prioritySummary(twin, { now = null, vip = [] } = {}) {
  const me = (twin.employee.email || "").toLowerCase();
  const items = permittedIndex(twin).filter((e) => e.unread).map((e) => {
    const reasons = [];
    if (vip.includes((e.from || "").toLowerCase())) reasons.push("from a VIP sender");
    if ((e.to || []).map((x) => String(x).toLowerCase()).includes(me)) reasons.push("addressed directly to you");
    if (/\?/.test(e.snippet) || /\?/.test(e.subject)) reasons.push("contains a question");
    if (/(urgent|asap|deadline|today|tomorrow|eod|by friday|overdue)/i.test(`${e.subject} ${e.snippet}`)) reasons.push("time pressure");
    if (e.attachments.length) reasons.push("has attachments");
    return { ref: e.ref, from: e.from, subject: e.subject, date: e.date, reasons, priority: reasons.length };
  });
  return items.sort((a, b) => b.priority - a.priority || (b.date || 0) - (a.date || 0));
}

/**
 * Threads where the last word came from someone else and the employee has not replied — the honest
 * definition of "unanswered", computed deterministically, with an optional age threshold.
 */
export function unansweredThreads(twin, { now = Date.now(), olderThanHours = 0 } = {}) {
  const me = (twin.employee.email || "").toLowerCase();
  const byThread = new Map();
  for (const e of permittedIndex(twin)) {
    const list = byThread.get(e.threadId) || [];
    list.push(e);
    byThread.set(e.threadId, list);
  }
  const out = [];
  for (const [threadId, msgs] of byThread) {
    msgs.sort((a, b) => (a.date || 0) - (b.date || 0));
    const last = msgs[msgs.length - 1];
    const lastFromMe = String(last.from || "").toLowerCase().includes(me) && me;
    if (lastFromMe) continue;                                     // we replied last → answered
    const ageH = last.date != null ? (now - last.date) / 3600000 : Infinity;
    if (ageH < olderThanHours) continue;
    out.push({ threadId, ref: last.ref, from: last.from, subject: last.subject, date: last.date,
      waitingHours: Number.isFinite(ageH) ? Math.round(ageH) : null, messages: msgs.length });
  }
  return out.sort((a, b) => (b.waitingHours || 0) - (a.waitingHours || 0));
}

/** Search messages and attachment names within permitted resources. */
export function searchWork(twin, query, { k = 10 } = {}) { return retrieveForRequest(twin, query, { k }); }

/** Extract tasks, commitments and deadlines. Deterministic patterns, each with its source. */
export function extractCommitments(twin, { refs = null } = {}) {
  const pool = permittedIndex(twin).filter((e) => !refs || refs.includes(e.ref));
  const out = [];
  const commitRe = /\b(i (?:will|'ll|can|shall)|we (?:will|'ll)|i commit to|i'll send|i will send|happy to)\b[^.!?\n]{0,120}/gi;
  const askRe = /\b(can you|could you|please|would you|need you to|waiting for)\b[^.!?\n]{0,120}/gi;
  const dateRe = /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|eod|end of (?:day|week)|by \w+ \d{1,2}|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2})\b/gi;
  for (const e of pool) {
    const text = `${e.subject}. ${e.snippet}`;
    for (const [re, kind] of [[commitRe, "commitment"], [askRe, "request"]]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) {
        const span = m[0].trim();
        const dates = span.match(dateRe) || text.match(dateRe) || [];
        out.push({ kind, text: span, deadline: dates[0] || null, ref: e.ref,
          citation: `${e.from || "unknown"} — ${e.subject || "(no subject)"}`, from: e.from });
      }
    }
  }
  return out;
}

/** Meeting preparation: each event with the related messages, commitments and open questions. */
export function meetingBrief(twin, events = [], { window = 5 } = {}) {
  return events.map((ev) => {
    const participants = (ev.attendees || []).map((a) => String(a).toLowerCase());
    const related = retrieveForRequest(twin, `${ev.title || ""} ${participants.join(" ")}`, { k: window });
    const refs = related.map((r) => r.ref);
    const commitments = extractCommitments(twin, { refs });
    return {
      event: { id: ev.id, title: ev.title, start: ev.start, attendees: ev.attendees || [], location: ev.location || null },
      relatedMessages: related,
      commitments: commitments.filter((c) => c.kind === "commitment"),
      openRequests: commitments.filter((c) => c.kind === "request"),
      sources: refs,
    };
  });
}

/** Follow-up suggestions: unanswered threads + requests made of the employee, ranked by wait time. */
export function followUpSuggestions(twin, { now = Date.now(), olderThanHours = 48 } = {}) {
  const unanswered = unansweredThreads(twin, { now, olderThanHours });
  const requests = extractCommitments(twin).filter((c) => c.kind === "request");
  return [
    ...unanswered.map((t) => ({ kind: "reply-owed", subject: t.subject, from: t.from, waitingHours: t.waitingHours, ref: t.ref })),
    ...requests.map((r) => ({ kind: "request-of-you", text: r.text, deadline: r.deadline, from: r.from, ref: r.ref })),
  ];
}

/**
 * Prepare a reply DRAFT. Never sends. Carries full attribution and its sources; the model (if any)
 * only writes prose — the permission decision and attribution are computed here.
 */
export function draftReply(twin, { messageRef, body = null, model = null, runtime = null, sources = [], at = null } = {}) {
  const perm = twinPermission(twin, { action: "draft-reply", resource: messageRef });
  if (!perm.allowed) return { ok: false, reason: perm.reason, permission: perm };
  const msg = (twin.index || []).find((e) => e.ref === messageRef) || null;
  const used = sources.length ? sources : (msg ? [{ ref: msg.ref, citation: `${msg.from} — ${msg.subject}` }] : []);
  const draft = {
    inReplyTo: messageRef,
    to: msg?.from || null,
    subject: msg?.subject ? (/^re:/i.test(msg.subject) ? msg.subject : `Re: ${msg.subject}`) : null,
    body: body || "(draft body to be generated by the configured model)",
    attribution: draftAttribution(twin, { model, runtime }),
    sources: used.map((s) => s.citation || s.ref || s),
    requiresApprovalToSend: true,     // sending is ALWAYS a separate, approved step
  };
  const record = auditRecord(twin, { action: "draft-reply", permission: perm.scope, approval: "not-required",
    model, runtime, accountId: msg?.accountId || null, sources: used, result: "draft-prepared", at });
  return { ok: true, draft, permission: perm, audit: record };
}

/**
 * SEND — the guarded path. Requires delegate mode, an explicit communicate grant, and an approved
 * approval. Returns a decision + audit; it never performs I/O itself.
 */
export function sendDraft(twin, { draft, approval = null, accountId = null, model = null, runtime = null, at = null } = {}) {
  const perm = twinPermission(twin, { action: "send-email", resource: draft?.inReplyTo || null, accountId });
  if (!perm.allowed)
    return { ok: false, reason: perm.reason, permission: perm,
      audit: auditRecord(twin, { action: "send-email", permission: perm.scope, approval: "denied", model, runtime, accountId, result: "refused", at }) };
  if (perm.requiresApproval && !(approval && approval.status === "approved"))
    return { ok: false, reason: "sending requires an approved human approval", permission: perm,
      audit: auditRecord(twin, { action: "send-email", permission: perm.scope, approval: "pending", model, runtime, accountId, result: "held-for-approval", at }) };
  return { ok: true, permission: perm,
    audit: auditRecord(twin, { action: "send-email", permission: perm.scope, approval: "approved",
      model, runtime, accountId, sources: draft?.sources || [], result: "authorized-to-send", at }) };
}

// ── Turning work into missions, and delegating with a COMPACT packet ─────────────────────────────

/** Convert an email/conversation into a structured BrainOutput mission (same MissionSpec as chat). */
export function emailToMission(twin, { messageRef, department = null, objective = null, constraints = [], criteria = [], policies = {} } = {}) {
  const msg = (twin.index || []).find((e) => e.ref === messageRef);
  if (!msg) throw new Error(`message '${messageRef}' is not in the permitted index`);
  let c = newConversation({ scope: "company", title: msg.subject });
  c = addMessage(c, { role: "user", mode: "plan", text: objective || `From email "${msg.subject}" (${msg.from}): ${msg.snippet}` });
  for (const t of constraints) c = pin(c, { kind: "constraint", text: t });
  for (const t of criteria) c = pin(c, { kind: "criterion", text: t });
  const spec = draftMissionSpec(c, { department, policies });
  return { ...spec, origin: { kind: "email", ref: msg.ref, from: msg.from, subject: msg.subject },
    references: [{ ref: msg.ref, citation: `${msg.from} — ${msg.subject}` }] };
}

/**
 * The COMPACT TASK PACKET a Work Twin hands to a departmental agent: the necessary facts, the source
 * references, the constraints and the permissions — and nothing else. The mailbox and the chat
 * transcript are never forwarded.
 */
export function taskPacket(twin, { department, objective, facts = [], sources = [], constraints = [], permissions = [], deadline = null } = {}) {
  if (!department) throw new Error("task packet: a department is required");
  return {
    from: { workTwin: twin.id, onBehalfOf: twin.employee.id },
    department,
    objective,
    facts: facts.slice(0, 12).map((f) => String(f).slice(0, 400)),
    sources: sources.map((s) => (typeof s === "string" ? s : s.ref || s.citation)).filter(Boolean).slice(0, 12),
    constraints,
    permissions,                       // what the receiving agent may do — never wider than the twin's
    deadline,
    mailboxForwarded: false,
    transcriptForwarded: false,
  };
}

/** Record a delegation and its returned result in the twin's task history (audit-friendly). */
export function recordDelegation(twin, { packet, result = null, at = null }) {
  const entry = { kind: "delegation", department: packet.department, objective: packet.objective,
    sources: packet.sources, result, at };
  return { ...twin, taskHistory: [...(twin.taskHistory || []), entry] };
}

// ── Events (dormancy) ───────────────────────────────────────────────────────────────────────────

/**
 * Wake the twin ONLY for a real trigger: a user request or a connector event. There is no timer and no
 * polling anywhere in this module — an idle Work Twin costs nothing.
 */
export function onConnectorEvent(twin, event = {}) {
  const wakes = ["message.received", "message.updated", "calendar.updated", "task.assigned"];
  if (!wakes.includes(event.type)) return { twin, woke: false, reason: `event '${event.type}' does not require the twin` };
  const next = event.messages ? indexMessages(twin, event.messages) : twin;
  return { twin: { ...next, activation: "active" }, woke: true, reason: `woken by ${event.type}` };
}
export function sleep(twin) { return { ...twin, activation: "dormant" }; }
