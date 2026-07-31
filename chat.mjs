// SPDX-License-Identifier: Apache-2.0
// BrainOutput Community Edition — conversational Command Center (2026-07-28).
//
// Talk to the company, a department, or a named agent, and turn that conversation into STRUCTURED,
// DURABLE state. The executor never receives the transcript: a compact MissionSpec goes to execution
// while the full transcript stays local for history and audit.
//
// Modes: ask (read-only) · plan (build an editable MissionSpec, no external writes) · execute (only
// after approval) · review (compare against acceptance criteria).
// No simulated agent-to-agent chatter, no management relay, no idle heartbeats. Pure logic; zero-dep.
import { planGraph, selectPolicies } from "./ce-core.mjs";

export const CHAT_SCOPES = ["work-twin", "company", "department", "agent"];
export const CHAT_MODES = ["ask", "plan", "execute", "review"];

/**
 * Does this message ask for WORK to be produced (not a question)? Imperative verbs at the
 * start ("crée", "build", "erstelle") or "X-moi" / "me X" forms — and NOT a question.
 * Used to auto-draft a mission in Ask mode: a user should never have to think about modes.
 */
export function looksLikeWork(text = "") {
  const s = String(text).trim();
  if (!s || /\?\s*$/.test(s)) return false;
  return /^(cr[ée]e?r?|créer|fais|faire|fabrique|build|make|create|write|implement|code|développe?|develop|génère|generate|erstelle?|baue?|schreibe|mach)\b/i.test(s)
    || /(crée?|fais|fabrique|build|make|create|write|génère)[- ](moi|me|nous|uns)\b/i.test(s)
    || /^(crée|fais|build|make|create)\s+(a|an|un|une|le|la|the|some|this)\b/i.test(s);
}

const tokenize = (s) => (String(s).toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w.length > 2);

// ── Conversation ────────────────────────────────────────────────────────────────────────────────

export function newConversation({ id, scope = "company", department = null, agentId = null, twinId = null, title = null, projectId = null } = {}) {
  if (!CHAT_SCOPES.includes(scope)) throw new Error(`unknown chat scope '${scope}'`);
  if (scope === "department" && !department) throw new Error("department chat needs a department");
  if (scope === "agent" && !agentId) throw new Error("agent chat needs an agentId");
  if (scope === "work-twin" && !twinId) throw new Error("Work Twin chat needs a twinId");
  return {
    id: id || `conv-${Date.now().toString(36)}`,
    scope, department, agentId, twinId, title, projectId,
    messages: [],        // full transcript — LOCAL ONLY, never forwarded wholesale
    pinned: [],          // decisions + constraints that must never fall out of context
    summary: null,       // rolling task-scoped summary
    summarizedThrough: 0,
    missionId: null,
    createdAt: null,
  };
}

/** An @mention retargets the conversation to a named agent (agent chat without leaving the thread). */
export function resolveMention(text, agents = []) {
  const m = String(text).match(/(?:^|\s)@([a-z0-9][a-z0-9._-]*)/i);
  if (!m) return null;
  const wanted = m[1].toLowerCase();
  return agents.find((a) => a.id.toLowerCase() === wanted || `${a.department}-${a.role}`.toLowerCase() === wanted) || null;
}

export function addMessage(conversation, { role = "user", text = "", mode = "ask", at = null, meta = {} } = {}) {
  if (!CHAT_MODES.includes(mode)) throw new Error(`unknown chat mode '${mode}'`);
  const msg = { i: conversation.messages.length, role, text: String(text), mode, at, meta };
  return { ...conversation, messages: [...conversation.messages, msg] };
}

/** Pin a decision or constraint — pinned items are ALWAYS in context, regardless of retrieval. */
export function pin(conversation, { kind = "decision", text }) {
  if (!["decision", "constraint", "criterion"].includes(kind)) throw new Error(`unknown pin kind '${kind}'`);
  return { ...conversation, pinned: [...conversation.pinned, { kind, text: String(text) }] };
}

/**
 * Roll the transcript into a compact summary every `every` messages, keeping the tail verbatim.
 * Deterministic (no model needed); a model-written summary can be supplied via `writer`.
 */
export function rollSummary(conversation, { every = 10, keepTail = 4, writer = null } = {}) {
  const n = conversation.messages.length;
  if (n - conversation.summarizedThrough < every) return conversation;
  const upTo = n - keepTail;
  if (upTo <= conversation.summarizedThrough) return conversation;
  const slice = conversation.messages.slice(conversation.summarizedThrough, upTo);
  const text = writer ? writer(slice, conversation.summary)
    : [conversation.summary, ...slice.map((m) => `${m.role}: ${m.text}`)].filter(Boolean).join(" • ").slice(0, 1200);
  return { ...conversation, summary: text, summarizedThrough: upTo };
}

/** Retrieve only the messages relevant to a query (term-frequency), newest-first on ties. */
export function retrieveRelevant(conversation, query, { k = 4 } = {}) {
  const q = new Set(tokenize(query));
  return conversation.messages
    .map((m) => {
      const tf = {};
      for (const t of tokenize(m.text)) tf[t] = (tf[t] || 0) + 1;
      let score = 0;
      for (const t of q) if (tf[t]) score += 1 + Math.log(1 + tf[t]);
      return { m, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.m.i - a.m.i)
    .slice(0, k)
    .map((x) => x.m);
}

/**
 * The ONLY context that leaves the chat: a rolling summary + pinned decisions/constraints + the few
 * relevant messages + ARTIFACT REFERENCES (never duplicated artifact content). The full transcript is
 * never forwarded.
 */
export function compactContext(conversation, { query = "", k = 4, artifacts = [] } = {}) {
  return {
    summary: conversation.summary,
    pinned: conversation.pinned,
    relevant: retrieveRelevant(conversation, query || conversation.messages.at(-1)?.text || "", { k })
      .map((m) => ({ role: m.role, text: m.text })),
    artifactRefs: artifacts.map((a) => (typeof a === "string" ? a : a.ref || a.id)).filter(Boolean),
    transcriptForwarded: false,
    messageCount: conversation.messages.length,
  };
}

// ── MissionSpec — the structured, durable state the executor actually receives ───────────────────

export const MISSION_STATUS = ["draft", "approved", "running", "done", "rejected"];

/**
 * Draft a MissionSpec from the conversation. DETERMINISTIC by default (works with no model at all);
 * `refine` may post-process it with a planner model when one is configured. Nothing here writes.
 */
export function draftMissionSpec(conversation, {
  objective = null, department = null, agents = [], capabilities = [], modelAssignments = {},
  tools = [], dataSources = [], permissions = [], approvals = {}, policies = {}, tags = [],
  complexity = null, risk = null, id = null, refine = null,
} = {}) {
  const userMsgs = conversation.messages.filter((m) => m.role === "user");
  // The objective is the RECENT intent, not just the first message — follow-ups carry real
  // requirements ("create a pdf…" + "www.my-hotel.com" as the next message).
  const obj = objective || userMsgs.slice(-3).map((m) => m.text).join("\n");
  const constraints = conversation.pinned.filter((p) => p.kind === "constraint").map((p) => p.text);
  const decisions = conversation.pinned.filter((p) => p.kind === "decision").map((p) => p.text);
  const criteria = conversation.pinned.filter((p) => p.kind === "criterion").map((p) => p.text);
  const dept = department || conversation.department || null;

  const bound = selectPolicies({ department: dept, tags }, policies);
  const task = {
    summary: obj, tags,
    ...(complexity ? { complexity } : {}),
    ...(risk ? { risk } : {}),
    policies: bound,
  };
  const graph = planGraph(task);

  const spec = {
    id: id || `mission-${Date.now().toString(36)}`,
    conversationId: conversation.id,
    objective: obj,
    missionScope: conversation.scope,
    constraints, decisions, acceptanceCriteria: criteria,
    department: dept,
    agents: agents.map((a) => (typeof a === "string" ? a : a.id)),
    requiredCapabilities: capabilities,
    modelAssignments,
    tools, dataSources,
    permissions,
    approvals: { ...approvals, ...(graph.nodes.some((n) => n.gate) ? { humanApprovalRequired: true } : {}) },
    artifacts: [], references: [],
    graph: { shape: graph.shape, nodes: graph.nodes.map((n) => n.node) },
    policies: bound.map((p) => p.id).filter(Boolean),
    status: "draft",
    task,
  };
  return refine ? refine(spec, compactContext(conversation, { query: obj })) : spec;
}

/** Apply user edits to a draft. Only a DRAFT is editable; approving requires an objective. */
/** Statuses an edit may start from. `approved` is included because a launch can fail and leave a
 *  mission there — the launch path's own comment promises "edit and re-approve", and refusing it
 *  made a failed mission permanently unusable with no way back to draft. Editing an approved
 *  mission returns it to draft, so the approval is never silently reused for changed work. */
const EDITABLE_STATUS = ["draft", "approved", "failed"];

export function editMissionSpec(spec, patch = {}) {
  if (!EDITABLE_STATUS.includes(spec.status))
    throw new Error(`mission '${spec.id}' is ${spec.status} — only ${EDITABLE_STATUS.join(", ")} can be edited`);
  // An unknown key used to be dropped in silence with a 200, so `agent` (singular) looked applied
  // and was not. Say so.
  const known = ["objective", "constraints", "decisions", "acceptanceCriteria", "department", "agents",
    "requiredCapabilities", "modelAssignments", "tools", "dataSources", "permissions", "approvals"];
  const unknown = Object.keys(patch).filter((k) => !known.includes(k));
  if (unknown.length) throw new Error(`unknown field(s) in patch: ${unknown.join(", ")} — nothing was changed`);
  const next = { ...spec, status: "draft", approvedBy: null, approvedAt: null };
  for (const key of known) if (key in patch) next[key] = patch[key];
  return next;
}

/**
 * `agents` is the COMPANY roster, passed in so this stays pure. It is optional: when omitted the
 * routability check is skipped rather than guessed at.
 *
 * Routability is checked HERE, at draft/approve time, because it used to be checked only at
 * launch: a user could draft, review, edit and approve a mission and only then be told
 * "no agent for department 'finance'" — after committing to it.
 */
export function validateMissionSpec(spec, { agents = null } = {}) {
  const errors = [];
  if (!spec.objective || !String(spec.objective).trim()) errors.push("objective is required");
  if (!spec.department) errors.push("a department must be selected");
  if (!MISSION_STATUS.includes(spec.status)) errors.push(`bad status '${spec.status}'`);
  if (agents && spec.department && !agents.some((a) => a.department === spec.department))
    errors.push(`no agent works in '${spec.department}' — add one to that department, or pick a department that has one`);
  return { ok: errors.length === 0, errors };
}

export function approveMission(spec, { approvedBy = "user", agents = null } = {}) {
  const v = validateMissionSpec(spec, { agents });
  if (!v.ok) throw new Error(`cannot approve: ${v.errors.join("; ")}`);
  return { ...spec, status: "approved", approvedBy, approvedAt: null };
}
export function rejectMission(spec, { reason = null } = {}) { return { ...spec, status: "rejected", rejectedReason: reason }; }

// ── Mode guards — the chat model can never exceed its mode ───────────────────────────────────────

/**
 * What a mode may do. `ask` is read-only; `plan` may not write externally; `execute` requires an
 * APPROVED mission; `review` reads results. Elevated connector actions ALWAYS go through the connector
 * permission schema — this guard never replaces it.
 */
export function modeAllows(mode, action, { mission = null } = {}) {
  if (!CHAT_MODES.includes(mode)) return { allowed: false, reason: `unknown mode '${mode}'` };
  const readOnly = ["read", "search", "rag-query", "inspect"];
  if (readOnly.includes(action)) return { allowed: true, reason: `${action} is read-only` };
  if (action === "draft-plan") return mode === "plan" || mode === "review"
    ? { allowed: true, reason: "planning is allowed in plan/review" }
    : { allowed: false, reason: `switch to Plan mode to build a mission (current: ${mode})` };
  if (action === "external-write" || action === "execute") {
    if (mode !== "execute") return { allowed: false, reason: `switch to Execute mode (current: ${mode})` };
    if (!mission || mission.status !== "approved")
      return { allowed: false, reason: "the mission must be approved before launch" };
    return { allowed: true, reason: "approved mission may launch" };
  }
  return { allowed: false, reason: `action '${action}' is not permitted in ${mode} mode` };
}

// ── Mission Composer — the editable pre-flight summary ───────────────────────────────────────────

/**
 * Everything the user reviews before launching. Shows provider/cost source per stage so it is clear who
 * pays for each model. (No BrainOutput-funding line — that is an internal implementation policy.)
 */
export function missionComposer(spec, { plan = [], stagesSkipped = [] } = {}) {
  const stages = plan.map((n) => ({
    node: n.node,
    model: n.model?.model || null,
    provider: n.model?.provider || null,
    costSource: n.model?.costSource || (n.gate ? "human-approval" : n.tool ? "deterministic-tool" : null),
    runtime: n.model?.connection?.runtime || null,
  }));
  return {
    objective: spec.objective,
    department: spec.department,
    agents: spec.agents,
    executionGraph: spec.graph,
    stages,
    tools: spec.tools,
    dataSources: spec.dataSources,
    permissions: spec.permissions,
    approvalGates: spec.approvals,
    acceptanceCriteria: spec.acceptanceCriteria,
    expectedOutputs: spec.expectedOutputs || spec.acceptanceCriteria,
    constraints: spec.constraints,
    stagesSkipped,
    // These are the action values /api/chat/mission actually accepts. It previously advertised
    // "approve-and-launch" and "save-as-workflow", both of which 400 — a UI built from this list
    // could not work.
    actions: ["edit", "approve", "reject", "cancel", "save-workflow"],
    status: spec.status,
  };
}

/** Review: compare results against the acceptance criteria. Deterministic; no model required. */
export function reviewMission(spec, results = [], { reviewerVerdict = null } = {}) {
  const text = results.map((r) => `${r.output || ""} ${r.artifact || ""} ${(r.changedFiles || []).join(" ")}`).join("\n").toLowerCase();
  const checks = (spec.acceptanceCriteria || []).map((c) => ({
    criterion: c,
    met: tokenize(c).filter((t) => text.includes(t)).length >= Math.max(1, Math.ceil(tokenize(c).length * 0.6)),
  }));
  const unmet = checks.filter((c) => !c.met);
  return {
    missionId: spec.id,
    checks,
    allMet: unmet.length === 0 && checks.length > 0,
    unmet: unmet.map((c) => c.criterion),
    reviewerVerdict,
    // An independent reviewer is justified when criteria are unmet or the mission is risky/policy-bound.
    independentReviewJustified: unmet.length > 0 || !!spec.policies?.length || spec.task?.risk === "high",
  };
}

/** Saved workflow: a reusable mission template with the conversation-specific bits stripped. */
export function saveAsWorkflow(spec, { name = null } = {}) {
  return {
    name: name || spec.objective.slice(0, 60),
    department: spec.department, agents: spec.agents, requiredCapabilities: spec.requiredCapabilities,
    modelAssignments: spec.modelAssignments, tools: spec.tools, dataSources: spec.dataSources,
    permissions: spec.permissions, approvals: spec.approvals,
    acceptanceCriteria: spec.acceptanceCriteria, constraints: spec.constraints,
    task: { ...spec.task, summary: undefined },
  };
}
