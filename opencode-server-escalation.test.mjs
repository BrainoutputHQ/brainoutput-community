#!/usr/bin/env node --test
// SPDX-License-Identifier: Apache-2.0
// Tests for worker escalation (permission replies + question routing) added to the server-backed
// OpenCode runtime (opencode-server.mjs), 2026-08-04. Fully hermetic — the same in-process
// node:http+SSE stub style as opencode-server-routing.test.mjs, extended with
// GET /api/session/{id}/permission, POST /api/session/{id}/permission/{id}/reply,
// GET /api/session/{id}/question, POST /api/session/{id}/question/{id}/reply,
// POST /api/session/{id}/question/{id}/reject.
//
// Ground truth (verified live against a real `opencode serve` 1.18.7, not guessed — see the
// mission report): NEITHER a pending permission ask NOR a pending question-tool call ever produces
// an SSE event on the session's own event stream — the stream just goes quiet after
// `session.next.tool.called`/`tool.input.ended` until someone replies. The runtime's only way to
// discover either is to POLL, which is exactly what this test file pins down.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decidePermissionRequest, fetchPendingPermissions, fetchPendingQuestions,
  runSessionAgainstServer,
} from "./opencode-server.mjs";
import { WORKSPACE_PERMISSION_GRANT } from "./opencode-adapter.mjs";
import { t, LOCALES, missingKeys } from "./i18n.mjs";

// ── Stub `opencode serve` — opencode-server-routing.test.mjs's stub, extended with the
// permission/question routes this change adds. Every call is counted; every reply/reject the
// runtime sends is recorded verbatim so tests can assert on the EXACT decision made, not just that
// "something" was sent. A request stays "pending" (returned by the GET list) until its own
// reply/reject arrives — mirrors the real server's behaviour (a request some other reply already
// resolved never reappears).
function startStub({ catalog = [], eventScript = [], messages = [],
  permissions = [], permissionEmptyPolls = 0, questions = [] } = {}) {
  const calls = { model: 0, prompt: 0, interrupt: 0, event: 0, session: 0,
    permissionList: 0, permissionReply: 0, questionList: 0, questionReply: 0, questionReject: 0 };
  const permState = new Map(permissions.map((p) => [p.id, { ...p, replied: false }]));
  const qState = new Map(questions.map((q) => [q.id, { ...q, replied: false }]));
  const permReplies = [];      // { id, reply, message? } — every POST .../permission/{id}/reply body
  const questionReplies = [];  // { id, answers }
  const questionRejects = [];  // [id, ...]
  let sseRes = null;

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
      if (req.method === "GET" && (m = path.match(/^\/api\/session\/([^/]+)\/message$/))) {
        return json(200, { data: messages });
      }

      // ── Permission routes ──────────────────────────────────────────────────────────────────
      if (req.method === "GET" && (m = path.match(/^\/api\/session\/([^/]+)\/permission$/))) {
        calls.permissionList++;
        // `permissionEmptyPolls` simulates a transiently-empty list (the SAME warmup gotcha the
        // model/skill/agent registries already have) — the request is real but not visible yet.
        if (calls.permissionList <= permissionEmptyPolls) return json(200, { data: [] });
        return json(200, { data: [...permState.values()].filter((p) => !p.replied).map(({ replied, ...rest }) => rest) });
      }
      if (req.method === "POST" && (m = path.match(/^\/api\/session\/([^/]+)\/permission\/([^/]+)\/reply$/))) {
        calls.permissionReply++;
        const b = JSON.parse(body || "{}");
        const p = permState.get(m[2]);
        if (p) p.replied = true;
        permReplies.push({ id: m[2], ...b });
        res.writeHead(204); return res.end();
      }

      // ── Question routes ────────────────────────────────────────────────────────────────────
      if (req.method === "GET" && (m = path.match(/^\/api\/session\/([^/]+)\/question$/))) {
        calls.questionList++;
        return json(200, { data: [...qState.values()].filter((q) => !q.replied).map(({ replied, ...rest }) => rest) });
      }
      if (req.method === "POST" && (m = path.match(/^\/api\/session\/([^/]+)\/question\/([^/]+)\/reply$/))) {
        calls.questionReply++;
        const b = JSON.parse(body || "{}");
        const q = qState.get(m[2]);
        if (q) q.replied = true;
        questionReplies.push({ id: m[2], answers: b.answers });
        res.writeHead(204); return res.end();
      }
      if (req.method === "POST" && (m = path.match(/^\/api\/session\/([^/]+)\/question\/([^/]+)\/reject$/))) {
        calls.questionReject++;
        const q = qState.get(m[2]);
        if (q) q.replied = true;
        questionRejects.push(m[2]);
        res.writeHead(204); return res.end();
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
        calls, permReplies, questionReplies, questionRejects,
        close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }),
      });
    });
  });
}

function makeGitWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), "oc-escalation-test-"));
  execFileSync("git", ["-C", ws, "init", "-q"]);
  execFileSync("git", ["-C", ws, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "pre", "--allow-empty"]);
  return ws;
}

const MODEL = { providerID: "stub-provider", id: "stub-model" };
const CATALOG_ENTRY = { id: MODEL.id, providerID: MODEL.providerID, family: "stub", name: "Stub Model",
  capabilities: [], limit: { context: 8192, output: 4096 }, status: "ok" };
const TERMINAL_SOON = [{ delayMs: 30, evt: { type: "session.next.step.ended", data: { finish: "stop" } } }];

// ── decidePermissionRequest: pure policy, no network ───────────────────────────────────────────
test("decidePermissionRequest: an action the workspace grant marks allow (edit, resource inside) is allowed, reply 'once'", () => {
  const ws = makeGitWorkspace();
  try {
    writeFileSync(join(ws, "out.txt"), "x");
    const d = decidePermissionRequest({ id: "per_1", action: "edit", resources: ["out.txt"] }, { workspace: ws });
    assert.equal(d.allow, true);
    assert.equal(d.reply, "once");
    assert.equal(d.reason, null);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("decidePermissionRequest: bash is allowed by the grant — its resources are command strings, not paths", () => {
  const ws = makeGitWorkspace();
  try {
    const d = decidePermissionRequest({ id: "per_2", action: "bash", resources: ["echo hi > out.txt"] }, { workspace: ws });
    assert.equal(d.allow, true);
    assert.equal(d.reply, "once");
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("decidePermissionRequest: an action the grant marks deny (webfetch/external_directory) is refused, reply 'reject'", () => {
  for (const action of ["webfetch", "external_directory"]) {
    assert.equal(WORKSPACE_PERMISSION_GRANT[action], "deny", `fixture assumption: ${action} is denied in the real grant`);
    const d = decidePermissionRequest({ id: "per_x", action, resources: ["https://example.com"] });
    assert.equal(d.allow, false);
    assert.equal(d.reply, "reject");
    assert.match(d.reason, new RegExp(action));
  }
});

test("decidePermissionRequest: an action not named in the grant at all is refused fail-closed, never a silent allow", () => {
  const d = decidePermissionRequest({ id: "per_y", action: "totally-unknown-action", resources: [] });
  assert.equal(d.allow, false);
  assert.equal(d.reply, "reject");
  assert.match(d.reason, /totally-unknown-action/);
});

test("decidePermissionRequest: edit is refused when its resource resolves OUTSIDE the confined workspace — even though edit itself is granted", () => {
  const ws = makeGitWorkspace();
  try {
    const traversal = decidePermissionRequest({ id: "per_z", action: "edit", resources: ["../../etc/passwd"] }, { workspace: ws });
    assert.equal(traversal.allow, false);
    assert.equal(traversal.reply, "reject");
    assert.match(traversal.reason, /\.\.\/\.\.\/etc\/passwd/);

    const absolute = decidePermissionRequest({ id: "per_z2", action: "edit", resources: ["/etc/passwd"] }, { workspace: ws });
    assert.equal(absolute.allow, false);
    assert.equal(absolute.reply, "reject");
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("decidePermissionRequest never widens the grant to 'always' — a granted action always replies 'once'", () => {
  const ws = makeGitWorkspace();
  try {
    const d = decidePermissionRequest({ id: "per_w", action: "edit", resources: ["a.txt"], save: ["*"] }, { workspace: ws });
    assert.equal(d.reply, "once");
    assert.notEqual(d.reply, "always");
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ── AC 1: a permission request INSIDE the grant is allowed and the run proceeds ────────────────
test("a permission request inside the workspace grant is allowed and the run proceeds", async () => {
  const stub = await startStub({
    catalog: [CATALOG_ENTRY], eventScript: TERMINAL_SOON,
    permissions: [{ id: "per_1", sessionID: "ses_stub1", action: "edit", resources: ["out.txt"] }],
  });
  const ws = makeGitWorkspace();
  writeFileSync(join(ws, "out.txt"), "written\n");
  try {
    const result = await runSessionAgainstServer({
      baseURL: stub.baseURL, workspace: ws, providerID: MODEL.providerID, modelID: MODEL.id,
      prompt: "go", timeoutMs: 5000, modelCatalogTimeoutMs: 2000, escalationPollMs: 15,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(stub.permReplies.length, 1);
    assert.deepEqual(stub.permReplies[0], { id: "per_1", reply: "once" });
    assert.equal(result.permissionEvents.length, 1);
    assert.equal(result.permissionEvents[0].allow, true);
    assert.equal(result.permissionEvents[0].reason, null);
  } finally {
    await stub.close();
    rmSync(ws, { recursive: true, force: true });
  }
});

// ── AC 2: a permission request OUTSIDE the grant is refused and the task blocks with an honest reason ──
test("a permission request outside the grant is refused, recorded with an honest reason, and surfaced in the log", async () => {
  const stub = await startStub({
    catalog: [CATALOG_ENTRY], eventScript: TERMINAL_SOON,
    permissions: [{ id: "per_2", sessionID: "ses_stub1", action: "webfetch", resources: ["https://evil.example"] }],
  });
  const ws = makeGitWorkspace();
  writeFileSync(join(ws, "out.txt"), "written anyway\n"); // real evidence exists — refusal must still be visible
  try {
    const result = await runSessionAgainstServer({
      baseURL: stub.baseURL, workspace: ws, providerID: MODEL.providerID, modelID: MODEL.id,
      prompt: "go", timeoutMs: 5000, modelCatalogTimeoutMs: 2000, escalationPollMs: 15,
    });
    assert.equal(stub.permReplies.length, 1);
    assert.equal(stub.permReplies[0].reply, "reject");
    assert.match(stub.permReplies[0].message, /webfetch/);
    assert.equal(result.permissionEvents[0].allow, false);
    assert.match(result.permissionEvents[0].reason, /webfetch/);
    assert.match(result.log, /permission defects \(security\)/);
    assert.match(result.log, /webfetch/);
  } finally {
    await stub.close();
    rmSync(ws, { recursive: true, force: true });
  }
});

// ── AC 3: a question answerable from DECISIONS is auto-answered without owner involvement ──────
test("a question answerable from the plan's decisions is auto-answered via the hook — no escalation", async () => {
  const stub = await startStub({
    catalog: [CATALOG_ENTRY], eventScript: TERMINAL_SOON,
    questions: [{ id: "que_1", sessionID: "ses_stub1",
      questions: [{ question: "Which stack?", header: "Stack", options: [{ label: "ESM", description: "d" }, { label: "CJS", description: "d2" }] }] }],
  });
  const ws = makeGitWorkspace();
  writeFileSync(join(ws, "out.txt"), "x\n");
  const seenQuestions = [];
  const onWorkerQuestion = async (qr) => {
    seenQuestions.push(qr.questions[0].question);
    return { answers: [["ESM"]] }; // simulates: the plan's decisions settle it
  };
  try {
    const result = await runSessionAgainstServer({
      baseURL: stub.baseURL, workspace: ws, providerID: MODEL.providerID, modelID: MODEL.id,
      prompt: "go", timeoutMs: 5000, modelCatalogTimeoutMs: 2000, escalationPollMs: 15, onWorkerQuestion,
    });
    assert.deepEqual(seenQuestions, ["Which stack?"]);
    assert.equal(stub.questionReplies.length, 1);
    assert.deepEqual(stub.questionReplies[0], { id: "que_1", answers: [["ESM"]] });
    assert.equal(stub.questionRejects.length, 0);
    assert.equal(result.questionEvents.length, 1);
    assert.equal(result.questionEvents[0].resolved, "answered");
    assert.equal(result.ok, true, "auto-answered — never forced to fail");
  } finally {
    await stub.close();
    rmSync(ws, { recursive: true, force: true });
  }
});

// ── AC 4: a question NOT covered escalates to the owner ─────────────────────────────────────────
test("a question the hook does not cover is rejected (not left hanging) and escalates to the owner, overriding evidence-based success", async () => {
  const stub = await startStub({
    catalog: [CATALOG_ENTRY], eventScript: TERMINAL_SOON,
    questions: [{ id: "que_2", sessionID: "ses_stub1",
      questions: [{ question: "Which color scheme?", header: "Color", options: [{ label: "Dark", description: "d" }] }] }],
  });
  const ws = makeGitWorkspace();
  writeFileSync(join(ws, "out.txt"), "real work happened before the pause\n"); // evidence exists regardless
  const onWorkerQuestion = async () => null; // NOT_COVERED — the plan's decisions don't settle it
  try {
    const result = await runSessionAgainstServer({
      baseURL: stub.baseURL, workspace: ws, providerID: MODEL.providerID, modelID: MODEL.id,
      prompt: "go", timeoutMs: 5000, modelCatalogTimeoutMs: 2000, escalationPollMs: 15, onWorkerQuestion,
    });
    assert.equal(stub.questionReplies.length, 0, "an uncovered question is never answered");
    assert.deepEqual(stub.questionRejects, ["que_2"], "rejected so the session does not hang forever");
    assert.equal(result.questionEvents[0].resolved, "escalated");
    assert.equal(result.ok, false, "escalation overrides evidence-based success — the task is not done until the owner answers");
    assert.equal(result.noWork, true);
    assert.equal(result.noWorkReason, t("en", "opencode.question.escalated"));
    assert.match(result.log, /worker questions awaiting the owner/);
    assert.match(result.log, /Which color scheme\?/);
  } finally {
    await stub.close();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("no onWorkerQuestion hook wired (byte-compat default): a pending question is rejected, never left hanging", async () => {
  const stub = await startStub({
    catalog: [CATALOG_ENTRY], eventScript: TERMINAL_SOON,
    questions: [{ id: "que_3", sessionID: "ses_stub1", questions: [{ question: "?", header: "h", options: [] }] }],
  });
  const ws = makeGitWorkspace();
  writeFileSync(join(ws, "out.txt"), "x\n");
  try {
    const result = await runSessionAgainstServer({
      baseURL: stub.baseURL, workspace: ws, providerID: MODEL.providerID, modelID: MODEL.id,
      prompt: "go", timeoutMs: 5000, modelCatalogTimeoutMs: 2000, escalationPollMs: 15,
      // onWorkerQuestion intentionally omitted
    });
    assert.deepEqual(stub.questionRejects, ["que_3"]);
    assert.equal(result.questionEvents[0].resolved, "escalated");
    assert.equal(result.ok, false);
  } finally {
    await stub.close();
    rmSync(ws, { recursive: true, force: true });
  }
});

// ── AC 5: the auto-answer cap still holds (the CAP itself lives in web-server.mjs's
// maybeAutoAnswer/MAX_TASK_AUTO_ANSWERS, unit-tested in escalation.test.mjs — this test proves
// opencode-server.mjs's plumbing defers ENTIRELY to whatever the hook decides, call by call, for
// MULTIPLE sequential questions within one run, which is what the real cap depends on) ───────────
test("multiple sequential questions in one run are each handed to the hook independently — the cap (wherever the hook enforces it) is respected", async () => {
  // Three distinct pending questions seeded up front — the real server only ever shows ONE at a
  // time per session, but our poller processes whatever GET returns in one pass, so this ALSO
  // exercises "more than one pending in a single poll round".
  const stub = await startStub({
    catalog: [CATALOG_ENTRY], eventScript: TERMINAL_SOON,
    questions: [
      { id: "que_a", sessionID: "ses_stub1", questions: [{ question: "q1", header: "h", options: [] }] },
      { id: "que_b", sessionID: "ses_stub1", questions: [{ question: "q2", header: "h", options: [] }] },
      { id: "que_c", sessionID: "ses_stub1", questions: [{ question: "q3", header: "h", options: [] }] },
    ],
  });
  const ws = makeGitWorkspace();
  writeFileSync(join(ws, "out.txt"), "x\n");
  let calls = 0;
  const CAP = 2;
  const onWorkerQuestion = async () => {
    calls += 1;
    return calls <= CAP ? { answers: [["ok"]] } : null; // the 3rd (over the cap) is NOT_COVERED
  };
  try {
    const result = await runSessionAgainstServer({
      baseURL: stub.baseURL, workspace: ws, providerID: MODEL.providerID, modelID: MODEL.id,
      prompt: "go", timeoutMs: 5000, modelCatalogTimeoutMs: 2000, escalationPollMs: 15, onWorkerQuestion,
    });
    assert.equal(calls, 3, "every pending question was handed to the hook");
    assert.equal(stub.questionReplies.length, 2, "the first two (within the cap) were answered");
    assert.equal(stub.questionRejects.length, 1, "the one over the cap was rejected, never left hanging");
    const resolved = result.questionEvents.map((e) => e.resolved).sort();
    assert.deepEqual(resolved, ["answered", "answered", "escalated"]);
    assert.equal(result.ok, false, "the escalated one still overrides evidence-based success");
  } finally {
    await stub.close();
    rmSync(ws, { recursive: true, force: true });
  }
});

// ── AC 6: the transient-empty poll — a pending permission that only APPEARS a few polls in is
// still discovered and resolved before the run ends, exactly like the model/skill/agent registry
// warmup gotcha this same file already handles. ─────────────────────────────────────────────────
test("a permission that is transiently absent from GET .../permission for the first few polls is still discovered and resolved", async () => {
  const stub = await startStub({
    catalog: [CATALOG_ENTRY],
    // The FIRST event must arrive quickly — subscribeEvents' own `sub.ready` race (and everything
    // after it: the pre-run context check, model select, prompt, and the poller's own start) is
    // blocked until the SSE connection's first byte lands. Only the TERMINAL event is delayed, to
    // leave genuine wall-clock room for several poll rounds in between.
    eventScript: [
      { evt: { type: "session.next.step.started", data: {} } },
      { delayMs: 500, evt: { type: "session.next.step.ended", data: { finish: "stop" } } },
    ],
    permissions: [{ id: "per_late", sessionID: "ses_stub1", action: "edit", resources: ["late.txt"] }],
    permissionEmptyPolls: 3, // empty on the first 3 GETs, populated from the 4th call onward
  });
  const ws = makeGitWorkspace();
  writeFileSync(join(ws, "late.txt"), "x\n");
  try {
    const result = await runSessionAgainstServer({
      baseURL: stub.baseURL, workspace: ws, providerID: MODEL.providerID, modelID: MODEL.id,
      prompt: "go", timeoutMs: 5000, modelCatalogTimeoutMs: 2000, escalationPollMs: 15,
    });
    assert.ok(stub.calls.permissionList >= 4, "must have polled past the empty responses");
    assert.equal(stub.permReplies.length, 1);
    assert.equal(stub.permReplies[0].reply, "once");
    assert.equal(result.permissionEvents[0].allow, true);
  } finally {
    await stub.close();
    rmSync(ws, { recursive: true, force: true });
  }
});

// ── Backward-compatibility: an old-style stub with NO permission/question routes at all (404s
// unconditionally) never breaks the run — the poller treats every 404 as "nothing pending". ──────
test("polling against a server with no permission/question routes (404) never breaks the run — byte-compat with the pre-escalation stub", async () => {
  // A minimal stub, deliberately WITHOUT the permission/question routes (matches
  // opencode-server.test.mjs's original stub shape exactly).
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const path = url.pathname;
    let body = ""; req.on("data", (d) => { body += d; });
    req.on("end", () => {
      const json = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (req.method === "GET" && path === "/api/health") return json(200, { healthy: true });
      if (req.method === "GET" && path === "/api/model") return json(200, { data: [CATALOG_ENTRY] });
      if (req.method === "POST" && path === "/api/session") return json(200, { data: { id: "ses_stub1" } });
      let m;
      if (req.method === "POST" && (m = path.match(/^\/api\/session\/([^/]+)\/model$/))) { res.writeHead(204); return res.end(); }
      if (req.method === "POST" && (m = path.match(/^\/api\/session\/([^/]+)\/prompt$/))) return json(200, { data: { admittedSeq: 1, id: "msg_1", sessionID: m[1] } });
      if (req.method === "GET" && (m = path.match(/^\/api\/session\/([^/]+)\/message$/))) return json(200, { data: [] });
      if (req.method === "GET" && (m = path.match(/^\/api\/session\/([^/]+)\/event$/))) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        setTimeout(() => res.write(`data: ${JSON.stringify({ type: "session.next.step.ended", data: { finish: "stop" } })}\n\n`), 30);
        return;
      }
      json(404, { error: "no such stub route", path }); // permission/question routes 404 unconditionally
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  const ws = makeGitWorkspace();
  writeFileSync(join(ws, "out.txt"), "x\n");
  try {
    const result = await runSessionAgainstServer({
      baseURL, workspace: ws, providerID: MODEL.providerID, modelID: MODEL.id,
      prompt: "go", timeoutMs: 5000, modelCatalogTimeoutMs: 2000, escalationPollMs: 15,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.permissionEvents, []);
    assert.deepEqual(result.questionEvents, []);
  } finally {
    await new Promise((r) => { server.close(r); server.closeAllConnections(); });
    rmSync(ws, { recursive: true, force: true });
  }
});

// ── fetchPendingPermissions / fetchPendingQuestions: tolerate a non-200/unreachable response ────
test("fetchPendingPermissions / fetchPendingQuestions never throw on a 404 — they report 'nothing pending'", async () => {
  const stub = await startStub({});
  try {
    assert.deepEqual(await fetchPendingPermissions(stub.baseURL, "ses_ghost"), []);
    assert.deepEqual(await fetchPendingQuestions(stub.baseURL, "ses_ghost"), []);
  } finally {
    await stub.close();
  }
});

// ── i18n parity for the new keys ────────────────────────────────────────────────────────────────
test("the new opencode.permission.*/opencode.question.* i18n keys are present and parity-complete across en/fr/de", () => {
  for (const key of ["opencode.permission.refusedAction", "opencode.permission.outsideWorkspace", "opencode.question.escalated"]) {
    for (const loc of LOCALES) assert.notEqual(t(loc, key), key, `${loc}/${key} must not fall back to the raw key`);
  }
  for (const loc of LOCALES) assert.deepEqual(missingKeys(loc), [], `${loc} is missing keys`);
});
