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
import { planGraph, selectPolicies, safeSlice } from "./ce-core.mjs";

export const CHAT_SCOPES = ["work-twin", "company", "department", "agent"];
export const CHAT_MODES = ["ask", "plan", "execute", "review"];

/**
 * Does this message ask for WORK to be produced (not a question)? Imperative verbs at the
 * start ("crée", "build", "erstelle") or "X-moi" / "me X" forms — and NOT a question.
 * "I need to create…" / "need a pdf" forms count too: first-time users ask for work in
 * polite phrasing, and silently treating it as a question strands them in Ask mode.
 * Used to auto-draft a mission in Ask mode: a user should never have to think about modes.
 */
export function looksLikeWork(text = "") {
  const s = String(text).trim();
  if (!s || /\?\s*$/.test(s)) return false;
  return /^(cr[ée]e?r?|créer|fais|faire|fabrique|build|make|create|write|implement|code|développe?|develop|génère|generate|draft|erstelle?|baue?|schreibe|mach)\b/i.test(s)
    || /(crée?|fais|fabrique|build|make|create|write|génère)[- ](moi|me|nous|uns)\b/i.test(s)
    || /^(crée|fais|build|make|create)\s+(a|an|un|une|le|la|the|some|this)\b/i.test(s)
    || /^(i\s+)?(need|want|would like|brauche)\s+(to\s+)?(a\s+|an\s+|une?\s+)?(create|build|make|write|generate|draft|produce)\b/i.test(s)
    || /^(i\s+)?(need|want)\s+(a|an|un|une|eine?)\s+\S*(campaign|pdf|document|brochure|report|post|page|site|deck|presentation|visuel|image)\b/i.test(s);
}

/** The recent conversation tail — the context follow-ups actually resolve against. Retrieval
 *  (term frequency) CANNOT resolve "do them" or "and the second one?" — nothing overlaps
 *  lexically. Recency can. Ask mode sends this alongside retrieval, never the whole transcript. */
export function askTail(conversation, { n = 6, maxLen = 350 } = {}) {
  return (conversation.messages || []).slice(-n).map((m) => ({ role: m.role, text: safeSlice(m.text, maxLen) }));
}

/**
 * Infer a department from the objective's vocabulary — against the company's EXISTING
 * departments only. Used when the user never picked one: without it, everything drafted from a
 * company-scope chat lands on whatever department happens to be first (a marketing campaign went
 * to "technical" because it was the only configured team — with no word about the mismatch).
 */
const DEPARTMENT_VOCABULARY = {
  marketing: ["marketing", "campaign", "instagram", "ig post", "social media", "social post", "tweet", "linkedin", "facebook", "tiktok", "newsletter", "seo", "brand", "promotion", "promo", "ad campaign", "ads", "campagne", "publicité", "werbung", "kampagne"],
  sales: ["sales", "deal", "lead", "prospect", "quote", "proposal", "crm", "vente", "devis", "verkauf", "angebot"],
  finance: ["invoice", "invoices", "accounting", "budget", "tax", "payment", "payroll", "expense", "bookkeeping", "facture", "comptabilité", "rechnung", "buchhaltung"],
  "customer-service": ["support", "ticket", "customer question", "refund", "complaint", "customer service", "helpdesk", "remboursement", "rek lamation", "kundensupport"],
  "legal-compliance": ["contract", "legal", "gdpr", "compliance", "privacy policy", "terms", "contrat", "juridique", "vertrag", "rechtlich"],
  "human-resources": ["hiring", "recruit", "job posting", "interview", "onboarding", "hr", "payroll review", "recrutement", "embauche", "einstellung", "bewerbung"],
  technical: ["code", "bug", "deploy", "api", "software", "implement", "refactor", "repository", "script", "migration", "déployer", "bereitstellen"],
  "data-research": ["research", "analysis", "benchmark", "dataset", "data report", "survey", "recherche", "analyse", "analyse de", "datenanalyse"],
  operations: ["operations", "logistics", "inventory", "supplier", "procurement", "logistique", "inventaire", "lieferanten"],
};
export function inferDepartment(objective = "", departments = []) {
  const text = ` ${String(objective).toLowerCase()} `;
  let best = null, bestHits = 0;
  for (const dept of departments) {
    const vocab = DEPARTMENT_VOCABULARY[dept];
    if (!vocab) continue;
    const hits = vocab.filter((w) => text.includes(` ${w}`) || text.includes(`${w} `) || text.includes(` ${w} `)).length;
    if (hits > bestHits) { best = dept; bestHits = hits; }
  }
  return best;                                   // null → caller falls back, honestly
}

/**
 * Is the deliverable meant for the public or for customers (social post, campaign, newsletter,
 * press, customer email, published page)? Public-facing work gets an independent REVIEWER stage
 * by default — a brand mistake outside is costlier than a slow draft inside. The human still
 * approves the mission itself before launch; this adds machine review inside the graph.
 */
export const PUBLIC_FACING_RE = /instagram|ig post|social (media|post)|tweet|linkedin|facebook|tiktok|newsletter|press release|campaign|campagne|public|publish|blog post|customer (email|mail|reply)|promo(ption)?|ad(s| campaign)?\b|affisch|werbung|posted?\b/i;

/** Building a connector/integration is multi-step engineering — it gets a PLANNER and a reviewer
 *  by default, and its worker runs the coding slot so real files land in the workspace. The
 *  founder's first-use complaint was exact: "the system never plans, it asks straight to approve." */
export const CONNECTOR_BUILD_RE = /\b(connector|integration|intégration|webhook)\b/i;

/**
 * A GOAL (vs a task): "need to have an assistant answering the phone automatically", "set up X
 * end-to-end". Goals get a planner — the founder watched a phone-assistant goal draft as a single
 * worker step with no plan, no reviews, no decisions. "Always plan" for anything substantial;
 * small clear tasks stay single-worker (the efficiency story stands).
 */
export const GOAL_RE = /\b(need|want|would like|have) to\b|\bautomat|\bend[- ]to[- ]end\b|\bset ?up\b|\bdeploy\b|\binstall\b|\bbuild (me |us )?(a|an|the) (system|service|assistant|platform|app|tool|pipeline|bot)\b|\bil faut\b/i;
export const isGoal = (text = "") => GOAL_RE.test(text) || String(text).length > 180;

/** The deterministic plan shown BEFORE approval — what the run will actually do. */
export function planStepsFor(spec) {
  if ((spec.task?.tags || []).includes("connector-builder"))
    return [
      "Scaffold the connector module (config schema, read-only read function, error handling) as REAL FILES in the company workspace",
      "Write an offline smoke test (mocked endpoint)",
      "Register the connector read-only with its configuration schema",
      "Guide the credential setup (sealed secrets) and run a live verification probe",
    ];
  const steps = [];
  for (const n of spec.graph?.nodes || []) {
    const kind = String(n).replace(/\d+$/, "");
    if (kind === "planner") steps.push("Plan: decompose the objective into concrete steps");
    else if (kind === "worker") steps.push("Work: produce the complete deliverable on the assigned model");
    else if (kind === "reviewer") steps.push("Review: an independent stage validates the result against the acceptance criteria and bound policies");
    else if (kind === "human-approval") steps.push("Gate: pause for your approval before anything acts");
    else if (kind === "tool") steps.push("Tool: run the deterministic tool (no model)");
  }
  if (!steps.length) steps.push("Work: produce the complete deliverable");
  return steps;
}

/** What the objective promised but the run could not produce. Honesty over "Mission complete". */
export function unmetDeliverables(objective = "", artifacts = [], { imageGenAvailable = false } = {}) {
  const gaps = [];
  const wantsImage = /\b(pic|pics|picture|photo|image|images|visual|visuals|logo|illustration|graphic|banner|poster|flyer|bild|visuel)\b/i.test(String(objective));
  const hasImage = (artifacts || []).some((a) => /^file:.*\.(png|jpe?g|webp|svg)$/i.test(String(a)) || /^image:/i.test(String(a)));
  if (wantsImage && !hasImage && !imageGenAvailable) gaps.push("image");
  return gaps;
}

/** One honest line naming what the run did NOT deliver and why. */
export function deliverableGapNote(gaps = []) {
  if (!gaps.length) return "";
  const parts = [];
  if (gaps.includes("image"))
    parts.push("the picture itself was NOT rendered — no image-generation model is configured. What you have is the copy plus a ready-to-use image prompt. Assign an image-gen model (Settings → Model assignment) to render images directly.");
  return ` Heads-up: ${parts.join(" ")}`;
}

/**
 * The worker prompt for a chat-launched mission. The COMPANY LINE is the fix for invented
 * businesses: a worker with no company context makes up "a generic lifestyle brand" when the
 * company is a hotel. One line of truth beats a paragraph of assumptions.
 */
export function missionWorkerPrompt({ objective, constraints = [], acceptanceCriteria = [], brief = null, company = null, fileInstruction = "" } = {}) {
  const companySection = company?.name
    ? `\n\nCompany: ${company.name}${company.does ? ` — ${company.does}` : ""}${company.website ? ` (${company.website})` : ""}. The work is for THIS company; never invent a different business, product, or brand.`
    : "";
  const briefSection = brief ? `\n\nProject context (so you don't start cold):\n${brief}` : "";
  return `${objective}\n\nConstraints: ${(constraints || []).join("; ") || "none"}\nAcceptance: ${(acceptanceCriteria || []).join("; ") || "none"}${companySection}${briefSection}\n\nDo not ask for clarification. Make reasonable assumptions (state them in one line), then produce the COMPLETE deliverable — the full file or content itself, not a description or plan of it.${fileInstruction}`;
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

// ── Plan drafts — the planner pass that fills a durable Plan (plans.mjs) ─────────────────────────

/**
 * The structured-output contract for ONE bounded planner pass over a plan draft (task-pm-03).
 * Same style as PLAN_TASKS_INSTRUCTION (plan-tasks.mjs, mission flow) but adapted to the draft
 * shape: a refined objective, the shared DECISIONS, and task drafts with directive fields.
 */
export const PLAN_DRAFT_INSTRUCTION = `

You are the PLANNER. Reply in exactly this form:
OBJECTIVE: <one line — the refined objective>
DECISIONS: <one or two lines of shared choices every step must respect — stack, style, names>
\`\`\`tasks
[{"title": "step one", "priority": "high", "skills": ["research"], "dependsOn": [], "acceptanceCriteria": ["done means …"]}]
\`\`\`
Rules: 2 to 6 steps; each step is one concrete, completable task; titles under 80 characters;
priority is one of urgent, high, medium, low, none; dependsOn holds INDEXES of earlier steps in
the same block; no nesting, no commentary inside the block.`;

const DRAFT_PRIORITIES = ["urgent", "high", "medium", "low", "none"];

/**
 * Parse the planner's answer into plan-draft fields for plans.mjs. Deterministic and fail-closed:
 * unusable output yields null (the caller keeps the previous draft and says so honestly). Every
 * field is bounded to the plans.mjs limits so a wild model answer can never blow the store up.
 */
export function parsePlanDraft(output = "", { max = 6 } = {}) {
  const text = String(output || "");
  const block = text.match(/```tasks\s*([\s\S]*?)```/);
  if (!block) return null;
  let arr;
  try { arr = JSON.parse(block[1]); } catch { return null; }
  if (!Array.isArray(arr)) return null;
  const taskDrafts = [];
  for (const raw of arr) {
    const title = String((typeof raw === "string" ? raw : raw?.title) || "").trim().slice(0, 120);
    if (title.length < 3) continue;
    const priority = DRAFT_PRIORITIES.includes(raw?.priority) ? raw.priority : "none";
    const skills = [...(Array.isArray(raw?.skills) ? raw.skills : [])].map((s) => String(s)).filter(Boolean).slice(0, 12);
    const dependsOn = [...(Array.isArray(raw?.dependsOn) ? raw.dependsOn : [])]
      .filter((d) => Number.isInteger(d) && d >= 0 && d < arr.length);
    const acceptanceCriteria = [...(Array.isArray(raw?.acceptanceCriteria) ? raw.acceptanceCriteria : [])]
      .map((c) => String(c).slice(0, 500)).filter(Boolean).slice(0, 20);
    taskDrafts.push({ title, objective: String(raw?.objective || title).slice(0, 4000), skills,
      agentSlot: typeof raw?.agentSlot === "string" ? raw.agentSlot : null,
      restrictions: raw?.restrictions && typeof raw.restrictions === "object" && !Array.isArray(raw.restrictions) ? raw.restrictions : {},
      priority, dependsOn, acceptanceCriteria });
  }
  if (taskDrafts.length < 1) return null;
  const sliced = taskDrafts.slice(0, max);
  // Indexes shifted by filtering/slicing: re-clamp every dependsOn to the final list so the
  // plans.mjs draft validation (in range, never a self-dependency) can never trip on model output.
  const fields = { taskDrafts: sliced.map((d, i) => ({ ...d,
    dependsOn: d.dependsOn.filter((x) => x >= 0 && x < sliced.length && x !== i) })) };
  const obj = text.match(/^\s*OBJECTIVE:\s*(.+)$/m)?.[1]?.trim();
  if (obj) fields.objective = obj.slice(0, 4000);
  const dec = text.match(/^\s*DECISIONS:\s*(.+)$/m)?.[1]?.trim();
  if (dec) fields.decisions = dec.slice(0, 4000);
  return fields;
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
  // Public-facing work (social posts, campaigns, customer mail, published pages) carries an
  // independent reviewer by default — see PUBLIC_FACING_RE. An explicit `risk` still wins.
  const publicFacing = PUBLIC_FACING_RE.test(obj);
  // Connector/integration builds: planner + reviewer + a CODING worker (real files in the
  // workspace), plus the acceptance criteria of a real deliverable when the user pinned none.
  const connectorBuild = CONNECTOR_BUILD_RE.test(obj);
  const goal = isGoal(obj);                                   // substantial asks plan first
  const effTags = connectorBuild ? [...new Set([...tags, "connector-builder"])] : tags;
  if (connectorBuild && !criteria.length)
    criteria.push("connector module scaffolded as real files", "offline smoke test included",
      "read-only permissions by default", "guided credential setup with sealed secrets", "verification probe recorded");
  const task = {
    summary: obj, tags: effTags,
    ...(complexity ? { complexity } : (connectorBuild || goal) ? { complexity: "high" } : {}),
    ...(risk ? { risk } : {}),
    ...(publicFacing || connectorBuild ? { requireReview: true } : {}),
    ...(connectorBuild ? { workerSlot: "coding-free" } : {}),
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
    // The plan you approve — shown in the mission card BEFORE launch (never just "approve something").
    planPreview: [],
    policies: bound.map((p) => p.id).filter(Boolean),
    status: "draft",
    task,
  };
  spec.planPreview = planStepsFor(spec);
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
