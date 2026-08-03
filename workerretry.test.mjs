// SPDX-License-Identifier: Apache-2.0
// Transient-failure policy for execution stages (task-pm-17). The founder watched his free-tier
// model 502 (ResourceExhausted) and work die without a real reason. Pinned here:
//   TRANSIENT (provider 5xx, 429, network, timeout, empty response) → up to 2 retries
//     (3 attempts total) with deterministic backoff — the sleep is injectable, so this file
//     runs on an INSTANT clock (BO_CE_STAGE_RETRY_BACKOFF_MS="0,0" in the server env).
//   PERMANENT (4xx — 401/403/400…) → block IMMEDIATELY, exactly 1 call, never a retry.
//   finish_reason=length no-content → NEITHER: the dedicated double-budget retry owns it
//     (one normal-budget call, then the bigger-budget one — never a transient retry loop).
//   FINAL worker-stage failure → the task blocks with the REAL error (provider + status +
//     message — never disguised as "no model configured") and the queue pauses.
//   REVIEWER stage down → blocked by:"reviewer-unavailable" with the real error in the note —
//     never a judged review, never by:"deterministic".
// Real-server tmp-dir pattern with a stubbed model endpoint (same as runqueue.test.mjs).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 4461;
const BASE = `http://127.0.0.1:${PORT}`;
let srv, dir, stub;

const WORKER_OUT = "ok — done. " + "Real work output follows: ".repeat(8);
const bodies = [];                 // every completion request body, in order
const counts = new Map();          // marker → calls seen (per-test behavior windows)
const seen = (m) => { const n = (counts.get(m) || 0) + 1; counts.set(m, n); return n; };
// The request body is one JSON line (newlines escaped) — the title capture stops at the first
// escape backslash, so workerCalls matches EXACT worker-stage titles (recovery.test.mjs trick).
const partOf = (d) => (d.match(/YOUR PART \(task \d+\/\d+\): ([^\\]*)/) || [])[1] || "";
const workerCalls = (mark) => bodies.filter((d) => partOf(d).includes(mark));
const reviewerCalls = (mark) => bodies.filter((d) => d.includes("rigorous reviewer for THIS task") && d.includes(mark));
const maxTokensOf = (d) => { try { return JSON.parse(d).max_tokens; } catch { return null; } };

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "bo-workerretry-"));
  const { createServer } = await import("node:http");
  stub = createServer((req, res) => {
    let d = ""; req.on("data", (c) => (d += c));
    req.on("end", () => {
      bodies.push(d);
      const say = (content, extra = {}) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content }, ...extra }] }));
      };
      const failWith = (code, message) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message } }));
      };
      // The bounded per-task REVIEW call (task-pm-06) — a REVDOWNMARK reviewer is down for good.
      if (d.includes("rigorous reviewer for THIS task")) {
        if (d.includes("REVDOWNMARK")) { seen("REVDOWNMARK"); return failWith(502, "ResourceExhausted: reviewer quota burned"); }
        return say("```review\n" + JSON.stringify({ criteria: [], overall: "pass", note: "fine" }) + "\n```");
      }
      if (d.includes("PLAN DECISIONS:")) return say("NOT_COVERED");
      // The mission planner: a stable 2-step task block.
      if (d.includes("Reply in exactly this form"))
        return say("Thinking through it.\n\n```tasks\n[{\"title\": \"retry alpha step\"}, {\"title\": \"retry beta step\"}]\n```");
      // finish_reason=length ONCE for the LENGTHMARK objective, then it recovers — the
      // double-budget retry path (it must NOT be transient-retried at the same budget).
      if (d.includes("LENGTHMARK") && seen("LENGTHMARK") === 1)
        return say("", { finish_reason: "length" });
      const mine = partOf(d);
      // A HANGMARK worker never answers in time — the client's (tiny) timeout fires.
      if (mine.includes("HANGMARK")) { seen("HANGMARK"); return setTimeout(() => { try { res.destroy(); } catch {} }, 3000); }
      if (mine.includes("FLAKY502MARK")) { const n = seen("FLAKY502MARK"); if (n <= 2) return failWith(502, "ResourceExhausted: free-tier quota exhausted, retry later"); }
      if (mine.includes("DEAD502MARK")) { seen("DEAD502MARK"); return failWith(502, "ResourceExhausted: free-tier quota exhausted, retry later"); }
      if (mine.includes("AUTH401MARK")) { seen("AUTH401MARK"); return failWith(401, "invalid api key"); }
      if (mine.includes("RATE429MARK")) { const n = seen("RATE429MARK"); if (n === 1) return failWith(429, "rate limit reached"); }
      if (mine.includes("EMPTYMARK")) { const n = seen("EMPTYMARK"); if (n <= 2) return say(""); }
      return say(WORKER_OUT);
    });
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  srv = spawn(process.execPath, [join(HERE, "web-server.mjs")],
    { env: { ...process.env, BO_CE_DATA: dir, BO_CE_WEB_PORT: String(PORT),
      BO_CE_FREE_ENDPOINT: `http://127.0.0.1:${stub.address().port}/v1/chat/completions`,
      BO_CE_STAGE_RETRY_BACKOFF_MS: "0,0",      // the injected instant clock — backoff sleeps are 0ms
      BO_OPENCODE_BIN: "/nonexistent-opencode" }, stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    try { await fetch(`${BASE}/api/state`); break; } catch { await new Promise((r) => setTimeout(r, 250)); if (i === 59) throw new Error("server did not start"); }
  }
  await post("/api/onboard", { companyName: "Retry Co", companyDoes: "tests", departments: ["technical"] });
  const st0 = await state();
  for (const slot of Object.keys(st0.assignments || {})) await post("/api/assign", { slot, connectionId: null });
  const cf = await post("/api/connect-free", {});
  assert.equal(cf.status, 200, JSON.stringify(cf.body).slice(0, 300));
});
after(() => { srv?.kill(); stub?.close(); rmSync(dir, { recursive: true, force: true }); });

const post = (path, body) => fetch(`${BASE}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json().then((j) => ({ status: r.status, body: j })));
const state = () => fetch(`${BASE}/api/state`).then((r) => r.json());
const until = async (fn, ms = 45000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for async work");
    await new Promise((r) => setTimeout(r, 300));
  }
};
const taskOf = async (id) => (await state()).tasks.find((t) => t.id === id) || null;
const queueOf = async (pid) => (await state()).queues?.filter((q) => q.projectId === pid).at(-1) || null;

/** A validated → materialized plan; returns the created tasks in draft order. */
async function materialize(pid, taskDrafts, { decisions = "esm only, zero-dep" } = {}) {
  const created = await post("/api/plan/new", { objective: `plan for ${pid}`, projectId: pid, decisions, taskDrafts });
  assert.equal(created.status, 200, JSON.stringify(created.body).slice(0, 300));
  assert.equal((await post("/api/plan/validate", { id: created.body.plan.id })).status, 200);
  const done = await post("/api/plan/materialize", { id: created.body.plan.id });
  assert.equal(done.status, 200, JSON.stringify(done.body).slice(0, 300));
  return { plan: done.body.plan, tasks: done.body.tasks };
}

/** A plain manual task, launched on its own (single-worker shape — no planner, no reviewer). */
async function launchManual(title, extra = {}) {
  const t = await post("/api/task/new", { title });
  assert.equal(t.status, 200, JSON.stringify(t.body).slice(0, 300));
  const launch = await post("/api/task/launch", { id: t.body.task.id, ...extra });
  assert.equal(launch.status, 200, JSON.stringify(launch.body).slice(0, 300));
  assert.equal(launch.body.started, true);
  return t.body.task;
}

// ── 1 · transient 502 ×2 then success → task done, exactly 3 calls ────────────────────────────
test("worker 502, 502, success → task done, exactly 3 worker calls", async () => {
  const task = await launchManual("FLAKY502MARK flaky chore");
  const fin = await until(async () => {
    const t = await taskOf(task.id);
    return t?.status === "done" ? t : null;
  });
  assert.equal(fin.result.ok, true);
  assert.equal(workerCalls("FLAKY502MARK").length, 3, "1 initial attempt + 2 retries, then the success");
  assert.equal(counts.get("FLAKY502MARK"), 3);
});

// ── 2 · persistent 502 → blocked with the REAL error, queue paused, exactly 3 calls ───────────
test("persistent 502 → task blocked with the real provider error, queue paused, exactly 3 calls", async () => {
  const p = await post("/api/project", { name: "retry-queue-502" });
  const pid = p.body.project.id;
  const { tasks } = await materialize(pid, [
    { title: "DEAD502MARK doomed chore" },
    { title: "waiting follower chore" },
  ]);
  const [A, B] = tasks;
  assert.equal((await post("/api/queue/start", { projectId: pid })).status, 200);

  const blocked = await until(async () => {
    const t = await taskOf(A.id);
    return t?.status === "blocked" ? t : null;
  });
  assert.equal(blocked.result.ok, false);
  assert.match(blocked.result.summary, /failed \(502\): ResourceExhausted/,
    "the REAL provider error (status + message) is on the task — never 'no model configured'");
  assert.match(blocked.result.summary, /provider: OpenCode Zen/, "the provider is named");
  assert.doesNotMatch(blocked.result.summary, /no model configured/i);
  const mission = (await state()).missions.find((m) => m.id === blocked.missionId);
  assert.equal(mission.status, "approved", "the mission is relaunchable — never stuck running");
  assert.match(mission.lastError, /502/);

  const q = await until(async () => {
    const qq = await queueOf(pid);
    return qq?.status === "paused" ? qq : null;
  });
  assert.equal(q.kind, "failed");
  assert.equal(q.currentTaskId, A.id, "the queue points at the blocked task");
  assert.match(q.reason, /DEAD502MARK/, "the pause reason names the task");
  assert.equal((await taskOf(B.id)).status, "todo", "the follower never launched while paused");
  assert.equal(workerCalls("DEAD502MARK").length, 3, "bounded: 3 attempts, then the block");
});

// ── 3 · 401 → immediate block, exactly 1 call, no retry ───────────────────────────────────────
test("worker 401 → immediate block, exactly 1 call, no retry", async () => {
  const task = await launchManual("AUTH401MARK bad-key chore");
  const blocked = await until(async () => {
    const t = await taskOf(task.id);
    return t?.status === "blocked" ? t : null;
  });
  assert.equal(blocked.result.ok, false);
  assert.match(blocked.result.summary, /failed \(401\): invalid api key/, "the real 401 is on the task");
  assert.match(blocked.result.summary, /provider: OpenCode Zen/);
  assert.equal(workerCalls("AUTH401MARK").length, 1, "a permanent 4xx is NEVER retried");
});

// ── 4 · 429 → transient, retried ───────────────────────────────────────────────────────────────
test("worker 429 then success → retried (transient), task done, exactly 2 calls", async () => {
  const task = await launchManual("RATE429MARK rate-limited chore");
  const fin = await until(async () => {
    const t = await taskOf(task.id);
    return t?.status === "done" ? t : null;
  });
  assert.equal(fin.result.ok, true);
  assert.equal(workerCalls("RATE429MARK").length, 2, "429 is transient — retried, then the success");
});

// ── 5 · empty response ×2 then content → done; timeout → transient ────────────────────────────
test("empty response ×2 then content → task done, exactly 3 calls", async () => {
  const task = await launchManual("EMPTYMARK empty-answer chore");
  const fin = await until(async () => {
    const t = await taskOf(task.id);
    return t?.status === "done" ? t : null;
  });
  assert.equal(fin.result.ok, true);
  assert.equal(workerCalls("EMPTYMARK").length, 3, "an empty response is transient — retried twice");
});

test("timeout → transient: 3 attempts on the injected instant clock, then blocked honestly", async () => {
  const task = await launchManual("HANGMARK hanging chore", { timeoutMs: 500 });
  const blocked = await until(async () => {
    const t = await taskOf(task.id);
    return t?.status === "blocked" ? t : null;
  });
  assert.equal(blocked.result.ok, false);
  assert.match(blocked.result.summary, /timeout/i, "the real cause (timeout) is on the task");
  assert.match(blocked.result.summary, /provider: OpenCode Zen/);
  assert.equal(workerCalls("HANGMARK").length, 3, "each attempt timed out, bounded at 3");
  assert.equal(counts.get("HANGMARK"), 3);
});

// ── 6 · reviewer 502 persistent → blocked reviewer-unavailable, NOT a judged review ───────────
test("reviewer 502 persistent → blocked by:'reviewer-unavailable' with the real error — never deterministic", async () => {
  const p = await post("/api/project", { name: "retry-reviewer-down" });
  const pid = p.body.project.id;
  const { tasks } = await materialize(pid, [
    { title: "build the REVDOWNMARK page", acceptanceCriteria: ["the page exists as a real file"] },
  ]);
  const [T] = tasks;
  const launch = await post("/api/task/launch", { id: T.id });
  assert.equal(launch.status, 200, JSON.stringify(launch.body).slice(0, 300));

  const blocked = await until(async () => {
    const t = await taskOf(T.id);
    return t?.status === "blocked" && t.review ? t : null;
  });
  assert.equal(blocked.review.ok, false);
  assert.equal(blocked.review.by, "reviewer-unavailable",
    "a failed review is never confused with a judged review (by:'reviewer') or a missing model (by:'deterministic')");
  assert.match(blocked.review.note, /^reviewer unavailable — /);
  assert.match(blocked.review.note, /failed \(502\): ResourceExhausted/, "the note carries the REAL provider error");
  assert.match(blocked.review.note, /provider: OpenCode Zen/);
  assert.deepEqual(blocked.review.criteria, [], "no criterion verdicts — nothing was judged");
  assert.match(blocked.result.summary, /reviewer unavailable/, "the block reason is visible on the task detail");
  assert.doesNotMatch(blocked.result.summary, /unmet:/, "NOT a review-fail verdict");
  assert.equal(reviewerCalls("REVDOWNMARK").length, 3, "the reviewer stage retried transiently, then gave up");
  assert.equal(workerCalls("REVDOWNMARK").length, 1, "the worker itself succeeded in one call");
});

// ── 7 · finish_reason=length: NO transient retry; the double-budget retry still owns it ───────
test("finish_reason=length → exactly ONE normal-budget call, then the double-budget retry (unchanged)", async () => {
  const send = await post("/api/chat/send", { scope: "department", department: "technical", mode: "plan",
    text: "build the LENGTHMARK widget" });
  assert.equal(send.status, 200, JSON.stringify(send.body).slice(0, 300));
  const m = send.body.mission;
  assert.ok(m, "mission drafted");
  await post("/api/chat/mission", { missionId: m.id, action: "approve" });
  const launch = await post("/api/chat/launch", { missionId: m.id, timeoutMs: 30000 });
  assert.equal(launch.body.started, true);

  const conv = await until(async () => {
    const st = await state();
    const c = (st.conversations || []).find((x) => x.id === m.conversationId);
    return c?.messages?.at(-1)?.text?.includes("retry with a bigger output budget") ? c : null;
  });
  assert.match(conv.messages.at(-1).text, /retry with a bigger output budget/);
  await until(async () => (await state()).missions.find((x) => x.id === m.id)?.status === "done" || null);

  const lengthBodies = bodies.filter((d) => d.includes("LENGTHMARK"));
  const normal = lengthBodies.filter((d) => maxTokensOf(d) === 1500);
  const doubled = lengthBodies.filter((d) => maxTokensOf(d) === 3000);
  assert.equal(normal.length, 1, "the length error was NOT transient-retried at the same budget");
  assert.ok(doubled.length >= 1, "the dedicated double-budget retry ran");
  assert.equal(counts.get("LENGTHMARK"), lengthBodies.length, "every LENGTHMARK call accounted for");
});

// ── 8 · i18n parity (fr/de) + the shell renders the reviewer-unavailable label ────────────────
test("i18n parity fr/de: review.by.reviewer-unavailable in every locale; reviewLine renders it", async () => {
  const { LOCALES, missingKeys, CATALOG } = await import("./i18n.mjs");
  for (const loc of LOCALES) assert.deepEqual(missingKeys(loc), [], `${loc} is missing keys`);
  for (const loc of LOCALES)
    assert.ok(CATALOG[loc]["review.by.reviewer-unavailable"], `${loc} has review.by.reviewer-unavailable`);

  const { SHELL_PAGE } = await import("./shell.mjs");
  const start = SHELL_PAGE.indexOf("function reviewLine(");
  const end = SHELL_PAGE.indexOf("/** A finished run", start);
  assert.ok(start > 0 && end > start, "reviewLine found in the shell");
  const vm = await import("node:vm");
  for (const loc of LOCALES) {
    const sandbox = {
      t: (k) => CATALOG[loc][k] || k,
      esc: (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])),
    };
    vm.createContext(sandbox);
    vm.runInContext(SHELL_PAGE.slice(start, end), sandbox);
    const html = sandbox.reviewLine({ ok: false,
      note: "reviewer unavailable — model 'x' failed (502): ResourceExhausted", by: "reviewer-unavailable" });
    assert.ok(html.includes(CATALOG[loc]["review.by.reviewer-unavailable"]), `${loc}: the translated label renders`);
    assert.ok(html.includes(CATALOG[loc]["review.fail"]), `${loc}: the fail verdict renders`);
    assert.ok(!html.includes("review.by.reviewer-unavailable"), `${loc}: no raw key leaks`);
  }
});
