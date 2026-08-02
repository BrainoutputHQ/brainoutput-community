// SPDX-License-Identifier: Apache-2.0
// Task launch (task-pm-11): a materialized/manual task launches on its own — POST /api/task/launch
// creates a mission bound to the task (objective + project from the record, single-worker shape,
// NEVER re-decomposed) and runs it through the existing chatLaunch machinery: the worker stage is
// bound by the task's directives and the per-task review flips it done. Fail-closed refusals:
// done / already running / pending question / open blocker → 4xx naming the cause; a
// review-blocked task relaunches with a fresh mission. Real-server tmp-dir pattern with a stubbed
// model endpoint (same as escalation.test.mjs).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 4413;
const BASE = `http://127.0.0.1:${PORT}`;
let srv, dir, stub;

const AC1 = "the landing page exists as a real file";
const AC2 = "the page names the company";
const QUESTION = "Which deployment target should I use?";
// Mutable stub behavior: rev = the reviewer's verdict mode (pass / fail the first criterion).
const MODE = { rev: "pass" };
const bodies = [];        // every completion request body, in order
const promptOf = (d) => { try { return JSON.parse(d).messages?.[0]?.content || ""; } catch { return ""; } };

/** Extract the numbered acceptance criteria the review prompt lists (verbatim round-trip). */
const criteriaFrom = (p) => {
  const sec = p.split("ACCEPTANCE CRITERIA")[1] || "";
  return sec.split("\n").map((l) => l.match(/^\d+\. (.+)$/)).filter(Boolean).map((m) => m[1]);
};
const reviewJson = (p, mode) => {
  const entries = criteriaFrom(p).map((c, i) => ({ criterion: c,
    verdict: mode === "fail" && i === 0 ? "fail" : "pass",
    evidence: mode === "fail" && i === 0 ? "nothing in the result or artifacts proves this" : `the result summary states it plainly: ${c}` }));
  return "```review\n" + JSON.stringify({ criteria: entries,
    overall: entries.some((e) => e.verdict === "fail") ? "fail" : "pass",
    note: mode === "fail" ? "one criterion lacks evidence" : "every criterion is evidenced in the worker report" }) + "\n```";
};

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "bo-tasklaunch-"));
  const { createServer } = await import("node:http");
  stub = createServer((req, res) => {
    let d = ""; req.on("data", (c) => (d += c));
    req.on("end", () => {
      bodies.push(d);
      res.writeHead(200, { "Content-Type": "application/json" });
      const say = (content) => res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      const answer = () => {
        // The bounded per-task REVIEW call (task-pm-06).
        if (d.includes("rigorous reviewer for THIS task")) return say(reviewJson(promptOf(d), MODE.rev));
        // A worker on a QMARK task escalates ONE question instead of guessing.
        if (d.includes("QMARK")) return say(`Some partial work happened first.\n\n\`\`\`question\n${QUESTION}\n\`\`\``);
        return say("ok — done. " + "Real work output follows: ".repeat(8));
      };
      // A SLOWMARK call holds its answer — the launch window stays measurably open.
      if (d.includes("SLOWMARK")) return setTimeout(answer, 1800);
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
  // Deterministic models: every slot (incl. the reviewer) → the stub free connection.
  await post("/api/onboard", { companyName: "Launch Co", companyDoes: "tests", departments: ["technical"] });
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
    await new Promise((r) => setTimeout(r, 400));
  }
};

/** A validated → materialized plan; returns the created tasks in draft order. */
async function materialize(pid, taskDrafts, { decisions = "esm only, zero-dep" } = {}) {
  const created = await post("/api/plan/new", { objective: `plan for ${pid}`, projectId: pid, decisions, taskDrafts });
  assert.equal(created.status, 200, JSON.stringify(created.body).slice(0, 300));
  assert.equal((await post("/api/plan/validate", { id: created.body.plan.id })).status, 200);
  const done = await post("/api/plan/materialize", { id: created.body.plan.id });
  assert.equal(done.status, 200, JSON.stringify(done.body).slice(0, 300));
  return { plan: done.body.plan, tasks: done.body.tasks };
}

test("launch a materialized task end to end: directives bind the worker, review flips it done", async () => {
  MODE.rev = "pass";
  const p = await post("/api/project", { name: "launch-e2e" });
  const pid = p.body.project.id;
  const { tasks } = await materialize(pid, [
    { title: "build the E2EMARK landing page", acceptanceCriteria: [AC1, AC2] },
    { title: "wire the contact form", dependsOn: [0] },
  ]);
  const [t1, t2] = tasks;
  const bodiesBefore = bodies.length;

  const launch = await post("/api/task/launch", { id: t1.id });
  assert.equal(launch.status, 200, JSON.stringify(launch.body).slice(0, 300));
  assert.equal(launch.body.started, true);
  const m = launch.body.mission;
  assert.equal(m.status, "running");
  assert.equal(m.objective, t1.objective, "the mission carries the task objective");
  assert.equal(m.projectId, pid, "the mission carries the task project");
  // LIVE STATE during the run: the execution record exists, running, from the response on.
  assert.equal(launch.body.execution.status, "running");
  assert.equal(launch.body.execution.missionId, m.id);

  // The task is linked from this moment (in-progress, mission id set).
  const linked = (await state()).tasks.find((t) => t.id === t1.id);
  assert.equal(linked.missionId, m.id);
  assert.equal(linked.status, "in-progress");

  // The run lands: the all-pass stub review flips the task done.
  const fin = await until(async () => {
    const t = (await state()).tasks.find((x) => x.id === t1.id);
    return t?.status === "done" && t.review ? t : null;
  });
  assert.equal(fin.review.ok, true);
  assert.equal(fin.review.by, "reviewer");
  assert.equal(fin.missionId, m.id);
  await until(async () => (await state()).missions.find((x) => x.id === m.id)?.status === "done" || null);

  // The worker was BOUND by the task record: exactly one worker stage, carrying the directives.
  const workerBodies = bodies.slice(bodiesBefore).filter((d) => d.includes("YOUR PART (task 1/1)"));
  assert.equal(workerBodies.length, 1, "single-worker shape — one worker stage");
  assert.ok(workerBodies[0].includes("TASK DIRECTIVES"), "the prompt carries the task directives");
  assert.ok(workerBodies[0].includes(AC1) && workerBodies[0].includes(AC2), "acceptance criteria verbatim");
  assert.ok(workerBodies[0].includes("esm only, zero-dep"), "the plan's DECISIONS are the shared context");
  // NEVER re-decomposed: no planner stage ran for this mission.
  assert.equal(bodies.slice(bodiesBefore).filter((d) => d.includes("You are the PLANNER")).length, 0,
    "a launched task is never re-planned");
  const exec = (await state()).executions.find((e) => e.id === launch.body.execution.id);
  assert.deepEqual((exec.graph || []).map((g) => g.node), ["worker-1"], "one spine worker entry");
  assert.equal(exec.status, "done");

  // The run is visible in a PROJECT thread (created here — the plan had no thread).
  const conv = (await state()).conversations.find((c) => c.id === m.conversationId);
  assert.ok(conv, "the mission reports into a conversation");
  assert.equal(conv.projectId, pid);
  assert.match(conv.messages.at(-1).text, /Mission complete/);

  // The dependent sibling task was NOT touched.
  const other = (await state()).tasks.find((t) => t.id === t2.id);
  assert.equal(other.status, "todo");
  assert.equal(other.missionId, null);
});

test("refusals are 4xx and name the cause: done / unknown / blocked-by / already-running / pending question", async () => {
  // Unknown task → 404.
  const ghost = await post("/api/task/launch", { id: "task-ghost" });
  assert.equal(ghost.status, 404);
  assert.match(ghost.body.error, /no task/);

  // Done → 409 "already done".
  const doneTask = await post("/api/task/new", { title: "finished chore" });
  await post("/api/task/status", { id: doneTask.body.task.id, status: "done" });
  const doneLaunch = await post("/api/task/launch", { id: doneTask.body.task.id });
  assert.equal(doneLaunch.status, 409);
  assert.match(doneLaunch.body.error, /already done/);

  // Open blocker → 409 naming the blocker.
  const p = await post("/api/project", { name: "launch-blocked" });
  const { tasks } = await materialize(p.body.project.id, [
    { title: "blocker OPENMARK step" },
    { title: "dependent step", dependsOn: [0] },
  ]);
  const depLaunch = await post("/api/task/launch", { id: tasks[1].id });
  assert.equal(depLaunch.status, 409);
  assert.match(depLaunch.body.error, /blocked by: blocker OPENMARK step/);
  const stillTodo = (await state()).tasks.find((t) => t.id === tasks[1].id);
  assert.equal(stillTodo.missionId, null, "a refused launch leaves the task untouched");

  // Already running → 409. The SLOWMARK worker holds the run open long enough to relaunch inside it.
  const slow = await post("/api/task/new", { title: "SLOWMARK long chore" });
  const first = await post("/api/task/launch", { id: slow.body.task.id });
  assert.equal(first.status, 200, JSON.stringify(first.body).slice(0, 300));
  const second = await post("/api/task/launch", { id: slow.body.task.id });
  assert.equal(second.status, 409);
  assert.match(second.body.error, /already running/);
  await until(async () => {
    const t = (await state()).tasks.find((x) => x.id === slow.body.task.id);
    return t?.status === "done" ? t : null;   // no acceptance criteria → the plain report path
  });

  // Pending question → 409 "answer the question first". The QMARK worker escalates; with no
  // plan behind the task there is nothing to auto-answer from — the owner holds the question.
  const q = await post("/api/task/new", { title: "QMARK chore with doubt" });
  assert.equal((await post("/api/task/launch", { id: q.body.task.id })).status, 200);
  const asked = await until(async () => {
    const t = (await state()).tasks.find((x) => x.id === q.body.task.id);
    return t?.pendingQuestion ? t : null;
  });
  assert.equal(asked.status, "blocked");
  assert.equal(asked.pendingQuestion.question, QUESTION);
  const qLaunch = await post("/api/task/launch", { id: q.body.task.id });
  assert.equal(qLaunch.status, 409);
  assert.match(qLaunch.body.error, /answer the question first/);
});

test("a review-blocked task relaunches: fresh mission, old missionId replaced, done after pass", async () => {
  const p = await post("/api/project", { name: "launch-relaunch" });
  const { tasks } = await materialize(p.body.project.id, [
    { title: "build the RELAUNCHMARK page", acceptanceCriteria: [AC1] },
  ]);
  const t1 = tasks[0];

  MODE.rev = "fail";
  const first = await post("/api/task/launch", { id: t1.id });
  assert.equal(first.status, 200, JSON.stringify(first.body).slice(0, 300));
  const blocked = await until(async () => {
    const t = (await state()).tasks.find((x) => x.id === t1.id);
    return t?.status === "blocked" && t.review ? t : null;
  });
  assert.equal(blocked.review.ok, false);
  assert.equal(blocked.missionId, first.body.mission.id);
  await until(async () => (await state()).missions.find((x) => x.id === first.body.mission.id)?.status === "done" || null);

  MODE.rev = "pass";
  const second = await post("/api/task/launch", { id: t1.id });
  assert.equal(second.status, 200, JSON.stringify(second.body).slice(0, 300));
  assert.notEqual(second.body.mission.id, first.body.mission.id, "a fresh mission, a fresh attempt");
  const fin = await until(async () => {
    const t = (await state()).tasks.find((x) => x.id === t1.id);
    return t?.status === "done" && t.review?.ok ? t : null;
  });
  assert.equal(fin.missionId, second.body.mission.id, "the old missionId is replaced");
});

test("i18n parity, the shell parse guard, and the Launch button wiring are pinned", async () => {
  const { LOCALES, missingKeys } = await import("./i18n.mjs");
  for (const loc of LOCALES) assert.deepEqual(missingKeys(loc), [], `${loc} is missing keys`);

  const { SHELL_PAGE } = await import("./shell.mjs");
  const vm = await import("node:vm");
  const page = SHELL_PAGE.replace("__BO_I18N__", "{}").replaceAll("__BO_LOCALE__", "en").replace("__BO_CSRF__", "x");
  const js = page.split("<script>")[1].split("</scr" + "ipt>")[0];
  new vm.Script(js);   // throws on a syntax error

  assert.ok(SHELL_PAGE.includes("task.launch"), "the Launch button is labeled from the catalog");
  assert.ok(SHELL_PAGE.includes("/api/task/launch"), "the button calls the launch endpoint");
  assert.ok(SHELL_PAGE.includes("launchable"), "the shown-exactly-when-launchable guard exists");
  const shell = await (await fetch(`${BASE}/`)).text();
  assert.match(shell, /task\.launch/);
});
