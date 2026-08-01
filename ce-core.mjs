// SPDX-License-Identifier: Apache-2.0
// BrainOutput Community Edition — core AI-company model (product architecture 2026-07-27).
// A configurable, token-efficient AI company: durable agent ROLES, on-demand execution, and
// USER-OWNED / FREE / LOCAL models only. HARD INVARIANT: Community Edition consumes ZERO
// BrainOutput-funded inference — BrainOutput's own hosted paid models are dev-only and can never be a
// Community model connection. Pure logic; no network here (adapters do I/O). ESM, zero-dep.

// ── Capability slots: agents reference these, NOT provider/model names ─────────────────────────
export const CAPABILITY_SLOTS = [
  "reasoning-premium", "reasoning-free", "coding-premium", "coding-free", "fast-cheap",
  "long-context", "vision", "voice", "embeddings", "multilingual", "private-local", "high-trust-review",
  "image-gen",
];

// ── Cost sources a Community model may draw on. NONE is BrainOutput-funded. ─────────────────────
export const COST_SOURCES = ["free", "user-subscription", "user-api-account", "local-compute"];
// A connection's funder is who pays for the tokens. "brainoutput" is FORBIDDEN in Community.
export const ALLOWED_FUNDERS = ["free", "user", "local"];

/**
 * Truncate without ever splitting a surrogate pair — a naive String.slice can cut an emoji in
 * half and print a replacement char into logs, briefs and deliverables.
 */
export function safeSlice(s, n) {
  const chars = [...String(s ?? "")];
  return chars.length <= n ? chars.join("") : chars.slice(0, n).join("");
}

// BrainOutput's dev credentials/models that must NEVER back a Community connection.
const DEV_ONLY_MARKERS = [/^kimi-for-coding\b/i, /sk-fleet/i];

/** Validate a Model Connection for Community use. Returns {ok, reason}. Fail-closed on funding. */
export function validateConnection(c) {
  if (!c || typeof c !== "object") return { ok: false, reason: "not an object" };
  if (!c.id || !c.kind || !c.model) return { ok: false, reason: "missing id/kind/model" };
  if (!ALLOWED_FUNDERS.includes(c.funder)) return { ok: false, reason: `funder '${c.funder}' not user/free/local` };
  if (c.funder === "brainoutput") return { ok: false, reason: "BrainOutput-funded inference is forbidden in Community" };
  if (!COST_SOURCES.includes(c.costSource)) return { ok: false, reason: `bad costSource '${c.costSource}'` };
  // A user MAY BYOK their own premium model, but never via BrainOutput's dev credential/endpoint.
  if (c.usesFounderCredential) return { ok: false, reason: "must not use BrainOutput's dev credential" };
  if (c.funder !== "user" && DEV_ONLY_MARKERS.some((re) => re.test(c.model)))
    return { ok: false, reason: `model '${c.model}' is a BrainOutput dev model; only user-BYOK may reference such a name` };
  return { ok: true };
}

// ── Free-model catalog: refreshable, never a single hardcoded model ────────────────────────────
export function makeCatalog(entries = []) {
  return {
    entries,
    // choose a currently-available free model that meets the requirement; else null (NEVER paid).
    pickFree(req = {}) {
      return this.entries.find((e) =>
        e.funder === "free" && e.available && e.health === "ok" &&
        (!req.coding || e.codingCategory !== "none") &&
        (!req.reasoning || e.reasoningCategory !== "none") &&
        (!req.tools || e.toolSupport) &&
        (!req.multilingual || e.multilingual) &&
        (!req.minContext || (e.contextSize || 0) >= req.minContext)) || null;
    },
  };
}

// ── Execution-graph shapes. The router picks the SMALLEST that fits. ───────────────────────────
export const GRAPH_SHAPES = ["single", "planner-worker", "planner-parallel-workers", "worker-reviewer", "agent-tool", "agent-approval-action"];

/**
 * Decide the smallest sufficient execution graph for a task.
 * - clear & bounded  → single (no planner)
 * - needs decomposition → planner-worker (or parallel workers)
 * - risky/sensitive/policy or user-required → append an independent reviewer
 * - a mutating real-world action → append human approval
 * Never invents a planner/reviewer/CEO that the task does not require.
 */
export function planGraph(task = {}) {
  const nodes = [];
  // Policies that BIND to this task (see selectPolicies). Their criteria are loaded into the
  // reviewer's context — the reviewer validates against exactly the rules the work had to satisfy,
  // NOT the worker's raw instructions. A policy that escalates makes the human gate CONDITIONAL:
  // the reviewer AGENT clears it and a human is pulled in ONLY on a flag (human-minimized).
  const policies = Array.isArray(task.policies) ? task.policies : [];
  const policyCriteria = policies.flatMap((p) => (Array.isArray(p.criteria) ? p.criteria : []));
  const policyIds = policies.map((p) => p.id).filter(Boolean);
  const policyEscalates = policies.some((p) => p.escalation === "human");
  const policyAutoClears = policies.length > 0 && policies.every((p) => p.autoApproveWhenClear === true);

  const needsPlan = task.complexity === "high" || task.decompose === true || (task.subtasks || 0) > 1;
  const needsReview = task.risk === "high" || task.sensitive === true || task.requireReview === true || policies.length > 0;
  const needsApproval = task.mutatesRealWorld === true || task.requiresHumanApproval === true;

  if (needsPlan) {
    nodes.push({ node: "planner", slot: task.plannerSlot || "reasoning-free" });
    const n = Math.max(1, Math.min(task.parallelWorkers || 1, 8));
    for (let i = 0; i < n; i++) nodes.push({ node: `worker${n > 1 ? i + 1 : ""}`, slot: task.workerSlot || "coding-free" });
  } else if (task.tool) {
    nodes.push({ node: "tool", slot: null, tool: task.tool }); // deterministic; no model
  } else {
    nodes.push({ node: "worker", slot: task.workerSlot || "fast-cheap" });
  }
  if (needsReview) nodes.push({
    node: "reviewer", slot: task.reviewerSlot || "high-trust-review", independent: true,
    ...(policyCriteria.length ? { reviewCriteria: policyCriteria, policies: policyIds } : {}),
  });
  // Hard real-world mutation → UNCONDITIONAL human gate. Policy-only escalation → CONDITIONAL gate
  // (auto-cleared when the reviewer passes and every bound policy allows it), always carrying a brief.
  if (needsApproval || policyEscalates) {
    const conditional = policyEscalates && !needsApproval && policyAutoClears;
    nodes.push({
      node: "human-approval", slot: null, gate: true,
      ...(policyEscalates ? { brief: true, policies: policyIds } : {}),
      ...(conditional ? { conditional: true } : {}),
    });
  }

  let shape = "single";
  if (needsPlan && (task.parallelWorkers || 1) > 1) shape = "planner-parallel-workers";
  else if (needsPlan) shape = "planner-worker";
  else if (task.tool) shape = "agent-tool";
  if (needsReview && !needsPlan) shape = "worker-reviewer";
  if (needsApproval || policyEscalates) shape = "agent-approval-action";
  return { shape, nodes };
}

/**
 * Select the policies that BIND to a task — by department and/or task tags. This is how a
 * reviewer/validator gets "the instructions for what it is validating": the router loads the
 * relevant policies (their criteria), not the worker's whole instruction set. Pure; policy-order
 * preserved. A policy with no `appliesTo` is company-wide (binds to every task).
 */
export function selectPolicies(req = {}, policies = {}) {
  const dept = req.department || req.agent?.department || null;
  const tags = new Set([...(req.tags || []), ...((req.task && req.task.tags) || [])]);
  const list = Array.isArray(policies) ? policies : Object.entries(policies).map(([id, p]) => ({ id, ...p }));
  return list.filter((p) => {
    const a = p.appliesTo;
    if (!a) return true; // company-wide
    const deptOk = !a.departments || (dept && a.departments.includes(dept));
    const tagOk = !a.tags || a.tags.some((t) => tags.has(t));
    // If a policy scopes BOTH, either match binds it (a legal policy on the marketing dept OR on a
    // publish-copy tag should catch a publish-copy task raised anywhere).
    if (a.departments && a.tags) return deptOk || tagOk;
    return deptOk && tagOk;
  });
}

/**
 * The review context a reviewer node loads to validate its target: the bound policy ids + their
 * criteria. This is the concrete answer to "are the instructions loaded to the reviewer depending
 * on what it validates?" — yes, as the criteria of the policies that bind to the work. Pure.
 */
export function reviewContextFor(node = {}) {
  return { policies: node.policies || [], criteria: node.reviewCriteria || [] };
}

/**
 * Human-minimized gate resolution. Given the reviewer's structured verdict
 * ({ pass, flags:[] }) and the gate node, decide whether a human is needed:
 * - conditional gate + reviewer passed with no flags → AUTO-CLEARED (no human).
 * - otherwise → pending-human-approval, carrying a brief when the node asks for one.
 * Pure; the orchestrator applies the returned fields onto the gate result.
 */
export function resolveApprovalGate({ review = null, node = {}, brief = null } = {}) {
  const passed = review && review.pass === true && (!Array.isArray(review.flags) || review.flags.length === 0);
  if (node.conditional && passed) {
    return { status: "auto-cleared-by-reviewer", humanRequired: false, clearedBy: "reviewer", flags: [] };
  }
  return {
    status: "pending-human-approval", humanRequired: true,
    reason: node.conditional ? "reviewer flagged — escalated to human" : "real-world action requires human approval",
    flags: (review && review.flags) || [],
    ...(node.brief ? { brief: brief || null } : {}),
  };
}

/**
 * Compose a MAXIMUM-INFORMATION decision brief for the human validator — so the escalation is a fast
 * yes/no, not research. Includes what was produced, every criterion checked with its verdict, the
 * specific flags, the reviewer's recommendation, and the single decision to make. Pure.
 */
export function escalationBrief({ task = {}, artifact = null, review = {}, policies = [] } = {}) {
  const criteria = policies.flatMap((p) => (p.criteria || []).map((c) => ({ policy: p.id, criterion: c })));
  const flags = Array.isArray(review.flags) ? review.flags : [];
  return {
    decision: "Approve or reject this before it takes effect.",
    what: task.summary || task.objective || task.title || "(unnamed task)",
    department: task.department || null,
    artifact,
    policiesChecked: policies.map((p) => p.id).filter(Boolean),
    criteria,
    reviewer: {
      verdict: review.pass === true && flags.length === 0 ? "pass" : "flagged",
      flags,
      notes: review.notes || null,
      recommendation: review.recommendation || (flags.length ? "hold for human decision" : "safe to approve"),
    },
    escalatedBecause: flags.length ? `reviewer raised ${flags.length} flag(s)` : "policy requires human sign-off",
  };
}

/** Resolve a capability slot → concrete connection via the user's assignments (+ free catalog). */
export function selectModel(slot, { assignments, connections, catalog, departmentDefaults = {} }) {
  if (!slot) return { slot: null, deterministic: true };            // a tool node needs no model
  const connId = assignments[slot] || departmentDefaults[slot];
  let conn = connId ? connections.find((c) => c.id === connId) : null;
  // free slots fall back to the live catalog (another FREE model) — never to paid.
  if (!conn && /-free$/.test(slot) && catalog) {
    const e = catalog.pickFree({ coding: slot.startsWith("coding"), reasoning: slot.startsWith("reasoning") });
    if (e) conn = { id: `catalog:${e.model}`, kind: "opencode-free", provider: e.provider, model: e.model, costSource: "free", funder: "free" };
  }
  if (!conn) return { slot, needsConfiguration: true, options: ["free", "byok", "local", "stop"] }; // NEVER auto-paid
  const v = validateConnection(conn);
  if (!v.ok) throw new Error(`Community invariant: ${v.reason} (slot ${slot}, conn ${conn.id})`);
  return { slot, connection: conn, provider: conn.provider, model: conn.model, costSource: conn.costSource, funder: conn.funder };
}

/**
 * Preflight a WHOLE company config before any execution. Returns { ok, errors, warnings } —
 * never throws. Errors make the config unrunnable (invalid connection, unknown slot, dangling
 * assignment, duplicate ids); warnings are safe-but-noteworthy (unassigned slot → free-catalog
 * fallback or needsConfiguration at runtime). Fail-closed on the zero-funded invariant via
 * validateConnection. Pure; no I/O.
 */
export function validateCompanyConfig(cfg) {
  const errors = [], warnings = [];
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return { ok: false, errors: ["company config must be an object"], warnings };

  const company = cfg.company || {};
  if (!company.name && !cfg.name) warnings.push("company.name is empty");
  if ((company.brainoutputFundedInference || "forbidden") !== "forbidden")
    errors.push("company.brainoutputFundedInference must be 'forbidden' (Community invariant)");

  // departments are optional — store.mjs derives them from agents — but if present they bind.
  const departments = cfg.departments;
  const deptList = Array.isArray(departments) ? departments : [...new Set((cfg.agents || []).map((a) => a?.department).filter(Boolean))];
  for (const d of deptList) if (typeof d !== "string" || !d) errors.push("departments entries must be non-empty strings");
  if (new Set(deptList).size !== deptList.length) errors.push("departments contain duplicates");
  if (deptList.length === 0) warnings.push("no departments declared and none derivable from agents");

  const agents = cfg.agents;
  if (!Array.isArray(agents) || agents.length === 0) {
    errors.push("agents must be a non-empty array");
  } else {
    const seen = new Set();
    for (const a of agents) {
      if (!a || typeof a !== "object" || !a.id || !a.department || !a.role) {
        errors.push(`agent missing id/department/role: ${JSON.stringify(a && typeof a === "object" ? a.id ?? a : a)}`);
        continue;
      }
      if (seen.has(a.id)) errors.push(`duplicate agent id '${a.id}'`);
      seen.add(a.id);
      if (!deptList.includes(a.department)) errors.push(`agent '${a.id}' department '${a.department}' is not a declared department`);
      for (const [cap, slot] of Object.entries(a.capabilities || {}))
        if (slot && !CAPABILITY_SLOTS.includes(slot)) errors.push(`agent '${a.id}' capability '${cap}' uses unknown slot '${slot}'`);
    }
  }

  const conns = cfg.modelConnections;
  const connIds = new Set();
  if (!Array.isArray(conns)) {
    errors.push("modelConnections must be an array");
  } else {
    for (const c of conns) {
      const v = validateConnection(c);
      if (!v.ok) { errors.push(`connection '${c?.id ?? "?"}' invalid: ${v.reason}`); continue; }
      if (connIds.has(c.id)) errors.push(`duplicate connection id '${c.id}'`);
      connIds.add(c.id);
    }
    if (conns.length === 0) warnings.push("no model connections — every slot will need configuration at runtime");
  }

  const assignments = cfg.modelAssignments;
  if (!assignments || typeof assignments !== "object" || Array.isArray(assignments)) {
    errors.push("modelAssignments must be an object mapping capability slot → connection id");
  } else {
    for (const [slot, connId] of Object.entries(assignments)) {
      if (!CAPABILITY_SLOTS.includes(slot)) errors.push(`modelAssignments uses unknown capability slot '${slot}'`);
      if (!connIds.has(connId)) errors.push(`modelAssignments '${slot}' → unknown connection '${connId}'`);
    }
  }

  // Warn on capability slots agents reference that have no assignment (runtime falls back to the
  // free catalog for *-free slots; anything else surfaces needsConfiguration — never paid).
  if (Array.isArray(agents) && assignments && typeof assignments === "object") {
    const referenced = new Set();
    for (const a of agents) for (const slot of Object.values(a?.capabilities || {})) if (slot) referenced.add(slot);
    for (const slot of referenced)
      if (!(slot in assignments))
        warnings.push(/-free$/.test(slot)
          ? `slot '${slot}' unassigned — free-catalog fallback at runtime`
          : `slot '${slot}' unassigned — tasks using it will needConfiguration (free/byok/local/stop, never paid)`);
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Route ONE task to an agent, a smallest execution graph, and a model per node — all user/free/
 * local. Throws if any resolved node would use BrainOutput-funded inference (fail-closed).
 */
export function routeTask(req, ctx) {
  const { agents, assignments, connections, catalog, departments = {}, policies = {} } = ctx;
  const agent = req.agent ||
    agents.find((a) => a.department === req.department && (!req.role || a.role === req.role)) ||
    agents.find((a) => a.department === req.department);
  if (!agent) return { ok: false, reason: `no agent for department '${req.department}'${req.role ? "/" + req.role : ""}` };

  // Agent capability slots are DEFAULTS; an explicit task slot overrides them (task wins).
  const caps = agent.capabilities || {};
  const task = { ...req.task, ...req.taskOverrides };
  task.plannerSlot = task.plannerSlot || caps.planner;
  task.workerSlot = task.workerSlot || caps.worker;
  task.reviewerSlot = task.reviewerSlot || caps.reviewer;
  // Bind the policies relevant to THIS work (by department/tags) — their criteria load into the
  // reviewer's context (see selectPolicies/reviewContextFor). The worker operated under them; the
  // reviewer now validates against exactly them. Explicit task.policies (if pre-bound) win.
  const boundPolicies = Array.isArray(task.policies) ? task.policies
    : selectPolicies({ department: agent.department, tags: task.tags, task }, policies);
  task.policies = boundPolicies;
  const graph = planGraph(task);
  const deptDefaults = departments[agent.department]?.capabilityDefaults || {};
  let plan = graph.nodes.map((n) => ({ ...n, model: selectModel(n.slot, { assignments, connections, catalog, departmentDefaults: deptDefaults }) }));
  plan = applyStageOverrides(plan, agent, connections);   // ADVANCED: per-stage models + privacy rules
  plan = applyPrivacyFloor(plan, ctx.settings?.privacy);  // company-wide: full-private = local only

  const funded = assertZeroFunded(plan);
  const needsConfig = plan.filter((n) => n.model?.needsConfiguration);
  return { ok: true, agent: agent.id, department: agent.department, shape: graph.shape, plan, zeroBrainOutputFunded: funded, needsConfiguration: needsConfig.map((n) => n.slot), policies: boundPolicies.map((p) => p.id).filter(Boolean), boundPolicies };
}

/**
 * ADVANCED MODE: apply an agent's per-stage runtime/model overrides to a routed plan, and enforce its
 * privacy classification. A stage may run on a different model/runtime/provider than the rest of the
 * plan. Privacy is FAIL-CLOSED: a `confidential`/`restricted` agent may only use a LOCAL model — a
 * cloud model is never silently used, the stage becomes unconfigured with local/stop as the options.
 * Pure. Only active when the agent carries advanced config, so Regular mode is unchanged.
 */
export function applyStageOverrides(plan, agent = {}, connections = []) {
  const stages = agent.stageRuntimes || {};
  const adv = agent.advanced || {};
  const privateOnly = ["confidential", "restricted"].includes(adv.privacy);
  if (!Object.keys(stages).length && !privateOnly) return plan;

  return plan.map((n) => {
    const kind = String(n.node).replace(/\d+$/, "");
    let node = n;
    const ov = stages[kind];
    if (ov && !n.gate && !n.tool) {
      const conn = typeof ov === "string" ? connections.find((c) => c.id === ov)
        : ov.connection || connections.find((c) => c.id === (ov.connectionId || ov.id));
      if (conn) {
        const v = validateConnection(conn);
        if (!v.ok) throw new Error(`stage override for '${kind}': ${v.reason}`);
        node = { ...n, model: { slot: n.slot, connection: conn, provider: conn.provider, model: conn.model,
          costSource: conn.costSource, funder: conn.funder, runtime: conn.runtime || null, override: true } };
      }
    }
    if (privateOnly && node.model?.funder && node.model.funder !== "local") {
      node = { ...node, model: { slot: node.slot, needsConfiguration: true, options: ["local", "stop"],
        privacyBlocked: adv.privacy, reason: `privacy '${adv.privacy}' requires a local model` } };
    }
    return node;
  });
}

/** True iff no node draws on BrainOutput-funded inference. Throws if a funded node slipped through. */
export function assertZeroFunded(plan) {
  for (const n of plan) {
    const f = n.model?.funder;
    if (f && !ALLOWED_FUNDERS.includes(f)) throw new Error(`BrainOutput-funded inference in plan (node ${n.node}, funder ${f})`);
  }
  return true;
}

// ── Company privacy posture: who may run models WHERE. ────────────────────────
// "open"   — any user/free/local connection may run (today's behaviour; the user picks per slot).
// "private"— FULL PRIVATE: only local models may execute, company-wide. Any stage that would run
//            on a free/cloud connection is left UNCONFIGURED with local/stop as the only options —
//            fail-closed, never a silent cloud call. Per-agent confidentiality
//            (applyStageOverrides) still applies on top.
export const PRIVACY_POSTURES = ["open", "private"];

export function applyPrivacyFloor(plan, posture) {
  if (posture !== "private") return plan;
  return plan.map((n) => {
    if (n.gate || n.tool || n.model?.deterministic) return n;          // tools/gates use no model
    if (n.model?.needsConfiguration) return n;                          // already unconfigured — nothing leaks
    const f = n.model?.funder;
    if (!f || f === "local") return n;
    return { ...n, model: { slot: n.slot, needsConfiguration: true, options: ["local", "stop"],
      privacyBlocked: "private", reason: "company posture is full-private — only local models may run" } };
  });
}

/**
 * Visible execution status for a finished run. PURE — never mutates `results`.
 * Each result: { node, tokens, costSource, funder, changedFiles?, artifact? }.
 * brainoutputFundedTokens must always be 0 in Community (funder not in ALLOWED_FUNDERS).
 */
export function executionSummary(results) {
  const sum = { tokens: 0, byCostSource: {}, fundersUsed: [], brainoutputFundedTokens: 0, zeroFundedOk: true, artifacts: [] };
  const funders = new Set();
  for (const r of results) {
    const tokens = r.tokens || 0;
    sum.tokens += tokens;
    const src = r.costSource || "unknown";
    sum.byCostSource[src] = (sum.byCostSource[src] || 0) + tokens;
    if (r.funder) funders.add(r.funder);
    if (r.funder && !ALLOWED_FUNDERS.includes(r.funder)) sum.brainoutputFundedTokens += tokens;
    if (typeof r.artifact === "string" && r.artifact) sum.artifacts.push(r.artifact);
    if (Array.isArray(r.changedFiles)) sum.artifacts.push(...r.changedFiles.filter((f) => typeof f === "string" && f));
  }
  sum.fundersUsed = [...funders].sort();
  sum.zeroFundedOk = sum.brainoutputFundedTokens === 0;
  return sum;
}

/** Sum only user/free/local token usage; BrainOutput-funded must always be 0. */
export function costReport(results) {
  const rep = { byCostSource: {}, brainoutputFundedTokens: 0, nodes: [] };
  for (const r of results) {
    const src = r.costSource || (r.deterministic ? "deterministic-tool" : r.gate ? "human-approval" : "unknown");
    rep.byCostSource[src] = (rep.byCostSource[src] || 0) + (r.tokens || 0);
    if (r.funder && !ALLOWED_FUNDERS.includes(r.funder)) rep.brainoutputFundedTokens += (r.tokens || 0);
    rep.nodes.push({ node: r.node, model: r.model || null, provider: r.provider || null, costSource: src, tokens: r.tokens || 0, artifact: r.artifact || null });
  }
  return rep;
}
