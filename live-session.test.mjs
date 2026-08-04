#!/usr/bin/env node --test
// SPDX-License-Identifier: Apache-2.0
// Tests for the live task view (oc-live-view, 2026-08-04): live-session.mjs's registry + event
// projection, AND its real integration with opencode-server.mjs's runSessionAgainstServer — the
// same in-process SSE stub pattern opencode-server.test.mjs already uses stands in for a real
// `opencode serve`, so these tests need no real model, no real opencode binary, and no network.
//
// What this file proves, matching the acceptance criteria one for one:
//   - the event -> label projection (pure, exhaustive over every documented event type + an
//     unrecognized one, tool/file extraction, clamping)
//   - the buffer cap: a flood past the cap drops the OLDEST entries first and stays bounded
//   - the live session closes cleanly on real completion, on the event stream closing early (the
//     "server died" case), and on our own timeout — each with the RIGHT status, never left running
//   - interrupt() reports the REAL outcome — success, failure, and "nothing to interrupt" — never
//     a fabricated success
//   - no raw OpenCode baseURL/port ever appears in anything JSON-serializable this module produces
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createLiveRegistry, projectEvent, DEFAULT_EVENT_CAP } from "./live-session.mjs";
import { runSessionAgainstServer } from "./opencode-server.mjs";

// ── Part 1 — projectEvent: pure event -> label projection ─────────────────────────────────────

test("projectEvent maps every documented event type to a real {kind, labelKey}, never raw JSON", () => {
  const cases = [
    ["session.next.model.switched", {}, "model", "live.event.model"],
    ["session.next.prompt.admitted", {}, "prompt", "live.event.promptAdmitted"],
    ["session.next.prompted", {}, "prompt", "live.event.prompted"],
    ["session.next.step.started", {}, "step", "live.event.stepStarted"],
    ["session.next.reasoning.started", {}, "reasoning", "live.event.reasoningStarted"],
    ["session.next.reasoning.ended", {}, "reasoning", "live.event.reasoningEnded"],
    ["session.next.tool.input.started", {}, "tool", "live.event.toolPreparing"],
    ["session.next.tool.input.ended", {}, "tool", "live.event.toolPreparing"],
    ["session.next.tool.called", {}, "tool", "live.event.toolRunning"],
    ["session.next.tool.success", {}, "tool", "live.event.toolDone"],
    ["session.next.tool.failed", {}, "tool", "live.event.toolFailed"],
    ["session.next.text.started", {}, "text", "live.event.writing"],
    ["session.next.text.ended", {}, "text", "live.event.wrote"],
  ];
  for (const [type, data, kind, labelKey] of cases) {
    const p = projectEvent({ type, data });
    assert.equal(p.kind, kind, type);
    assert.equal(p.labelKey, labelKey, type);
    assert.equal(p.type, type);
  }
});

test("session.next.step.ended is the ONE event whose label depends on its payload — finish:'stop' is terminal, anything else is not", () => {
  const stop = projectEvent({ type: "session.next.step.ended", data: { finish: "stop" } });
  assert.equal(stop.labelKey, "live.event.finished");
  assert.equal(stop.finish, "stop");
  const mid = projectEvent({ type: "session.next.step.ended", data: { finish: "tool-calls" } });
  assert.equal(mid.labelKey, "live.event.stepEnded");
  assert.notEqual(mid.labelKey, stop.labelKey);
});

test("an unrecognized event type still produces a real, generic entry — activity is never silently dropped", () => {
  const p = projectEvent({ type: "session.next.moved", data: {} });
  assert.equal(p.kind, "other");
  assert.equal(p.labelKey, "live.event.other");
  assert.equal(p.type, "session.next.moved", "the verbatim type rides along as non-translated technical detail");
});

test("tool/file are extracted ONLY when the event actually carries them — never fabricated", () => {
  const withTool = projectEvent({ type: "session.next.tool.called", data: { tool: "write", file: "notes.txt" } });
  assert.equal(withTool.tool, "write");
  assert.equal(withTool.file, "notes.txt");
  const bare = projectEvent({ type: "session.next.tool.called", data: {} });
  assert.equal(bare.tool, undefined);
  assert.equal(bare.file, undefined);
  // Alternate real-world field names (the exact tool-event data shape is NOT pinned by the docs —
  // see live-session.mjs's own comment) are still picked up, defensively.
  const alt = projectEvent({ type: "session.next.tool.called", data: { name: "edit", input: { path: "src/a.js" } } });
  assert.equal(alt.tool, "edit");
  assert.equal(alt.file, "src/a.js");
});

test("a pathologically long tool/file field is clamped — one projected entry can never be unbounded", () => {
  const huge = "x".repeat(5000);
  const p = projectEvent({ type: "session.next.tool.called", data: { tool: huge, file: huge } });
  assert.ok(p.tool.length < 250, `tool field must be clamped, got ${p.tool.length} chars`);
  assert.ok(p.file.length < 250, `file field must be clamped, got ${p.file.length} chars`);
});

test("projectEvent never throws on a malformed/empty event", () => {
  assert.equal(projectEvent(null), null);
  assert.equal(projectEvent(undefined), null);
  assert.doesNotThrow(() => projectEvent({}));
  assert.doesNotThrow(() => projectEvent({ type: 42, data: null }));
});

// ── Part 2 — the registry: cap, close-on-end, interrupt honesty, no leaked URL/port ────────────

test("the per-session event buffer is CAPPED — a flood past the cap drops the OLDEST entries first and never grows unbounded", () => {
  const reg = createLiveRegistry({ cap: 5 });
  reg.start("s1", { interrupt: null });
  const FLOOD = 47;
  for (let i = 0; i < FLOOD; i++) {
    reg.push("s1", { type: "session.next.tool.called", data: { tool: String(i) } });
  }
  const rec = reg.get("s1");
  assert.equal(rec.events.length, 5, "the buffer must never exceed the configured cap");
  assert.equal(rec.dropped, FLOOD - 5, "every dropped entry must be counted, never silently vanish");
  // FIFO: the newest 5 pushes survive, the oldest are gone — a live viewer sees the RECENT tail.
  assert.deepEqual(rec.events.map((e) => e.tool), ["42", "43", "44", "45", "46"]);
  // seq is monotonic across the WHOLE session, not just the surviving window — proves the cap
  // trims the array without resetting the sequence a client might use to detect gaps.
  assert.deepEqual(rec.events.map((e) => e.seq), [43, 44, 45, 46, 47]);
});

test("the default cap is a real, finite, sane number (never 0, never Infinity, never accidentally huge)", () => {
  assert.ok(Number.isFinite(DEFAULT_EVENT_CAP) && DEFAULT_EVENT_CAP > 0 && DEFAULT_EVENT_CAP <= 5000);
});

test("end() notifies every live subscriber with the close sentinel exactly once, then further pushes are no-ops", () => {
  const reg = createLiveRegistry();
  reg.start("s1", { interrupt: null });
  const received = [];
  reg.subscribe("s1", (entry) => received.push(entry));
  reg.push("s1", { type: "session.next.prompted", data: {} });
  reg.end("s1", { status: "done", reason: null });
  reg.push("s1", { type: "session.next.tool.called", data: {} }); // must be silently ignored — session is over
  assert.equal(received.length, 2, "one real event, then exactly one close sentinel");
  assert.notEqual(received[0], null);
  assert.equal(received[1], null, "the close sentinel is the null entry");
  assert.equal(reg.get("s1").events.length, 1, "a push after end() must never be recorded");
  assert.equal(reg.get("s1").status, "done");
  // end() itself is idempotent — a second call (e.g. a duplicate lifecycle hook) never re-notifies.
  const before = received.length;
  reg.end("s1", { status: "timeout" });
  assert.equal(received.length, before, "end() on an already-ended session must be a no-op");
  assert.equal(reg.get("s1").status, "done", "the FIRST real status wins, never overwritten");
});

test("subscribe/push/interrupt against an unknown session id are safe, honest no-ops — never throw", async () => {
  const reg = createLiveRegistry();
  assert.doesNotThrow(() => reg.push("ghost", { type: "session.next.prompted", data: {} }));
  const unsub = reg.subscribe("ghost", () => { throw new Error("must never be called"); });
  assert.doesNotThrow(unsub);
  const result = await reg.interrupt("ghost");
  assert.deepEqual(result, { ok: false, reason: "no such live session" });
});

test("interrupt(): SUCCESS is reported honestly from the real closure result", async () => {
  const reg = createLiveRegistry();
  reg.start("s-ok", { interrupt: async () => ({ ok: true, status: 204 }) });
  const result = await reg.interrupt("s-ok");
  assert.equal(result.ok, true);
  assert.equal(result.status, 204);
});

test("interrupt(): FAILURE (a real non-2xx from the underlying call) is reported honestly, never upgraded to success", async () => {
  const reg = createLiveRegistry();
  reg.start("s-fail", { interrupt: async () => ({ ok: false, status: 503, text: "Session wait is not available yet" }) });
  const result = await reg.interrupt("s-fail");
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.match(result.reason, /not available/);
});

test("interrupt(): a closure that THROWS is caught and reported as a real failure, never crashes the caller", async () => {
  const reg = createLiveRegistry();
  reg.start("s-throw", { interrupt: async () => { throw new Error("ECONNREFUSED"); } });
  const result = await reg.interrupt("s-throw");
  assert.equal(result.ok, false);
  assert.match(result.reason, /ECONNREFUSED/);
});

test("interrupt(): a session with no interrupt handle (never wired) fails honestly instead of silently 'succeeding'", async () => {
  const reg = createLiveRegistry();
  reg.start("s-none", {});
  const result = await reg.interrupt("s-none");
  assert.equal(result.ok, false);
  assert.match(result.reason, /no interrupt handle/);
});

test("interrupt(): a session that already ended is refused — the button must never claim it stopped a run that is already over", async () => {
  const reg = createLiveRegistry();
  reg.start("s-done", { interrupt: async () => ({ ok: true }) });
  reg.end("s-done", { status: "done" });
  const result = await reg.interrupt("s-done");
  assert.equal(result.ok, false);
  assert.match(result.reason, /not running/);
});

test("no raw OpenCode baseURL/port ever appears in anything this module hands back as data", () => {
  const reg = createLiveRegistry();
  const SECRET_PORT = "54321";
  const baseURL = `http://127.0.0.1:${SECRET_PORT}`;
  // The interrupt closure legitimately CLOSES OVER the real baseURL (exactly like
  // opencode-server.mjs's `() => interruptSession(baseURL, sessionID, ...)`) — that is the whole
  // point of the design: the URL lives ONLY inside this unreachable closure.
  reg.start("s1", { interrupt: () => fetch(`${baseURL}/api/session/s1/interrupt`, { method: "POST" }) });
  for (let i = 0; i < 10; i++) {
    reg.push("s1", { type: "session.next.tool.called", data: { tool: "write", file: `file-${i}.txt` } });
  }
  const rec = reg.get("s1");
  // JSON.stringify silently DROPS function-valued properties (the `interrupt` closure and the
  // `listeners` Set both vanish) — this is exactly the serialization boundary web-server.mjs's
  // SSE relay and interrupt endpoint actually cross. Assert the secret is nowhere in that output.
  const serializable = { ...rec, listeners: undefined, interrupt: undefined };
  const asJson = JSON.stringify(serializable);
  assert.ok(!asJson.includes(SECRET_PORT), "the port must never reach a JSON-serializable shape");
  assert.ok(!asJson.includes("127.0.0.1"), "the host must never reach a JSON-serializable shape");
  // Same check on just the events array — the literal payload the SSE relay actually streams out.
  const eventsJson = JSON.stringify(rec.events);
  assert.ok(!eventsJson.includes(SECRET_PORT) && !eventsJson.includes(baseURL));
});

// ── Part 3 — real integration with opencode-server.mjs's runSessionAgainstServer ───────────────
// A minimal stub `opencode serve` (same idiom as opencode-server.test.mjs) — enough of the real
// v2 REST + SSE surface to drive the runtime end-to-end without a real opencode binary.
function startStub({ catalog = [], eventScript = [], closeStreamAfterMs = null } = {}) {
  const calls = { model: 0, prompt: 0, interrupt: 0 };
  let sseRes = null;
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const path = url.pathname;
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      const json = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (req.method === "GET" && path === "/api/health") return json(200, { healthy: true });
      if (req.method === "GET" && path === "/api/model") return json(200, { data: catalog });
      let m;
      if (req.method === "POST" && path === "/api/session")
        return json(200, { data: { id: SESSION_ID, projectID: "global", location: { directory: JSON.parse(body || "{}")?.location?.directory || null } } });
      if (req.method === "POST" && (m = path.match(/^\/api\/session\/([^/]+)\/model$/))) { calls.model++; res.writeHead(204); return res.end(); }
      if (req.method === "POST" && (m = path.match(/^\/api\/session\/([^/]+)\/prompt$/))) { calls.prompt++; return json(200, { data: { admittedSeq: 1, id: "msg1", sessionID: m[1] } }); }
      if (req.method === "POST" && (m = path.match(/^\/api\/session\/([^/]+)\/interrupt$/))) { calls.interrupt++; res.writeHead(204); return res.end(); }
      if (req.method === "GET" && path.match(/^\/api\/session\/[^/]+\/message$/)) return json(200, { data: [] });
      if (req.method === "GET" && path.match(/^\/api\/session\/[^/]+\/event$/)) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        sseRes = res;
        let i = 0;
        const pump = () => {
          if (i >= eventScript.length) {
            if (closeStreamAfterMs != null) setTimeout(() => { try { res.end(); } catch {} }, closeStreamAfterMs);
            return;
          }
          const { delayMs = 5, evt } = eventScript[i++];
          setTimeout(() => { if (sseRes) sseRes.write(`data: ${JSON.stringify(evt)}\n\n`); pump(); }, delayMs);
        };
        pump();
        res.on("close", () => { if (sseRes === res) sseRes = null; });
        return;
      }
      json(404, { error: "no such stub route", path });
    });
  });
  // A fresh, unique session id per stub instance — several tests run against the SAME process-wide
  // `liveSessions` singleton (imported by opencode-server.mjs), so ids must never collide.
  const SESSION_ID = `ses_stub_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ baseURL: `http://127.0.0.1:${server.address().port}`, sessionId: SESSION_ID, calls,
        close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }) });
    });
  });
}
function makeGitWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), "live-session-test-"));
  execFileSync("git", ["-C", ws, "init", "-q"]);
  execFileSync("git", ["-C", ws, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "pre", "--allow-empty"]);
  return ws;
}
const MODEL = { providerID: "stub-provider", id: "stub-model" };
const CATALOG_ENTRY = { id: MODEL.id, providerID: MODEL.providerID, family: "stub", name: "Stub", capabilities: [], limit: { context: 8192, output: 4096 }, status: "ok" };

test("integration: the live registry receives PROJECTED events as they arrive — while the run is still in flight, not just at the end", async () => {
  const eventScript = [
    { evt: { type: "session.next.model.switched", data: {} } },
    { evt: { type: "session.next.prompt.admitted", data: {} } },
    { evt: { type: "session.next.prompted", data: {} } },
    { delayMs: 40, evt: { type: "session.next.step.started", data: {} } },
    { evt: { type: "session.next.tool.called", data: { tool: "write", file: "out.txt" } } },
    { delayMs: 40, evt: { type: "session.next.step.ended", data: { finish: "stop" } } },
  ];
  const stub = await startStub({ catalog: [CATALOG_ENTRY], eventScript });
  const ws = makeGitWorkspace();
  writeFileSync(join(ws, "out.txt"), "hi\n");
  let startedId = null;
  try {
    const runPromise = runSessionAgainstServer({
      baseURL: stub.baseURL, workspace: ws, providerID: MODEL.providerID, modelID: MODEL.id,
      prompt: "write a file", timeoutMs: 5000, modelCatalogTimeoutMs: 2000,
      onSessionStart: (id) => { startedId = id; },
    });
    // Poll the registry WHILE the run is still pending — proves activity is visible live, not
    // reconstructed after the fact.
    const { liveSessions } = await import("./live-session.mjs");
    let sawToolCall = false;
    for (let i = 0; i < 100 && !sawToolCall; i++) {
      await new Promise((r) => setTimeout(r, 15));
      const rec = startedId && liveSessions.get(startedId);
      if (rec && rec.status === "running" && rec.events.some((e) => e.tool === "write")) sawToolCall = true;
    }
    assert.ok(sawToolCall, "the tool-call activity must be observable on the registry BEFORE the run finishes");
    const result = await runPromise;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(startedId, stub.sessionId);
    const finalRec = liveSessions.get(startedId);
    assert.equal(finalRec.status, "done", "a clean completion must end the live session as done");
    assert.ok(finalRec.events.some((e) => e.labelKey === "live.event.finished"));
  } finally {
    await stub.close();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("integration: the event stream closing before a terminal event (the server dying mid-run) ends the live session honestly — never left 'running' forever", async () => {
  const eventScript = [
    { evt: { type: "session.next.prompt.admitted", data: {} } },
    { evt: { type: "session.next.prompted", data: {} } },
    // No step.started/step.ended ever arrives — the stub then closes the connection outright.
  ];
  const stub = await startStub({ catalog: [CATALOG_ENTRY], eventScript, closeStreamAfterMs: 30 });
  const ws = makeGitWorkspace();
  let startedId = null;
  try {
    const result = await runSessionAgainstServer({
      baseURL: stub.baseURL, workspace: ws, providerID: MODEL.providerID, modelID: MODEL.id,
      prompt: "irrelevant", timeoutMs: 20000, modelCatalogTimeoutMs: 2000,
      onSessionStart: (id) => { startedId = id; },
    });
    assert.equal(result.ok, false);
    assert.match(result.noWorkReason, /stream closed|may have exited/);
    const { liveSessions } = await import("./live-session.mjs");
    const rec = liveSessions.get(startedId);
    assert.equal(rec.status, "stream-closed");
    assert.match(rec.endedReason, /stream closed|may have exited/);
  } finally {
    await stub.close();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("integration: our own overall timeout (no terminal event, stream stays open) ends the live session as 'timeout', not 'running' forever", async () => {
  const eventScript = [
    { evt: { type: "session.next.prompt.admitted", data: {} } },
    { evt: { type: "session.next.prompted", data: {} } },
    // Deliberately never sends a step.ended and never closes the stream — the ONLY way out is our
    // own timeoutMs firing.
  ];
  const stub = await startStub({ catalog: [CATALOG_ENTRY], eventScript });
  const ws = makeGitWorkspace();
  let startedId = null;
  try {
    const result = await runSessionAgainstServer({
      baseURL: stub.baseURL, workspace: ws, providerID: MODEL.providerID, modelID: MODEL.id,
      prompt: "irrelevant", timeoutMs: 250, modelCatalogTimeoutMs: 2000,
      onSessionStart: (id) => { startedId = id; },
    });
    assert.equal(result.ok, false);
    assert.match(result.noWorkReason, /timed out/);
    assert.equal(stub.calls.interrupt, 1, "a timeout must attempt a real interrupt call");
    const { liveSessions } = await import("./live-session.mjs");
    const rec = liveSessions.get(startedId);
    assert.equal(rec.status, "timeout");
  } finally {
    await stub.close();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("integration: a model-registry gate refusal still registers + closes the live session (visible even for a run that never really starts)", async () => {
  const stub = await startStub({ catalog: [] }); // MODEL is never present
  const ws = makeGitWorkspace();
  let startedId = null;
  try {
    const result = await runSessionAgainstServer({
      baseURL: stub.baseURL, workspace: ws, providerID: MODEL.providerID, modelID: MODEL.id,
      prompt: "irrelevant", modelCatalogTimeoutMs: 300, requestTimeoutMs: 2000,
      onSessionStart: (id) => { startedId = id; },
    });
    assert.equal(result.ok, false);
    assert.ok(startedId, "onSessionStart must still fire even though the gate refuses the run");
    const { liveSessions } = await import("./live-session.mjs");
    const rec = liveSessions.get(startedId);
    assert.equal(rec.status, "failed");
  } finally {
    await stub.close();
    rmSync(ws, { recursive: true, force: true });
  }
});
