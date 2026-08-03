// SPDX-License-Identifier: Apache-2.0
// Crash recovery (task-pm-16): a process dying mid-run must never strand honest state.
//   BOOT RECONCILIATION (before listen): executions stuck "running" → failed ("process
//     restarted", finishedAt); missions stuck "running" → approved + recovery note
//     (relaunchable); tasks in-progress on a dead run → todo + recovery note (result/review/
//     qna/pendingQuestion preserved — a pendingQuestion task STAYS blocked); pending approvals
//     stay pending; a clean boot writes nothing (runtime.json byte-identical).
//   QUEUE AUTO-RESUME: a running queue whose current task died relaunches it ONCE via the
//     existing taskLaunch machinery — recoveryAttempts persisted per task; after 2 attempts the
//     queue pauses { kind: "recovery" } (never a crash-loop); paused queues stay paused.
//   MISSION RESUME: already-done subtasks keep their result and are never executed again
//     (proven by stub call counts).
// The heart of the file is a REAL kill: a server on a tmp BO_CE_DATA runs a 3-task queue with
// slow/hanging worker stubs; it is SIGKILLed while task 2 runs; a fresh server boots against
// the same directory. Real-server tmp-dir pattern as in runqueue.test.mjs.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOG, LOCALES, missingKeys } from "./i18n.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 4451;
const BASE = `http://127.0.0.1:${PORT}`;
let srv = null, dir, stub;

// Mutable stub behavior: while MODE.hang, any worker call for a HANG-titled task is held
// forever (the process dies holding it). flip MODE.hang = false to let recoveries answer.
const MODE = { hang: true };
const QUESTION = "Which deployment target should I use?";
const calls = [];
// The request body is one JSON line (newlines escaped as \n) — the title capture stops at the
// first escape backslash, so workerCalls can match EXACT titles.
const partOf = (d) => (d.match(/YOUR PART \(task \d+\/\d+\): ([^\\]*)/) || [])[1] || "";
const workerCalls = (title) => calls.filter((d) => partOf(d) === title).length;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "bo-recovery-"));
  const { createServer } = await import("node:http");
  stub = createServer((req, res) => {
    let d = ""; req.on("data", (c) => (d += c));
    req.on("end", () => {
      calls.push(d);
      const say = (content) => {
        try {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { content } }] }));
        } catch { /* the server was killed mid-answer — nothing to report to */ }
      };
      // A worker for a HANG-titled task never answers while MODE.hang — the SIGKILL test.
      if (MODE.hang && partOf(d).includes("HANG")) return;
      if (d.includes("PLAN DECISIONS:")) return say("NOT_COVERED");
      // A QMARK worker escalates ONE question — the task blocks pendingQuestion, queue pauses.
      if (partOf(d).includes("QMARK") && !d.includes("Previous questions and answers"))
        return say(`Some partial work happened first.\n\n\`\`\`question\n${QUESTION}\n\`\`\``);
      // The mission planner: a STABLE 2-step task block — the same titles on every plan, so a
      // relaunched mission must reconcile against the spine's existing children, not duplicate.
      if (d.includes("Reply in exactly this form"))
        return say("Thinking through it.\n\n```tasks\n[{\"title\": \"relaunch alpha step\"}, {\"title\": \"HANG relaunch beta step\"}]\n```");
      return say("ok — done. " + "Real work output follows: ".repeat(8));
    });
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  srv = await boot();
  await post("/api/onboard", { companyName: "Recovery Co", companyDoes: "tests", departments: ["technical"] });
  const st0 = await state();
  for (const slot of Object.keys(st0.assignments || {})) await post("/api/assign", { slot, connectionId: null });
  const cf = await post("/api/connect-free", {});
  assert.equal(cf.status, 200, JSON.stringify(cf.body).slice(0, 300));
});
after(() => { srv?.kill("SIGKILL"); stub?.close(); rmSync(dir, { recursive: true, force: true }); });

/** A fresh server process against the SAME store dir (waits until it serves). */
async function boot() {
  const s = spawn(process.execPath, [join(HERE, "web-server.mjs")],
    { env: { ...process.env, BO_CE_DATA: dir, BO_CE_WEB_PORT: String(PORT),
      BO_CE_FREE_ENDPOINT: `http://127.0.0.1:${stub.address().port}/v1/chat/completions`,
      BO_OPENCODE_BIN: "/nonexistent-opencode" }, stdio: "ignore" });
  for (let i = 0; i < 80; i++) {
    try { await fetch(`${BASE}/api/state`); return s; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error("server did not start");
}

/** SIGKILL the running server mid-work and wait for the process to die. */
async function killServer() {
  if (!srv) return;
  srv.kill("SIGKILL");
  await new Promise((r) => srv.on("exit", r));
  await new Promise((r) => setTimeout(r, 300));   // let the OS release the port
  srv = null;
}

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
const queueOf = async (pid) => (await state()).queues?.filter((q) => q.projectId === pid).at(-1) || null;
const taskOf = async (id) => (await state()).tasks.find((t) => t.id === id) || null;

/** A validated → materialized plan; returns the created tasks in draft order. */
async function materialize(pid, taskDrafts, { decisions = "esm only, zero-dep" } = {}) {
  const created = await post("/api/plan/new", { objective: `plan for ${pid}`, projectId: pid, decisions, taskDrafts });
  assert.equal(created.status, 200, JSON.stringify(created.body).slice(0, 300));
  assert.equal((await post("/api/plan/validate", { id: created.body.plan.id })).status, 200);
  const done = await post("/api/plan/materialize", { id: created.body.plan.id });
  assert.equal(done.status, 200, JSON.stringify(done.body).slice(0, 300));
  return { plan: done.body.plan, tasks: done.body.tasks };
}

// ── 1 · boot reconciliation: dead run failed/reset, mission relaunchable, nothing "running" ────
test("boot reconciliation: killed execution failed, task back to todo + note, mission approved and relaunchable", async () => {
  const p = await post("/api/project", { name: "recovery-direct" });
  const pid = p.body.project.id;
  const { tasks } = await materialize(pid, [{ title: "HANG direct task" }]);
  const [task] = tasks;
  const launched = await post("/api/task/launch", { id: task.id });
  assert.equal(launched.status, 200, JSON.stringify(launched.body).slice(0, 300));
  const exec = launched.body.execution;
  const missionId = launched.body.mission.id;
  await until(async () => (await taskOf(task.id)).status === "in-progress");
  await until(async () => workerCalls("HANG direct task") === 1);   // the worker is hung now
  await killServer();

  MODE.hang = false;                                   // a later relaunch may complete
  srv = await boot();
  const st = await state();
  // The killed execution is failed with the restart reason + finishedAt — never "running".
  const killed = st.executions.find((e) => e.id === exec.id);
  assert.equal(killed.status, "failed");
  assert.equal(killed.error, "process restarted");
  assert.ok(killed.finishedAt, "finishedAt stamped");
  // The mission is approved again + a recovery note — relaunchable, not stranded.
  const m = st.missions.find((x) => x.id === missionId);
  assert.equal(m.status, "approved");
  assert.match(m.lastError || "", /Process restarted mid-run/);
  assert.ok(m.recoveredAt);
  // The task is back to todo, note appended; nothing else touched.
  const t = await taskOf(task.id);
  assert.equal(t.status, "todo");
  assert.equal(t.recoveryNotes.length, 1);
  assert.match(t.recoveryNotes[0].note, /Process restarted mid-run/);
  // Runtime state fully honest: NOTHING running anywhere.
  assert.equal(st.executions.filter((e) => e.status === "running").length, 0);
  assert.equal(st.missions.filter((x) => x.status === "running").length, 0);
  // No queue exists for this project → no auto-resume: the task stays todo.
  assert.equal(workerCalls("HANG direct task"), 1);
  // Relaunchable: the approved mission path launches again through the same machinery.
  const relaunched = await post("/api/task/launch", { id: task.id });
  assert.equal(relaunched.status, 200, JSON.stringify(relaunched.body).slice(0, 300));
  await until(async () => (await taskOf(task.id)).status === "done");
  assert.equal(workerCalls("HANG direct task"), 2);   // exactly one new run, not more
});

// ── 2 · kill mid-queue: auto-resume once, queue to done, done task never re-run ───────────────
test("kill mid-run: queue auto-resumes task 2 exactly once, continues to done, task 1 never re-runs", async () => {
  MODE.hang = true;                                    // task 2's first run hangs (the kill window)
  const p = await post("/api/project", { name: "recovery-queue" });
  const pid = p.body.project.id;
  const { tasks } = await materialize(pid, [
    { title: "resume alpha task" },
    { title: "HANG resume beta task" },
    { title: "resume gamma task" },
  ]);
  const [t1, t2, t3] = tasks;
  const started = await post("/api/queue/start", { projectId: pid });
  assert.equal(started.status, 200, JSON.stringify(started.body).slice(0, 300));
  // Task 1 completes; task 2 launches and its worker hangs — the kill window.
  await until(async () => (await taskOf(t2.id)).status === "in-progress");
  await until(async () => workerCalls("HANG resume beta task") === 1);
  const q0 = await queueOf(pid);
  assert.equal(q0.currentTaskId, t2.id);
  assert.deepEqual(q0.completedTaskIds, [t1.id]);
  assert.equal(workerCalls("resume alpha task"), 1);
  const runningExec = (await state()).executions.find((e) => e.status === "running");
  assert.ok(runningExec);
  await killServer();

  MODE.hang = false;                                   // the recovery relaunch may complete
  srv = await boot();
  // The queue recovers task 2 and runs to done.
  await until(async () => (await queueOf(pid))?.status === "done");
  // Boot reconciliation failed the killed execution honestly (never left "running").
  const killed = (await state()).executions.find((e) => e.id === runningExec.id);
  assert.equal(killed.status, "failed");
  assert.equal(killed.error, "process restarted");
  assert.ok(killed.finishedAt);
  // The recovery went through the bounded path: exactly ONE recovery attempt for task 2.
  const q = await queueOf(pid);
  assert.equal(q.recoveryAttempts?.[t2.id], 1);
  // Stub call counts: task 2 relaunched EXACTLY once (2 total), task 1 NEVER re-run, task 3 ran.
  assert.equal(workerCalls("HANG resume beta task"), 2, "task 2 relaunched exactly once");
  assert.equal(workerCalls("resume alpha task"), 1, "task 1 was done — never re-run");
  assert.equal(workerCalls("resume gamma task"), 1);
  // Every task done; nothing running.
  const st = await state();
  for (const id of [t1.id, t2.id, t3.id]) assert.equal(st.tasks.find((t) => t.id === id).status, "done");
  assert.equal(st.executions.filter((e) => e.status === "running").length, 0);
  assert.equal(st.missions.filter((x) => x.status === "running").length, 0);
});

// ── 3 · mission relaunch: done subtasks never re-execute; the dead one re-runs under its id ────
// The reviewer's P6: kill mid-subtask-2 of a DECOMPOSED mission, reboot, relaunch via
// /api/chat/launch — the relaunch re-plans, but the decomposition reconciles planned steps
// against the spine's existing children by title: done keeps its record (skipped), the
// interrupted one re-runs under its ORIGINAL id, no duplicate records ever.
test("mission relaunch: done subtask not re-executed, interrupted subtask re-runs under its original id", async () => {
  MODE.hang = true;
  const p = await post("/api/project", { name: "recovery-relaunch" });
  const pid = p.body.project.id;
  // A project mission whose planner decomposes the objective into REAL spine subtasks.
  const send = await post("/api/chat/send", { scope: "department", department: "technical", mode: "ask",
    text: "build me a platform for the relaunch customer portal", projectId: pid });
  assert.equal(send.status, 200, JSON.stringify(send.body).slice(0, 300));
  const m = send.body.mission;
  assert.ok(m, "mission drafted");
  assert.equal((await post("/api/chat/mission", { missionId: m.id, action: "approve" })).status, 200);
  const launch = await post("/api/chat/launch", { missionId: m.id, timeoutMs: 30000 });
  assert.equal(launch.body.started, true, JSON.stringify(launch.body).slice(0, 300));
  const childrenOf = async () => (await state()).tasks.filter((t) => t.parentId && t.projectId === pid);
  const spineOf = async () => (await state()).tasks.find((t) => t.projectId === pid && !t.parentId && t.missionId === m.id) || null;
  // Subtask 1 completes; subtask 2's worker hangs — kill mid-subtask-2.
  await until(async () => {
    const ch = await childrenOf();
    return ch.find((t) => t.title === "relaunch alpha step")?.status === "done"
      && ch.find((t) => t.title === "HANG relaunch beta step")?.status === "in-progress";
  });
  await until(async () => workerCalls("relaunch alpha step") === 1 && workerCalls("HANG relaunch beta step") === 1);
  const alphaBefore = (await childrenOf()).find((t) => t.title === "relaunch alpha step");
  const betaBefore = (await childrenOf()).find((t) => t.title === "HANG relaunch beta step");
  await killServer();

  MODE.hang = false;
  srv = await boot();
  // Boot reconciliation: the interrupted subtask is back to todo + note; the done one untouched.
  const betaBoot = (await childrenOf()).find((t) => t.title === "HANG relaunch beta step");
  assert.equal(betaBoot.status, "todo");
  assert.equal(betaBoot.recoveryNotes.length, 1);
  assert.equal((await childrenOf()).find((t) => t.title === "relaunch alpha step").status, "done");
  // Relaunch the (approved-again) mission through the existing endpoint.
  const relaunch = await post("/api/chat/launch", { missionId: m.id, timeoutMs: 30000 });
  assert.equal(relaunch.status, 200, JSON.stringify(relaunch.body).slice(0, 300));
  await until(async () => (await spineOf())?.status === "done");
  // The DONE subtask was NOT re-executed (stub count stays 1) — its result was kept.
  assert.equal(workerCalls("relaunch alpha step"), 1, "done subtask was re-executed — the defect");
  // The interrupted subtask re-ran EXACTLY once, under its ORIGINAL record — no duplicates.
  assert.equal(workerCalls("HANG relaunch beta step"), 2);
  const kids = await childrenOf();
  assert.equal(kids.filter((t) => t.title === "relaunch alpha step").length, 1, "duplicate spine records");
  assert.equal(kids.filter((t) => t.title === "HANG relaunch beta step").length, 1, "duplicate spine records");
  assert.equal(kids.find((t) => t.title === "relaunch alpha step").id, alphaBefore.id);
  assert.equal(kids.find((t) => t.title === "HANG relaunch beta step").id, betaBefore.id);
  // The whole spine completes; nothing running anywhere.
  for (const t of kids) assert.equal(t.status, "done");
  const st = await state();
  assert.equal(st.executions.filter((e) => e.status === "running").length, 0);
  assert.equal(st.missions.filter((x) => x.status === "running").length, 0);
});

// ── 4 · crash-loop cap: 2 recovery attempts → paused kind recovery, a 3rd never happens ───────
test("crash-loop cap: worker always hangs → 2 recovery attempts → queue paused kind recovery", async () => {
  MODE.hang = true;                                    // every launch hangs from here on
  const p = await post("/api/project", { name: "recovery-loop" });
  const pid = p.body.project.id;
  const { tasks } = await materialize(pid, [{ title: "HANG loopy task" }]);
  const [task] = tasks;
  assert.equal((await post("/api/queue/start", { projectId: pid })).status, 200);
  await until(async () => workerCalls("HANG loopy task") === 1);   // initial launch (hangs)
  await killServer();

  srv = await boot();                                  // recovery attempt 1
  await until(async () => workerCalls("HANG loopy task") === 2);
  assert.equal((await queueOf(pid)).recoveryAttempts?.[task.id], 1);
  await killServer();

  srv = await boot();                                  // recovery attempt 2
  await until(async () => workerCalls("HANG loopy task") === 3);
  assert.equal((await queueOf(pid)).recoveryAttempts?.[task.id], 2);
  await killServer();

  srv = await boot();                                  // the cap: paused, no third relaunch
  const q = await until(async () => {
    const x = await queueOf(pid);
    return x?.status === "paused" ? x : null;
  });
  assert.equal(q.kind, "recovery");
  assert.match(q.reason, /HANG loopy task/);           // names the task
  assert.match(q.reason, /\b2\b/);                     // and the attempts
  assert.equal(q.recoveryAttempts?.[task.id], 2);
  await new Promise((r) => setTimeout(r, 2000));       // settle: a third attempt NEVER happens
  assert.equal(workerCalls("HANG loopy task"), 3, "1 initial launch + exactly 2 recovery attempts");
});

// ── 5 · a paused queue (pending question) stays paused across a restart ───────────────────────
test("paused queue stays paused; the pendingQuestion task stays blocked awaiting its answer", async () => {
  MODE.hang = false;
  const p = await post("/api/project", { name: "recovery-question" });
  const pid = p.body.project.id;
  const { tasks } = await materialize(pid, [{ title: "QMARK recovery task" }]);
  const [task] = tasks;
  assert.equal((await post("/api/queue/start", { projectId: pid })).status, 200);
  const q0 = await until(async () => {
    const x = await queueOf(pid);
    return x?.status === "paused" ? x : null;
  });
  assert.equal(q0.kind, "question");
  const blocked = await taskOf(task.id);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.pendingQuestion.question, QUESTION);
  const callsBefore = workerCalls("QMARK recovery task");
  const reasonBefore = q0.reason;
  await killServer();

  srv = await boot();
  const q = await queueOf(pid);
  assert.equal(q.status, "paused", "paused stays paused — never auto-resumed");
  assert.equal(q.kind, "question");
  assert.equal(q.reason, reasonBefore);
  assert.equal(q.recoveryAttempts, undefined, "no recovery touches a paused queue");
  const t = await taskOf(task.id);
  assert.equal(t.status, "blocked", "STAYS blocked awaiting its answer");
  assert.equal(t.pendingQuestion.question, QUESTION);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(workerCalls("QMARK recovery task"), callsBefore, "no relaunch across the restart");
});

// ── 6 · clean boot: nothing running → runtime.json BYTE-IDENTICAL ─────────────────────────────
test("clean boot: a store with no running work is left byte-identical", async () => {
  // Test 4's boot settled into: executions done/failed, missions done/approved, queues paused/
  // done — NOTHING running. That is exactly the clean-boot case.
  const st = await state();
  assert.equal(st.executions.filter((e) => e.status === "running").length, 0);
  assert.equal(st.missions.filter((m) => m.status === "running").length, 0);
  const before = readFileSync(join(dir, "runtime.json"), "utf8");
  await killServer();
  srv = await boot();
  await state();                                       // fully up, reconciled, queues considered
  const afterBytes = readFileSync(join(dir, "runtime.json"), "utf8");
  assert.equal(afterBytes, before, "clean boot must not write runtime.json at all");
});

// ── 7 · i18n parity: every new user-visible string in en/fr/de ────────────────────────────────
test("i18n parity: recovery keys exist in en/fr/de and catalogs stay complete", () => {
  const keys = ["queue.kind.recovery", "recovery.processRestarted", "recovery.missionNote",
    "recovery.taskNote", "recovery.queuePause"];
  for (const k of keys) for (const loc of LOCALES) {
    assert.ok(CATALOG[loc][k], `${k} missing in ${loc}`);
    assert.notEqual(CATALOG[loc][k], k);
  }
  assert.equal(CATALOG.en["recovery.processRestarted"], "process restarted");
  assert.deepEqual(missingKeys("fr"), []);
  assert.deepEqual(missingKeys("de"), []);
});
