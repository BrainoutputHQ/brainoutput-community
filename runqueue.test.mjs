// SPDX-License-Identifier: Apache-2.0
// Run queue (task-pm-13): a deterministic, sequential per-project queue — POST /api/queue/start
// seeds launchable top-level tasks dependency-first and launches ONE at a time through the
// existing taskLaunch machinery; done → auto-advance; review-blocked / pendingQuestion → paused
// {kind, reason, taskId}; skip / relaunch / owner-answer resumes; pause (finish current) and
// stop (+ marked stopped); start on stopped/done reseeds from still-open tasks; start while
// running → 409. Plus: the launch-all + task-status chat intents (zero model, routed BEFORE
// plan drafting — the "list the tasks got a PLAN" regression is PINNED), the running working-dots
// (sidebar task / board card / project row), the queue card, and the run-card logs-toggle fix.
// Real-server tmp-dir pattern with a stubbed model endpoint (same as tasklaunch.test.mjs);
// component tests render the real SHELL_PAGE blocks in a vm (same as projheader.test.mjs).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { SHELL_PAGE } from "./shell.mjs";
import { CATALOG, LOCALES, missingKeys } from "./i18n.mjs";
import { looksLikeLaunchAll, looksLikeTaskStatus, looksLikeWork, looksLikeOccupancy } from "./chat.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 4431;
const BASE = `http://127.0.0.1:${PORT}`;
let srv, dir, stub;

const AC1 = "the page exists as a real file";
const QUESTION = "Which deployment target should I use?";
// Mutable stub behavior: rev = reviewer verdict; auto = planner auto-answer mode.
const MODE = { rev: "pass", auto: "not_covered" };
const bodies = [];
const promptOf = (d) => { try { return JSON.parse(d).messages?.[0]?.content || ""; } catch { return ""; } };
const criteriaFrom = (p) => {
  const sec = p.split("ACCEPTANCE CRITERIA")[1] || "";
  return sec.split("\n").map((l) => l.match(/^\d+\. (.+)$/)).filter(Boolean).map((m) => m[1]);
};
const reviewJson = (p, mode) => {
  const entries = criteriaFrom(p).map((c, i) => ({ criterion: c,
    verdict: mode === "fail" && i === 0 ? "fail" : "pass",
    evidence: mode === "fail" && i === 0 ? "nothing proves this" : `the result states it: ${c}` }));
  return "```review\n" + JSON.stringify({ criteria: entries,
    overall: entries.some((e) => e.verdict === "fail") ? "fail" : "pass",
    note: mode === "fail" ? "one criterion lacks evidence" : "every criterion is evidenced" }) + "\n```";
};

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "bo-runqueue-"));
  const { createServer } = await import("node:http");
  stub = createServer((req, res) => {
    let d = ""; req.on("data", (c) => (d += c));
    req.on("end", () => {
      bodies.push(d);
      res.writeHead(200, { "Content-Type": "application/json" });
      const say = (content) => res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      const answer = () => {
        if (d.includes("rigorous reviewer for THIS task")) return say(reviewJson(promptOf(d), MODE.rev));
        if (d.includes("PLAN DECISIONS:")) return say(MODE.auto === "answer" ? "ESM only — the decisions settle it." : "NOT_COVERED");
        // Markers bind to THIS worker's part only — the project brief lists sibling task titles
        // in every prompt, so a bare includes() would leak the behavior to the whole queue.
        const mine = (d.match(/YOUR PART \(task \d+\/\d+\): ([^\n]*)/) || [])[1] || "";
        // A QMARK worker escalates ONE question — once (the resume carries the qna section).
        if (mine.includes("QMARK") && !d.includes("Previous questions and answers"))
          return say(`Some partial work happened first.\n\n\`\`\`question\n${QUESTION}\n\`\`\``);
        return say("ok — done. " + "Real work output follows: ".repeat(8));
      };
      // A SLOWMARK worker holds its answer — the launch window stays measurably open.
      const mineSlow = (d.match(/YOUR PART \(task \d+\/\d+\): ([^\n]*)/) || [])[1] || "";
      if (mineSlow.includes("SLOWMARK")) return setTimeout(answer, 1800);
      answer();
    });
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  srv = spawn(process.execPath, [join(HERE, "web-server.mjs")],
    { env: { ...process.env, BO_CE_DATA: dir, BO_CE_WEB_PORT: String(PORT),
      BO_CE_FREE_ENDPOINT: `http://127.0.0.1:${stub.address().port}/v1/chat/completions`,
      BO_OPENCODE_BIN: "/nonexistent-opencode" }, stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    try { await fetch(`${BASE}/api/state`); break; } catch { await new Promise((r) => setTimeout(r, 250)); if (i === 59) throw new Error("server did not start"); }
  }
  await post("/api/onboard", { companyName: "Queue Co", companyDoes: "tests", departments: ["technical"] });
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

// ── 1 · queue e2e: dependency-first, ONE at a time, auto-advance, queue done ──────────────────
test("queue e2e: B waits on A despite being listed; one task runs at any moment; auto-advance to done", async () => {
  const p = await post("/api/project", { name: "queue-e2e" });
  const pid = p.body.project.id;
  const { tasks } = await materialize(pid, [
    { title: "SLOWMARK queue alpha step" },
    { title: "queue beta step", dependsOn: [0] },
    { title: "queue gamma step" },
  ]);
  const [A, B, C] = tasks;

  const start = await post("/api/queue/start", { projectId: pid });
  assert.equal(start.status, 200, JSON.stringify(start.body).slice(0, 300));
  const q0 = start.body.queue;
  assert.equal(q0.status, "running");
  assert.deepEqual(q0.taskIds, [A.id, B.id, C.id], "seeded dependency-first: A before its dependent B");
  assert.equal(q0.currentTaskId, A.id, "A runs first");

  // Starting while running → 409.
  const again = await post("/api/queue/start", { projectId: pid });
  assert.equal(again.status, 409);
  assert.match(again.body.error, /already has a running queue/);

  // DURING A's (slow) run: B is listed but still waits; exactly ONE execution runs at any poll.
  let maxRunning = 0;
  const win = await until(async () => {
    const st = await state();
    const running = st.executions.filter((e) => e.status === "running");
    maxRunning = Math.max(maxRunning, running.length);
    const tB = st.tasks.find((t) => t.id === B.id);
    const tC = st.tasks.find((t) => t.id === C.id);
    if (running.length === 1 && running[0].missionId === (st.tasks.find((t) => t.id === A.id) || {}).missionId
      && tB.status === "todo" && tC.status === "todo") return true;
    return (await taskOf(A.id))?.status === "done" ? true : null;
  }, 15000);
  assert.ok(win, "during A's run B and C waited (dependency-first, one at a time)");
  assert.equal(maxRunning, 1, "never more than ONE running execution");

  // Auto-advance to the end: every task done, the queue done with a full completion record.
  const qf = await until(async () => {
    const q = await queueOf(pid);
    return q?.status === "done" ? q : null;
  });
  assert.deepEqual(qf.completedTaskIds, [A.id, B.id, C.id], "completion order is the seed order");
  assert.equal(qf.currentTaskId, null);
  for (const t of [A, B, C]) assert.equal((await taskOf(t.id)).status, "done");

  // Sequential by the clock too: the next execution starts only after the previous one finished.
  const st = await state();
  const execOf = (t) => st.executions.find((e) => e.missionId === (st.tasks.find((x) => x.id === t.id) || {}).missionId);
  assert.ok(execOf(A).finishedAt <= execOf(B).createdAt, "B started only after A finished");
  assert.ok(execOf(B).finishedAt <= execOf(C).createdAt, "C started only after B finished");
  // …and re-seeding a DONE queue finds nothing open (fresh queue, zero tasks).
  const re = await post("/api/queue/start", { projectId: pid });
  assert.equal(re.status, 200);
  assert.equal(re.body.queue.taskIds.length, 0, "no open tasks → empty reseed");
  await until(async () => (await queueOf(pid))?.status === "done" || null);
});

// ── 2 · review-blocked → paused naming the task; skip continues; relaunch continues ────────────
test("review-blocked pauses the queue naming the task; /api/queue/skip continues it", async () => {
  MODE.rev = "fail";
  const p = await post("/api/project", { name: "queue-review-skip" });
  const pid = p.body.project.id;
  const { tasks } = await materialize(pid, [
    { title: "build the REVSKIPMARK page", acceptanceCriteria: [AC1] },
    { title: "follow-up chore" },
  ]);
  const [RB, F] = tasks;
  assert.equal((await post("/api/queue/start", { projectId: pid })).status, 200);

  const paused = await until(async () => {
    const q = await queueOf(pid);
    return q?.status === "paused" ? q : null;
  });
  assert.equal(paused.kind, "review-blocked");
  assert.equal(paused.currentTaskId, RB.id, "the queue points at the blocking task");
  assert.match(paused.reason, /REVSKIPMARK/, "the reason names the task");
  assert.equal((await taskOf(F.id)).status, "todo", "the follower never launched while paused");
  assert.equal((await taskOf(RB.id)).status, "blocked");

  // SKIP = the owner's decision: the queue continues with the next task.
  const skip = await post("/api/queue/skip", { taskId: RB.id });
  assert.equal(skip.status, 200, JSON.stringify(skip.body).slice(0, 300));
  assert.equal(skip.body.queue.status, "running");
  const qf = await until(async () => (await queueOf(pid))?.status === "done" ? await queueOf(pid) : null);
  assert.deepEqual(qf.skippedTaskIds, [RB.id]);
  assert.deepEqual(qf.completedTaskIds, [F.id]);
  assert.equal((await taskOf(F.id)).status, "done");
  assert.equal((await taskOf(RB.id)).status, "blocked", "a skipped task stays honestly blocked");
  MODE.rev = "pass";
});

test("review-blocked: RELAUNCHING the task (owner decision) continues the queue", async () => {
  MODE.rev = "fail";
  const p = await post("/api/project", { name: "queue-review-relaunch" });
  const pid = p.body.project.id;
  const { tasks } = await materialize(pid, [
    { title: "build the REVREMARK page", acceptanceCriteria: [AC1] },
    { title: "second chore" },
  ]);
  const [RB, F] = tasks;
  assert.equal((await post("/api/queue/start", { projectId: pid })).status, 200);
  await until(async () => (await queueOf(pid))?.status === "paused" || null);
  assert.equal((await queueOf(pid)).kind, "review-blocked");

  // The owner relaunches the SAME task (existing /api/task/launch) — the queue resumes and
  // continues when the fresh run completes.
  MODE.rev = "pass";
  const relaunch = await post("/api/task/launch", { id: RB.id });
  assert.equal(relaunch.status, 200, JSON.stringify(relaunch.body).slice(0, 300));
  const qf = await until(async () => (await queueOf(pid))?.status === "done" ? await queueOf(pid) : null);
  assert.deepEqual(qf.completedTaskIds.sort(), [RB.id, F.id].sort());
  assert.equal((await taskOf(RB.id)).status, "done", "the relaunched task passed review");
  assert.equal((await taskOf(RB.id)).missionId, relaunch.body.mission.id, "a fresh mission replaced the old one");
  assert.equal((await taskOf(F.id)).status, "done");
});

// ── 3 · pendingQuestion → paused; owner answer resumes → done → advance ───────────────────────
test("pendingQuestion pauses the queue; the owner answer resumes the task and the queue advances", async () => {
  MODE.auto = "not_covered";   // the plan's decisions do not settle it → the owner holds the question
  const p = await post("/api/project", { name: "queue-question" });
  const pid = p.body.project.id;
  const { tasks } = await materialize(pid, [
    { title: "QMARK queue chore with doubt" },
    { title: "queued follower" },
  ]);
  const [Q, F] = tasks;
  assert.equal((await post("/api/queue/start", { projectId: pid })).status, 200);

  const paused = await until(async () => (await queueOf(pid))?.status === "paused" ? await queueOf(pid) : null);
  assert.equal(paused.kind, "question");
  assert.equal(paused.currentTaskId, Q.id);
  const asked = await taskOf(Q.id);
  assert.equal(asked.pendingQuestion.question, QUESTION);
  assert.equal((await taskOf(F.id)).status, "todo", "the follower waits while the question is open");

  const ans = await post("/api/task/answer", { id: Q.id, answer: "Deploy to the staging target." });
  assert.equal(ans.status, 200, JSON.stringify(ans.body).slice(0, 300));
  assert.equal(ans.body.resumed, true, "the paused worker stage re-runs");
  const qf = await until(async () => (await queueOf(pid))?.status === "done" ? await queueOf(pid) : null);
  assert.deepEqual(qf.completedTaskIds.sort(), [Q.id, F.id].sort());
  assert.equal((await taskOf(Q.id)).status, "done");
  assert.equal((await taskOf(F.id)).status, "done");
});

// ── 4 · pause (finish current, launch nothing), stop, reseed, 409 ──────────────────────────────
test("pause finishes only the current task; stop marks stopped; start reseeds from open tasks", async () => {
  const p = await post("/api/project", { name: "queue-pause-stop" });
  const pid = p.body.project.id;
  const { tasks } = await materialize(pid, [
    { title: "SLOWMARK pause alpha" },
    { title: "SLOWMARK pause beta" },
    { title: "pause gamma" },
  ]);
  const [A, B, C] = tasks;
  assert.equal((await post("/api/queue/start", { projectId: pid })).status, 200);
  assert.equal((await post("/api/queue/start", { projectId: pid })).status, 409, "start while running → 409");

  // PAUSE: the current (slow) task finishes, nothing new launches.
  const pause = await post("/api/queue/pause", { projectId: pid });
  assert.equal(pause.status, 200, JSON.stringify(pause.body).slice(0, 300));
  assert.equal(pause.body.queue.status, "paused");
  assert.equal(pause.body.queue.kind, "owner");
  await until(async () => (await taskOf(A.id))?.status === "done" || null);
  const qp = await queueOf(pid);
  assert.equal(qp.status, "paused", "still paused after the current task finished");
  assert.deepEqual(qp.completedTaskIds, [A.id], "the finished task was recorded");
  assert.equal((await taskOf(B.id)).status, "todo", "nothing new launched while paused");
  assert.equal((await taskOf(C.id)).status, "todo");

  // RESUME via start; wait for B to be running, then STOP: B finishes, C never launches.
  const resume = await post("/api/queue/start", { projectId: pid });
  assert.equal(resume.status, 200);
  assert.equal(resume.body.queue.status, "running");
  await until(async () => (await taskOf(B.id))?.status === "in-progress" || null);
  const stop = await post("/api/queue/stop", { projectId: pid });
  assert.equal(stop.status, 200, JSON.stringify(stop.body).slice(0, 300));
  await until(async () => (await taskOf(B.id))?.status === "done" || null, 20000);
  const qs = (await state()).queues.filter((q) => q.projectId === pid).at(-1);
  assert.equal(qs.status, "stopped");
  assert.equal((await taskOf(C.id)).status, "todo", "a stopped queue launches nothing more");

  // START on stopped: a FRESH queue reseeded from the still-open tasks (C only).
  const re = await post("/api/queue/start", { projectId: pid });
  assert.equal(re.status, 200);
  assert.notEqual(re.body.queue.id, qs.id, "a fresh queue record");
  assert.deepEqual(re.body.queue.taskIds, [C.id], "reseeded from still-open tasks");
  await until(async () => (await queueOf(pid))?.status === "done" || null);
  assert.equal((await taskOf(C.id)).status, "done");
});

// ── 5 · chat intents: launch-all + status (zero model, gated BEFORE plan drafting) ─────────────
test("intent matchers: en/fr/de launch-all and status variants; work/occupancy untouched", () => {
  for (const s of ["launch all the tasks", "launch all tasks", "start all", "run everything",
    "lance toutes les tâches", "lance tout", "démarre tout", "starte alle Aufgaben", "starte alles"])
    assert.equal(looksLikeLaunchAll(s), true, s);
  for (const s of ["list the tasks", "list tasks", "where are we", "task status", "what's the status",
    "quelles sont les tâches", "liste les tâches", "où en est-on", "aufgabenliste", "status der aufgaben",
    "wo stehen wir", "list the tasks in the project"])
    assert.equal(looksLikeTaskStatus(s), true, s);
  // Negative space: a work request, a status-ish non-match, an occupancy question.
  for (const s of ["crée-moi un jeu snake", "build me a dashboard", "set up the portal end-to-end",
    "how many rooms are occupied today?", "what is the status of my refund claim with the supplier?"])
    assert.equal(looksLikeLaunchAll(s) || looksLikeTaskStatus(s), false, s);
  assert.equal(looksLikeWork("crée-moi un jeu snake"), true, "the work fast path matcher is untouched");
  assert.equal(looksLikeOccupancy("how many rooms are occupied today?"), true, "the occupancy matcher is untouched");
});

test("launch-all intent starts the thread's project queue (en/fr/de); no project → honest reply", async () => {
  const variants = ["launch all the tasks", "start all", "run everything",
    "lance toutes les tâches", "lance tout", "démarre tout", "starte alle Aufgaben", "starte alles"];
  for (const text of variants) {
    const p = await post("/api/project", { name: `intent-${variants.indexOf(text)}` });
    const pid = p.body.project.id;
    const t = await post("/api/task/new", { title: `chore for ${text}`, projectId: pid });
    assert.equal(t.status, 200);
    const send = await post("/api/chat/send", { scope: "company", mode: "ask", text, projectId: pid });
    assert.equal(send.status, 200, JSON.stringify(send.body).slice(0, 300));
    const reply = send.body.conversation.messages.at(-1).text;
    assert.match(reply, /Queue started/, `${text} → ${reply}`);
    assert.ok(reply.includes(`chore for ${text}`), "the reply names the running task");
    const q = await queueOf(pid);
    assert.equal(q.status, "running", `${text} started the queue`);
    assert.deepEqual(q.taskIds, [t.body.task.id]);
    await until(async () => (await queueOf(pid))?.status === "done" || null);
  }

  // Localized replies: the reply speaks the WORKSPACE locale, whatever the phrasing's language.
  await post("/api/settings", { locale: "fr" });
  const pf = await post("/api/project", { name: "intent-fr" });
  await post("/api/task/new", { title: "corvée", projectId: pf.body.project.id });
  const fr = await post("/api/chat/send", { scope: "company", mode: "ask", text: "lance tout", projectId: pf.body.project.id });
  assert.match(fr.body.conversation.messages.at(-1).text, /File lancée/, "French workspace → French answer");
  await until(async () => (await queueOf(pf.body.project.id))?.status === "done" || null);
  await post("/api/settings", { locale: "de" });
  const pd = await post("/api/project", { name: "intent-de" });
  await post("/api/task/new", { title: "Aufgabe", projectId: pd.body.project.id });
  const de = await post("/api/chat/send", { scope: "company", mode: "ask", text: "starte alles", projectId: pd.body.project.id });
  assert.match(de.body.conversation.messages.at(-1).text, /Warteschlange gestartet/, "German workspace → German answer");
  await until(async () => (await queueOf(pd.body.project.id))?.status === "done" || null);
  await post("/api/settings", { locale: "en" });

  // No project on the thread → an honest pointer, and NO queue, NO mission, NO plan.
  const before = await state();
  const none = await post("/api/chat/send", { scope: "company", mode: "ask", text: "launch all the tasks" });
  assert.equal(none.status, 200);
  assert.equal(none.body.conversation.messages.at(-1).text, CATALOG.en["chat.queueNoProject"]);
  const afterSt = await state();
  assert.equal(afterSt.queues.length, before.queues.length, "no queue created");
  assert.equal(afterSt.missions.length, before.missions.length, "no mission drafted");
});

test("status intent answers from the store: counts, running task, blockers, queue — en/fr/de", async () => {
  const p = await post("/api/project", { name: "status-proj" });
  const pid = p.body.project.id;
  const { tasks } = await materialize(pid, [
    { title: "status root step" },
    { title: "status child step", dependsOn: [0] },
  ]);
  const doneT = await post("/api/task/new", { title: "finished chore", projectId: pid });
  await post("/api/task/status", { id: doneT.body.task.id, status: "done" });

  for (const text of ["list the tasks", "where are we", "task status", "what's the status"]) {
    const send = await post("/api/chat/send", { scope: "company", mode: "ask", text, projectId: pid });
    assert.equal(send.status, 200, JSON.stringify(send.body).slice(0, 300));
    const reply = send.body.conversation.messages.at(-1).text;
    assert.ok(reply.includes("2 to do"), `${text} → counts (${reply})`);
    assert.ok(reply.includes("1 done"), "done count");
    assert.ok(reply.includes("Blocked: status child step"), "the blocked task is named");
    assert.ok(reply.includes("status root step"), "…with its blocker title");
    assert.equal(send.body.mission, null, "no mission drafted for a status ask");
  }

  // fr / de localized answers.
  await post("/api/settings", { locale: "fr" });
  const fr = await post("/api/chat/send", { scope: "company", mode: "ask", text: "quelles sont les tâches", projectId: pid });
  assert.ok(fr.body.conversation.messages.at(-1).text.includes("Tâches :"), "French counts");
  assert.ok(fr.body.conversation.messages.at(-1).text.includes("Bloquée : status child step"), "French blocked line");
  await post("/api/settings", { locale: "de" });
  const de = await post("/api/chat/send", { scope: "company", mode: "ask", text: "wo stehen wir", projectId: pid });
  assert.ok(de.body.conversation.messages.at(-1).text.includes("Aufgaben:"), "German counts");
  assert.ok(de.body.conversation.messages.at(-1).text.includes("Blockiert: status child step"), "German blocked line");
  await post("/api/settings", { locale: "en" });

  // The queue state shows when one is active — with the RUNNING task named.
  const sq = await post("/api/project", { name: "status-queue" });
  const sqid = sq.body.project.id;
  await post("/api/task/new", { title: "SLOWMARK status queued chore", projectId: sqid });
  assert.equal((await post("/api/queue/start", { projectId: sqid })).status, 200);
  const qs = await post("/api/chat/send", { scope: "company", mode: "ask", text: "what's the status", projectId: sqid });
  const qreply = qs.body.conversation.messages.at(-1).text;
  assert.ok(qreply.includes("Queue: running"), `the queue line (${qreply})`);
  assert.ok(qreply.includes("Running now: SLOWMARK status queued chore"), "the running task is named");
  await until(async () => (await queueOf(sqid))?.status === "done" || null);
});

test("PINNED: 'list the tasks in the project' never drafts a plan or a mission (any mode)", async () => {
  const p = await post("/api/project", { name: "status-pin" });
  const pid = p.body.project.id;
  await post("/api/task/new", { title: "pin chore", projectId: pid });
  for (const mode of ["ask", "plan"]) {
    const before = await state();
    const send = await post("/api/chat/send", { scope: "company", mode, text: "list the tasks in the project", projectId: pid });
    assert.equal(send.status, 200, JSON.stringify(send.body).slice(0, 300));
    const afterSt = await state();
    assert.equal(afterSt.plans.length, before.plans.length, `mode ${mode}: NO plan drafted`);
    assert.equal(afterSt.missions.length, before.missions.length, `mode ${mode}: NO mission drafted`);
    assert.ok(send.body.conversation.messages.at(-1).text.includes("Tasks:"), "the status answer came instead");
  }
});

test("untouched paths: snake still drafts a mission; occupancy still wins; no queue side-effects", async () => {
  const p = await post("/api/project", { name: "fast-path" });
  const pid = p.body.project.id;
  const snake = await post("/api/chat/send", { scope: "company", mode: "ask", text: "crée-moi un jeu snake", projectId: pid });
  assert.equal(snake.status, 200, JSON.stringify(snake.body).slice(0, 300));
  assert.ok(snake.body.mission?.id, "the ask-mode work fast path still drafts a mission");
  assert.equal(snake.body.mission.status, "draft");

  const before = await state();
  const occ = await post("/api/chat/send", { scope: "company", mode: "ask", text: "how many rooms are occupied today?" });
  assert.equal(occ.status, 200);
  assert.match(occ.body.conversation.messages.at(-1).text, /Lodgify/, "the occupancy intent answers (connect guidance, no key here)");
  const afterSt = await state();
  assert.equal(afterSt.queues.length, before.queues.length, "occupancy never starts a queue");
  assert.equal(afterSt.missions.length, before.missions.length, "occupancy never drafts a mission");
});

// ── component tests: indicators, queue card, the logs-toggle fix — real SHELL_PAGE blocks in a vm ──
const TL_START = SHELL_PAGE.indexOf("// ── task list helpers");
const TL_END = SHELL_PAGE.indexOf("/** A foldable settings section", TL_START);
const B_START = SHELL_PAGE.indexOf("// ── task board (task-pm-08)");
const B_END = SHELL_PAGE.indexOf("// Theme: LIGHT is the default", B_START);
const PC_START = SHELL_PAGE.indexOf("/** A durable Plan");
const D_START = SHELL_PAGE.indexOf("// ── task detail (task-pm-09)");
const PH = SHELL_PAGE.indexOf("// ── project header (task-pm-10)", D_START);
const PV_END = SHELL_PAGE.indexOf("// ── settings:", PH);
assert.ok(TL_START > 0 && TL_END > TL_START && B_START > 0 && B_END > B_START && PC_START > 0 && PH > D_START && PV_END > PH,
  "the shell blocks the tests render are present");
const BLOCKS = [
  SHELL_PAGE.slice(TL_START, TL_END),     // helpers: launchable, taskRunning, workDot, projectRow, issueRow…
  SHELL_PAGE.slice(B_START, B_END),       // the board (boardCard)
  SHELL_PAGE.slice(PC_START, D_START),    // the cards (runCard)
  SHELL_PAGE.slice(PH, PV_END),           // the project header (queueCard)
].join("\n");

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const mkStub = () => ({ open: false, children: [], value: "", textContent: "", style: {}, dataset: {},
  classList: { add() {}, remove() {}, toggle() {} }, appendChild(c) { this.children.push(c); return c; } });

function makeCtx(st = {}, locale = "en") {
  const calls = [];
  const sandbox = {
    t: (k) => CATALOG[locale][k] || CATALOG.en[k] || k,
    esc,
    S: { state: st },
    __renders: 0, __alerts: [],
    render() { sandbox.__renders++; },
    alert(m) { sandbox.__alerts.push(String(m)); },
    refresh: async () => {},
    api: async (p, body) => { calls.push([p, body]); return {}; },
    I: (n) => `<svg data-ic="${n}"></svg>`,
    el(h) {
      const node = { html: h, children: [], _qs: {}, value: "", textContent: "", style: {}, dataset: {},
        classList: { add() {}, remove() {}, toggle() {} },
        appendChild(c) { node.children.push(c); return c; },
        querySelector(sel) { return node._qs[sel] ||= mkStub(); },
        querySelectorAll() { return []; } };
      return node;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(BLOCKS + "\n;globalThis.__h={issueRow,boardCard,projectRow,queueCard,runCard,taskRunning,projectRunning};", sandbox);
  return { sandbox, h: sandbox.__h, calls };
}

test("indicators: sidebar task dot + board card dot + project dot, present exactly when running", () => {
  const tk = { id: "t1", title: "alpha", status: "in-progress", projectId: "p1", missionId: "m1", dependsOn: [], labels: [], priority: "none" };
  const live = { projects: [{ id: "p1", name: "Portal" }], tasks: [tk],
    missions: [{ id: "m1", status: "running", projectId: "p1" }],
    executions: [{ id: "e1", missionId: "m1", projectId: "p1", status: "running", graph: [], results: [], logs: [] }] };
  const { h } = makeCtx(live);
  assert.ok(h.issueRow(tk).html.includes('class="wdot"'), "the sidebar task row pulses while its execution runs");
  assert.ok(h.boardCard(live, tk, []).html.includes('class="wdot"'), "the board card pulses");
  assert.ok(h.projectRow(live, live.projects[0], 0, false).html.includes('sdot run'), "the project row is live");
  assert.equal(h.taskRunning(live, tk), true);
  assert.equal(h.projectRunning(live, "p1"), true);

  const idle = { ...live, missions: [{ id: "m1", status: "done", projectId: "p1" }], executions: [{ id: "e1", missionId: "m1", projectId: "p1", status: "done", graph: [], results: [], logs: [] }] };
  const hi = makeCtx(idle).h;
  assert.ok(!hi.issueRow(tk).html.includes("wdot"), "no dot when nothing runs");
  assert.ok(!hi.boardCard(idle, tk, []).html.includes("wdot"), "no board dot when nothing runs");
  assert.ok(!hi.projectRow(idle, idle.projects[0], 0, false).html.includes("sdot run"), "no project dot when nothing runs");
  assert.equal(hi.taskRunning(idle, tk), false);
});

test("queue card: progress, current task, state, controls, esc()'d blocked reason", async () => {
  const EVIL = '</div><img src=x onerror=alert(1)>';
  const tk = { id: "t1", title: `alpha ${EVIL}`, status: "blocked", projectId: "p1", missionId: null, dependsOn: [], labels: [] };
  const st = { projects: [{ id: "p1", name: "Portal" }], tasks: [tk], executions: [],
    queues: [{ id: "q1", projectId: "p1", taskIds: ["t1", "t2"], status: "paused", kind: "review-blocked",
      reason: `review-blocked: alpha ${EVIL}`, currentTaskId: "t1", completedTaskIds: [], skippedTaskIds: [], startedAt: 1, updatedAt: 1 }] };
  const { h, calls } = makeCtx(st);
  const d = h.queueCard(st, st.projects[0]);
  assert.ok(d.html.includes("id=queuecard"), "the card renders");
  assert.ok(d.html.includes("0/2"), "done/total progress");
  assert.ok(d.html.includes(CATALOG.en["queue.status.paused"]), "the state is localized");
  assert.ok(d.html.includes(CATALOG.en["queue.kind.review-blocked"]), "the blocked reason shows");
  assert.ok(!d.html.includes(EVIL), "the raw payload is NOT in the card");
  assert.ok(d.html.includes(esc(EVIL)), "the title shows escaped");
  const ctrl = d.querySelector("#qctrl");
  assert.equal(ctrl.children.length, 2, "paused → resume + stop");
  await ctrl.children[0].onclick();
  assert.deepEqual([calls.at(-1)[0], { ...calls.at(-1)[1] }], ["/api/queue/start", { projectId: "p1" }], "resume posts a start (resume semantics)");
  await ctrl.children[1].onclick();
  assert.deepEqual([calls.at(-1)[0], { ...calls.at(-1)[1] }], ["/api/queue/stop", { projectId: "p1" }], "stop posts a stop");

  // running → pause + stop; done → start (reseed); no queue → no card.
  const run = makeCtx({ ...st, queues: [{ ...st.queues[0], status: "running", kind: null }] });
  const rc = run.h.queueCard(run.sandbox.S.state, st.projects[0]);
  const rctrl = rc.querySelector("#qctrl");
  assert.equal(rctrl.children.length, 2);
  await rctrl.children[0].onclick();
  assert.deepEqual([run.calls.at(-1)[0], { ...run.calls.at(-1)[1] }], ["/api/queue/pause", { projectId: "p1" }], "running → pause first");
  const done = makeCtx({ ...st, queues: [{ ...st.queues[0], status: "done", kind: null, currentTaskId: null, completedTaskIds: ["t1", "t2"] }] });
  const dc = done.h.queueCard(done.sandbox.S.state, st.projects[0]);
  assert.ok(dc.html.includes("2/2"), "a finished queue shows full progress");
  await dc.querySelector("#qctrl").children[0].onclick();
  assert.deepEqual([done.calls.at(-1)[0], { ...done.calls.at(-1)[1] }], ["/api/queue/start", { projectId: "p1" }], "done → start reseeds");
  assert.equal(h.queueCard({ projects: [st.projects[0]] }, st.projects[0]), null, "no queue → no card, no empty chrome");
});

test("terminal button: the logs toggle survives the live re-render (the running-execution bug)", () => {
  const ex = { id: "ex1", status: "running", department: "technical",
    graph: [{ node: "worker-1", status: "pending" }], results: [], logs: ["planner: no usable task list — running as one task"] };
  const { h, sandbox } = makeCtx({ artifacts: [] });
  const d1 = h.runCard(ex);
  assert.ok(d1.html.includes("id=runlogs"), "the logs fold renders on a running execution");
  assert.ok(!d1.html.includes("<details open"), "closed by default");
  // THE CLICK PATH: the user opens the fold…
  const det = d1.querySelector("#runlogs");
  det.open = true;
  det.ontoggle();
  assert.equal(sandbox.S.openLogs.ex1, true, "the toggle is recorded (survives the 3s poll re-render)");
  // …the poll re-renders the card from scratch — and the fold is STILL open.
  const d2 = h.runCard(ex);
  assert.ok(d2.html.includes("<details open"), "the re-rendered card re-applies the open state (the bug is fixed)");
  // Closing is recorded the same way.
  const det2 = d2.querySelector("#runlogs");
  det2.open = false;
  det2.ontoggle();
  const d3 = h.runCard(ex);
  assert.ok(!d3.html.includes("<details open"), "a closed choice survives re-renders too");
  // The fold exists while running even with NO logs yet (it was missing entirely mid-run).
  const early = h.runCard({ ...ex, id: "ex2", logs: [] });
  assert.ok(early.html.includes("id=runlogs"), "running with no logs yet still shows the fold");
  const fin = h.runCard({ ...ex, id: "ex3", status: "done", logs: [] });
  assert.ok(!fin.html.includes("id=runlogs"), "a finished run with no logs shows no empty fold");
});

test("i18n parity (fr/de) for all new keys; the shell still parses", () => {
  for (const loc of LOCALES) assert.deepEqual(missingKeys(loc), [], `${loc} is missing keys`);
  const KEYS = ["chat.queueStarted", "chat.queueStartedEmpty", "chat.queueAlready", "chat.queueNoProject",
    "chat.statusAll", "chat.statusNone", "chat.statusCounts", "chat.statusRunning", "chat.statusBlocked", "chat.statusQueue",
    "queue.title", "queue.now", "queue.pause", "queue.resume", "queue.stop", "queue.start",
    "queue.status.running", "queue.status.paused", "queue.status.stopped", "queue.status.done",
    "queue.kind.owner", "queue.kind.question", "queue.kind.review-blocked", "queue.kind.failed", "queue.kind.stuck"];
  for (const loc of LOCALES) for (const k of KEYS)
    assert.ok(CATALOG[loc][k] && CATALOG[loc][k] !== k, `${loc}:${k} has a real translation`);
  const page = SHELL_PAGE.replace("__BO_I18N__", "{}").replaceAll("__BO_LOCALE__", "en").replace("__BO_CSRF__", "x");
  const js = page.split("<script>")[1].split("</scr" + "ipt>")[0];
  new vm.Script(js);   // parse guard
});
