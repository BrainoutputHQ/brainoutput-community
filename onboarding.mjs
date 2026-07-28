// SPDX-License-Identifier: Apache-2.0
// BrainOutput Community Edition — first-run onboarding engine (product architecture 2026-07-27).
// Pure logic (no I/O; the driver does probes/prompts). Implements the 10-step flow: detect/connect
// user models → describe company → pick departments → note knowledge sources → generate the
// MINIMUM useful org → recommend a model per capability slot with its cost source → allow override
// → confirm $0 BrainOutput inference → deploy agents DORMANT. ESM, zero-dep.
import { validateConnection, CAPABILITY_SLOTS } from "./ce-core.mjs";
import { DEPARTMENT_TEMPLATES, ACTIVATION_DEFAULT } from "./departments.mjs";
import { runtimeConnection, describeLocation } from "./runtimes.mjs";

// Minimum-useful role templates per department (the org generator instantiates only selected depts).
export const ROLE_TEMPLATES = {
  "executive":        [{ role: "ceo", caps: { planner: "reasoning-premium", reviewer: "high-trust-review" }, tools: ["board"], permissions: ["decide"], approvals: {} }],
  "technical":        [{ role: "architect", caps: { planner: "reasoning-premium", worker: "coding-free", reviewer: "high-trust-review" }, tools: ["repo", "run-tests"], permissions: ["read-repo", "write-branch"], approvals: { deploy: "human" } },
                       { role: "engineer", caps: { worker: "coding-free" }, tools: ["repo", "run-tests"], permissions: ["read-repo", "write-branch"], approvals: {} }],
  "customer-service": [{ role: "support", caps: { planner: "reasoning-free", worker: "multilingual", reviewer: "private-local" }, tools: ["kb-search"], permissions: ["read-kb", "send-reply-draft"], approvals: {} }],
  "sales":            [{ role: "sdr", caps: { planner: "reasoning-free", worker: "fast-cheap" }, tools: ["crm"], permissions: ["read-crm"], approvals: {} }],
  "marketing":        [{ role: "content", caps: { planner: "reasoning-free", worker: "fast-cheap", vision: "vision" }, tools: ["cms"], permissions: ["draft"], approvals: { publish: "human", "ad-spend": "human" } }],
  "finance":          [{ role: "controller", caps: { planner: "private-local", worker: "fast-cheap", reviewer: "high-trust-review", vision: "vision" }, tools: ["reconcile", "extract-invoice"], permissions: ["read-ledger"], approvals: { payment: "human", transfer: "human" } }],
  "human-resources":  [{ role: "people-ops", caps: { planner: "reasoning-free", worker: "fast-cheap", reviewer: "private-local" }, tools: ["hris"], permissions: ["read-hr"], approvals: { "employment-decision": "human" } }],
  "legal-compliance": [{ role: "counsel", caps: { planner: "private-local", reviewer: "high-trust-review" }, tools: ["policy"], permissions: ["read-policy"], approvals: { "legal-commitment": "human" } }],
  "operations":       [{ role: "ops", caps: { planner: "reasoning-free", worker: "fast-cheap" }, tools: ["procurement"], permissions: ["read-ops"], approvals: { purchase: "human" } }],
  "data-research":    [{ role: "analyst", caps: { planner: "reasoning-free", worker: "long-context", embeddings: "embeddings" }, tools: ["search"], permissions: ["read-data"], approvals: {} }],
};

// Step 1 — turn raw probe results into validated user/free/local Model Connections.
export function detectConnections({ localModels = [], byokKeys = {}, freeAvailable = false } = {}) {
  const conns = [];
  for (const m of localModels) {
    conns.push({ id: `local:${m.name}`, kind: "local", provider: m.provider || "ollama", model: m.name,
      endpoint: m.endpoint || "http://127.0.0.1:11434/v1/chat/completions", costSource: "local-compute", funder: "local",
      contextSize: m.contextSize || null, vision: !!m.vision, multilingual: m.multilingual !== false, coding: m.coding !== false });
  }
  for (const [prov, env] of Object.entries(byokKeys)) {
    if (!env?.present) continue;
    conns.push({ id: `byok:${prov}`, kind: "byok", provider: prov, model: env.model || "(user-selected)",
      endpoint: env.endpoint || "", apiKeyEnv: env.envName, costSource: env.subscription ? "user-subscription" : "user-api-account", funder: "user" });
  }
  // keep only Community-valid connections (rejects any BrainOutput-funded/paid-credential source)
  return { connections: conns.filter((c) => validateConnection(c).ok), freeAvailable };
}

// Step 0 — the model-source choice a first-time user sees. "Use free models" is the clearest DEFAULT;
// local and BYOK are equally available. Plain language, no jargon. Nothing here is BrainOutput-funded.
export function onboardingModelPaths() {
  return [
    { key: "free",        runtime: "generic-llm",  label: "Use free models",              default: true,  payer: "free — the provider pays", where: "cloud model" },
    { key: "claude-code", runtime: "claude-code",  label: "Use Claude Code",              default: false, payer: "your Claude subscription", where: "local CLI, cloud model" },
    { key: "codex",       runtime: "codex",        label: "Use Codex",                    default: false, payer: "your OpenAI account",     where: "local CLI, cloud model" },
    { key: "byok",        runtime: "generic-llm",  label: "Connect another provider",     default: false, payer: "your own provider account", where: "cloud model" },
    { key: "local",       runtime: "local-openai", label: "Use local models on this computer", default: false, payer: "runs on your own computer", where: "fully local model" },
  ];
}

// Plain-language "who pays" for a model, from its funder. Never implies BrainOutput pays.
export function payerLabel(funder) {
  switch (funder) {
    case "free":  return "free — the provider pays";
    case "local": return "runs on your own computer";
    case "user":  return "your own provider account";
    default:      return "not available — connect a model you own";
  }
}

// When a capability slot (e.g. "vision") has no available model, offer useful, non-paid alternatives —
// never a paid/BrainOutput fallback. Returns plain-language options a first-time user can act on.
export function capabilityAlternatives(slot, connections = []) {
  if (slot === "vision")
    return ["Connect a vision-capable provider (BYOK)", "Run a local vision model (e.g. llava)", "Skip vision for now"];
  return ["Use a free model for this", "Run a local model for this", "Connect your own provider", "Skip it for now"];
}

// Step 5 — generate the minimum useful org for the selected departments (dormant-by-default).
export function generateOrg({ companyDoes = "", departments = [] } = {}) {
  const agents = [];
  for (const dept of departments) {
    const roles = ROLE_TEMPLATES[dept] || [];
    for (const t of roles) {
      agents.push({ id: `${dept}-${t.role}`, department: dept, role: t.role,
        objectives: [`Support "${companyDoes || "the company"}" within ${dept}`],
        capabilities: t.caps, tools: t.tools, permissions: t.permissions, approvalThresholds: t.approvals,
        activation: ACTIVATION_DEFAULT });
    }
  }
  return agents;
}

// Rank a connection's fitness for a capability slot (higher = better). Local/free preferred → $0.
function fitness(slot, c) {
  let s = 0;
  if (slot === "vision" && !c.vision) return -1;                              // hard requirement
  if (slot.startsWith("coding") && c.coding === false) s -= 2;
  if (slot === "multilingual" && c.multilingual === false) return -1;
  if (slot === "private-local" && c.funder !== "local") return -1;            // private ⇒ local only
  // If a connection's MODEL is named for its role (coder/plan/reviewer/worker — common on local
  // gateways), match it to the slot. Generic: works for any provider, no vendor names.
  const roleModel = slot.startsWith("reasoning") || slot === "private-local" || slot === "long-context" ? "plan"
    : slot.startsWith("coding") ? "coder" : slot === "high-trust-review" ? "reviewer" : "worker";
  if (c.model === roleModel) s += 3;
  if (slot.startsWith("long-context")) s += Math.min(4, Math.floor((c.contextSize || 0) / 16000));
  if (slot.endsWith("-premium") || slot === "high-trust-review") s += (c.funder === "user" ? 3 : 1) + (c.contextSize ? 1 : 0);
  if (slot.endsWith("-free") || slot === "fast-cheap" || slot === "multilingual") s += (c.funder === "local" ? 3 : c.funder === "free" ? 2 : 0) - (c.contextSize || 8192) / 32000; // cheap/routine slots prefer smaller/faster models
  else s += (c.funder === "local" ? 2 : c.funder === "user" ? 1 : 1);
  return s;
}

// Step 6/7 — recommend a connection for every slot the org uses, with its paying source. Never paid-
// fallback: a slot with no valid option stays UNASSIGNED with options [free, byok, local, stop].
export function recommendAssignments(agents, connections) {
  const slots = new Set();
  for (const a of agents) for (const v of Object.values(a.capabilities || {})) if (v) slots.add(v);
  const assignments = {}, view = {}, unassigned = [];
  for (const slot of slots) {
    const ranked = connections.map((c) => ({ c, f: fitness(slot, c) })).filter((x) => x.f >= 0).sort((a, b) => b.f - a.f);
    if (!ranked.length) { unassigned.push(slot); view[slot] = { needsConfiguration: true, options: ["free", "byok", "local", "stop"] }; continue; }
    const c = ranked[0].c;
    assignments[slot] = c.id;
    view[slot] = { connectionId: c.id, provider: c.provider, model: c.model, costSource: c.costSource, funder: c.funder };
  }
  return { assignments, view, unassigned, slotsUsed: [...slots] };
}

// Step 8 — apply user overrides (slot → connectionId or null to clear). Rejects funded overrides.
export function applyOverrides(assignments, overrides = {}, connections) {
  const out = { ...assignments };
  for (const [slot, connId] of Object.entries(overrides)) {
    if (connId == null) { delete out[slot]; continue; }
    const c = connections.find((x) => x.id === connId);
    if (!c) throw new Error(`override for ${slot}: unknown connection ${connId}`);
    const v = validateConnection(c); if (!v.ok) throw new Error(`override for ${slot}: ${v.reason}`);
    out[slot] = connId;
  }
  return out;
}

// Step 9 — confirm the whole plan uses ZERO BrainOutput-funded inference.
export function confirmZeroFunded(assignments, connections) {
  let funded = 0; const offenders = [];
  for (const connId of Object.values(assignments)) {
    const c = connections.find((x) => x.id === connId);
    if (c && c.funder !== "free" && c.funder !== "user" && c.funder !== "local") { funded++; offenders.push(connId); }
  }
  return { ok: funded === 0, brainoutputFundedConnections: funded, offenders };
}

// Step 10 — the deployable company config; agents DORMANT by default.
export function buildCompanyConfig({ companyDoes, departments }, connections, agents, assignments) {
  return { company: { name: companyDoes || "My Company", brainoutputFundedInference: "forbidden" },
    modelConnections: connections, modelAssignments: assignments,
    agents: agents.map((a) => ({ ...a, activation: "dormant" })),
    departments, generatedAt: null };
}

// Per-agent UI view (department, role, model per slot, provider/source, cost source, tools,
// permissions, activation, tasks/outputs placeholder).
export function renderAgentView(agent, assignments, connections) {
  const slotView = {};
  for (const [role, slot] of Object.entries(agent.capabilities || {})) {
    const connId = assignments[slot];
    const c = connId ? connections.find((x) => x.id === connId) : null;
    slotView[`${role} (${slot})`] = c ? `${c.provider}/${c.model} · ${c.costSource}` : `UNCONFIGURED → free/BYOK/local/stop`;
  }
  return { id: agent.id, department: agent.department, role: agent.role, models: slotView,
    tools: agent.tools || [], permissions: agent.permissions || [], approvals: agent.approvalThresholds || {},
    activation: agent.activation || "dormant", tasks: [], outputs: [] };
}

// ── Regular vs Advanced onboarding ─────────────────────────────────────────────────────────────

/** REGULAR MODE — the 8 steps a first-time user walks through. One default model per agent. */
export function regularOnboardingSteps() {
  return [
    "1. Choose how to run your models — free · Claude Code · Codex · another provider · local",
    "2. Describe your company",
    "3. Select departments",
    "4. Review the generated team",
    "5. Assign one default model per agent",
    "6. Connect tools (read-only by default)",
    "7. Review cost sources and permissions",
    "8. Launch — agents dormant by default",
    "9. Connect your work and create your Work Twin (optional — starts in Mirror, read-only)",
  ];
}

/**
 * The Work Twin onboarding step. Every option lands in MIRROR mode (read-only) — the twin can read
 * and summarize, but cannot draft, send or change anything until you say so.
 */
export function workTwinOnboarding() {
  return {
    title: "Connect your work and create your Work Twin",
    explain: "A Work Twin is your own agent. It sees only the folders you authorize, prepares drafts you review, and never sends anything without your approval.",
    options: [
      { key: "google-workspace", label: "Continue with Google", needs: "your Google OAuth credentials" },
      { key: "microsoft-365", label: "Continue with Microsoft", needs: "your Microsoft OAuth credentials" },
      { key: "imap", label: "Connect another email server", needs: "host, user and password (IMAP/SMTP)" },
      { key: "local-mail", label: "Use local / imported email", needs: "a Maildir folder or an mbox file" },
      { key: "skip", label: "Skip for now", needs: null },
    ],
    defaultMode: "mirror",
    permissionScreen: [
      "Read and search the folders you choose — yes",
      "Prepare drafts you review — only in Copilot mode",
      "Send, delete or change anything — only in Delegate mode, with an explicit grant and your approval",
    ],
  };
}

/** ADVANCED MODE — the extra per-agent knobs unlocked beyond the single default model. */
export function advancedOnboardingFields() {
  return [
    "planner model", "worker model", "reviewer model", "fallbacks", "context limits",
    "reasoning settings", "privacy classification", "cost limits", "permissions", "approval rules",
  ];
}

/**
 * Apply an ADVANCED per-agent config: a different model/runtime per execution STAGE, plus fallbacks,
 * context limits, reasoning, privacy, cost limit, permissions and approval rules. Pure. Stage runtimes
 * are validated user/free/local by runtimeConnection at construction; here we just attach the plan.
 */
export function applyAdvancedAgentConfig(agent, adv = {}) {
  const out = { ...agent };
  // Per-stage runtime/model — the "different model, runtime and provider per stage" differentiator.
  if (adv.stages) out.stageRuntimes = { ...(out.stageRuntimes || {}), ...adv.stages };
  // MERGE with what the agent already has: a partial update must never silently erase settings the
  // caller did not mention (only an explicit null clears a value).
  const prev = out.advanced || {};
  const pick = (k, dflt = null) => (k in adv ? (adv[k] ?? null) : (prev[k] ?? dflt));
  out.advanced = {
    fallbacks: pick("fallbacks"),               // ordered fallback runtimes (never a paid auto-fallback)
    contextLimits: pick("contextLimits"),
    reasoning: pick("reasoning"),
    privacy: pick("privacy", "internal"),       // public | internal | confidential | restricted
    costLimit: pick("costLimit"),
  };
  if (adv.permissions) out.permissions = adv.permissions;
  if (adv.approvals) out.approvalThresholds = adv.approvals;
  return out;
}

/**
 * The onboarding EXAMPLE the founder specified — four agents, each on a DIFFERENT runtime, showing the
 * CLI-vs-local-model distinction, a read-only connector, and a private RAG source. Every runtime is
 * user/free/local; nothing BrainOutput-funded. Agents deploy DORMANT.
 */
export function onboardingExample() {
  const agents = [
    {
      id: "technical-architect", department: "technical", role: "architect",
      objectives: ["turn objectives into a plan and a tested implementation"],
      runtime: runtimeConnection({ runtime: "claude-code", provider: "anthropic", model: "claude (your plan)", authSource: "user-subscription", contextLimit: 200000 }),
      tools: ["repo", "run-tests"], permissions: ["read-repo", "write-branch"], approvalThresholds: { deploy: "human" }, activation: "dormant",
      note: "Claude Code on your Claude subscription — a local CLI calling a cloud model.",
    },
    {
      id: "software-engineer", department: "technical", role: "engineer",
      objectives: ["implement tickets and open pull requests"],
      runtime: runtimeConnection({ runtime: "codex", provider: "openai", model: "codex (your account)", authSource: "user-api-account", contextLimit: 128000 }),
      tools: ["repo", "run-tests"], permissions: ["read-repo", "write-branch"], approvalThresholds: {}, activation: "dormant",
      note: "Codex on your OpenAI account — a local CLI calling a cloud model.",
    },
    {
      id: "legal-clerk", department: "legal-compliance", role: "clerk",
      objectives: ["answer policy questions from the company's own documents"],
      runtime: runtimeConnection({ runtime: "local-openai", provider: "ollama", model: "qwen3.5-122b", authSource: "local", modelLocation: "local", contextLimit: 32000 }),
      tools: ["policy", "rag:private-legal"], permissions: ["read-policy", "read:rag"], approvalThresholds: { "legal-commitment": "human" }, activation: "dormant",
      rag: { source: "private-legal-docs", access: "read-only" },
      note: "A FULLY LOCAL model + a private RAG source — nothing leaves the machine.",
    },
    {
      id: "customer-support-agent", department: "customer-service", role: "support",
      objectives: ["answer customer questions in the customer's language"],
      runtime: runtimeConnection({ runtime: "generic-llm", provider: "free-provider", model: "(free multilingual model)", authSource: "free", capabilities: ["multilingual", "tools"] }),
      tools: ["zendesk"], permissions: ["read:zendesk"], approvalThresholds: { "send-reply": "human" }, activation: "dormant",
      connectors: [{ system: "zendesk", scope: "read", access: "read-only" }],
      note: "A free multilingual model + Zendesk connected READ-ONLY (sending a reply needs approval).",
    },
  ];
  return {
    company: { name: "Example Co", brainoutputFundedInference: "forbidden" },
    departments: ["technical", "legal-compliance", "customer-service"],
    agents,
    where: agents.map((a) => ({ id: a.id, runs: describeLocation(a.runtime) })),
    note: "Every agent runs on a DIFFERENT runtime — Claude Code, Codex, a fully local model, and a free model.",
  };
}
