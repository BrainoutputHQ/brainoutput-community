// SPDX-License-Identifier: Apache-2.0
// Review-contract robustness (task-pm-20). Live evidence: a real opencode run produced a real
// index.html yet the task blocked TWICE on "review could not be parsed" — the match-back was
// strict on FORM (production-shaped prompts make free models paraphrase) and the raw reviewer
// output was DISCARDED on parse failure. Pinned here:
//   OBSERVABILITY — a parse failure / self-contradictory block note carries a bounded (≤200
//     chars, whitespace-collapsed), LABELED slice of the raw reviewer output, rendered esc()'d.
//   FORM-NORMALIZED match-back — case, collapsed spacing, surrounding quotes/punctuation and a
//     leading list marker are form; every WORD must still match (reworded/dropped → null).
//   STRICT-REMINDER RETRY — parse failure → ONE extra bounded reviewer call with a stricter
//     prompt. Not on reviewer-unavailable (its own transient retry), not on a judged FAIL.
//   maxTokens 1600 on the first call, 3200 on the strict retry (task-pm-22: the retry doubles the
//     base so a truncated attempt gets room to finish).
// Separate file from taskreview.test.mjs: that suite pins the review CONTRACT (byte-stable
// pins, shared MODE stub); this one drives per-marker reviewer behaviors (prose→valid,
// prose-always, contradiction, fail-stands, reviewer-down) — no mode cross-talk.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 4462;
const BASE = `http://127.0.0.1:${PORT}`;
let srv, dir, stub;

const AC1 = "the landing page exists as a real file";
const AC2 = "the page names the company";
const WORKER_OUT = "Built it for real. " + "Concrete work output follows: the file was written and checked. ".repeat(4);
const PROSE = "I looked at the work and honestly it all seems fine to me, ship it. ".repeat(8); // >200 chars, no fence
// A well-formed verdict cut off mid-JSON (task-pm-22 live evidence) — the fence never closes.
const TRUNC = "```review\n" + JSON.stringify({ criteria: [{ criterion: AC1, verdict: "pass",
  evidence: "the diff shows the file written and the head of the page naming the comp" }], overall: "pass" }).slice(0, -20);
const bodies = [];
const counts = new Map();
const seen = (m) => { const n = (counts.get(m) || 0) + 1; counts.set(m, n); return n; };
const promptOf = (d) => { try { return JSON.parse(d).messages?.[0]?.content || ""; } catch { return ""; } };
const maxTokensOf = (d) => { try { return JSON.parse(d).max_tokens; } catch { return null; } };
const reviewerBodies = (mark) => bodies.filter((d) => d.includes("rigorous reviewer for THIS task") && d.includes(mark));

/** Extract the numbered acceptance criteria the review prompt lists (verbatim round-trip). */
const criteriaFrom = (p) => {
  const sec = p.split("ACCEPTANCE CRITERIA")[1] || "";
  return sec.split("\n").map((l) => l.match(/^\d+\. (.+)$/)).filter(Boolean).map((m) => m[1]);
};
const reviewJson = (p, mode) => {
  const entries = criteriaFrom(p).map((c, i) => ({ criterion: c,
    verdict: mode === "fail" && i === 0 ? "fail" : "pass",
    evidence: mode === "fail" && i === 0 ? "nothing in the result or artifacts proves this" : `the diff shows it: ${c}` }));
  return "```review\n" + JSON.stringify({ criteria: entries,
    // CONTRADICT: per-criterion all-pass but the declared overall disagrees.
    overall: mode === "contradict" ? (entries.some((e) => e.verdict === "fail") ? "pass" : "fail")
      : entries.some((e) => e.verdict === "fail") ? "fail" : "pass",
    note: mode === "fail" ? "one criterion lacks evidence" : "every criterion is evidenced" }) + "\n```";
};

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "bo-reviewrobust-"));
  const { createServer } = await import("node:http");
  stub = createServer((req, res) => {
    let d = ""; req.on("data", (c) => (d += c));
    req.on("end", () => {
      bodies.push(d);
      const say = (content) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ choices: [{ message: { content } }] })); };
      const failWith = (code, message) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message } })); };
      if (d.includes("rigorous reviewer for THIS task")) {
        if (d.includes("REVDOWNROBMARK")) return failWith(502, "ResourceExhausted: reviewer quota burned");
        if (d.includes("CONTRADICTMARK")) return say(reviewJson(promptOf(d), "contradict"));
        if (d.includes("FAILSTANDMARK")) return say(reviewJson(promptOf(d), "fail"));
        if (d.includes("PROSE2PASSMARK")) { const n = seen("PROSE2PASSMARK"); if (n === 1) return say(PROSE); return say(reviewJson(promptOf(d), "pass")); }
        if (d.includes("TRUNC2PASSMARK")) { const n = seen("TRUNC2PASSMARK"); if (n === 1) return say(TRUNC); return say(reviewJson(promptOf(d), "pass")); }
        if (d.includes("PROSEALWAYSMARK")) return say(PROSE);
        return say(reviewJson(promptOf(d), "pass"));
      }
      if (d.includes("PLAN DECISIONS:")) return say("NOT_COVERED");
      return say(WORKER_OUT);
    });
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  srv = spawn(process.execPath, [join(HERE, "web-server.mjs")],
    { env: { ...process.env, BO_CE_DATA: dir, BO_CE_WEB_PORT: String(PORT),
      BO_CE_FREE_ENDPOINT: `http://127.0.0.1:${stub.address().port}/v1/chat/completions`,
      BO_CE_STAGE_RETRY_BACKOFF_MS: "0,0",      // instant clock — the reviewer-down retries don't sleep
      BO_OPENCODE_BIN: "/nonexistent-opencode" }, stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    try { await fetch(`${BASE}/api/state`); break; } catch { await new Promise((r) => setTimeout(r, 250)); if (i === 59) throw new Error("server did not start"); }
  }
  await post("/api/onboard", { companyName: "Rob Co", companyDoes: "tests", departments: ["technical"] });
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

/** A validated → materialized single-task plan carrying acceptance criteria, launched. */
async function launchReviewed(title, acceptanceCriteria = [AC1, AC2]) {
  const p = await post("/api/project", { name: `rob-${title.slice(0, 12)}` });
  const pid = p.body.project.id;
  const created = await post("/api/plan/new", { objective: `plan for ${title}`, projectId: pid,
    decisions: "esm only, zero-dep", taskDrafts: [{ title, acceptanceCriteria }] });
  assert.equal(created.status, 200, JSON.stringify(created.body).slice(0, 300));
  assert.equal((await post("/api/plan/validate", { id: created.body.plan.id })).status, 200);
  const done = await post("/api/plan/materialize", { id: created.body.plan.id });
  assert.equal(done.status, 200, JSON.stringify(done.body).slice(0, 300));
  const [T] = done.body.tasks;
  const launch = await post("/api/task/launch", { id: T.id });
  assert.equal(launch.status, 200, JSON.stringify(launch.body).slice(0, 300));
  return T;
}

// ── 1 · strict-reminder retry: prose then a valid block → 2 calls, task PASSES ────────────────
test("parse failure → ONE strict-reminder retry: prose then valid → 2 reviewer calls, strict instruction, task done", async () => {
  const { REVIEW_STRICT_REMINDER } = await import("./review-tasks.mjs");
  const T = await launchReviewed("build the PROSE2PASSMARK page");
  const fin = await until(async () => {
    const t = await taskOf(T.id);
    return t?.status === "done" && t.review ? t : null;
  });
  assert.equal(fin.review.ok, true);
  assert.equal(fin.review.by, "reviewer");
  assert.equal(fin.review.note, "every criterion is evidenced");
  const calls = reviewerBodies("PROSE2PASSMARK");
  assert.equal(calls.length, 2, "exactly one bounded retry after the unparseable first output");
  assert.ok(!promptOf(calls[0]).includes("STRICT FORMAT"), "the first call is the plain review prompt");
  assert.ok(promptOf(calls[1]).includes(REVIEW_STRICT_REMINDER), "the retry carries the full strict reminder");
  assert.ok(promptOf(calls[1]).includes("ONLY the fenced"), "only the fenced block, no commentary");
  assert.ok(promptOf(calls[1]).includes("EXACTLY as given"), "criteria copied exactly");
  assert.equal(maxTokensOf(calls[0]), 1600, "base budget on the first review call (task-pm-22)");
  assert.equal(maxTokensOf(calls[1]), 3200, "the strict retry doubles the base budget");
});

// ── 1b · truncated-block first + valid second → PASSES, exactly 2 calls (task-pm-22) ──────────
test("well-formed verdict truncated mid-JSON → strict retry recovers: task done, exactly 2 reviewer calls", async () => {
  const T = await launchReviewed("build the TRUNC2PASSMARK page");
  const fin = await until(async () => {
    const t = await taskOf(T.id);
    return t?.status === "done" && t.review ? t : null;
  });
  assert.equal(fin.review.ok, true);
  assert.equal(fin.review.by, "reviewer");
  assert.equal(fin.review.note, "every criterion is evidenced");
  const calls = reviewerBodies("TRUNC2PASSMARK");
  assert.equal(calls.length, 2, "the truncated attempt + one strict retry, no more");
  assert.equal(maxTokensOf(calls[0]), 1600, "base budget on the first call");
  assert.equal(maxTokensOf(calls[1]), 3200, "the retry gets double — room to finish the block");
});

// ── 2 · prose twice → blocked, the note carries the bounded labeled raw slice ─────────────────
test("prose twice → blocked with the labeled raw slice (≤200 chars, whitespace-collapsed) on the note", async () => {
  const T = await launchReviewed("build the PROSEALWAYSMARK page");
  const blocked = await until(async () => {
    const t = await taskOf(T.id);
    return t?.status === "blocked" && t.review ? t : null;
  });
  assert.equal(blocked.review.ok, false);
  assert.equal(blocked.review.by, "reviewer");
  assert.match(blocked.review.note, /^review could not be parsed — raw: /, "the labeled raw slice");
  const slice = blocked.review.note.split("— raw: ")[1];
  assert.ok(slice.length <= 200, `bounded: ${slice.length} chars`);
  assert.ok(slice.endsWith("…"), "truncation is visible");
  assert.ok(slice.includes("honestly it all seems fine"), "the verbatim reviewer words are diagnosable");
  assert.ok(!slice.includes("\n"), "whitespace-collapsed");
  assert.deepEqual(blocked.review.criteria, []);
  assert.match(blocked.result.summary, /review could not be parsed — raw: /, "the block reason surfaces on the task detail");
  assert.equal(reviewerBodies("PROSEALWAYSMARK").length, 2, "one retry, then blocked honestly");
});

// ── 3 · self-contradictory block → contradiction note + raw slice ─────────────────────────────
test("parsed block contradicts itself (overall vs criteria) → blocked with the contradiction note + raw slice", async () => {
  const T = await launchReviewed("build the CONTRADICTMARK page");
  const blocked = await until(async () => {
    const t = await taskOf(T.id);
    return t?.status === "blocked" && t.review ? t : null;
  });
  assert.equal(blocked.review.ok, false);
  assert.equal(blocked.review.by, "reviewer");
  assert.match(blocked.review.note, /^review contradicts itself \(overall verdict vs per-criterion verdicts\) — raw: /);
  assert.ok(blocked.review.note.split("— raw: ")[1].includes("```review"), "the raw block is right there in the note");
  assert.equal(reviewerBodies("CONTRADICTMARK").length, 2, "a contradiction is a parse failure — one retry, then blocked");
});

// ── 4 · a judged FAIL stands — NO retry ────────────────────────────────────────────────────────
test("parsed FAIL verdict → NO retry (a judged fail stands): 1 reviewer call, blocked naming the criterion", async () => {
  const T = await launchReviewed("build the FAILSTANDMARK page");
  const blocked = await until(async () => {
    const t = await taskOf(T.id);
    return t?.status === "blocked" && t.review ? t : null;
  });
  assert.equal(blocked.review.ok, false);
  assert.equal(blocked.review.by, "reviewer");
  assert.ok(blocked.review.note.startsWith("failing criteria:"), "the judged fail note, not a parse note");
  assert.ok(blocked.review.note.includes(AC1), "the failing criterion named verbatim");
  assert.equal(reviewerBodies("FAILSTANDMARK").length, 1, "a parseable FAIL is never retried");
});

// ── 5 · reviewer-unavailable path unchanged — no parse-retry stacking ─────────────────────────
test("reviewer down → by:'reviewer-unavailable' with its own transient retry (3 calls), never the parse note", async () => {
  const T = await launchReviewed("build the REVDOWNROBMARK page");
  const blocked = await until(async () => {
    const t = await taskOf(T.id);
    return t?.status === "blocked" && t.review ? t : null;
  });
  assert.equal(blocked.review.by, "reviewer-unavailable");
  assert.match(blocked.review.note, /^reviewer unavailable — /);
  assert.match(blocked.review.note, /failed \(502\): ResourceExhausted/);
  assert.doesNotMatch(blocked.review.note, /could not be parsed|raw: /, "no parse-retry stacking on a stage failure");
  assert.equal(reviewerBodies("REVDOWNROBMARK").length, 3, "1 initial + 2 transient retries — then no strict-reminder call");
});

// ── 6 · normalization fixtures: faithful-but-restyled parse, reworded → null ──────────────────
test("match-back normalizes FORM only: restyled-faithful criteria parse with verdicts intact", async () => {
  const { parseTaskReview } = await import("./review-tasks.mjs");
  const ac = [AC1, AC2];
  const block = (entries, overall = "pass") => "```review\n" + JSON.stringify({ criteria: entries, overall, note: "n" }) + "\n```";
  const restyled = [
    "THE LANDING PAGE EXISTS AS A REAL FILE",                 // case
    "  the   landing  page\nexists as a real file  ",          // collapsed spacing
    "1. the landing page exists as a real file",               // a leading list marker
    "\"the landing page exists as a real file\"",              // straight quotes
    "“the landing page exists as a real file”",                // curly quotes
    "the landing page exists as a real file.",                 // trailing punctuation
  ];
  for (const r of restyled) {
    const got = parseTaskReview(block([{ criterion: r, verdict: "fail", evidence: "absent" },
      { criterion: AC2, verdict: "pass", evidence: "shown" }], "fail"), { acceptanceCriteria: ac });
    assert.ok(got, `restyled-faithful parses: ${JSON.stringify(r)}`);
    assert.deepEqual(got.criteria.map((c) => c.criterion), ac, "the TASK's verbatim strings come back");
    assert.deepEqual(got.criteria.map((c) => c.verdict), ["fail", "pass"], "verdicts intact");
    assert.equal(got.overall, "fail");
  }
  const reworded = [
    "the landing page exists as a file",                       // a word dropped
    "the landing page exists as a real document",              // a word changed
    "landing page exists as a real file",                      // leading word dropped
    "the landing page exists as a real file somewhere",        // a word added
  ];
  for (const r of reworded)
    assert.equal(parseTaskReview(block([{ criterion: r, verdict: "pass" },
      { criterion: AC2, verdict: "pass" }]), { acceptanceCriteria: ac }), null,
      `reworded is content, not form — still null: ${JSON.stringify(r)}`);
});

// ── 7 · diag reasons + the raw-slice helper + the strict reminder contract ────────────────────
test("diag reasons, reviewRawSlice bounds, REVIEW_STRICT_REMINDER content", async () => {
  const { parseTaskReview, reviewRawSlice, REVIEW_STRICT_REMINDER } = await import("./review-tasks.mjs");
  const diag = {};
  assert.equal(parseTaskReview("no fence at all", { acceptanceCriteria: [AC1], diag }), null);
  assert.equal(diag.reason, "no-block");
  assert.equal(parseTaskReview("```review\n" + JSON.stringify({ criteria: [{ criterion: AC1, verdict: "pass" }], overall: "fail", note: "" }) + "\n```",
    { acceptanceCriteria: [AC1], diag }), null);
  assert.equal(diag.reason, "contradiction", "the caller can build the contradiction note");
  assert.equal(parseTaskReview("```review\n{bad\n```", { acceptanceCriteria: [AC1], diag }), null);
  assert.equal(diag.reason, "json");

  assert.equal(reviewRawSlice("  lots   of\n\nwhite   space "), "lots of white space");
  assert.equal(reviewRawSlice("x".repeat(500)).length, 200, "bounded at 200 incl. the ellipsis");
  assert.ok(reviewRawSlice("x".repeat(500)).endsWith("…"));
  assert.equal(reviewRawSlice(null), "");

  assert.ok(REVIEW_STRICT_REMINDER.includes("ONLY the fenced ```review block"));
  assert.ok(REVIEW_STRICT_REMINDER.includes("EXACTLY as given"));
});

// ── 8 · i18n parity (en/fr/de) — the note is built from parts, the slice never translated ─────
test("i18n parity: review.note.parseFailed / review.note.contradictory in en/fr/de with a {raw} slot", async () => {
  const { LOCALES, missingKeys, CATALOG, t } = await import("./i18n.mjs");
  for (const loc of LOCALES) assert.deepEqual(missingKeys(loc), [], `${loc} is missing keys`);
  for (const loc of LOCALES)
    for (const k of ["review.note.parseFailed", "review.note.contradictory"]) {
      assert.ok(CATALOG[loc][k], `${loc} has ${k}`);
      assert.ok(CATALOG[loc][k].includes("{raw}"), `${loc} ${k}: the raw slice slot is delimited`);
    }
  assert.equal(t("en", "review.note.parseFailed").split("{raw}")[0], "review could not be parsed — raw: ");
  assert.ok(t("fr", "review.note.parseFailed").startsWith("revue impossible à analyser"));
  assert.ok(t("de", "review.note.parseFailed").startsWith("Review konnte nicht geparst werden"));
});

// ── 9 · the raw slice renders esc()'d in the task detail (reviewLine pattern) ─────────────────
test("reviewLine renders the raw-slice note escaped — model output can never inject markup", async () => {
  const { SHELL_PAGE } = await import("./shell.mjs");
  const { CATALOG } = await import("./i18n.mjs");
  const start = SHELL_PAGE.indexOf("function reviewLine(");
  const end = SHELL_PAGE.indexOf("/** A finished run", start);
  assert.ok(start > 0 && end > start, "reviewLine found in the shell");
  const vm = await import("node:vm");
  const sandbox = {
    t: (k) => CATALOG.en[k] || k,
    esc: (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])),
  };
  vm.createContext(sandbox);
  vm.runInContext(SHELL_PAGE.slice(start, end), sandbox);
  const EVIL = '</div><img src=x onerror=alert(1)>';
  const html = sandbox.reviewLine({ ok: false,
    note: `review could not be parsed — raw: ${EVIL}`, by: "reviewer" });
  assert.ok(!html.includes(EVIL), "the raw reviewer output is NOT rendered as markup");
  assert.ok(html.includes("&lt;/div&gt;&lt;img src=x onerror=alert(1)&gt;"), "the escaped slice appears");
  assert.ok(html.includes("review could not be parsed — raw: "), "the label renders");
});
