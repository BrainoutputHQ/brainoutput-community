// BrainOutput Community Edition — executor-neutral runtime adapters .
// An adapter turns one execution-graph node into a result. Only user/free/local sources here;
// no BrainOutput-funded inference. Deterministic tools and human-approval use NO model at all.
import http from "node:http";
import https from "node:https";

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
        try {
          const j = JSON.parse(data);
          const content = j.choices?.[0]?.message?.content ?? "";
          const usage = j.usage || {};
          resolve({ content, tokens: usage.total_tokens ?? ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0)), raw: j });
        } catch (e) { reject(new Error(`bad completion response: ${data.slice(0, 200)}`)); }
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
  "run-tests": (input) => ({ command: input?.command || "n/a", passed: true, note: "deterministic test runner stub" }),
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
  const prompt = input.prompt || opts.prompt || "Respond concisely.";
  if (opts.dryRun) return { node: node.node, model: conn.model, provider: conn.provider, costSource: conn.costSource, funder: conn.funder, tokens: 0, artifact: "(dry-run: not executed)", output: null };
  const r = await chatCompletion({ endpoint, model: conn.model, apiKey, prompt, maxTokens: opts.maxTokens || 400 });
  return { node: node.node, model: conn.model, provider: conn.provider, costSource: conn.costSource, funder: conn.funder, tokens: r.tokens, output: r.content, artifact: `completion:${conn.provider}/${conn.model}` };
}

// Run a whole routed plan; returns the results array (feed to ce-core.costReport).
export async function executePlan(plan, inputsByNode = {}, opts = {}) {
  const out = [];
  for (const n of plan) out.push(await runNode(n, n.model, inputsByNode[n.node] || inputsByNode._all || {}, opts));
  return out;
}

// Adapter registry (executor-neutral). Claude Code / Codex / Hermes are OPTIONAL later adapters.
export const ADAPTERS = {
  "opencode": "engineering/repository work — runs through the hardened sandbox with a user/free/local coding model (never a BrainOutput-hosted paid model in Community)",
  "generic-llm-agent": "customer service, sales, marketing, HR, finance, general tool workflows via an OpenAI-compatible endpoint (free/BYOK/local)",
  "local-openai-compatible": "a user's local model server (e.g. ollama/vLLM) — local compute, $0 BrainOutput",
  "deterministic-workflow": "pure tools, no model",
  "human-approval": "a person authorizes a real-world action; no model",
};
