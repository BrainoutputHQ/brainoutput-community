#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// tools/oc-ping.mjs — zero-dependency end-to-end smoke check of `opencode serve`'s REST API.
// Starts a fresh loopback-only server on an OS-assigned port, drives ONE session (create →
// select model → prompt → wait for completion → report token usage), then tears the server
// down. Every behavior below is verified against docs/OPENCODE_SERVER_API.md — the payload
// shapes and the completion signal are non-obvious, so the choices are commented inline.
//
// Usage: node tools/oc-ping.mjs
// Env overrides: OPENCODE_BIN (binary path), OC_PING_PROVIDER / OC_PING_MODEL (model pick),
//                OC_PING_PROMPT (prompt text), OC_PING_TIMEOUT_MS (total run budget).
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = process.env.OPENCODE_BIN || "opencode";
const PROMPT = process.env.OC_PING_PROMPT || "Reply with exactly the word: pong";
const RUN_TIMEOUT_MS = Number(process.env.OC_PING_TIMEOUT_MS || 120000);
const BOOT_TIMEOUT_MS = 30000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(baseURL, method, path, body) {
  const res = await fetch(baseURL + path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
  return { status: res.status, ok: res.ok, json, text };
}

// Spawn `opencode serve`, loopback-only, on an OS-assigned port (--port 0). The bound address
// only appears in stdout/stderr, so we scan for it. stdin is "ignore" — an open stdin pipe
// makes opencode wait for interactive input.
function startServer(cwd) {
  return new Promise((resolve, reject) => {
    const proc = spawn(BIN, ["serve", "--port", "0", "--hostname", "127.0.0.1"], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let boot = "", settled = false;
    const timer = setTimeout(() => fail(new Error(`no listening URL within ${BOOT_TIMEOUT_MS}ms: ${boot.slice(-300)}`)), BOOT_TIMEOUT_MS);
    const fail = (e) => { if (!settled) { settled = true; clearTimeout(timer); try { proc.kill("SIGKILL"); } catch {} reject(e); } };
    const onData = (d) => {
      boot += d.toString();
      const m = boot.match(/https?:\/\/127\.0\.0\.1:(\d+)/);
      if (m && !settled) { settled = true; clearTimeout(timer); resolve({ proc, baseURL: `http://127.0.0.1:${m[1]}` }); }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("error", fail);
    proc.on("close", () => fail(new Error(`serve exited during boot: ${boot.slice(-300)}`)));
  });
}

// SIGTERM, then SIGKILL after a grace period; resolve only once the process is really gone.
function stopServer(proc) {
  return new Promise((resolve) => {
    if (!proc || proc.exitCode !== null) return resolve();
    proc.once("exit", resolve);
    try { proc.kill("SIGTERM"); } catch { return resolve(); }
    setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 4000).unref();
  });
}

async function waitHealthy(baseURL) {
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      const r = await api(baseURL, "GET", "/api/health");
      if (r.ok && r.json?.healthy === true) return;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error("server never reported healthy");
    await sleep(150);
  }
}

// Subscribe to the session's SSE stream and resolve on the terminal event. ONLY
// `session.next.step.ended` with data.finish === "stop" means the turn is done — intermediate
// steps end with "tool-calls", and POST /api/session/{id}/wait reliably 503s in this build.
async function waitForCompletion(baseURL, sessionID) {
  const controller = new AbortController();
  const res = await fetch(`${baseURL}/api/session/${sessionID}/event`, { signal: controller.signal, headers: { accept: "text/event-stream" } });
  if (!res.ok || !res.body) throw new Error(`event subscription failed: HTTP ${res.status}`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { controller.abort(); reject(new Error(`run did not finish within ${RUN_TIMEOUT_MS}ms (if the prompt was admitted but no step events ever arrived, this is the known docs §9 hang — try a different OC_PING_PROVIDER/OC_PING_MODEL)`)); }, RUN_TIMEOUT_MS);
    const finish = (fn, v) => { clearTimeout(timer); controller.abort(); fn(v); };
    (async () => {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return finish(reject, new Error("event stream closed before the run finished"));
        buf += decoder.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data:")) continue; // blank lines / ":" heartbeat comments
            try {
              const evt = JSON.parse(line.slice(5).trim());
              if (evt?.type === "session.next.step.ended" && evt.data?.finish === "stop") return finish(resolve, evt);
            } catch { /* one malformed frame never kills the wait */ }
          }
        }
      }
    })().catch((e) => { if (!controller.signal.aborted) finish(reject, e); });
  });
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "oc-ping-"));
  let proc, baseURL;
  try {
    ({ proc, baseURL } = await startServer(dir));
    console.log(`server up: ${baseURL} (workspace ${dir})`);
    await waitHealthy(baseURL);

    // Fail-closed model pick: only use a model GET /api/model actually lists — a model that is
    // selectable but invisible to the catalog hangs forever after prompting (docs §9). Poll
    // briefly: a fresh workspace's catalog can lag /api/health by 1-3s (docs §4).
    let catalog = [];
    for (let i = 0; i < 40 && !catalog.length; i++) {
      catalog = (await api(baseURL, "GET", "/api/model")).json?.data || [];
      if (!catalog.length) await sleep(250);
    }
    if (!catalog.length) throw new Error("model catalog is empty");
    const wantP = process.env.OC_PING_PROVIDER, wantM = process.env.OC_PING_MODEL;
    const model = (wantP || wantM)
      ? catalog.find((m) => (!wantP || m.providerID === wantP) && (!wantM || m.id === wantM))
      : catalog[0];
    if (!model) throw new Error(`requested model ${wantP}/${wantM} not in catalog`);

    const session = (await api(baseURL, "POST", "/api/session", { location: { directory: dir } })).json?.data;
    if (!session?.id) throw new Error("session creation failed");
    console.log(`session: ${session.id}`);

    // Payload trap (docs §5): the field is `id` (not `modelID`), wrapped under top-level "model".
    const sel = await api(baseURL, "POST", `/api/session/${session.id}/model`, { model: { id: model.id, providerID: model.providerID } });
    if (sel.status !== 204) throw new Error(`model selection failed: HTTP ${sel.status} ${sel.text}`);
    console.log(`model: ${model.providerID}/${model.id}`);

    const waiting = waitForCompletion(baseURL, session.id); // subscribe BEFORE prompting
    const pr = await api(baseURL, "POST", `/api/session/${session.id}/prompt`, { prompt: { text: PROMPT }, delivery: "queue" });
    if (!pr.ok) throw new Error(`prompt failed: HTTP ${pr.status} ${pr.text}`);
    console.log("prompt admitted; waiting for completion ...");
    await waiting;

    // GET /api/session/{id} itself reports {input:0,...} forever — the messages are the ONLY
    // authoritative token source (docs §10).
    const messages = (await api(baseURL, "GET", `/api/session/${session.id}/message`)).json?.data || [];
    const tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
    for (const m of messages) {
      if (m?.type !== "assistant") continue;
      tokens.input += m.tokens?.input || 0;
      tokens.output += m.tokens?.output || 0;
      tokens.reasoning += m.tokens?.reasoning || 0;
      tokens.cacheRead += m.tokens?.cache?.read || 0;
      tokens.cacheWrite += m.tokens?.cache?.write || 0;
    }
    const reply = messages.filter((m) => m?.type === "assistant").map((m) => m.text || "").join(" ").slice(0, 200);
    console.log(JSON.stringify({ ok: true, session: session.id, model: `${model.providerID}/${model.id}`, tokens, reply }, null, 2));
  } finally {
    if (proc) { await stopServer(proc); console.log("server stopped"); }
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error("oc-ping FAILED:", e?.message || e); process.exitCode = 1; });
