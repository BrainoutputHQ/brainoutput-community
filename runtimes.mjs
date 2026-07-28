// SPDX-License-Identifier: Apache-2.0
// BrainOutput Community Edition — first-class runtimes (product architecture 2026-07-28).
// A RUNTIME is HOW an agent stage runs its model. Five are first-class. Each runtime CONNECTION
// records the fields the product must surface (item 3): runtime · provider · model · auth source ·
// cost source · local-vs-cloud · capabilities · context limit · tool support · health.
//
// CRITICAL distinction (founder): a locally-running CLI is NOT a fully-local model.
//   - Claude Code / Codex / OpenCode are CLIs that run ON YOUR MACHINE but usually call a model in
//     the provider's CLOUD, on YOUR account/subscription. (cliLocal:true, modelLocation:"cloud")
//   - Local / OpenAI-compatible (Ollama/vLLM/LM Studio) runs the MODEL on YOUR HARDWARE. Fully local.
//     (modelLocation:"local")
//
// Community invariant: a runtime NEVER uses a BrainOutput/founder credential. Only free / user / local.
import { validateConnection } from "./ce-core.mjs";

export const RUNTIME_KINDS = ["opencode", "claude-code", "codex", "local-openai", "generic-llm"];

// authSource → the funder who pays for the tokens (never "brainoutput").
const FUNDER_OF = {
  "free": "free", "local": "local", "none": "local",
  "user-subscription": "user", "user-api-account": "user",
};

export const RUNTIME_CATALOG = {
  "opencode": {
    label: "OpenCode",
    worksWith: "OpenCode",
    summary: "Coding agent for repository work — runs locally in a hardened sandbox.",
    cliLocal: true, defaultModelLocation: "cloud",
    capabilities: ["coding", "tools", "files", "repo"],
    toolSupport: true,
    authSources: ["free", "user-api-account", "local"],
    note: "A locally-running CLI. The coding model may be free/cloud or a local model you point it at.",
  },
  "claude-code": {
    label: "Claude Code",
    worksWith: "Claude Code",
    summary: "Anthropic's Claude Code CLI — runs locally, calls Claude via YOUR subscription.",
    cliLocal: true, defaultModelLocation: "cloud",
    capabilities: ["coding", "reasoning", "tools", "long-context", "vision"],
    toolSupport: true,
    authSources: ["user-subscription", "user-api-account"],
    note: "A locally-running CLI — NOT a local model. The model runs in Anthropic's cloud, on your account.",
  },
  "codex": {
    label: "Codex",
    worksWith: "Codex",
    summary: "OpenAI's Codex CLI — runs locally, calls the model via YOUR OpenAI account.",
    cliLocal: true, defaultModelLocation: "cloud",
    capabilities: ["coding", "reasoning", "tools"],
    toolSupport: true,
    authSources: ["user-api-account", "user-subscription"],
    note: "A locally-running CLI — NOT a local model. The model runs in OpenAI's cloud, on your account.",
  },
  "local-openai": {
    label: "Local / OpenAI-compatible",
    worksWith: "Ollama · vLLM · LM Studio",
    summary: "A model running on YOUR hardware via an OpenAI-compatible API.",
    cliLocal: false, defaultModelLocation: "local",
    capabilities: ["coding", "reasoning", "multilingual", "private"],
    toolSupport: false, // model-dependent; conservative default
    authSources: ["local", "none"],
    note: "A FULLY LOCAL model — nothing leaves your machine.",
  },
  "generic-llm": {
    label: "Generic LLM agent",
    worksWith: "any OpenAI-compatible provider",
    summary: "Any OpenAI-compatible endpoint — a free model or your own provider (BYOK).",
    cliLocal: false, defaultModelLocation: "cloud",
    capabilities: ["reasoning", "multilingual", "tools"],
    toolSupport: true,
    authSources: ["free", "user-api-account", "user-subscription"],
    note: "A client call to a provider — free or your own account. Not a local process.",
  },
};

/**
 * Build a RUNTIME CONNECTION record with every field the product must surface. Pure. Fail-closed:
 * authSource must be one of the runtime's allowed sources, and can never be BrainOutput-funded.
 */
export function runtimeConnection(spec = {}) {
  const base = RUNTIME_CATALOG[spec.runtime];
  if (!base) throw new Error(`unknown runtime '${spec.runtime}'`);
  const authSource = spec.authSource || base.authSources[0];
  if (!base.authSources.includes(authSource))
    throw new Error(`runtime '${spec.runtime}' does not support auth source '${authSource}'`);
  const funder = FUNDER_OF[authSource];
  if (!["free", "user", "local"].includes(funder))
    throw new Error(`runtime auth source '${authSource}' is not user/free/local (Community invariant)`);
  const costSource = spec.costSource ||
    (authSource === "local" || authSource === "none" ? "local-compute" : authSource === "free" ? "free" : authSource);
  const modelLocation = spec.modelLocation || base.defaultModelLocation;
  return {
    runtime: spec.runtime,
    provider: spec.provider || null,
    model: spec.model || null,
    authSource,
    costSource,
    funder,
    location: { cliLocal: base.cliLocal, modelLocation, fullyLocal: modelLocation === "local" && !base.cliLocal ? true : modelLocation === "local" },
    capabilities: spec.capabilities || base.capabilities,
    contextLimit: spec.contextLimit ?? null,
    toolSupport: spec.toolSupport ?? base.toolSupport,
    health: spec.health || "unknown",
  };
}

/** Plain-language "where does this run?" — the founder's CLI-vs-local-model distinction, spelled out. */
export function describeLocation(rec) {
  const base = RUNTIME_CATALOG[rec.runtime] || {};
  if (rec.location.modelLocation === "local")
    return "fully local — the model runs on your hardware; nothing leaves your machine";
  if (base.cliLocal)
    return "local CLI, cloud model — the tool runs on your machine, the model runs on your provider account";
  return "cloud model — called over the network on your account or a free provider";
}

/**
 * Validate a runtime connection for Community use. Fail-closed on any BrainOutput/founder credential.
 * Bridges to ce-core.validateConnection via an equivalent model-connection shape.
 */
export function validateRuntime(rec) {
  if (!rec || !RUNTIME_CATALOG[rec.runtime]) return { ok: false, reason: "unknown runtime" };
  if (rec.funder === "brainoutput") return { ok: false, reason: "BrainOutput-funded runtime is forbidden" };
  if (rec.usesFounderCredential) return { ok: false, reason: "must not use a BrainOutput/founder credential" };
  const asConn = {
    id: `runtime:${rec.runtime}`, kind: rec.funder === "local" ? "local" : rec.funder === "free" ? "opencode-free" : "byok",
    provider: rec.provider || rec.runtime, model: rec.model || "(user-selected)",
    costSource: rec.costSource, funder: rec.funder,
  };
  const v = validateConnection(asConn);
  return v.ok ? { ok: true } : { ok: false, reason: v.reason };
}

/**
 * Bridge a validated runtime connection into a ce-core MODEL CONNECTION the router/store can use.
 * Carries the runtime metadata alongside the connection fields. Pure. Throws if the runtime would
 * not validate (fail-closed on any BrainOutput/founder credential).
 */
export function runtimeToConnection(rec, { id, endpoint, apiKeyEnv } = {}) {
  const v = validateRuntime(rec);
  if (!v.ok) throw new Error(`cannot connect runtime: ${v.reason}`);
  return {
    id: id || `runtime:${rec.runtime}`,
    kind: rec.runtime,
    provider: rec.provider || rec.runtime,
    model: rec.model || "(user-selected)",
    endpoint: endpoint || "",
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    costSource: rec.costSource,
    funder: rec.funder,
    ...(rec.contextLimit ? { contextSize: rec.contextLimit } : {}),
    // runtime metadata the product surfaces:
    runtime: rec.runtime, authSource: rec.authSource, location: rec.location,
    capabilities: rec.capabilities, toolSupport: rec.toolSupport, health: rec.health,
  };
}

/** The user-facing runtime cards (item 3): every catalog runtime + its surfaced fields. */
export function runtimeCards() {
  return RUNTIME_KINDS.map((k) => {
    const c = RUNTIME_CATALOG[k];
    return {
      runtime: k, label: c.label, worksWith: c.worksWith, summary: c.summary, note: c.note,
      capabilities: c.capabilities, toolSupport: c.toolSupport, authSources: c.authSources,
      cliLocal: c.cliLocal, defaultModelLocation: c.defaultModelLocation,
    };
  });
}
