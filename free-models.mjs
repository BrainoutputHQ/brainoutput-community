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

/** A REAL minimal completion — a model that cannot answer is not "available". */
export async function healthCheckFree(endpoint, model, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  try {
    const r = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with exactly: ok" }], max_tokens: 8 }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return { model, ok: false, reason: `HTTP ${r.status}` };
    const j = await r.json();
    const content = j.choices?.[0]?.message?.content ?? j.choices?.[0]?.message?.reasoning_content;
    if (content == null) return { model, ok: false, reason: "empty completion" };
    return { model, ok: true };
  } catch (e) { return { model, ok: false, reason: String(e.message || e) }; }
}

/** First healthy candidate wins; checks run in order, one at a time (polite to the free tier). */
export async function pickFreeModel({ endpoint = process.env.BO_CE_FREE_ENDPOINT || ZEN_CHAT_ENDPOINT,
  candidates = FREE_CANDIDATES, fetchImpl = fetch } = {}) {
  const tried = [];
  for (const model of candidates) {
    const h = await healthCheckFree(endpoint, model, { fetchImpl });
    tried.push(h);
    if (h.ok) return { model, endpoint, tried };
  }
  return { model: null, endpoint, tried };
}

/** The ce-core connection for a picked free model. */
export function freeConnection({ id, model, endpoint = ZEN_CHAT_ENDPOINT }) {
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
  };
}
