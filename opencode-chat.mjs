// SPDX-License-Identifier: Apache-2.0
// BrainOutput Community Edition — chat answers routed through OpenCode (2026-08-04).
//
// Founder's ask: "I would use opencode in the background for everything even chatbot answers —
// this allows to have only one space to manage the llm, agent skills, persistency." Gated behind
// BO_CE_OPENCODE_SERVER=1 (the SAME flag as the coding-worker server runtime) at its single call
// site, web-server.mjs's ask-mode chat reply. When the flag is unset this module is never imported.
//
// This is DELIBERATELY NOT runOpenCodeServer (opencode-server.mjs): a chat reply is not an agentic
// run — no tools, no repo exploration, no skill/agent routing, no context-compaction rotation, no
// worker-question escalation. Every one of those exists to let a multi-step coding run finish
// correctly over minutes; a chat answer needs none of them and paying their cost would make chat
// reply latency indistinguishable from a coding run (measured: see docs/OPENCODE_SERVER_API.md and
// the report — the ONLY unavoidable overhead left is opencode's own ~1.6K-token system prompt,
// baked into the `build` agent and not configurable away).
//
// Reuses the verified HTTP layer from opencode-server.mjs (apiCall-level helpers) and the isolation
// helpers from opencode-adapter.mjs — this file adds no new HTTP semantics, only the smallest
// correct sequencing for a single Q&A turn plus a small warm-server pool so a multi-turn
// conversation does not repay the ~3-10s boot + ~3s model-catalog-warmup tax on every message.
import { join } from "node:path";
import {
  OPENCODE_BIN, DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_BOOT_TIMEOUT_MS, DEFAULT_HEALTH_TIMEOUT_MS,
  DEFAULT_MODEL_CATALOG_TIMEOUT_MS,
  waitForHealth, verifyModelPresent, createSession, selectModel, sendPrompt, interruptSession,
  fetchMessages, sumAssistantTokens, subscribeEvents, createTerminalWatcher, spawnServer, stopServer,
} from "./opencode-server.mjs";
import { prepareOpenCodeWorkspace, connectionToConfig, CHAT_PERMISSION_GRANT } from "./opencode-adapter.mjs";
import { approvedWorkspaceRoots } from "./workspace-registry.mjs";

// A chat reply has its own (shorter) budget — a coding run's 240s default would let a stuck local
// model hang a chat thread for four minutes before the user sees anything.
export const DEFAULT_CHAT_TIMEOUT_MS = 90000;
// How long an idle warm server may sit before it is reaped (never .ref()'d — see below).
export const DEFAULT_CHAT_SERVER_IDLE_MS = 10 * 60 * 1000;

function timeoutAfter(ms) {
  let timer;
  const promise = new Promise((resolve) => { timer = setTimeout(resolve, ms); });
  return { promise, cancel: () => clearTimeout(timer) };
}

// ── Warm-server pool, keyed by connection identity ──────────────────────────────────────────────
// Every distinct connection (provider+model+endpoint+funder+key-env) gets its OWN server: they
// carry different isolated auth/config, and a per-conversation model picker means two threads can
// legitimately be talking to two different connections at once. Entries hold a PROMISE (not just
// the resolved value) so two chat sends racing in before the first server is up never spawn two.
const pool = new Map();

// Best-effort "is this connection's model actually confirmed present in OpenCode's live registry"
// map (task chat-model-picker requirement: "source the options from … the live GET /api/model
// registry when the server runtime is on"). Populated lazily, only as a SIDE EFFECT of a real chat
// turn actually verifying it — never probed just to answer this question (that would spin up a
// server merely to fill a dropdown, adding latency nobody asked for). Absent = never checked yet,
// not "unavailable"; the UI treats that as neutral, not a warning.
const verification = new Map();
/** Snapshot for publicState(): { [connectionId]: true|false }. Never resolves promises — instant. */
export function chatModelVerificationSnapshot() { return Object.fromEntries(verification); }

function connectionKey(connection) {
  return [connection?.provider, connection?.model, connection?.endpoint || "", connection?.apiKeyEnv || "", connection?.funder]
    .map((x) => String(x ?? "")).join("|");
}

async function startServer(connection, { workspaceBase, bin, bootTimeoutMs, healthTimeoutMs, approvedRoots }) {
  const { ws, env, modelRef } = prepareOpenCodeWorkspace({
    connection, workspace: workspaceBase, approvedRoots, permissionGrant: CHAT_PERMISSION_GRANT,
  });
  const server = await spawnServer({ bin, cwd: ws, env: { ...env, PWD: ws }, bootTimeoutMs });
  await waitForHealth(server.baseURL, { timeoutMs: healthTimeoutMs, isAlive: () => server.proc.exitCode === null });
  return { ...server, ws, modelRef, lastUsed: Date.now() };
}

/** Get (or start) the warm server for this connection. Never throws into a dangling half-started
 *  pool entry: a failed start is removed so the NEXT call gets a clean retry, not a cached rejection. */
async function getServer(connection, opts) {
  const key = connectionKey(connection);
  const cached = pool.get(key);
  if (cached) {
    try {
      const entry = await cached;
      if (entry.proc.exitCode === null && entry.proc.signalCode === null) { entry.lastUsed = Date.now(); return entry; }
    } catch { /* fall through and restart below */ }
    pool.delete(key);
  }
  const starting = startServer(connection, opts);
  pool.set(key, starting);
  try { return await starting; }
  catch (e) { pool.delete(key); throw e; }
}

/** Every text part of the assistant's LAST message this turn — a chat reply never uses tools
 *  under CHAT_PERMISSION_GRANT, so there is exactly one assistant message per turn in practice;
 *  this still degrades honestly (joins whatever text parts exist) if a model ever narrates in
 *  more than one step. */
function extractReplyText(messages) {
  const asst = [...(messages || [])].reverse().find((m) => m?.type === "assistant");
  if (!asst) return null;
  const parts = Array.isArray(asst.content) ? asst.content : [];
  const text = parts.filter((p) => p?.type === "text").map((p) => String(p.text || "")).join("\n").trim();
  return text || null;
}

/**
 * Route ONE chat turn through OpenCode's session API. Returns `{ ok, output, tokens, tokensDetail,
 * model, provider, costSource, funder }` on success. On ANY expected failure (workspace prep,
 * boot, an unverified model, a timeout, a run error) returns `{ ok:false, reason }` — it never
 * throws for those, so the caller (web-server.mjs) can fall back to the direct chat adapter for
 * this turn rather than breaking chat. The OpenCode server's own baseURL/port/session id are used
 * ONLY inside this function — never returned, so they can never reach a browser payload.
 *
 * HARD REQUIREMENT (model registry gate, mirrors opencode-server.mjs's own rule): the model is
 * verified present in the LIVE `GET /api/model` registry before it is ever selected or prompted.
 * `kimi-for-coding`-shaped connections would otherwise get durably admitted and then hang forever
 * with no error — refused here, honestly, before that can happen.
 */
export async function runOpenCodeChatAnswer({ connection, prompt, workspaceBase,
  timeoutMs = DEFAULT_CHAT_TIMEOUT_MS, bin = OPENCODE_BIN, bootTimeoutMs = DEFAULT_BOOT_TIMEOUT_MS,
  healthTimeoutMs = DEFAULT_HEALTH_TIMEOUT_MS, modelCatalogTimeoutMs = DEFAULT_MODEL_CATALOG_TIMEOUT_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, approvedRoots } = {}) {
  const meta = { model: connection?.model || null, provider: connection?.provider || null,
    costSource: connection?.costSource || null, funder: connection?.funder || null };
  const fail = (reason) => ({ ok: false, reason: String(reason), ...meta });
  if (!connection) return fail("no model connection configured");

  let modelRef;
  try { ({ modelRef } = connectionToConfig(connection)); }
  catch (e) { return fail(`connection rejected: ${e.message || e}`); }
  const slash = modelRef.indexOf("/");
  const providerID = modelRef.slice(0, slash), modelID = modelRef.slice(slash + 1);

  const ws = workspaceBase || join(approvedWorkspaceRoots()[0], "oc-chat", connectionKey(connection).replace(/[^a-zA-Z0-9_-]/g, "_"));

  let server;
  try { server = await getServer(connection, { workspaceBase: ws, bin, bootTimeoutMs, healthTimeoutMs, approvedRoots }); }
  catch (e) { return fail(`opencode serve failed to start: ${e.message || e}`); }

  try {
    // Fail-closed model registry gate — never selects/prompts a model the live catalog doesn't confirm.
    const v = await verifyModelPresent(server.baseURL, { providerID, modelID, timeoutMs: modelCatalogTimeoutMs, requestTimeoutMs });
    verification.set(connection.id || connectionKey(connection), v.present);
    if (!v.present) return fail(`model '${providerID}/${modelID}' is not present in the live OpenCode model registry`);

    // A FRESH session per turn — never reused — sidesteps a real trap found while building this:
    // resubscribing to an existing session's /event stream replays its ENTIRE history from the
    // start (no cursor is used here), so a second turn's completion watcher could resolve
    // instantly on the FIRST turn's already-fired "stop" event. A new session's stream starts
    // empty, so the only "stop" event it can ever see is this turn's own.
    const session = await createSession(server.baseURL, { directory: server.ws, requestTimeoutMs });
    await selectModel(server.baseURL, session.id, { id: modelID, providerID, requestTimeoutMs });

    const watcher = createTerminalWatcher();
    const sub = subscribeEvents(server.baseURL, session.id, watcher.onEvent);
    await sub.ready;
    await sendPrompt(server.baseURL, session.id, prompt, { delivery: "queue", requestTimeoutMs });

    const { promise: timeoutPromise, cancel } = timeoutAfter(timeoutMs);
    const winner = await Promise.race([watcher.terminal.then(() => "done"), timeoutPromise.then(() => "timeout")]);
    sub.stop();
    server.lastUsed = Date.now();
    if (winner === "timeout") {
      await interruptSession(server.baseURL, session.id, { requestTimeoutMs });
      return fail(`chat answer timed out after ${timeoutMs}ms`);
    }
    cancel();

    const messages = await fetchMessages(server.baseURL, session.id, { requestTimeoutMs });
    const output = extractReplyText(messages);
    if (!output) return fail("model returned no text content");
    const totals = sumAssistantTokens(messages);
    return { ok: true, output, tokens: totals.input + totals.output, tokensDetail: totals, ...meta };
  } catch (e) {
    return fail(`server runtime error: ${e.message || e}`);
  }
}

// ── Lifecycle: never leave an orphaned `opencode serve` behind ──────────────────────────────────

/** Stop every pooled server (tests, and graceful process shutdown). Safe to call with an empty pool. */
export async function shutdownAllChatServers() {
  const entries = [...pool.values()];
  pool.clear();
  for (const p of entries) {
    try { const e = await p; await stopServer(e.proc); } catch { /* already gone, or never started */ }
  }
}

function killAllSync() {
  for (const p of pool.values()) {
    // Best-effort, synchronous only (an 'exit' handler cannot await): SIGKILL cannot be ignored,
    // so even an in-flight `startServer()` promise's eventual process still dies.
    p.then((e) => { try { e.proc.kill("SIGKILL"); } catch { /* already gone */ } }).catch(() => {});
  }
}
let lifecycleWired = false;
/** Wire process-exit cleanup exactly once per process (idempotent — safe to call from a test that
 *  imports this module directly, and from web-server.mjs's normal startup). */
export function wireChatServerLifecycle() {
  if (lifecycleWired) return;
  lifecycleWired = true;
  process.on("exit", killAllSync);
  let shuttingDown = false;
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      shutdownAllChatServers().finally(() => process.exit(0));
    });
  }
}
wireChatServerLifecycle();

// Idle reaper: a warm server nobody has used in a while is stopped rather than held forever.
// .unref()'d so it never keeps a process (or a test's `node --test`) alive on its own.
const reaper = setInterval(async () => {
  const now = Date.now();
  for (const [key, p] of [...pool.entries()]) {
    try {
      const e = await p;
      if (now - e.lastUsed > DEFAULT_CHAT_SERVER_IDLE_MS) { pool.delete(key); await stopServer(e.proc); }
    } catch { pool.delete(key); }
  }
}, 60000);
reaper.unref();

/** Test/ops visibility: how many servers are currently pooled (does not resolve promises). */
export function chatServerPoolSize() { return pool.size; }
