// SPDX-License-Identifier: Apache-2.0
// Worker escalation (task-pm-05): a per-task worker may pause with ONE fenced ```question block
// instead of guessing. The task flips to blocked with the question pending; the planner
// auto-answers ONLY what the plan's DECISIONS settle (one bounded call, prompt = decisions +
// question and nothing else, capped at 3 — the 4th always goes to the owner); the owner answers
// on the question card (POST /api/task/answer) and the paused worker stage re-runs with the Q&A.
// Real-server tmp-dir pattern with a stubbed model endpoint (same as shell.test.mjs).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 4391;
const BASE = `http://127.0.0.1:${PORT}`;
let srv, dir, stub;

const QUESTION = "Which module system must I use for the new files?";
const AUTO_ANSWER = "ESM only, zero-dep — the decisions settle it.";
const OWNER_ANSWER = "Use ESM everywhere — decided by the owner.";
// Mutable stub behavior per test: w1/w2 = worker question modes, auto = planner auto-answer mode.
const MODE = { w1: "never", w2: "never", auto: "answer" };
const bodies = [];        // every completion request body, in order
const promptOf = (d) => { try { return JSON.parse(d).messages?.[0]?.content || ""; } catch { return ""; } };
const autoBodies = () => bodies.filter((d) => d.includes("PLAN DECISIONS:"));
const w1Since = (n) => bodies.slice(n).filter((d) => d.includes("YOUR PART (task 1/"));

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "bo-escalation-"));
  const { createServer } = await import("node:http");
  stub = createServer((req, res) => {
    let d = ""; req.on("data", (c) => (d += c));
    req.on("end", () => {
      bodies.push(d);
      res.writeHead(200, { "Content-Type": "application/json" });
      const say = (content) => res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      // The bounded planner auto-answer call (prompt = decisions + question, nothing else).
      if (d.includes("PLAN DECISIONS:"))
        return say(MODE.auto === "answer" ? AUTO_ANSWER : "NOT_COVERED");
      // The mission planner (and the plan-draft pass): a usable 2-step task block.
      if (d.includes("Reply in exactly this form"))
        return say("Thinking through it.\n\n```tasks\n[{\"title\": \"alpha step one\"}, {\"title\": \"beta step two\"}]\n```");
      // Worker for task 1: asks per the current mode.
      if (d.includes("YOUR PART (task 1/")) {
        const alreadyAnswered = d.includes("Previous questions and answers");
        const ask = MODE.w1 === "always" || (MODE.w1 === "once" && !alreadyAnswered);
        if (ask) return say(`Some partial work happened first.\n\n\`\`\`question\n${QUESTION}\n\`\`\``);
      }
      // Worker for task 2: same modes.
      if (d.includes("YOUR PART (task 2/")) {
        const alreadyAnswered = d.includes("Previous questions and answers");
        const ask = MODE.w2 === "always" || (MODE.w2 === "once" && !alreadyAnswered);
        if (ask) return say(`Some partial work happened here too.\n\n\`\`\`question\n${QUESTION}\n\`\`\``);
      }
      return say("ok — done. " + "Real work output follows: ".repeat(8));
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
  // Deterministic models: every slot goes to the stub free connection (this machine may have
  // live local models — clear, then connect-free fills from the stub).
  await post("/api/onboard", { companyName: "Esc Co", companyDoes: "tests", departments: ["technical"] });
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
const task1Of = async (pid) => (await state()).tasks.find((t) => t.projectId === pid && t.parentId && t.title === "alpha step one") || null;

/** Onboard + connect the stub free model, then launch a 2-task project mission whose plan
 *  carries `decisions` (the plan the subtasks link to, via the mission's conversation). */
async function launchMission(marker, decisions) {
  const p = await post("/api/project", { name: `esc-${marker}` });
  const pid = p.body.project.id;
  const send = await post("/api/chat/send", { scope: "department", department: "technical", mode: "plan",
    text: `set up the ${marker} customer portal`, projectId: pid });
  assert.equal(send.status, 200, JSON.stringify(send.body).slice(0, 300));
  const m = send.body.mission;
  assert.ok(m, "mission drafted");
  const plan = await post("/api/plan/new", { objective: `plan ${marker}`, decisions,
    taskDrafts: [{ title: `${marker} owner-gate draft step` }], conversationId: send.body.conversation.id });
  assert.equal(plan.status, 200, JSON.stringify(plan.body).slice(0, 300));
  await post("/api/chat/mission", { missionId: m.id, action: "approve" });
  const launch = await post("/api/chat/launch", { missionId: m.id, timeoutMs: 30000 });
  assert.equal(launch.body.started, true, "async launch");
  return { pid, m, convId: send.body.conversation.id, plan: plan.body.plan };
}

test("owner cycle: question → blocked → planner NOT_COVERED → owner card → answer → resume", async () => {
  MODE.w1 = "once"; MODE.auto = "not_covered";
  const bodiesBefore = bodies.length, autoBefore = autoBodies().length;
  const { pid, m } = await launchMission("ESCMARK1", "Stack: node ESM only; zero dependencies.");

  // DETECT: the task flips to blocked with the pending question — the planner was consulted ONCE
  // (the plan has decisions and a model exists) and said NOT_COVERED → the owner keeps it.
  const t1 = await until(async () => {
    const t = await task1Of(pid);
    return t?.pendingQuestion && autoBodies().length === autoBefore + 1 ? t : null;
  });
  assert.equal(t1.status, "blocked");
  assert.equal(t1.pendingQuestion.question, QUESTION);
  assert.equal(t1.planId, (await state()).plans.find((p) => p.conversationId === m.conversationId && p.decisions)?.id,
    "the subtask links to the plan with decisions");
  assert.deepEqual(t1.qna ?? [], [], "nothing answered yet — the question waits on the owner");
  // The other spine task kept running and the mission completed with an honest waiting note.
  await until(async () => (await state()).missions.find((x) => x.id === m.id)?.status === "done" || null);
  const conv = (await state()).conversations.find((c) => c.id === m.conversationId);
  assert.match(conv.messages.at(-1).text, /question|Frage/i);

  // OWNER ANSWER → recorded by:"owner", task in-progress, resume re-runs the worker to done.
  const ans = await post("/api/task/answer", { id: t1.id, answer: OWNER_ANSWER });
  assert.equal(ans.status, 200, JSON.stringify(ans.body).slice(0, 300));
  assert.equal(ans.body.task.status, "in-progress");
  assert.equal(ans.body.task.pendingQuestion, null);
  assert.equal(ans.body.resumed, true);
  assert.deepEqual(ans.body.task.qna.map((x) => x.by), ["owner"]);
  assert.equal(ans.body.task.qna[0].question, QUESTION);
  assert.equal(ans.body.task.qna[0].answer, OWNER_ANSWER);

  const done = await until(async () => {
    const t = await task1Of(pid);
    return t?.status === "done" ? t : null;
  });
  assert.equal(done.result.ok, true, "the resumed worker reported into the task");
  assert.equal(done.missionId, m.id);
  // The resume prompt carried the Q&A — the worker saw the owner's answer.
  const resumePrompts = w1Since(bodiesBefore).map(promptOf).filter((p) => p.includes("Previous questions and answers"));
  assert.ok(resumePrompts.length >= 1, "the re-run prompt renders the qna section");
  assert.ok(resumePrompts[0].includes(QUESTION) && resumePrompts[0].includes(OWNER_ANSWER));
  const exec = await until(async () => {
    const e = (await state()).executions.find((x) => x.missionId === m.id);
    return e?.finishedAt ? e : null;
  });
  assert.equal(exec.graph.find((g) => g.node === "worker-1").status, "done");
  assert.ok(Number.isFinite(exec.finishedAt) && exec.finishedAt >= exec.createdAt,
    "a finished execution carries a real finishedAt (the task activity trail renders it)");
});

test("auto-answer: planner answers from DECISIONS — recorded by:'planner', prompt pinned", async () => {
  MODE.w1 = "once"; MODE.auto = "answer";
  const bodiesBefore = bodies.length, autoBefore = autoBodies().length;
  const decisions = "DECISIONS-MARKER-XYZ — esm only, zero-dep";
  const { pid } = await launchMission("ESCMARK2", decisions);

  const done = await until(async () => {
    const t = await task1Of(pid);
    return t?.status === "done" ? t : null;
  });
  assert.equal(done.pendingQuestion, null);
  assert.equal(done.qna.length, 1);
  assert.equal(done.qna[0].by, "planner");
  assert.equal(done.qna[0].question, QUESTION);
  assert.equal(done.qna[0].answer, AUTO_ANSWER);

  // ONE bounded planner call — and its ENTIRE context is the decisions + the question.
  const autos = autoBodies().slice(autoBefore);
  assert.equal(autos.length, 1, "exactly one auto-answer call");
  const { autoAnswerPrompt } = await import("./plan-tasks.mjs");
  const prompt = promptOf(autos[0]);
  assert.equal(prompt, autoAnswerPrompt({ decisions, question: QUESTION }), "the constructed prompt is deterministic");
  assert.ok(prompt.includes(decisions) && prompt.includes(QUESTION));
  assert.ok(!prompt.includes("ESCMARK2"), "the mission objective never enters the auto-answer context");
  assert.ok(!prompt.includes("YOUR PART"), "no worker context enters the auto-answer context");

  // The worker re-ran with the planner's Q&A in its prompt.
  const reruns = w1Since(bodiesBefore).map(promptOf).filter((p) => p.includes("Previous questions and answers"));
  assert.ok(reruns.length >= 1, "the worker resumed with the qna section");
  assert.ok(reruns[0].includes(AUTO_ANSWER));
});

test("cap: questions 1–3 auto-answer; the 4th skips the planner entirely and goes to the owner", async () => {
  MODE.w1 = "always"; MODE.auto = "answer";
  const autoBefore = autoBodies().length;
  const { pid, m } = await launchMission("ESCMARK3", "decisions three: esm, zero-dep");

  // Stable end state: 3 planner answers recorded, the 4th question pending for the owner.
  const t1 = await until(async () => {
    const t = await task1Of(pid);
    return t?.pendingQuestion && (t.qna || []).length === 3 ? t : null;
  });
  assert.equal(t1.status, "blocked");
  assert.equal(t1.pendingQuestion.question, QUESTION);
  assert.deepEqual(t1.qna.map((x) => x.by), ["planner", "planner", "planner"]);
  assert.equal(autoBodies().length - autoBefore, 3, "the cap held BEFORE any 4th model call");

  // The other spine task was never held up.
  await until(async () => (await state()).missions.find((x) => x.id === m.id)?.status === "done" || null);
  const t2 = (await state()).tasks.find((t) => t.projectId === pid && t.title === "beta step two");
  assert.equal(t2.status, "done");
  // Left blocked on purpose — the owner never answered here.
});

test("all workers waiting on the owner → waiting note in the verdict, NEVER the noWork failure", async () => {
  MODE.w1 = "always"; MODE.w2 = "always"; MODE.auto = "not_covered";
  const { pid, m } = await launchMission("ESCMARK4", "decisions four: esm.");

  // Both workers escalate; NOTHING exceeds the no-work threshold — the run must still NOT be
  // reported as a clarification/no-work failure: it is paused on the owner's answers.
  const mm = await until(async () => {
    const cur = (await state()).missions.find((x) => x.id === m.id);
    return cur?.status === "done" || cur?.lastError ? cur : null;
  });
  assert.equal(mm.status, "done", "not a failure — the mission is waiting on the owner");
  assert.equal(mm.lastError, undefined, "no noWork error recorded");
  const conv = (await state()).conversations.find((c) => c.id === m.conversationId);
  const verdict = conv.messages.at(-1).text;
  assert.match(verdict, /2 task\(s\) paused with a question/, "the verdict is the waiting-on-owner note");
  assert.doesNotMatch(verdict, /produced no work/i, "never the misleading noWork relaunch text");
  const st = await state();
  const subs = st.tasks.filter((t) => t.projectId === pid && t.parentId);
  assert.equal(subs.length, 2);
  for (const s of subs) {
    assert.equal(s.status, "blocked");
    assert.equal(s.pendingQuestion?.question, QUESTION);
  }
  MODE.w2 = "never";
});

test("questionCard escapes qna history — worker-controlled markup can never inject into the owner's browser", async () => {
  const { SHELL_PAGE } = await import("./shell.mjs");
  const vm = await import("node:vm");
  const { CATALOG } = await import("./i18n.mjs");
  // Render the real questionCard against a malicious record, like the parse-guard test renders
  // the page script: evaluate the component in a vm with the same helpers the shell gives it.
  const start = SHELL_PAGE.indexOf("function questionCard(");
  const end = SHELL_PAGE.indexOf("/** A finished run", start);
  assert.ok(start > 0 && end > start, "questionCard found in the shell");
  const seen = [];
  const sandbox = {
    t: (k) => CATALOG.en[k] || k,
    esc: (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])),
    el: (h) => { seen.push(h); return { querySelector: () => ({ appendChild() {}, set onclick(v) {} }), appendChild() {} }; },
    api: async () => ({}), refresh: async () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(SHELL_PAGE.slice(start, end), sandbox);
  const EVIL_Q = '</div><img src=x onerror=alert(1)>';
  const EVIL_A = '</b><img src=y onerror=alert(2)>';
  sandbox.questionCard({ id: "tk-evil", title: "evil task", pendingQuestion: null, qna: [
    { question: "first question?", answer: EVIL_A, by: "owner", at: 1 },
    { question: EVIL_Q, answer: "second answer.", by: "planner", at: 2 },
  ] });
  assert.equal(seen.length, 1, "the card renders one element");
  const html = seen[0];
  assert.ok(!html.includes(EVIL_Q), "the raw question markup is NOT in the card");
  assert.ok(!html.includes(EVIL_A), "the raw answer markup is NOT in the history");
  assert.ok(html.includes("&lt;/div&gt;&lt;img src=x onerror=alert(1)&gt;"), "the escaped question appears");
  assert.ok(html.includes("&lt;/b&gt;&lt;img src=y onerror=alert(2)&gt;"), "the escaped answer appears");
  assert.ok(html.includes(CATALOG.en["q.q"]) && html.includes(CATALOG.en["q.a"]), "the Q/A labels come from the catalog");
});

test("answer API is fail-closed: unknown task, empty answer, no pendingQuestion → 400", async () => {
  assert.equal((await post("/api/task/answer", { id: "ghost", answer: "x" })).status, 400);
  const t = await post("/api/task/new", { title: "plain manual task" });
  assert.equal(t.status, 200);
  assert.equal((await post("/api/task/answer", { id: t.body.task.id, answer: "   " })).status, 400);
  const noPending = await post("/api/task/answer", { id: t.body.task.id, answer: "a real answer" });
  assert.equal(noPending.status, 400);
  assert.match(noPending.body.error, /no pending question/);
  // …and the manual task is untouched.
  const st = await state();
  assert.equal(st.tasks.find((x) => x.id === t.body.task.id).status, "todo");
});

test("workerPartPrompt: qna section renders; absent qna stays byte-identical", async () => {
  const { workerPartPrompt } = await import("./plan-tasks.mjs");
  const args = { objective: "OBJ", planOutput: "PLAN", part: "STEP", index: 1, total: 2 };
  const BASE = `OBJ\n\nThe plan and decisions (shared, binding on every worker):\nPLAN\n\nYOUR PART (task 1/2): STEP\nComplete ONLY your part, fully, and stay inside the shared decisions.`;
  assert.equal(workerPartPrompt(args), BASE);
  assert.equal(workerPartPrompt({ ...args, task: { qna: [] } }), BASE, "empty qna → no section");
  const withQna = workerPartPrompt({ ...args, task: { qna: [{ question: "ESM or CJS?", answer: "ESM.", by: "owner", at: 1 }] } });
  assert.ok(withQna.startsWith(BASE), "the base prompt is untouched");
  assert.ok(withQna.includes("Previous questions and answers"));
  assert.ok(withQna.includes("- Q: ESM or CJS?\n  A: ESM."));
  // Directives + qna compose; malformed qna entries are dropped, never thrown.
  const both = workerPartPrompt({ ...args, task: { acceptanceCriteria: ["compiles"], qna: [{ question: "q1", answer: "a1" }, { broken: true }] } });
  assert.ok(both.includes("- [ ] compiles"));
  assert.ok(both.includes("- Q: q1\n  A: a1") && !both.includes("broken"));
});

test("parseWorkerQuestion: bounded, tolerant, fail-closed — at most ONE question", async () => {
  const { parseWorkerQuestion } = await import("./plan-tasks.mjs");
  assert.equal(parseWorkerQuestion(""), null);
  assert.equal(parseWorkerQuestion("no fence here"), null);
  assert.equal(parseWorkerQuestion("```question\n```"), null, "empty is not a question");
  assert.equal(parseWorkerQuestion("```question\n  " + "x".repeat(501) + "\n```"), null, "over 500 chars fails closed");
  assert.equal(parseWorkerQuestion("work\n```question\nESM or CJS?\n```\ntail"), "ESM or CJS?");
  assert.equal(parseWorkerQuestion("```question\nfirst?\n```\n```question\nsecond?\n```"), "first?", "at most ONE question per output");
  assert.equal(parseWorkerQuestion("```question\n" + "x".repeat(500) + "\n```").length, 500, "the bound itself is allowed");
});

test("the question card is in the shell (project thread + task detail) and i18n stays at parity", async () => {
  const shell = await (await fetch(`${BASE}/`)).text();
  assert.match(shell, /function questionCard\(/, "the question card component exists");
  assert.match(shell, /\/api\/task\/answer/, "the owner answers inline via the API");
  assert.match(shell, /q\.awaiting/, "status labels are localized");
  const { LOCALES, missingKeys } = await import("./i18n.mjs");
  for (const loc of LOCALES) assert.deepEqual(missingKeys(loc), [], `${loc} is missing keys`);
});
