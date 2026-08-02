// SPDX-License-Identifier: Apache-2.0
// Task detail issue page (task-pm-09): the open task is its own single source of truth —
// objective (when it adds information over the title), an acceptance-criteria checklist with
// REAL per-criterion states (parseTaskReview match-back semantics: whitespace-tolerant,
// content-strict — a state is never invented), the read-only directives (skills / agentSlot /
// restrictions / priority / labels), and an activity trail built ONLY from real records (plan
// link, mission runs, review, escalations, creation — sorted by timestamp ascending,
// untimestamped entries last in stable order; a category with no records leaves no trace).
// The status select, assignee/reporter lines, result, subtasks, question card and the embedded
// live run keep working. Component tests follow the vm/parse-guard pattern (tasklist/taskboard).
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { SHELL_PAGE } from "./shell.mjs";
import { CATALOG, LOCALES, missingKeys } from "./i18n.mjs";

// Extract the REAL blocks from the page: task-list helpers (prioDot/blockedBadge/labelChips),
// the question/review/run cards, the new task-detail block, and taskRow itself.
const TL_START = SHELL_PAGE.indexOf("// ── task list helpers");
const TL_END = SHELL_PAGE.indexOf("/** A foldable settings section", TL_START);
const Q_START = SHELL_PAGE.indexOf("/** A worker's escalated question");
const D_START = SHELL_PAGE.indexOf("// ── task detail (task-pm-09)");
const PV = SHELL_PAGE.indexOf("// ── project view: the task spine", D_START);
const TR_START = SHELL_PAGE.indexOf("function taskRow(", PV);
const TR_END = SHELL_PAGE.indexOf("function projectView(", TR_START);
assert.ok(TL_START > 0 && TL_END > TL_START, "the task-list helper block is in the shell");
assert.ok(Q_START > 0 && D_START > Q_START && PV > D_START, "the card + task-detail blocks are in the shell");
assert.ok(TR_START > PV && TR_END > TR_START, "taskRow is in the shell");
const BLOCKS = [
  SHELL_PAGE.slice(TL_START, TL_END),
  SHELL_PAGE.slice(Q_START, D_START),   // questionCard, reviewLine, extractHtml, runCard
  SHELL_PAGE.slice(D_START, PV),        // the task-detail block (task-pm-09)
  SHELL_PAGE.slice(TR_START, TR_END),   // taskRow + srow
].join("\n");

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** A vm context with the same helpers the shell gives its components. el() is a fake that keeps
 *  the HTML string and tracks appended children, so the detail card, trail rows, embedded run
 *  and question card stay reachable. */
function makeCtx(state = {}, locale = "en") {
  const stub = () => ({ onclick: null, onchange: null, value: "", style: {}, appendChild() {} });
  const sandbox = {
    t: (k) => CATALOG[locale][k] || CATALOG.en[k] || k,
    esc,
    S: { state },
    __renders: 0,
    render() { sandbox.__renders++; },
    alert() {},
    api: async () => ({}),
    refresh: async () => {},
    el(h) {
      return { html: h, children: [], value: "", style: {}, dataset: {},
        classList: { add() {}, remove() {} },
        appendChild(c) { this.children.push(c); },
        querySelector() { return stub(); } };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(BLOCKS + "\n;globalThis.__h={prioDot,blockedBadge,labelChips,critNorm,objectiveBlock,acChecklist,directivesBlock,activityEntries,activityTrail,taskRow,questionCard,reviewLine,runCard};", sandbox);
  return { sandbox, h: sandbox.__h };
}

const kindOf = (row) => row.html.match(/data-kind="([^"]+)"/)[1];
const idOf = (row) => row.html.match(/data-id="([^"]*)"/)[1];

test("AC checklist: every criterion gets its real state — pass/fail from the review (verbatim match-back), pending otherwise; evidence shown esc()'d", () => {
  const AC1 = "the landing page exists as a real file";
  const AC2 = "the page names the company";
  const AC3 = "the CSS is <b>linked</b>";
  const tk = { id: "t1", title: "build the page", status: "blocked",
    acceptanceCriteria: [AC1, AC2, AC3],
    review: { ok: false, note: "one unmet", by: "reviewer", at: 500,
      criteria: [
        { criterion: AC1, verdict: "pass", evidence: "the result names the file index.html" },
        { criterion: "  the   page\nnames the company  ", verdict: "fail", evidence: "nothing <i>proves</i> it" },
      ] } };
  const { h } = makeCtx();
  const html = h.acChecklist(tk);
  const chunks = html.split("<div class=acitem").slice(1);
  assert.equal(chunks.length, 3, "one row per criterion");
  assert.ok(chunks[0].startsWith(' data-state="pass"'), "AC1 passed");
  assert.ok(chunks[1].startsWith(' data-state="fail"'), "AC2 failed — whitespace-tolerant, content-strict match-back");
  assert.ok(chunks[2].startsWith(' data-state="pending"'), "AC3 was never judged — pending, never invented");
  assert.ok(chunks[0].includes(AC1) && chunks[1].includes(AC2), "criteria render verbatim");
  assert.ok(chunks[0].includes("the result names the file index.html"), "the pass evidence shows");
  assert.ok(chunks[1].includes("nothing &lt;i&gt;proves&lt;/i&gt; it"), "the fail evidence shows, escaped");
  assert.ok(!chunks[1].includes("<i>proves</i>"), "never the raw evidence markup");
  assert.ok(!chunks[2].includes(CATALOG.en["task.evidence"]), "no evidence line without a judged criterion");
  assert.ok(chunks[2].includes("the CSS is &lt;b&gt;linked&lt;/b&gt;") && !chunks[2].includes("<b>linked</b>"), "criterion text escaped");
  assert.ok(chunks[0].includes(CATALOG.en["task.ac.pass"]) && chunks[1].includes(CATALOG.en["task.ac.fail"]) && chunks[2].includes(CATALOG.en["task.ac.pending"]),
    "the state labels are localized");
  assert.ok(html.includes(CATALOG.en["task.criteria"]), "the section header is localized");

  // No review yet → everything pending; an alien review entry can never leak a state on.
  assert.ok(h.acChecklist({ acceptanceCriteria: [AC1] }).includes('data-state="pending"'), "no review → pending");
  const alien = h.acChecklist({ acceptanceCriteria: [AC1],
    review: { ok: true, criteria: [{ criterion: "something else entirely", verdict: "pass", evidence: "x" }] } });
  assert.ok(alien.includes('data-state="pending"'), "an unmatched review entry changes nothing");
  assert.ok(!alien.includes("something else entirely"), "an unmatched entry is not displayed either");
  // A review verdict outside pass/fail is not a state — pending, never invented.
  const weird = h.acChecklist({ acceptanceCriteria: [AC1],
    review: { ok: true, criteria: [{ criterion: AC1, verdict: "maybe", evidence: "x" }] } });
  assert.ok(weird.includes('data-state="pending"'), "an unknown verdict is not a state");
  // No acceptanceCriteria → no checklist chrome at all.
  assert.equal(h.acChecklist({}), "");
  assert.equal(h.acChecklist({ acceptanceCriteria: [], review: { criteria: [] } }), "");
});

test("directives: skills / agentSlot / restrictions / priority / labels render when present — and nothing (no empty chrome) when absent", () => {
  const { h } = makeCtx();
  const full = h.directivesBlock({ skills: ["web", "pdf"], agentSlot: "coding-free",
    restrictions: { "no-network": true, budget: "0$" }, priority: "high", labels: ["frontend", "v1"] });
  for (const k of ["task.directives", "task.skills", "task.agentSlot", "task.restrictions", "task.priority", "task.labels"])
    assert.ok(full.includes(CATALOG.en[k]), `the ${k} line shows`);
  assert.ok(full.includes(">web<") && full.includes(">pdf<"), "skills render as chips");
  assert.ok(full.includes("coding-free"), "the agent slot renders");
  assert.ok(full.includes("no-network: true") && full.includes("budget: 0$"), "restrictions render as key: value lines");
  assert.ok(full.includes(CATALOG.en["task.priority.high"]), "the priority renders localized");
  assert.ok(full.includes("frontend") && full.includes("v1"), "labels render");

  assert.equal(h.directivesBlock({}), "", "nothing present → no block at all");
  assert.equal(h.directivesBlock({ skills: [], restrictions: {}, labels: [], priority: "none", agentSlot: null }), "",
    "empty/absent directive fields leave no empty chrome");
  const partial = h.directivesBlock({ agentSlot: "private-local" });
  assert.ok(partial.includes("private-local"), "a lone agentSlot renders");
  assert.ok(!partial.includes(CATALOG.en["task.skills"]), "no skills line without skills");
  assert.ok(!partial.includes(CATALOG.en["task.priority"]), "no priority line without priority");
  assert.ok(!h.directivesBlock({ priority: "bogus" }).includes(CATALOG.en["task.priority"]), "an unknown priority renders nothing");
  // The objective shows only when it adds information over the title.
  assert.ok(h.objectiveBlock({ title: "short", objective: "a much longer objective" }).includes("a much longer objective"));
  assert.equal(h.objectiveBlock({ title: "same", objective: "same" }), "", "objective == title → not repeated");
  assert.equal(h.objectiveBlock({ title: "x" }), "");
});

test("activity trail: real records only, sorted by timestamp ascending — untimestamped entries last, stable; links carry the right ids", () => {
  const T0 = 1_700_000_000_000;
  const plan = { id: "plan-1", projectId: "p1", conversationId: "conv-plan", objective: "build the portal", status: "materialized", createdAt: T0 + 100 };
  const task = { id: "t1", title: "alpha", status: "blocked", projectId: "p1",
    planId: "plan-1", missionId: "m1", createdAt: T0 + 50,
    review: { ok: false, note: "one unmet", by: "reviewer", at: T0 + 400, criteria: [] },
    qna: [
      { question: "ESM or CJS?", answer: "ESM.", by: "owner", at: T0 + 300 },
      { question: "second?", answer: "answered.", by: "planner" },       // no timestamp → last
    ],
    pendingQuestion: { question: "which module system?", at: T0 + 500 } };
  const state = {
    plans: [plan],
    executions: [
      { id: "exec-2", missionId: "m1", status: "running", createdAt: T0 + 200, conversationId: "conv-run2" },
      { id: "exec-1", missionId: "m1", status: "done", createdAt: T0 + 150, conversationId: "conv-run1", finishedAt: T0 + 180 },
      { id: "exec-other", missionId: "m2", status: "done", createdAt: T0 + 10, conversationId: "conv-x" },
    ],
  };
  const { sandbox, h } = makeCtx(state);
  const entries = h.activityEntries(state, task);
  // NOTE: activityEntries returns a vm-realm array — copy into this realm before deepEqual.
  assert.deepEqual(Array.from(entries, (e) => [e.kind, e.id]),
    [["created", "t1"], ["plan", "plan-1"], ["run", "exec-1"], ["run", "exec-2"],
     ["qna", "t1-q0"], ["review", "t1"], ["question", "t1-pq"], ["qna", "t1-q1"]],
    "timestamp ascending (NOT insertion order — exec-1 predates exec-2); the untimestamped qna sorts last, stably");
  assert.ok(!entries.some((e) => e.id === "exec-other"), "another mission's run never appears");

  const byId = Object.fromEntries(entries.map((e) => [e.id, e]));
  // Plan entry: objective + localized status, click opens the plan.
  assert.ok(byId["plan-1"].html.includes("build the portal"), "the plan entry names the plan objective");
  assert.ok(byId["plan-1"].html.includes(CATALOG.en["plan.status.materialized"]), "…with its real status");
  byId["plan-1"].onclick();
  assert.equal(sandbox.S.projectId, "p1", "clicking the plan opens its project");
  assert.equal(sandbox.S.convId, "conv-plan", "…and its conversation");
  assert.ok(sandbox.__renders >= 1, "the click re-renders");
  // Run entries: real status + started/finished times; click opens the run's thread.
  assert.ok(byId["exec-1"].html.includes("done"), "the finished run shows its status");
  assert.ok(byId["exec-1"].html.includes(CATALOG.en["task.started"]) && byId["exec-1"].html.includes(CATALOG.en["task.finished"]),
    "started AND finished times when the record carries them");
  assert.ok(byId["exec-2"].html.includes("running"), "the running execution shows running");
  assert.ok(byId["exec-2"].html.includes(CATALOG.en["task.started"]) && !byId["exec-2"].html.includes(CATALOG.en["task.finished"]),
    "…started only — a finish time is never invented");
  byId["exec-2"].onclick();
  assert.equal(sandbox.S.convId, "conv-run2", "clicking the run opens its thread");
  // Review entry: verdict + note + by + at (the review line folded in — no information lost).
  const reviewEntry = entries.find((e) => e.kind === "review");
  assert.ok(reviewEntry.html.includes(CATALOG.en["review.fail"]), "the review verdict shows");
  assert.ok(reviewEntry.html.includes("one unmet"), "the review note shows");
  assert.ok(reviewEntry.html.includes(CATALOG.en["review.by.reviewer"]), "the reviewer shows");
  // Escalations: answered qna with by/at; the pending question shows as awaiting.
  assert.ok(byId["t1-q0"].html.includes("ESM or CJS?") && byId["t1-q0"].html.includes("ESM."), "qna question + answer show");
  assert.ok(byId["t1-q0"].html.includes(CATALOG.en["q.by.owner"]), "who answered shows");
  assert.ok(byId["t1-pq"].html.includes("which module system?") && byId["t1-pq"].html.includes(CATALOG.en["q.awaiting"]),
    "the pending question shows as awaiting");
  assert.ok(entries.find((e) => e.kind === "created").html.includes(CATALOG.en["task.act.created"]), "creation is stamped");

  // The trail element: one row per entry, in the same order, kinds/ids on the rows.
  const trail = h.activityTrail(state, task);
  assert.deepEqual(trail.children.map(kindOf), Array.from(entries, (e) => e.kind), "trail rows follow the entry order");
  assert.deepEqual(trail.children.map(idOf), Array.from(entries, (e) => e.id));
  assert.ok(trail.html.includes(CATALOG.en["task.activity"]), "the trail header is localized");

  // A task with NONE of these records → no trail at all, no fabricated entries.
  assert.equal(h.activityEntries(state, { id: "t9", title: "manual" }).length, 0);
  assert.equal(h.activityTrail(state, { id: "t9", title: "manual", status: "todo" }), null,
    "no records → the trail section is absent entirely");
  const onlyCreated = h.activityEntries(state, { id: "t10", title: "m", createdAt: 1 });
  assert.deepEqual(Array.from(onlyCreated, (e) => e.kind), ["created"], "creation is the only entry when it is the only record");
});

test("taskRow regression: status select / assignee / reporter / result / subtasks / question card keep working — and the live run still embeds while the mission runs", () => {
  const state = {
    projects: [{ id: "p1", name: "Portal" }],
    missions: [{ id: "m1", status: "running", conversationId: "conv-1" }],
    executions: [{ id: "exec-1", missionId: "m1", status: "running", department: "technical",
      graph: [{ node: "worker-1", status: "pending" }], results: [], logs: [], createdAt: 1 }],
    tasks: [], conversations: [], plans: [],
  };
  const tk = { id: "t1", title: "build it", status: "in-progress", projectId: "p1", missionId: "m1",
    assignee: "worker-1", reporter: "you", objective: "build the whole portal",
    result: { ok: true, summary: "half done", artifacts: [] },
    pendingQuestion: { question: "which stack?", at: 2 } };
  const { sandbox, h } = makeCtx(state);
  sandbox.S.openTask = "t1";
  const d = h.taskRow(tk, [{ id: "s1", title: "sub one", status: "todo", parentId: "t1" }]);
  assert.ok(d.html.includes("id=tst"), "the status select stays");
  assert.ok(d.html.includes(CATALOG.en["task.assignee"]) && d.html.includes("worker-1"), "the assignee line stays");
  assert.ok(d.html.includes(CATALOG.en["task.reporter"]), "the reporter line stays");
  assert.ok(d.html.includes("Portal"), "the project name stays");
  assert.ok(d.html.includes("half done"), "the result summary stays");
  assert.ok(d.html.includes("sub one"), "subtask rows stay");
  assert.ok(d.html.includes(CATALOG.en["task.openThread"]), "the open-thread button stays");
  assert.ok(d.html.includes("build the whole portal"), "the objective shows (different from the title)");
  // The embedded live run — still there, still marked running.
  const runEl = d.children.find((c) => (c.html || "").includes(CATALOG.en["run.title"]));
  assert.ok(runEl, "the running execution embeds as a live run card inside the issue");
  assert.ok(runEl.html.includes(CATALOG.en["run.running"]), "…marked running");
  // The question card still renders for the pending question.
  const qEl = d.children.find((c) => (c.html || "").includes(CATALOG.en["q.title"]));
  assert.ok(qEl, "the question card stays");
  // The activity trail appended (run at=1 before question at=2).
  const trail = d.children.find((c) => (c.html || "").includes(CATALOG.en["task.activity"]));
  assert.ok(trail, "the activity trail renders in the detail");
  assert.deepEqual(trail.children.map(kindOf), ["run", "question"], "trail entries in timestamp order");
  // A closed detail renders none of the detail chrome.
  sandbox.S.openTask = null;
  const closed = h.taskRow(tk, []);
  assert.equal(closed.children.length, 0, "closed row → no detail children");
  assert.ok(!closed.html.includes("id=tst"), "closed row → no status select, no detail card");
  // Once the run finished, nothing embeds live anymore.
  sandbox.S.openTask = "t1";
  state.executions[0].status = "done";
  const d2 = h.taskRow(tk, []);
  assert.ok(!d2.children.some((c) => (c.html || "").includes(CATALOG.en["run.title"])), "no live embed once the run finished");
});

test("XSS sweep: objective / criteria / evidence / skills / restrictions / plan objective / qna / review note all render escaped", () => {
  const EVIL = '</div><img src=x onerror=alert(1)>';
  const EVIL2 = '"><script>alert(2)</script>';
  const plan = { id: "plan-x", objective: EVIL, status: "draft", createdAt: 10 };
  const tk = { id: "t1", title: "safe", status: "blocked", planId: "plan-x", createdAt: 1,
    objective: EVIL,
    acceptanceCriteria: [EVIL],
    skills: [EVIL2], restrictions: { [EVIL2]: EVIL }, agentSlot: EVIL,
    review: { ok: false, note: EVIL, by: "reviewer", at: 5,
      criteria: [{ criterion: EVIL, verdict: "fail", evidence: EVIL2 }] },
    qna: [{ question: EVIL, answer: EVIL2, by: "owner", at: 6 }],
    pendingQuestion: { question: EVIL2, at: 7 } };
  const st = { plans: [plan] };
  const { h } = makeCtx(st);
  const html = h.objectiveBlock(tk) + h.acChecklist(tk) + h.directivesBlock(tk)
    + h.activityEntries(st, tk).map((e) => e.html).join("\n");
  assert.ok(!html.includes(EVIL), "no raw payload anywhere in the detail");
  assert.ok(!html.includes(EVIL2), "no raw payload anywhere in the detail");
  assert.ok(html.includes(esc(EVIL)), "the escaped payload shows as text");
  assert.ok(html.includes(esc(EVIL2)), "the escaped payload shows as text");
});

test("the detail wires the new sections into taskRow (source pins)", () => {
  const row = SHELL_PAGE.slice(SHELL_PAGE.indexOf("function taskRow("), SHELL_PAGE.indexOf("function projectView("));
  assert.ok(row.includes("objectiveBlock(tk)"), "the objective renders in the detail");
  assert.ok(row.includes("acChecklist(tk)"), "the AC checklist renders in the detail");
  assert.ok(row.includes("directivesBlock(tk)"), "the directives render in the detail");
  assert.ok(row.includes("activityTrail(S.state||{},tk)"), "the activity trail renders in the detail");
  assert.ok(row.includes("runCard(execution)"), "the live run still embeds");
  assert.ok(row.includes("questionCard(tk)"), "the question card stays");
});

test("i18n parity (fr/de) for all new keys, and the page script still parses", () => {
  for (const loc of LOCALES) assert.deepEqual(missingKeys(loc), [], `${loc} is missing keys`);
  const KEYS = ["task.objective", "task.criteria", "task.ac.pass", "task.ac.fail", "task.ac.pending",
    "task.evidence", "task.directives", "task.skills", "task.agentSlot", "task.restrictions",
    "task.priority", "task.labels", "task.activity", "task.act.plan", "task.act.run",
    "task.act.review", "task.act.question", "task.act.created", "task.started", "task.finished"];
  for (const loc of LOCALES) for (const k of KEYS)
    assert.ok(CATALOG[loc][k] && CATALOG[loc][k] !== k, `${loc}:${k} has a real translation`);
  // The detail localizes for real: French checklist states + trail header.
  const { h } = makeCtx({}, "fr");
  assert.ok(h.acChecklist({ acceptanceCriteria: ["x"] }).includes(CATALOG.fr["task.ac.pending"]));
  assert.ok(h.directivesBlock({ agentSlot: "s" }).includes(CATALOG.fr["task.directives"]));
  assert.ok(h.activityTrail({}, { id: "t", title: "t", createdAt: 1 }).html.includes(CATALOG.fr["task.activity"]));
  assert.ok(h.activityEntries({}, { id: "t", title: "t", review: { ok: true, note: "n", by: "reviewer", at: 1 } })[0].html.includes(CATALOG.fr["review.pass"]));

  const page = SHELL_PAGE.replace("__BO_I18N__", "{}").replaceAll("__BO_LOCALE__", "en").replace("__BO_CSRF__", "x");
  const js = page.split("<script>")[1].split("</scr" + "ipt>")[0];
  new vm.Script(js);   // parse guard — a template-literal slip can never blank the page
});
