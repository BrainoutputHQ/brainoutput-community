// SPDX-License-Identifier: Apache-2.0
// BrainOutput Community Edition — free models from OpenCode Zen (2026-07-31, founder request:
// "use opencode free models from the start if needed"). A hosted workspace has no ollama —
// free models are the only zero-config path to a working first run.
//
// Honesty rules (unchanged from the rest of CE):
//  - NEVER one hardcoded model: candidates are health-checked with a REAL minimal completion
//    at connect time; the first healthy one wins; if none answer, we say so.
//  - The free tier is labeled: during the free period, prompts may be used to improve the
//    model (per Zen's own privacy note) — confidential work belongs on a local model or BYOK.
//  - costSource "free", funder "free" — the Community invariant (never BrainOutput-funded).
//
// Candidates per Zen's public docs (https://opencode.ai/docs/zen), all OpenAI-compatible
// chat/completions, anonymous (no key) at the time of writing. The list is a CANDIDATE SET,
// not a promise — health checks decide, and the endpoint is overridable (tests, gateways).
export const ZEN_CHAT_ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";
export const FREE_CANDIDATES = [
  "deepseek-v4-flash-free",
  "big-pickle",
  "mimo-v2.5-free",
  "laguna-s-2.1-free",
  "ling-3.0-flash-free",
  "north-mini-code-free",
  "nemotron-3-ultra-free",
];

export const FREE_PRIVACY_NOTE =
  "Free models (OpenCode Zen): $0, no key needed — but during the free period prompts may be used to improve the model. Don't send confidential data through them; use a local model or your own key for private work.";

/** A REAL minimal completion — a model that cannot answer is not "available".
 *  Requires visible CONTENT within a tiny budget: reasoning models (deepseek-r1-style) spend
 *  it all on hidden reasoning_content and return "" — fine models, wrong fit for a chat UI
 *  where the user watches a blank assistant for minutes. We prefer models that answer fast
 *  and directly; a reasoning-only set fails honestly. */
export async function healthCheckFree(endpoint, model, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const started = Date.now();
  try {
    const r = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with exactly: ok" }], max_tokens: 8 }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return { model, ok: false, reason: `HTTP ${r.status}` };
    const j = await r.json();
    const content = j.choices?.[0]?.message?.content;
    if (content == null || String(content).trim() === "")
      return { model, ok: false, reason: j.choices?.[0]?.message?.reasoning_content ? "reasoning-only answer (too slow for chat)" : "empty completion" };
    return { model, ok: true, ms: Date.now() - started };
  } catch (e) { return { model, ok: false, reason: String(e.message || e) }; }
}

/** All candidates checked in PARALLEL (one connect-time burst); the fastest healthy wins. */
export async function pickFreeModel({ endpoint = process.env.BO_CE_FREE_ENDPOINT || ZEN_CHAT_ENDPOINT,
  candidates = FREE_CANDIDATES, fetchImpl = fetch } = {}) {
  const tried = await Promise.all(candidates.map((m) => healthCheckFree(endpoint, m, { fetchImpl })));
  const healthy = tried.filter((h) => h.ok);
  // The product EXECUTES work — a chat-only model is a dead end for missions. Probe tool
  // calling for real on the healthy candidates; tool-capable models rank first, then speed.
  const probed = await Promise.all(healthy.map(async (h) => ({ ...h, ...(await toolProbeFree(endpoint, h.model, { fetchImpl })) })));
  const ranked = probed.sort((a, b) => (b.tools === true) - (a.tools === true) || a.ms - b.ms);
  const best = ranked[0];
  const probedByModel = new Map(probed.map((p) => [p.model, p]));
  return { model: best?.model || null, endpoint, tried: tried.map((h) => probedByModel.get(h.model) || h), ms: best?.ms ?? null, toolSupport: best?.tools ?? null };
}

/** A REAL tool-call probe: some free models 400 on `tools`, others answer but never call. */
export async function toolProbeFree(endpoint, model, { fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  try {
    const r = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "What time is it in Paris right now? Use the get_time tool." }],
        tools: [{ type: "function", function: { name: "get_time",
          description: "Get the current time in a city",
          parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } }],
        tool_choice: "auto", max_tokens: 200,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return { tools: false, toolsReason: `HTTP ${r.status} (no tool support)` };
    const j = await r.json();
    const calls = j.choices?.[0]?.message?.tool_calls;
    if (Array.isArray(calls) && calls.length > 0) return { tools: true };
    return { tools: false, toolsReason: "answered without calling the tool" };
  } catch (e) { return { tools: false, toolsReason: String(e.message || e) }; }
}

/** The ce-core connection for a picked free model. */
export function freeConnection({ id, model, endpoint = ZEN_CHAT_ENDPOINT, toolSupport = null }) {
  if (!model) throw new Error("freeConnection needs a health-checked model");
  return {
    id: id || `free-${model}`,
    kind: "opencode-free",
    provider: "OpenCode Zen",
    model,
    endpoint,
    costSource: "free",
    funder: "free",
    contextSize: 64000,
    ...(toolSupport != null ? { toolSupport } : {}),
  };
}
