// SPDX-License-Identifier: Apache-2.0
// Per-task review (task-pm-06): a spine task carrying acceptance criteria is judged against
// them between the worker report and the task flipping done — ONE bounded reviewer-slot call,
// parsed fail-closed (criterion fail or unparseable review → blocked, never a silent pass);
// no reviewer model → the deterministic guard + an honest note on the record; no criteria →
// the pre-review path, unchanged. Real-server tmp-dir pattern with a stubbed model endpoint
// (same as escalation.test.mjs).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 4397;
const BASE = `http://127.0.0.1:${PORT}`;
let srv, dir, stub;

const AC1 = "the landing page exists as a real file";
const AC2 = "the page names the company";
const WORKER_OUT = "Built it for real. " + "Concrete work output follows: the file was written and checked. ".repeat(4);
// Mutable stub behavior per test: plan = do planned steps carry acceptance criteria,
// rev = the reviewer's verdict mode (pass / fail one criterion / garbage).
const MODE = { plan: "with_ac", rev: "pass" };
const bodies = [];        // every completion request body, in order
const promptOf = (d) => { try { return JSON.parse(d).messages?.[0]?.content || ""; } catch { return ""; } };
const reviewBodies = () => bodies.filter((d) => d.includes("rigorous reviewer for THIS task"));

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
const tasksBlock = (withAc) => "```tasks\n" + JSON.stringify(withAc
  ? [{ title: "alpha reviewed step", acceptanceCriteria: [AC1, AC2] }, { title: "beta reviewed step", acceptanceCriteria: [AC2] }]
  : [{ title: "alpha plain step" }, { title: "beta plain step" }]) + "\n```";

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "bo-taskreview-"));
  const { createServer } = await import("node:http");
  stub = createServer((req, res) => {
    let d = ""; req.on("data", (c) => (d += c));
    req.on("end", () => {
      bodies.push(d);
      res.writeHead(200, { "Content-Type": "application/json" });
      const say = (content) => res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      // The bounded per-task REVIEW call (task-pm-06).
      if (d.includes("rigorous reviewer for THIS task")) {
        if (MODE.rev === "garbage") return say("Looks good to me, ship it — no block here.");
        return say(reviewJson(promptOf(d), MODE.rev));
      }
      if (d.includes("PLAN DECISIONS:")) return say("NOT_COVERED");
      // The mission planner: a usable 2-step task block, with or without criteria.
      if (d.includes("Reply in exactly this form")) return say("Thinking through it.\n\n" + tasksBlock(MODE.plan === "with_ac"));
      // Workers: solid, long, non-clarifying output.
      return say(WORKER_OUT);
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
  // Deterministic models: every slot (incl. the reviewer's high-trust-review) → the stub.
  await post("/api/onboard", { companyName: "Rev Co", companyDoes: "tests", departments: ["technical"] });
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
const subOf = async (pid, title) => (await state()).tasks.find((t) => t.projectId === pid && t.parentId && t.title === title) || null;

/** Launch a 2-task project mission; the planner's steps carry acceptance criteria per MODE.
 *  The mission drafts through the ask-mode fast path (plan-mode project asks no longer draft
 *  missions — task-pm-11); its own planner still decomposes it into spine subtasks. */
async function launchMission(marker) {
  const p = await post("/api/project", { name: `rev-${marker}` });
  const pid = p.body.project.id;
  const send = await post("/api/chat/send", { scope: "department", department: "technical", mode: "ask",
    text: `build me a platform for the ${marker} customer portal`, projectId: pid });
  assert.equal(send.status, 200, JSON.stringify(send.body).slice(0, 300));
  const m = send.body.mission;
  assert.ok(m, "mission drafted");
  await post("/api/chat/mission", { missionId: m.id, action: "approve" });
  const launch = await post("/api/chat/launch", { missionId: m.id, timeoutMs: 30000 });
  assert.equal(launch.body.started, true, "async launch");
  return { pid, m };
}

test("pass path: all-pass review → task done, review {ok, note, criteria+evidence, by:'reviewer'} persisted", async () => {
  MODE.plan = "with_ac"; MODE.rev = "pass";
  const reviewsBefore = reviewBodies().length;
  const { pid, m } = await launchMission("PASSMARK");

  const t1 = await until(async () => {
    const t = await subOf(pid, "alpha reviewed step");
    return t?.status === "done" && t.review ? t : null;
  });
  assert.equal(t1.review.ok, true);
  assert.equal(t1.review.by, "reviewer");
  assert.equal(t1.review.note, "every criterion is evidenced in the worker report");
  assert.deepEqual(t1.review.criteria.map((c) => [c.criterion, c.verdict]), [[AC1, "pass"], [AC2, "pass"]],
    "the task's verbatim criteria round-tripped through the reviewer");
  assert.ok(t1.review.criteria.every((c) => c.evidence.length > 0), "per-criterion evidence persisted");
  assert.equal(t1.result.ok, true);
  assert.equal(t1.missionId, m.id);

  const t2 = await until(async () => {
    const t = await subOf(pid, "beta reviewed step");
    return t?.status === "done" && t.review ? t : null;
  });
  assert.deepEqual(t2.review.criteria.map((c) => c.criterion), [AC2]);
  // ONE bounded reviewer call per task with criteria — no more, no less.
  assert.equal(reviewBodies().length - reviewsBefore, 2, "one reviewer call per reviewed task");
  const prompt = promptOf(reviewBodies().at(-2));
  assert.ok(prompt.includes("alpha reviewed step") && prompt.includes(AC1) && prompt.includes(AC2),
    "the review prompt carried the objective and every criterion verbatim");
  await until(async () => (await state()).missions.find((x) => x.id === m.id)?.status === "done" || null);
});

test("fail path: one criterion fails → task blocked, the note NAMES the failing criterion verbatim", async () => {
  MODE.plan = "with_ac"; MODE.rev = "fail";
  const reviewsBefore = reviewBodies().length;
  const { pid, m } = await launchMission("FAILMARK");

  const t1 = await until(async () => {
    const t = await subOf(pid, "alpha reviewed step");
    return t?.status === "blocked" && t.review ? t : null;
  });
  assert.equal(t1.review.ok, false);
  assert.equal(t1.review.by, "reviewer");
  assert.ok(t1.review.note.includes(AC1), `the note names the failing criterion verbatim: ${t1.review.note}`);
  assert.deepEqual(t1.review.criteria.map((c) => c.verdict), ["fail", "pass"]);
  assert.match(t1.result.summary, new RegExp(AC1.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "the result-style summary names it too");

  // A review-blocked task does NOT stop the other spine tasks: beta was reviewed too
  // (its single criterion failed under this mode) and the mission completed.
  const t2 = await until(async () => {
    const t = await subOf(pid, "beta reviewed step");
    return t?.status === "blocked" && t.review ? t : null;
  });
  assert.ok(t2.review.note.includes(AC2));
  assert.equal(reviewBodies().length - reviewsBefore, 2, "the second task was still reviewed");
  await until(async () => (await state()).missions.find((x) => x.id === m.id)?.status === "done" || null);
});

test("unparseable review → blocked with the parse-failure note — never a silent pass", async () => {
  MODE.plan = "with_ac"; MODE.rev = "garbage";
  const { pid } = await launchMission("GARBAGEMARK");

  const t1 = await until(async () => {
    const t = await subOf(pid, "alpha reviewed step");
    return t?.status === "blocked" && t.review ? t : null;
  });
  assert.equal(t1.review.ok, false);
  assert.equal(t1.review.by, "reviewer");
  // task-pm-20: the parse-failure note now carries a bounded, labeled slice of the raw
  // reviewer output so the block is diagnosable (was the bare "review could not be parsed").
  assert.match(t1.review.note, /^review could not be parsed — raw: /);
  assert.ok(t1.review.note.includes("Looks good to me, ship it"), "the raw reviewer output is on the record");
  assert.deepEqual(t1.review.criteria, []);
  assert.equal(t1.status, "blocked", "an unparseable review can never flip a task done");
});

test("prompt contract: objective + every criterion verbatim + demand-evidence + no rubber-stamping", async () => {
  const { reviewTaskPrompt } = await import("./review-tasks.mjs");
  const p = reviewTaskPrompt({ objective: "OBJ-VERBATIM", acceptanceCriteria: [AC1, AC2],
    resultSummary: "SUMMARY-VERBATIM", artifacts: ["index.html", "style.css"], testEvidence: "TESTS-VERBATIM" });
  assert.ok(p.includes("OBJ-VERBATIM"), "the task objective");
  assert.ok(p.includes(AC1) && p.includes(AC2), "every acceptance criterion verbatim");
  assert.ok(p.includes("SUMMARY-VERBATIM"), "the worker's result summary");
  assert.ok(p.includes("index.html") && p.includes("style.css"), "artifact names");
  assert.ok(p.includes("TESTS-VERBATIM"), "test evidence when present");
  assert.ok(p.includes("rigorous reviewer for THIS task"), "a rigorous reviewer for THIS task");
  assert.ok(/DEMAND EVIDENCE/.test(p), "demands evidence");
  assert.ok(/Never rubber-stamp/.test(p) && /absence of evidence is a fail/.test(p), "no rubber-stamping");
  assert.ok(p.includes("```review"), "the fenced reply contract");
  assert.ok(p.includes('"overall"'), "the overall verdict field");
  const noTests = reviewTaskPrompt({ objective: "O", acceptanceCriteria: ["c"], resultSummary: "s" });
  assert.ok(!noTests.includes("TEST EVIDENCE"), "no test-evidence section when absent");
  assert.ok(!noTests.includes("CODE DIFF"), "no diff section when absent");
});

test("prompt contract: the DIFF is primary evidence and the worker's summary is only a claim", async () => {
  const { reviewTaskPrompt } = await import("./review-tasks.mjs");
  const p = reviewTaskPrompt({ objective: "O", acceptanceCriteria: [AC1],
    resultSummary: "I did everything perfectly", artifacts: [],
    diff: "--- NEW FILE: src/a.js ---\nexport const DIFF_MARKER = 1;", testEvidence: "exit code: 0 (PASSED)" });
  assert.ok(p.includes("DIFF_MARKER"), "the real diff reaches the reviewer");
  assert.ok(p.includes("CODE DIFF"), "labelled as the code diff");
  assert.ok(/primary evidence/i.test(p), "the diff is named primary evidence");
  assert.ok(/unverified claim/i.test(p), "the summary is labelled an unverified claim");
  assert.ok(/is NOT evidence/i.test(p), "prose is explicitly not evidence");
  assert.ok(/empty diff means no work was done/i.test(p), "an empty diff fails every criterion");
  assert.ok(/TRUNCATED or INCOMPLETE/i.test(p), "partial evidence must fail, not be assumed");
  assert.ok(p.includes("exit code: 0 (PASSED)"), "the real test exit code reaches the reviewer");
  // The pre-existing rigour clauses must survive the rewrite.
  assert.ok(p.includes("rigorous reviewer for THIS task") && /DEMAND EVIDENCE/.test(p));
  assert.ok(/Never rubber-stamp/.test(p) && /absence of evidence is a fail/.test(p));
});

test("parser: fail-closed on missing/unknown verdict, tampered or missing criterion, contradiction", async () => {
  const { parseTaskReview } = await import("./review-tasks.mjs");
  const ac = [AC1, AC2];
  const block = (obj) => "```review\n" + JSON.stringify(obj) + "\n```";
  const ok = parseTaskReview(block({ criteria: [
    { criterion: AC1, verdict: "pass", evidence: "shown" },
    { criterion: "  the   page names\nthe company  ", verdict: "fail", evidence: "absent" }],
    overall: "fail", note: "one unmet" }), { acceptanceCriteria: ac });
  assert.equal(ok.overall, "fail");
  assert.deepEqual(ok.criteria.map((c) => c.criterion), ac, "whitespace-tolerant, content-strict: the TASK's strings come back");
  assert.equal(ok.note, "one unmet");

  assert.equal(parseTaskReview("no fence at all", { acceptanceCriteria: ac }), null, "missing block");
  assert.equal(parseTaskReview("```review\n{not json\n```", { acceptanceCriteria: ac }), null, "unparseable");
  assert.equal(parseTaskReview(block({ criteria: [
    { criterion: AC1, verdict: "pass" }, { criterion: AC2 }], overall: "pass", note: "" }),
    { acceptanceCriteria: ac }), null, "a criterion missing its verdict");
  assert.equal(parseTaskReview(block({ criteria: [
    { criterion: AC1, verdict: "maybe" }, { criterion: AC2, verdict: "pass" }], overall: "pass", note: "" }),
    { acceptanceCriteria: ac }), null, "unknown verdict value");
  assert.equal(parseTaskReview(block({ criteria: [
    { criterion: AC1, verdict: "pass" }, { criterion: "the page names the company WELL", verdict: "pass" }], overall: "pass", note: "" }),
    { acceptanceCriteria: ac }), null, "tampered criterion text");
  assert.equal(parseTaskReview(block({ criteria: [{ criterion: AC1, verdict: "pass" }], overall: "pass", note: "" }),
    { acceptanceCriteria: ac }), null, "an unjudged criterion");
  assert.equal(parseTaskReview(block({ criteria: [
    { criterion: AC1, verdict: "fail" }, { criterion: AC2, verdict: "pass" }], overall: "pass", note: "" }),
    { acceptanceCriteria: ac }), null, "declared overall contradicts the verdicts");
  assert.equal(parseTaskReview(block({ criteria: [
    { criterion: AC1, verdict: "pass" }, { criterion: AC1, verdict: "pass" }], overall: "pass", note: "" }),
    { acceptanceCriteria: ac }), null, "duplicated criterion");
  const big = Array.from({ length: 21 }, (_, i) => `criterion ${i}`);
  assert.equal(parseTaskReview(block({ criteria: big.map((c) => ({ criterion: c, verdict: "pass" })), overall: "pass", note: "" }),
    { acceptanceCriteria: big }), null, ">20 criteria is out of bounds");
  const noted = parseTaskReview(block({ criteria: [{ criterion: AC1, verdict: "pass" }], overall: "pass", note: "x".repeat(1500) }),
    { acceptanceCriteria: [AC1] });
  assert.equal(noted.note.length, 1000, "the note is bounded");
});

test("no reviewer model configured → deterministic path + honest note by:'deterministic'", async () => {
  MODE.plan = "with_ac"; MODE.rev = "pass";
  const connId = (await state()).connections[0].id;
  const un = await post("/api/assign", { slot: "high-trust-review", connectionId: null });
  assert.equal(un.status, 200);
  const reviewsBefore = reviewBodies().length;
  try {
    const { pid } = await launchMission("DETMARK");
    const t1 = await until(async () => {
      const t = await subOf(pid, "alpha reviewed step");
      return t?.status === "done" && t.review ? t : null;
    });
    assert.equal(t1.review.ok, true);
    assert.equal(t1.review.by, "deterministic");
    assert.equal(t1.review.note, "deterministic checks only — no reviewer model configured");
    assert.deepEqual(t1.review.criteria, []);
    assert.equal(reviewBodies().length, reviewsBefore, "no reviewer call was made");
  } finally {
    await post("/api/assign", { slot: "high-trust-review", connectionId: connId });
  }
});

test("no acceptanceCriteria → the pre-review path, unchanged (no review field, no reviewer call)", async () => {
  MODE.plan = "no_ac"; MODE.rev = "pass";
  const reviewsBefore = reviewBodies().length;
  const { pid, m } = await launchMission("PLAINMARK");

  const t1 = await until(async () => {
    const t = await subOf(pid, "alpha plain step");
    return t?.status === "done" ? t : null;
  });
  assert.equal(t1.review, undefined, "no review record — migration-safe, field appears only on use");
  assert.equal(t1.result.ok, true);
  assert.equal(t1.result.summary, WORKER_OUT.slice(0, 200), "the same reportMissionToTask summary as before");
  assert.equal(t1.result.artifacts.length, 1);
  assert.ok(String(t1.result.artifacts[0]).startsWith("completion:"), "the same artifact shape as before");
  assert.equal(t1.missionId, m.id);
  const t2 = await until(async () => {
    const t = await subOf(pid, "beta plain step");
    return t?.status === "done" ? t : null;
  });
  assert.equal(t2.review, undefined);
  assert.equal(reviewBodies().length, reviewsBefore, "no reviewer call for criteria-less tasks");
  await until(async () => (await state()).missions.find((x) => x.id === m.id)?.status === "done" || null);
});

test("i18n parity + the review line escapes every field (malicious note rendered escaped)", async () => {
  const { LOCALES, missingKeys, CATALOG } = await import("./i18n.mjs");
  for (const loc of LOCALES) assert.deepEqual(missingKeys(loc), [], `${loc} is missing keys`);
  for (const loc of LOCALES)
    for (const k of ["review.title", "review.pass", "review.fail", "review.by.reviewer", "review.by.deterministic"])
      assert.ok(CATALOG[loc][k], `${loc} has ${k}`);

  const { SHELL_PAGE } = await import("./shell.mjs");
  assert.match(SHELL_PAGE, /function reviewLine\(/, "the review line component exists");
  const vm = await import("node:vm");
  const start = SHELL_PAGE.indexOf("function reviewLine(");
  const end = SHELL_PAGE.indexOf("/** A finished run", start);
  assert.ok(start > 0 && end > start, "reviewLine found in the shell");
  const sandbox = {
    t: (k) => CATALOG.en[k] || k,
    esc: (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])),
  };
  vm.createContext(sandbox);
  vm.runInContext(SHELL_PAGE.slice(start, end), sandbox);
  const EVIL = '</div><img src=x onerror=alert(1)>';
  const html = sandbox.reviewLine({ ok: false, note: EVIL, by: "reviewer" });
  assert.ok(!html.includes(EVIL), "the raw note markup is NOT rendered");
  assert.ok(html.includes("&lt;/div&gt;&lt;img src=x onerror=alert(1)&gt;"), "the escaped note appears");
  assert.ok(html.includes(CATALOG.en["review.fail"]) && html.includes(CATALOG.en["review.by.reviewer"]),
    "verdict and reviewer labels come from the catalog");
  const det = sandbox.reviewLine({ ok: true, note: "deterministic checks only — no reviewer model configured", by: "deterministic" });
  assert.ok(det.includes(CATALOG.en["review.pass"]) && det.includes(CATALOG.en["review.by.deterministic"]));
});
