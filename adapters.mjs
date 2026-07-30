// SPDX-License-Identifier: Apache-2.0
// BrainOutput Community Edition — executor-neutral runtime adapters .
// An adapter turns one execution-graph node into a result. Only user/free/local sources here;
// no BrainOutput-funded inference. Deterministic tools and human-approval use NO model at all.
import http from "node:http";
import https from "node:https";
import { resolveApprovalGate, escalationBrief } from "./ce-core.mjs";

// Minimal OpenAI-compatible /v1/chat/completions client (works with ollama, local, or BYOK).
export async function chatCompletion({ endpoint, model, apiKey, prompt, maxTokens = 512, timeoutMs = 60000 }) {
  const url = new URL(endpoint);
  const body = JSON.stringify({ model, messages: [{ role: "user", content: prompt }], stream: false, max_tokens: maxTokens, temperature: 0.2 });
  const lib = url.protocol === "https:" ? https : http;
  const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return new Promise((resolve, reject) => {
    const req = lib.request(url, { method: "POST", headers, timeout: timeoutMs }, (res) => {
      let data = ""; res.on("data", (d) => (data += d));
      res.on("end", () => {
        let j;
        try { j = JSON.parse(data); }
        catch { return reject(new Error(`bad completion response from ${url.host}: ${data.slice(0, 200)}`)); }
        // An API error must NEVER look like a successful empty answer. A missing model, a bad key or a
        // rate limit has to surface as a failure the caller can act on.
        const apiErr = j.error?.message || j.error || j.detail;
        if (res.statusCode >= 400 || apiErr)
          return reject(new Error(`model '${model}' failed (${res.statusCode}): ${typeof apiErr === "string" ? apiErr : JSON.stringify(apiErr || j).slice(0, 160)}`));
        const msg = j.choices?.[0]?.message ?? {};
        const content = msg.content;
        // Reasoning models (Step, o-series, DeepSeek-R1…) spend the token budget on
        // `reasoning_content` FIRST and return content:"" when it runs out. An empty string is not
        // null, so the old check let that through as a successful empty answer — the same failure
        // this file already refuses for a missing model. Found against a real GB10.
        if (content == null || String(content).trim() === "") {
          const reasoned = String(msg.reasoning_content ?? "").trim().length;
          const why = reasoned
            ? `it spent the whole ${maxTokens}-token budget on reasoning (${reasoned} chars) and had none left for an answer — raise maxTokens`
            : `response: ${JSON.stringify(j).slice(0, 160)}`;
          return reject(new Error(`model '${model}' returned no content — ${why}`));
        }
        const usage = j.usage || {};
        resolve({ content, tokens: usage.total_tokens ?? ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0)), raw: j });
      });
    });
    req.on("error", reject); req.on("timeout", () => req.destroy(new Error("timeout")));
    req.write(body); req.end();
  });
}

// Deterministic tools — pure logic, no model, no tokens. The router prefers these over LLM calls.
export const DETERMINISTIC_TOOLS = {
  "reconcile": (input) => {
    const { ledger = [], statement = [] } = input || {};
    const sum = (a) => a.reduce((s, x) => s + (x.amount || 0), 0);
    const diff = +(sum(statement) - sum(ledger)).toFixed(2);
    return { matched: diff === 0, ledgerTotal: sum(ledger), statementTotal: sum(statement), difference: diff };
  },
  // "run-tests" REMOVED: it returned a hardcoded `passed: true` and executed nothing, under a
  // homepage line claiming tests "run as deterministic code". A tool that cannot fail is worse
  // than no tool — it launders a guess into a green check. Reinstate only with a real runner.
  "noop": () => ({ ok: true }),
};

// Execute one plan node. `nodeModel` is the resolved model object from ce-core.selectModel().
export async function runNode(node, nodeModel, input = {}, opts = {}) {
  // human-approval gate — pauses for a person; never a model.
  if (node.gate) return { node: node.node, gate: true, status: "pending-human-approval", tokens: 0, artifact: null };
  // deterministic tool — no model.
  if (node.tool || nodeModel?.deterministic) {
    const fn = DETERMINISTIC_TOOLS[node.tool] || DETERMINISTIC_TOOLS.noop;
    return { node: node.node, deterministic: true, tokens: 0, output: fn(input), artifact: `tool:${node.tool || "noop"}` };
  }
  // needs a model but the user hasn't configured one → fail-closed to configuration (NEVER paid).
  if (nodeModel?.needsConfiguration)
    return { node: node.node, needsConfiguration: true, options: nodeModel.options, tokens: 0, note: `slot '${nodeModel.slot}' unassigned — offer free/BYOK/local or stop` };

  const conn = nodeModel.connection;
  const endpoint = conn.endpoint || "http://127.0.0.1:11434/v1/chat/completions";
  const apiKey = conn.apiKeyEnv ? process.env[conn.apiKeyEnv] : undefined;

  // Reviewer carrying policy criteria → validate the artifact against EXACTLY those criteria and
  // return a structured verdict { pass, flags[], notes }. This is where "the instructions for what
  // it validates" are loaded into the reviewer's context. Fail-SAFE: an injected/dry verdict wins;
  // an unparseable model verdict escalates (never silently auto-clears).
  if (Array.isArray(node.reviewCriteria) && node.reviewCriteria.length) {
    const target = input.artifact || input.toReview || input.prompt || "(no artifact provided)";
    const criteria = node.reviewCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
    const base = { node: node.node, model: conn.model, provider: conn.provider, costSource: conn.costSource, funder: conn.funder, artifact: `review:${conn.provider}/${conn.model}` };
    if (opts.reviewVerdict || opts.dryRun) {
      const review = opts.reviewVerdict || { pass: true, flags: [], notes: "(dry-run reviewer — no model called)" };
      return { ...base, tokens: 0, review, output: review.notes };
    }
    const reviewPrompt =
      `You are an INDEPENDENT reviewer. Validate the work strictly against these criteria and reply ONLY with JSON: {"pass":true|false,"flags":["..."],"notes":"...","recommendation":"..."}.\n\nCriteria:\n${criteria}\n\nWork to review:\n${target}`;
    const rr = await chatCompletion({ endpoint, model: conn.model, apiKey, prompt: reviewPrompt, maxTokens: opts.maxTokens || 400, timeoutMs: opts.timeoutMs || 60000 });
    let review;
    try {
      const m = (rr.content || "").match(/\{[\s\S]*\}/);
      review = m ? JSON.parse(m[0]) : null;
    } catch { review = null; }
    if (!review || typeof review.pass !== "boolean")
      review = { pass: false, flags: ["reviewer verdict not parseable — escalate to human"], notes: rr.content || "", recommendation: "hold for human decision" };
    if (!Array.isArray(review.flags)) review.flags = [];
    return { ...base, tokens: rr.tokens, review, output: rr.content };
  }

  const prompt = input.prompt || opts.prompt || "Respond concisely.";
  if (opts.dryRun) return { node: node.node, model: conn.model, provider: conn.provider, costSource: conn.costSource, funder: conn.funder, tokens: 0, artifact: "(dry-run: not executed)", output: null };
  const r = await chatCompletion({ endpoint, model: conn.model, apiKey, prompt, maxTokens: opts.maxTokens || 400, timeoutMs: opts.timeoutMs || 60000 });
  return { node: node.node, model: conn.model, provider: conn.provider, costSource: conn.costSource, funder: conn.funder, tokens: r.tokens, output: r.content, artifact: `completion:${conn.provider}/${conn.model}` };
}

// Run a whole routed plan; returns the results array (feed to ce-core.costReport).
// A human-approval gate is resolved AGAINST the preceding reviewer's verdict: a conditional gate
// whose reviewer passed clears with no human; anything flagged (or a hard real-world action) pends
// for a human and carries a maximum-information brief. `opts.boundPolicies`/`opts.task` enrich the
// brief; `opts.reviewVerdict` injects a deterministic verdict for demos/tests.
export async function executePlan(plan, inputsByNode = {}, opts = {}) {
  const out = [];
  let lastReview = null;
  for (const n of plan) {
    let r = await runNode(n, n.model, inputsByNode[n.node] || inputsByNode._all || {}, opts);
    if (n.node === "reviewer" && r.review) lastReview = r.review;
    if (n.gate) {
      const brief = n.brief
        ? escalationBrief({ task: opts.task || {}, artifact: opts.artifact ?? null, review: lastReview || {}, policies: opts.boundPolicies || [] })
        : null;
      r = { ...r, ...resolveApprovalGate({ review: lastReview, node: n, brief }) };
    }
    out.push(r);
  }
  return out;
}

// Adapter registry (executor-neutral). Claude Code / Codex / Hermes are OPTIONAL later adapters.
export const ADAPTERS = {
  "opencode": "engineering/repository work — runs through the hardened sandbox with a user/free/local coding model (never a BrainOutput-hosted paid model in Community)",
  "generic-llm-agent": "customer service, sales, marketing, HR, finance, general tool workflows via an OpenAI-compatible endpoint (free/BYOK/local)",
  "local-openai-compatible": "a user's local model server (e.g. ollama/vLLM) — runs on your own machine",
  "deterministic-workflow": "pure tools, no model",
  "human-approval": "a person authorizes a real-world action; no model",
};
