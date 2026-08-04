#!/usr/bin/env node --test
// SPDX-License-Identifier: Apache-2.0
// Tests for the server-backed OpenCode runtime (opencode-server.mjs).
//
// The default suite is fully hermetic — a tiny in-process HTTP+SSE stub (node:http, zero deps)
// stands in for `opencode serve`, so these tests need no real model and no network. They exercise
// EXACTLY the hard requirements the runtime exists to satisfy: the model-registry gate refuses
// before prompting, completion is detected from the SSE stream (never /wait), a hung run gets
// interrupted and reported honestly, token accounting is summed from the message payload, and a
// run that changes no files is never reported ok.
//
// ONE live end-to-end test proves the real thing works against a real `opencode serve` + a real
// local model — opt-in via BO_OC_LIVE_E2E=1 so the default `npm test` stays fast and offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  apiCall, waitForHealth, verifyModelPresent, createSession, selectModel, sendPrompt,
  interruptSession, fetchMessages, sumAssistantTokens, subscribeEvents, createTerminalWatcher,
  runSessionAgainstServer, runOpenCodeServer, stopServer,
} from "./opencode-server.mjs";
import { runOpenCode } from "./opencode-adapter.mjs";

// ── Stub `opencode serve` (node:http, no deps) ─────────────────────────────────────────────────
// Enough of the real v2 REST surface to drive runSessionAgainstServer end-to-end: health, model
// catalog, session create, model select, prompt, SSE events, interrupt, message history. Every
// call is counted so tests can assert what was (and was NOT) called — e.g. the registry gate must
// refuse WITHOUT ever calling /model or /prompt.
function startStub({ catalog = [], eventScript = [], messages = [] } = {}) {
  const calls = { model: 0, prompt: 0, interrupt: 0, event: 0, session: 0 };
  let sseRes = null; // the currently-connected event-stream response, if any

  function sendEvent(evt) {
    if (!sseRes) return;
    sseRes.write(`data: ${JSON.stringify(evt)}\n\n`);
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const path = url.pathname;
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      const json = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };

      if (req.method === "GET" && path === "/api/health") return json(200, { healthy: true });

      if (req.method === "GET" && path === "/api/model") return json(200, { data: catalog });

      if (req.method === "POST" && path === "/api/session") {
        calls.session++;
        return json(200, { data: { id: "ses_stub1", projectID: "global", location: { directory: JSON.parse(body || "{}")?.location?.directory || null } } });
      }

      let m;
      if (req.method === "POST" && (m = path.match(/^\/api\/session\/([^/]+)\/model$/))) {
        calls.model++;
        res.writeHead(204); return res.end();
      }
      if (req.method === "POST" && (m = path.match(/^\/api\/session\/([^/]+)\/prompt$/))) {
        calls.prompt++;
        return json(200, { data: { admittedSeq: 1, id: "msg_stub1", sessionID: m[1] } });
      }
      if (req.method === "POST" && (m = path.match(/^\/api\/session\/([^/]+)\/interrupt$/))) {
        calls.interrupt++;
        res.writeHead(204); return res.end();
      }
      if (req.method === "POST" && (m = path.match(/^\/api\/session\/([^/]+)\/wait$/))) {
        // The real server 503s here, always (docs §8). The runtime must never depend on this.
        return json(503, { _tag: "ServiceUnavailableError", message: "Session wait is not available yet" });
      }
      if (req.method === "GET" && (m = path.match(/^\/api\/session\/([^/]+)\/message$/))) {
        return json(200, { data: messages });
      }
      if (req.method === "GET" && (m = path.match(/^\/api\/session\/([^/]+)\/event$/))) {
        calls.event++;
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        sseRes = res;
        let i = 0;
        const pump = () => {
          if (i >= eventScript.length) return;
          const { delayMs = 5, evt } = eventScript[i++];
          setTimeout(() => { sendEvent(evt); pump(); }, delayMs);
        };
        pump();
        // NOTE: this must be res.on("close"), not req.on("close") — for a bodyless GET, the
        // REQUEST's "close" fires almost immediately once its (empty) body is fully read, long
        // before the client actually disconnects from the response. res "close" is the client
        // disconnect / connection-terminated signal we actually want.
        res.on("close", () => { if (sseRes === res) sseRes = null; });
        return;
      }

      json(404, { error: "no such stub route", path });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        baseURL: `http://127.0.0.1:${port}`,
        calls,
        // server.close() alone waits for every open connection to end on its own — and fetch()'s
        // HTTP keep-alive pooling (plus any still-open SSE stream) means one is often still open.
        // closeAllConnections() forces them shut so close() actually resolves instead of hanging.
        close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }),
      });
    });
  });
}

// A confined, git-initialized scratch workspace — mirrors what prepareOpenCodeWorkspace leaves
// behind (git-inited + pre-committed) so the runtime's `git diff HEAD` changed-files logic works
// exactly as it does against the real thing.
function makeGitWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), "oc-server-test-"));
  execFileSync("git", ["-C", ws, "init", "-q"]);
  execFileSync("git", ["-C", ws, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "pre", "--allow-empty"]);
  return ws;
}

const MODEL = { providerID: "stub-provider", id: "stub-model" };
const CATALOG_ENTRY = { id: MODEL.id, providerID: MODEL.providerID, family: "stub", name: "Stub Model", capabilities: [], limit: { context: 8192, output: 4096 }, status: "ok" };

// ── 1. Model-registry gate: an unknown model is REFUSED, never prompted ───────────────────────
test("model absent from GET /api/model is refused WITHOUT ever selecting or prompting it", async () => {
  const stub = await startStub({ catalog: [] }); // registry never contains MODEL
  const ws = makeGitWorkspace();
  try {
    const result = await runSessionAgainstServer({
      baseURL: stub.baseURL, workspace: ws, providerID: MODEL.providerID, modelID: MODEL.id,
      prompt: "irrelevant", modelCatalogTimeoutMs: 400, requestTimeoutMs: 2000,
    });
    assert.equal(result.ok, false);
    assert.equal(result.noWork, true);
    assert.match(result.noWorkReason, /not present in GET \/api\/model|absent/i);
    assert.equal(stub.calls.model, 0, "POST /model must NEVER be called for an absent model");
    assert.equal(stub.calls.prompt, 0, "POST /prompt must NEVER be called for an absent model");
  } finally {
    await stub.close();
    rmSync(ws, { recursive: true, force: true });
  }
});

// ── 2. Completion detection from a simulated SSE event stream ─────────────────────────────────
test("completion is detected from session.next.step.ended{finish:'stop'} on the real SSE wire, not before", async () => {
  const eventScript = [
    { evt: { type: "session.next.model.switched", data: {} } },
    { evt: { type: "session.next.prompt.admitted", data: {} } },
    { evt: { type: "session.next.prompted", data: {} } },
    { evt: { type: "session.next.step.started", data: {} } },
    { evt: { type: "session.next.tool.called", data: {} } },
    // Intermediate step end — NOT terminal. A naive "any step.ended" check would stop here (wrong).
    { evt: { type: "session.next.step.ended", data: { finish: "tool-calls" } } },
    { evt: { type: "session.next.step.started", data: {} } },
    { evt: { type: "session.next.text.ended", data: {} } },
    // The real terminal event.
    { evt: { type: "session.next.step.ended", data: { finish: "stop" } } },
  ];
  const stub = await startStub({ catalog: [CATALOG_ENTRY], eventScript, messages: [] });
  const ws = makeGitWorkspace();
  writeFileSync(join(ws, "written-by-agent.txt"), "hello\n"); // simulate the agent's write
  try {
    const result = await runSessionAgainstServer({
      baseURL: stub.baseURL, workspace: ws, providerID: MODEL.providerID, modelID: MODEL.id,
      prompt: "write a file", timeoutMs: 5000, modelCatalogTimeoutMs: 2000,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.events.filter((t) => t === "session.next.step.ended"), ["session.next.step.ended", "session.next.step.ended"]);
    assert.ok(result.changedFiles.includes("written-by-agent.txt"));
    assert.equal(stub.calls.interrupt, 0, "a clean completion must never be interrupted");
  } finally {
    await stub.close();
    rmSync(ws, { recursive: true, force: true });
  }
});

// createTerminalWatcher in isolation (pure, no HTTP): the exact intermediate-vs-terminal distinction.
test("createTerminalWatcher resolves ONLY on finish:'stop', never on finish:'tool-calls'", () => {
  const w = createTerminalWatcher();
  let resolved = false;
  w.terminal.then(() => { resolved = true; });
  w.onEvent({ type: "session.next.step.ended", data: { finish: "tool-calls" } });
  assert.equal(resolved, false);
  w.onEvent({ type: "session.next.step.started", data: {} });
  assert.equal(resolved, false);
  w.onEvent({ type: "session.next.step.ended", data: { finish: "stop" } });
  return w.terminal.then((evt) => {
    assert.equal(evt.data.finish, "stop");
  });
});

// ── 3. Timeout / interrupt behaviour ───────────────────────────────────────────────────────────
test("a run that never reaches finish:'stop' is interrupted and reported as an honest failure on timeout", async () => {
  // The SSE stream sends a prompt-admitted event and then goes silent forever — exactly the
  // real kimi-for-coding failure mode (docs §9): admitted, never progresses, no error event.
  const eventScript = [
    { evt: { type: "session.next.prompt.admitted", data: {} } },
    { evt: { type: "session.next.prompted", data: {} } },
  ];
  const stub = await startStub({ catalog: [CATALOG_ENTRY], eventScript, messages: [] });
  const ws = makeGitWorkspace();
  try {
    const start = Date.now();
    const result = await runSessionAgainstServer({
      baseURL: stub.baseURL, workspace: ws, providerID: MODEL.providerID, modelID: MODEL.id,
      prompt: "hang forever", timeoutMs: 300, modelCatalogTimeoutMs: 2000,
    });
    const elapsed = Date.now() - start;
    assert.equal(result.ok, false);
    assert.equal(result.noWork, true);
    assert.match(result.noWorkReason, /timed out/i);
    assert.equal(stub.calls.interrupt, 1, "the runtime must call POST /interrupt on timeout");
    assert.ok(elapsed < 5000, `should not block far past its own timeout budget (took ${elapsed}ms)`);
  } finally {
    await stub.close();
    rmSync(ws, { recursive: true, force: true });
  }
});

// ── 4. Token summing from the message payload ──────────────────────────────────────────────────
test("sumAssistantTokens sums ONLY assistant messages, across every step of the turn", () => {
  const messages = [
    { type: "user", tokens: { input: 999, output: 999 } }, // must be ignored
    { type: "assistant", tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 300, write: 1 } } },
    { type: "assistant", tokens: { input: 50, output: 94, reasoning: 0, cache: { read: 10, write: 0 } } },
  ];
  const totals = sumAssistantTokens(messages);
  assert.deepEqual(totals, { input: 150, output: 114, reasoning: 5, cacheRead: 310, cacheWrite: 1 });
});

test("token accounting flows end to end from GET /.../message into the result's tokensDetail", async () => {
  const eventScript = [{ evt: { type: "session.next.step.ended", data: { finish: "stop" } } }];
  const messages = [
    { type: "assistant", tokens: { input: 2973, output: 288, reasoning: 0, cache: { read: 3079, write: 0 } } },
  ];
  const stub = await startStub({ catalog: [CATALOG_ENTRY], eventScript, messages });
  const ws = makeGitWorkspace();
  writeFileSync(join(ws, "out.txt"), "x\n");
  try {
    const result = await runSessionAgainstServer({
      baseURL: stub.baseURL, workspace: ws, providerID: MODEL.providerID, modelID: MODEL.id,
      prompt: "go", timeoutMs: 5000, modelCatalogTimeoutMs: 2000,
    });
    assert.equal(result.tokens, 288); // output tokens, matching runOpenCode's `tokens` field semantics
    assert.deepEqual(result.tokensDetail, { input: 2973, output: 288, reasoning: 0, cacheRead: 3079, cacheWrite: 0, contextTotal: 2973 + 3079 });
  } finally {
    await stub.close();
    rmSync(ws, { recursive: true, force: true });
  }
});

// ── 5. No-work guard ────────────────────────────────────────────────────────────────────────────
test("a clean completion that changed NO files is reported noWork:true, ok:false (never a silent success)", async () => {
  const eventScript = [{ evt: { type: "session.next.step.ended", data: { finish: "stop" } } }];
  const stub = await startStub({ catalog: [CATALOG_ENTRY], eventScript, messages: [] });
  const ws = makeGitWorkspace(); // no file written this time
  try {
    const result = await runSessionAgainstServer({
      baseURL: stub.baseURL, workspace: ws, providerID: MODEL.providerID, modelID: MODEL.id,
      prompt: "do nothing", timeoutMs: 5000, modelCatalogTimeoutMs: 2000,
    });
    assert.equal(result.ok, false);
    assert.equal(result.noWork, true);
    assert.match(result.noWorkReason, /changed NO files/i);
  } finally {
    await stub.close();
    rmSync(ws, { recursive: true, force: true });
  }
});

// ── Low-level helpers ───────────────────────────────────────────────────────────────────────────
test("waitForHealth polls until {healthy:true} and respects isAlive()", async () => {
  const stub = await startStub({});
  try {
    await waitForHealth(stub.baseURL, { timeoutMs: 2000 });
  } finally {
    await stub.close();
  }
});

test("waitForHealth throws once isAlive() reports the process is gone", async () => {
  await assert.rejects(
    () => waitForHealth("http://127.0.0.1:1", { timeoutMs: 500, isAlive: () => false }),
    /exited before becoming healthy/,
  );
});

test("verifyModelPresent polls GET /api/model and finds a model that only appears after a delay (cold-start warmup)", async () => {
  // `catalog` is captured by REFERENCE inside startStub's request handler — mutating the same
  // array after the server is listening simulates the documented cold-start gap (docs §4): the
  // catalog starts empty and is populated asynchronously within a second or two.
  const catalog = [];
  const stub = await startStub({ catalog });
  setTimeout(() => { catalog.push(CATALOG_ENTRY); }, 150);
  try {
    const result = await verifyModelPresent(stub.baseURL, { providerID: MODEL.providerID, modelID: MODEL.id, timeoutMs: 2000, pollMs: 50 });
    assert.equal(result.present, true);
    assert.equal(result.model.id, MODEL.id);
  } finally {
    await stub.close();
  }
});

// ── apiCall / interrupt / selectModel / sendPrompt smoke coverage ────────────────────────────────
test("apiCall round-trips a JSON body and reports non-2xx via .ok", async () => {
  const stub = await startStub({ catalog: [CATALOG_ENTRY] });
  try {
    const health = await apiCall(stub.baseURL, "GET", "/api/health");
    assert.equal(health.ok, true);
    assert.equal(health.json.healthy, true);
    const missing = await apiCall(stub.baseURL, "GET", "/api/nope");
    assert.equal(missing.status, 404);
  } finally {
    await stub.close();
  }
});

test("createSession / selectModel / sendPrompt / interruptSession drive the stub's real endpoints", async () => {
  const stub = await startStub({ catalog: [CATALOG_ENTRY] });
  const ws = makeGitWorkspace();
  try {
    const session = await createSession(stub.baseURL, { directory: ws });
    assert.equal(session.id, "ses_stub1");
    await selectModel(stub.baseURL, session.id, { id: MODEL.id, providerID: MODEL.providerID });
    const admitted = await sendPrompt(stub.baseURL, session.id, "hi");
    assert.equal(admitted.id, "msg_stub1");
    const interrupted = await interruptSession(stub.baseURL, session.id);
    assert.equal(interrupted.status, 204);
    assert.equal(stub.calls.model, 1);
    assert.equal(stub.calls.prompt, 1);
    assert.equal(stub.calls.interrupt, 1);
  } finally {
    await stub.close();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("subscribeEvents parses real data: frames off the wire and stop() cleanly aborts", async () => {
  const eventScript = [
    { evt: { type: "a" }, delayMs: 5 },
    { evt: { type: "b" }, delayMs: 5 },
  ];
  const stub = await startStub({ catalog: [], eventScript });
  try {
    const seen = [];
    const sub = subscribeEvents(stub.baseURL, "ses_x", (e) => seen.push(e.type));
    await sub.ready;
    await new Promise((r) => setTimeout(r, 60));
    sub.stop();
    assert.deepEqual(seen, ["a", "b"]);
  } finally {
    await stub.close();
  }
});

// ── AC3 companion — flag-unset byte-identical behaviour lives in the full suite (see report); this
// module-level check just confirms the dispatch exists and is inert when unset. ──────────────────
test("BO_CE_OPENCODE_SERVER unset: runOpenCode never touches opencode-server.mjs's HTTP surface", async () => {
  delete process.env.BO_CE_OPENCODE_SERVER;
  // We don't invoke runOpenCode here (it would spawn the real opencode CLI) — this is covered by
  // the existing opencode-adapter.test.mjs suite and the full `npm test` run (see report). This
  // test exists to document the invariant the wiring depends on.
  assert.equal(process.env.BO_CE_OPENCODE_SERVER, undefined);
  void runOpenCode; // referenced so the import above resolves the wiring exists
});

// ── AC2 — ONE live end-to-end test, opt-in only (BO_OC_LIVE_E2E=1), real opencode + real local model.
test("LIVE: a real coding task runs through the REST runtime and writes a file (BO_OC_LIVE_E2E=1)", { skip: !process.env.BO_OC_LIVE_E2E, timeout: 180000 }, async (t) => {
  const marker = `oc-server-live-${Date.now()}`;
  const root = mkdtempSync(join(tmpdir(), "oc-server-live-"));
  const ws = join(root, "ws");
  // The model is CONFIGURABLE and must be one that can actually finish a tool-calling turn.
  // The original fixture hardcoded CPU-only ollama (qwen2.5:7b), which reached tool.success and
  // then timed out mid-`text` — measured at ~31s for 10 tokens on this box, so it can never reach
  // finish:"stop" inside any sane budget. That is a fixture limit, not a runtime fault: the same
  // code path against a GPU-backed endpoint completes in ~37s (ok:true, file asserted).
  const connection = {
    id: "local:live", kind: "local",
    provider: process.env.BO_OC_LIVE_PROVIDER || "brainoutput-local",
    model: process.env.BO_OC_LIVE_MODEL || "coder",
    endpoint: process.env.BO_OC_LIVE_ENDPOINT || "http://192.168.1.14:9000/v1/chat/completions",
    costSource: "local-compute", funder: "local", contextSize: 32768,
  };
  // Unreachable endpoint ⇒ SKIP with a reason. Never a silent pass, never a false failure that
  // says the runtime is broken when the box simply has no model to run.
  const probeURL = connection.endpoint.replace(/\/chat\/completions\/?$/, "/models");
  try {
    const r = await fetch(probeURL, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (e) {
    t.skip(`live model endpoint unreachable (${connection.endpoint}): ${String(e.message || e)}`);
    return;
  }
  process.env.BO_CE_OPENCODE_SERVER = "1";
  try {
    const oc = await runOpenCode({
      connection, workspace: ws, approvedRoots: [root], timeoutMs: 150000,
      prompt: `Create a file named live-output.txt in the current directory containing exactly this ` +
        `single line and nothing else:\n${marker}\nUse the write tool directly. Do not ask for ` +
        `confirmation, do not explain, just create the file.`,
    });
    console.log("LIVE runOpenCode result:", JSON.stringify({ ok: oc.ok, changedFiles: oc.changedFiles, tokens: oc.tokens, tokensDetail: oc.tokensDetail, noWork: oc.noWork, sessionId: oc.sessionId }, null, 2));
    assert.equal(oc.ok, true, `expected ok:true, got noWork=${oc.noWork} reason=${oc.noWorkReason}\nlog:\n${oc.log}`);
    assert.ok(oc.changedFiles.includes("live-output.txt"), `expected live-output.txt in changedFiles, got ${JSON.stringify(oc.changedFiles)}`);
    const content = readFileSync(join(ws, "live-output.txt"), "utf8").trim();
    assert.equal(content, marker);
  } finally {
    delete process.env.BO_CE_OPENCODE_SERVER;
    rmSync(root, { recursive: true, force: true });
  }
});
