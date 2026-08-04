// SPDX-License-Identifier: Apache-2.0
// BrainOutput Community Edition — server-backed OpenCode runtime (2026-08-04).
//
// Drives `opencode serve`'s v2 REST API over plain HTTP + SSE instead of spawning `opencode run`
// per task. One fresh, isolated `opencode serve` process per call — started, driven, torn down.
// Opt-in only, gated behind BO_CE_OPENCODE_SERVER=1 at the single call site in opencode-adapter.mjs
// (runOpenCode). When the flag is unset this module is never imported and behaviour is unchanged.
//
// Ground truth for every trap below: docs/OPENCODE_SERVER_API.md, verified end-to-end by
// tools/oc-api-probe.mjs (run it: `node tools/oc-api-probe.mjs`). Isolation guarantees here are
// IDENTICAL to the CLI runtime in opencode-adapter.mjs — same isolated HOME/XDG (prepareOpenCodeWorkspace),
// same confined + approved workspace, same fail-closed credential guard (assertHostOwnedCredentials,
// enforced inside buildExecutorEnv which prepareOpenCodeWorkspace already calls).
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { prepareOpenCodeWorkspace } from "./opencode-adapter.mjs";
import { detectNoWork } from "./work-evidence.mjs";

const HOME = process.env.HOME || homedir();
// Same binary resolution as opencode-adapter.mjs (BO_OPENCODE_BIN override, then the standard install path).
export const OPENCODE_BIN = process.env.BO_OPENCODE_BIN || join(HOME, ".opencode", "bin", "opencode");

// ── Tunables — all overridable per call; defaults mirror tools/oc-api-probe.mjs ──────────────────
// HARD REQUIREMENT: every HTTP request needs an explicit timeout. Node's built-in fetch (undici)
// has NO default and wedges forever against a not-yet-ready server — measured, not theoretical.
export const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
export const DEFAULT_BOOT_TIMEOUT_MS = 30000; // process must print its bound loopback address by then
export const DEFAULT_HEALTH_TIMEOUT_MS = 15000; // GET /api/health must go green by then
// GET /api/model can be empty for 1-3s on a brand-new workspace even after /api/health is healthy
// (the provider/model catalog warms up asynchronously) — poll, don't trust the first response.
export const DEFAULT_MODEL_CATALOG_TIMEOUT_MS = 10000;
export const MODEL_CATALOG_POLL_MS = 300;
export const DEFAULT_RUN_TIMEOUT_MS = 240000; // overall budget: prompt admitted -> terminal step

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// A cancelable delay: resolves after `ms` UNLESS canceled first. Used for races (Promise.race)
// so the loser's underlying timer is always cleared — a bare `sleep()` left in a race would keep
// a handle alive (and, worst case, keep the process/test runner alive) long after the race settled.
function timeoutAfter(ms) {
  let timer;
  const promise = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

// ---------------------------------------------------------------------------------------------
// Low-level HTTP. One shared helper so every call site gets the mandatory AbortSignal.timeout.
// ---------------------------------------------------------------------------------------------
export async function apiCall(baseURL, method, urlPath, body, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
  const res = await fetch(baseURL + urlPath, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
  return { status: res.status, ok: res.ok, json, text };
}

/** Poll GET /api/health until it reports {healthy:true}, the process dies, or timeoutMs elapses. */
export async function waitForHealth(baseURL, { timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS, isAlive = () => true } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!isAlive()) throw new Error("opencode serve process exited before becoming healthy");
    try {
      const r = await fetch(`${baseURL}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) {
        const j = await r.json();
        if (j && j.healthy === true) return;
      }
    } catch { /* not up yet, or this single attempt hung/timed out — retry */ }
    if (Date.now() > deadline) throw new Error(`server did not become healthy within ${timeoutMs}ms`);
    await sleep(150);
  }
}

// ---------------------------------------------------------------------------------------------
// HARD REQUIREMENT — model registry gate, fail-closed. `kimi-for-coding` is authenticated and
// selectable via POST /api/session/{id}/model (204!) but is INVISIBLE to GET /api/model. Prompting
// it gets durably admitted (session.next.prompted fires) and then NEVER progresses — no error, no
// event, forever (docs §9, reproduced twice with a 5+ minute wait). We refuse anything that is not
// CONFIRMED present in this registry, polling briefly first because a fresh workspace's catalog can
// be empty for ~1-3s even after /api/health already reports healthy (docs §4).
// ---------------------------------------------------------------------------------------------
export async function verifyModelPresent(baseURL, { providerID, modelID,
  timeoutMs = DEFAULT_MODEL_CATALOG_TIMEOUT_MS, pollMs = MODEL_CATALOG_POLL_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  let catalog = [];
  for (;;) {
    const res = await apiCall(baseURL, "GET", "/api/model", undefined, requestTimeoutMs);
    catalog = res.json?.data || [];
    const found = catalog.find((m) => m.providerID === providerID && m.id === modelID);
    if (found) return { present: true, model: found, catalog };
    if (Date.now() > deadline) return { present: false, model: null, catalog };
    await sleep(pollMs);
  }
}

// ---------------------------------------------------------------------------------------------
// Session lifecycle calls.
// ---------------------------------------------------------------------------------------------

/** POST /api/session — pass location.directory explicitly (requirement 6: cleaner + more robust
 *  than the $PWD env trick, and it works even if the server's own cwd resolution differs). */
export async function createSession(baseURL, { directory, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  const res = await apiCall(baseURL, "POST", "/api/session", directory ? { location: { directory } } : {}, requestTimeoutMs);
  if (!res.ok || !res.json?.data?.id) throw new Error(`session creation failed: HTTP ${res.status} ${res.text}`);
  return res.json.data;
}

/** POST /api/session/{id}/model — the payload trap (docs §5): the field is `id`, NOT `modelID`,
 *  and the whole ModelRef must be wrapped under a top-level "model" key. Expects 204 No Content. */
export async function selectModel(baseURL, sessionID, { id, providerID, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  const res = await apiCall(baseURL, "POST", `/api/session/${sessionID}/model`, { model: { id, providerID } }, requestTimeoutMs);
  if (res.status !== 204) throw new Error(`model selection failed: HTTP ${res.status} ${res.text}`);
}

/** POST /api/session/{id}/prompt — HTTP 200 means DURABLY ADMITTED, not that the run finished. */
export async function sendPrompt(baseURL, sessionID, text, { delivery = "queue", requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  const res = await apiCall(baseURL, "POST", `/api/session/${sessionID}/prompt`, { prompt: { text }, delivery }, requestTimeoutMs);
  if (!res.ok) throw new Error(`prompt failed: HTTP ${res.status} ${res.text}`);
  return res.json?.data;
}

/** POST /api/session/{id}/interrupt — best-effort. Called on our own timeout (never on /wait,
 *  which reliably 503s in this build per docs §8). Its own failure never masks the timeout we're
 *  already reporting — the caller has already decided the run failed by the time this runs. */
export async function interruptSession(baseURL, sessionID, { requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  try { return await apiCall(baseURL, "POST", `/api/session/${sessionID}/interrupt`, undefined, requestTimeoutMs); }
  catch (e) { return { status: 0, ok: false, text: String(e.message || e) }; }
}

/** GET /api/session/{id}/message — the AUTHORITATIVE token source (docs §10). GET /api/session/{id}
 *  itself stays permanently {input:0,output:0,...} even after a real completed run — never use it. */
export async function fetchMessages(baseURL, sessionID, { requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  const res = await apiCall(baseURL, "GET", `/api/session/${sessionID}/message`, undefined, requestTimeoutMs);
  return res.json?.data || [];
}

/** Sum real per-step token usage across every assistant message in a turn (docs §10). Pure. */
export function sumAssistantTokens(messages) {
  const totals = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  for (const m of messages || []) {
    if (m?.type !== "assistant") continue;
    totals.input += m.tokens?.input || 0;
    totals.output += m.tokens?.output || 0;
    totals.reasoning += m.tokens?.reasoning || 0;
    totals.cacheRead += m.tokens?.cache?.read || 0;
    totals.cacheWrite += m.tokens?.cache?.write || 0;
  }
  return totals;
}

// ---------------------------------------------------------------------------------------------
// SSE event subscription (docs §7). Only `data: <json>\n\n` frames are on the wire in this build
// — no separate `event:`/`id:` SSE fields despite the OpenAPI schema modeling them. Lines starting
// with ":" are heartbeat comments and are skipped.
// ---------------------------------------------------------------------------------------------
export function subscribeEvents(baseURL, sessionID, onEvent) {
  const controller = new AbortController();
  let firstByteResolve;
  const firstByte = new Promise((r) => { firstByteResolve = r; });

  // The whole body (including the initial fetch) lives inside ONE try/catch — deliberately wider
  // than the reference probe's scope, because here `stop()` can legitimately race the connection
  // itself (e.g. an early model-selection failure aborts the subscription almost immediately);
  // an abort during `fetch()` must be swallowed exactly like an abort during the read loop.
  const streamPromise = (async () => {
    try {
      const res = await fetch(`${baseURL}/api/session/${sessionID}/event`, {
        signal: controller.signal,
        headers: { accept: "text/event-stream" },
      });
      if (!res.ok || !res.body) throw new Error(`event subscription failed: HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (firstByteResolve) { firstByteResolve(); firstByteResolve = null; }
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of frame.split("\n")) {
            if (!line || line.startsWith(":")) continue; // blank / heartbeat comment
            if (line.startsWith("data:")) {
              const payload = line.slice(5).trim();
              if (!payload) continue;
              try { onEvent(JSON.parse(payload)); } catch { /* one malformed frame never kills the subscription */ }
            }
          }
        }
      }
    } catch (err) {
      if (controller.signal.aborted) return; // expected on stop()
      throw err;
    }
  })();
  // Never let a genuinely failed/aborted subscription surface as an unhandled rejection — callers
  // that only ever read `sub.stop()`/events (never await `sub.done`) must not crash the process.
  streamPromise.catch(() => {});

  return { ready: firstByte, stop: () => controller.abort(), done: streamPromise };
}

/**
 * HARD REQUIREMENT — completion detection via SSE only. POST /api/session/{id}/wait reliably
 * returns 503 in this build, before AND long after the run actually finishes (docs §8) — never
 * call it to detect completion. The sole signal is `session.next.step.ended` with
 * `data.finish === "stop"`; an intermediate step ends with `data.finish === "tool-calls"` and must
 * NOT be treated as terminal (docs §7 — a real turn is 2+ steps, only the LAST one is "stop").
 */
export function createTerminalWatcher() {
  const events = [];
  let resolveTerminal;
  const terminal = new Promise((r) => { resolveTerminal = r; });
  function onEvent(evt) {
    events.push(evt);
    if (evt && evt.type === "session.next.step.ended" && evt.data && evt.data.finish === "stop") resolveTerminal(evt);
  }
  return { events, onEvent, terminal };
}

// ---------------------------------------------------------------------------------------------
// Server process lifecycle (requirement 10: start/stop, never orphaned).
// ---------------------------------------------------------------------------------------------

/** Spawn a fresh `opencode serve`, loopback-only, on an OS-assigned free port (`--port 0`). Scans
 *  stdout+stderr for the bound address the same way the proven reference (startOpenCodeServer in
 *  opencode-adapter.mjs) does. Captures the full (bounded) output for the lifetime of the process —
 *  used later as part of the run's log evidence, matching the CLI runtime's log-based signals. */
export function spawnServer({ bin = OPENCODE_BIN, cwd, env, bootTimeoutMs = DEFAULT_BOOT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    // stdin closed (ignore): an open stdin pipe makes opencode wait for interactive input at init,
    // exactly like the `run` CLI path (opencode-adapter.mjs runOpenCode) — same reason, same fix.
    const child = spawn(bin, ["serve", "--port", "0", "--hostname", "127.0.0.1"], {
      cwd, env, stdio: ["ignore", "pipe", "pipe"],
    });
    let boot = "";
    let full = "";
    let settled = false;
    const MAX_LOG = 200_000; // bounded — this process can run for the whole timeoutMs budget
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      reject(new Error(`opencode serve did not report a listening URL within ${bootTimeoutMs}ms: ${boot.slice(-500)}`));
    }, bootTimeoutMs);
    const onChunk = (d) => {
      const s = d.toString();
      full += s;
      if (full.length > MAX_LOG) full = full.slice(-MAX_LOG);
      if (settled) return;
      boot += s;
      const m = boot.match(/https?:\/\/127\.0\.0\.1:(\d+)/) || boot.match(/127\.0\.0\.1:(\d+)/);
      if (!m) return;
      settled = true;
      clearTimeout(timer);
      resolve({ baseURL: `http://127.0.0.1:${m[1]}`, port: Number(m[1]), proc: child, getLog: () => full });
    };
    child.stdout.setEncoding("utf8"); child.stdout.on("data", onChunk);
    child.stderr.setEncoding("utf8"); child.stderr.on("data", onChunk);
    child.on("error", (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
    child.on("close", () => {
      if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`opencode serve exited during boot: ${boot.slice(-500)}`)); }
    });
  });
}

/** Terminate the server process and WAIT for it to actually exit (SIGTERM, then SIGKILL after a
 *  grace period) — never returns while the process might still be alive. This is what guarantees
 *  no orphaned `opencode serve` process is ever left behind, including on every error path. */
export function stopServer(proc, { graceMs = 4000 } = {}) {
  return new Promise((resolve) => {
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return resolve();
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    proc.once("exit", finish);
    try { proc.kill("SIGTERM"); } catch { return finish(); }
    const killTimer = setTimeout(() => {
      if (done) return;
      try { proc.kill("SIGKILL"); } catch { /* already gone */ }
    }, graceMs);
    proc.once("exit", () => clearTimeout(killTimer));
  });
}

// ---------------------------------------------------------------------------------------------
// The core session-driving flow, factored out from server process management so it is testable
// against ANY already-running server (a stub HTTP server in tests, a real `opencode serve` in the
// live end-to-end run) without needing to spawn a real opencode binary. Returns a result shape
// that deliberately mirrors the connection-agnostic fields of runOpenCode()'s return value; the
// caller (runOpenCodeServer, below) fills in the connection-derived fields (model/provider/etc).
// ---------------------------------------------------------------------------------------------
export async function runSessionAgainstServer({ baseURL, workspace, providerID, modelID, prompt,
  timeoutMs = DEFAULT_RUN_TIMEOUT_MS, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  modelCatalogTimeoutMs = DEFAULT_MODEL_CATALOG_TIMEOUT_MS, getServerLog = () => "" }) {
  const session = await createSession(baseURL, { directory: workspace, requestTimeoutMs });
  const sessionID = session.id;

  // HARD REQUIREMENT 1 — fail-closed BEFORE selecting or prompting. See createTerminalWatcher's
  // doc comment and docs §9 for exactly what happens if this gate is skipped: silent forever-hang.
  const gate = await verifyModelPresent(baseURL, { providerID, modelID, timeoutMs: modelCatalogTimeoutMs, requestTimeoutMs });
  if (!gate.present) {
    const available = gate.catalog.map((m) => `${m.providerID}/${m.id}`).join(", ") || "(none)";
    return {
      ok: false, sessionId: sessionID, changedFiles: [], tokens: 0, tokensDetail: null, providersUsed: [],
      log: `model ${providerID}/${modelID} is absent from GET /api/model — refused BEFORE selecting/prompting it. available: ${available}`,
      noWork: true,
      noWorkReason: `model ${providerID}/${modelID} is not present in GET /api/model — refusing to select/prompt it ` +
        `(an absent-from-registry model can still be selected+admitted and then never executes, silently, forever — see docs/OPENCODE_SERVER_API.md §9)`,
      events: [],
    };
  }

  // HARD REQUIREMENT 2 — subscribe BEFORE prompting.
  const watcher = createTerminalWatcher();
  const sub = subscribeEvents(baseURL, sessionID, watcher.onEvent);
  const readyTimer = timeoutAfter(1500);
  await Promise.race([sub.ready, readyTimer.promise]);
  readyTimer.cancel();

  try {
    await selectModel(baseURL, sessionID, { id: modelID, providerID, requestTimeoutMs });
    await sendPrompt(baseURL, sessionID, prompt, { requestTimeoutMs });
  } catch (e) {
    sub.stop();
    return {
      ok: false, sessionId: sessionID, changedFiles: [], tokens: 0, tokensDetail: null, providersUsed: [providerID],
      log: String(e.message || e), noWork: true, noWorkReason: `failed before the run could start: ${e.message || e}`,
      events: watcher.events.map((x) => x.type),
    };
  }

  // Enforce the overall timeout. On timeout: interrupt (best-effort) and report an honest failure
  // — never hang, never fabricate success.
  const termTimer = timeoutAfter(timeoutMs);
  let timedOut = false;
  await Promise.race([watcher.terminal, termTimer.promise.then(() => { timedOut = true; })]);
  termTimer.cancel();
  sub.stop();

  if (timedOut) {
    await interruptSession(baseURL, sessionID, { requestTimeoutMs });
    return {
      ok: false, sessionId: sessionID, changedFiles: [], tokens: 0, tokensDetail: null, providersUsed: [providerID],
      log: `${getServerLog()}\n\n=== events observed before timeout ===\n${watcher.events.map((x) => x.type).join("\n")}`.slice(-4000),
      noWork: true,
      noWorkReason: `timed out after ${timeoutMs}ms waiting for session.next.step.ended{finish:"stop"} on the event stream — interrupted`,
      events: watcher.events.map((x) => x.type),
    };
  }

  // Real completion. changedFiles: same git-diff technique the CLI runtime uses (the workspace is
  // git-init'd + pre-committed by prepareOpenCodeWorkspace, so `diff HEAD` is exactly this run's work).
  let changedFiles = [];
  try {
    changedFiles = execFileSync("git", ["-C", workspace, "diff", "--name-only", "HEAD"], { encoding: "utf8" })
      .split("\n").filter(Boolean).filter((f) => f !== "opencode.json");
  } catch { /* not a git workspace, or nothing changed — changedFiles stays empty, honestly */ }
  try {
    changedFiles.push(...execFileSync("git", ["-C", workspace, "ls-files", "--others", "--exclude-standard"], { encoding: "utf8" })
      .split("\n").filter(Boolean).filter((f) => f !== "opencode.json" && !f.startsWith(".oc-iso")));
  } catch { /* same */ }
  changedFiles = [...new Set(changedFiles)];

  // HARD REQUIREMENT 4 — tokens from GET /.../message, summed. GET /api/session/{id} itself stays
  // permanently zero (docs §10) and is never consulted here.
  let messages = [];
  try { messages = await fetchMessages(baseURL, sessionID, { requestTimeoutMs }); } catch { /* leaves totals at 0, honestly */ }
  const totals = sumAssistantTokens(messages);

  const log = `${getServerLog()}\n\n=== session events ===\n${watcher.events.map((x) => x.type).join("\n")}`.slice(-4000);
  // HARD REQUIREMENT 9 — the SAME no-work guard the CLI runtime uses. A run that changed no files
  // is NOT ok, regardless of how cleanly the API round-trip completed.
  const { noWork, reason } = detectNoWork({ exitCode: 0, changedFiles, log });

  return {
    ok: !noWork, sessionId: sessionID, changedFiles, tokens: totals.output,
    tokensDetail: { input: totals.input, output: totals.output, reasoning: totals.reasoning,
      cacheRead: totals.cacheRead, cacheWrite: totals.cacheWrite,
      contextTotal: totals.input + totals.cacheRead + totals.cacheWrite },
    providersUsed: [providerID], log, noWork, noWorkReason: reason,
    events: watcher.events.map((x) => x.type),
  };
}

// ---------------------------------------------------------------------------------------------
// Top-level entry point — same shape of inputs/outputs as opencode-adapter.mjs's runOpenCode, so
// the flag-dispatch at the call site needs zero special-casing downstream (requirement 9).
// ---------------------------------------------------------------------------------------------
export async function runOpenCodeServer({ connection, prompt, workspace, effort, isoBase, approvedRoots,
  timeoutMs = DEFAULT_RUN_TIMEOUT_MS, bin = OPENCODE_BIN, bootTimeoutMs = DEFAULT_BOOT_TIMEOUT_MS,
  healthTimeoutMs = DEFAULT_HEALTH_TIMEOUT_MS, modelCatalogTimeoutMs = DEFAULT_MODEL_CATALOG_TIMEOUT_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  // `effort` (--variant on the CLI path) has no REST equivalent surfaced by this build's ModelRef
  // beyond the optional `variant` field — not exercised here; left as a documented gap (see report).
  void effort;

  const meta = { model: connection?.model, provider: connection?.provider, costSource: connection?.costSource, funder: connection?.funder };
  const failResult = (reason, extra = {}) => ({
    ok: false, exitCode: null, ...meta, tokens: 0, providersUsed: [], changedFiles: [],
    founderCredentialUsed: false, log: String(reason).slice(-4000), sessionId: null,
    tokensDetail: null, noWork: true, noWorkReason: reason, ...extra,
  });

  // HARD REQUIREMENT 8 — identical isolation to the CLI path: isolated HOME/XDG, confined + approved
  // workspace, the fail-closed credential guard (all enforced inside prepareOpenCodeWorkspace /
  // buildExecutorEnv), and the workspace opencode.json that keeps a headless run from auto-rejecting
  // its own write permission (requirement 7).
  let ws, env, modelRef;
  try {
    ({ ws, env, modelRef } = prepareOpenCodeWorkspace({ connection, workspace, isoBase, approvedRoots }));
  } catch (e) {
    return failResult(`workspace preparation failed: ${e.message || e}`);
  }
  // providerId is sanitized to [a-zA-Z0-9_-] by connectionToConfig (opencode-adapter.mjs) so it can
  // never itself contain "/" — the FIRST "/" in modelRef is always exactly the provider/model boundary,
  // even if the model id contains further slashes.
  const slash = modelRef.indexOf("/");
  const providerID = modelRef.slice(0, slash);
  const modelID = modelRef.slice(slash + 1);

  let server;
  try {
    // HARD REQUIREMENT 6 — belt and suspenders on top of location.directory (passed inside
    // runSessionAgainstServer's createSession call): also set PWD in the spawn env, because
    // spawn(cmd,{cwd}) does NOT update the inherited PWD and opencode resolves its project root
    // from $PWD in some code paths.
    server = await spawnServer({ bin, cwd: ws, env: { ...env, PWD: ws }, bootTimeoutMs });
  } catch (e) {
    return failResult(`opencode serve failed to start: ${e.message || e}`);
  }

  // HARD REQUIREMENT 10 — the server process is ALWAYS torn down, on every path out of here,
  // success or failure. No orphaned `opencode serve` process survives this function.
  try {
    await waitForHealth(server.baseURL, { timeoutMs: healthTimeoutMs, isAlive: () => server.proc.exitCode === null });
    const core = await runSessionAgainstServer({
      baseURL: server.baseURL, workspace: ws, providerID, modelID, prompt,
      timeoutMs, requestTimeoutMs, modelCatalogTimeoutMs, getServerLog: server.getLog,
    });
    return { ...core, ...meta, exitCode: 0, founderCredentialUsed: false };
  } catch (e) {
    return failResult(`server runtime error: ${e.message || e}`);
  } finally {
    await stopServer(server.proc);
  }
}
