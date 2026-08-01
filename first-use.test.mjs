#!/usr/bin/env node --test
// SPDX-License-Identifier: Apache-2.0
//
// FIRST USE, REPLAYED AS TESTS.
//
// A real first session went wrong in nine recognizable ways (project status read as a status
// string, "do them" lost the thread, a campaign drafted for the wrong department with no review
// stage, an unrenderable image promised as done, duplicated output, mojibake, silent token
// undercounting). Every one was reachable in the first ten minutes — and none had a test.
// This suite walks the product the way a first user does and pins the behavior that must hold.
// Model calls run against a local mock HTTP server; everything else is pure logic.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.mjs";
import { newProject, projectBrief } from "./projects.mjs";
import { newConversation, addMessage, draftMissionSpec, approveMission, modeAllows, looksLikeWork,
         askTail, inferDepartment, missionWorkerPrompt, unmetDeliverables, deliverableGapNote,
         PUBLIC_FACING_RE, retrieveRelevant } from "./chat.mjs";
import { planGraph, safeSlice } from "./ce-core.mjs";
import { chatCompletion, execLogLine } from "./adapters.mjs";
import { efficiencyReport } from "./efficiency.mjs";
import { CATALOG } from "./i18n.mjs";

const clean = () => new Store(mkdtempSync(join(tmpdir(), "bo-firstuse-")));

// The two tasks the user could see but the assistant could not describe.
function storeWithProj1() {
  const s = clean();
  s.setCompany({ name: "Hotel Soleil", does: "a family-run lakeside hotel" }).save();
  const p = newProject({ id: "proj-1", name: "proj1", at: 1 });
  s.addProject(p);
  s.addTask({ id: "t1", projectId: "proj-1", title: "do something", status: "todo" });
  s.addTask({ id: "t2", projectId: "proj-1", title: "do something else", status: "todo" });
  s.saveRuntime();
  return s;
}

test("scenario: 'where do we stand on proj1' — the brief says OPEN TASKS, not a status string", () => {
  const s = storeWithProj1();
  const brief = projectBrief(s.runtime, "proj-1");
  assert.match(brief, /open tasks \(2\): "do something"; "do something else"/,
    "a model reading this cannot mistake the task list for a status");
  assert.match(brief, /0 mission\(s\)/);
  assert.ok(!/\bopen: /.test(brief), "the ambiguous 'open:' serialization is gone");
});

test("scenario: 'i see 2 tasks in proj1' — the state never contradicts itself turn over turn", () => {
  const s = storeWithProj1();
  const brief = projectBrief(s.runtime, "proj-1");
  const tasks = s.runtime.tasks.filter((t) => t.projectId === "proj-1" && t.status !== "done");
  assert.equal(tasks.length, 2);
  assert.ok(brief.includes(`open tasks (${tasks.length})`), "the brief and the task spine agree");
});

test("scenario: 'do them' — a follow-up resolves against the RECENT TAIL retrieval cannot see", () => {
  let conv = newConversation({ scope: "company", id: "c1" });
  conv = addMessage(conv, { role: "user", text: "where do we stand on proj1?", mode: "ask", at: 1 });
  conv = addMessage(conv, { role: "assistant", text: "Two open tasks: 1. do something 2. do something else", mode: "ask", at: 2 });
  // proof that retrieval alone cannot resolve the reference — no lexical overlap at all
  assert.deepEqual(retrieveRelevant(conv, "do them"), [], "retrieval sees nothing (expected)");
  // …and the reason the ask path must send the recent tail:
  const tail = askTail(conv, { n: 6 });
  assert.equal(tail.length, 2);
  assert.ok(tail.some((m) => m.text.includes("do something else")),
    "the model now sees the task list when answering 'do them'");
});

test("scenario: 'need to create a campaign…' is recognized as work even in polite phrasing", () => {
  assert.equal(looksLikeWork("need to create a campaign for a promotion -30% off in august"), true);
  assert.equal(looksLikeWork("I need a PDF brochure for the hotel"), true);
  assert.equal(looksLikeWork("generate the pic and IG post text"), true);
  assert.equal(looksLikeWork("what is the status of proj1?"), false, "questions stay questions");
  assert.equal(looksLikeWork("do them"), false, "a bare follow-up is not a new work request");
});

test("scenario: the campaign goes to MARKETING when it exists — not to the first department", () => {
  const depts = ["technical", "customer-service", "finance", "marketing"];
  assert.equal(inferDepartment("create a campaign for a promotion -30% off, generate the IG post text", depts), "marketing");
  assert.equal(inferDepartment("reply to a refund request from a guest", depts), "customer-service");
  assert.equal(inferDepartment("reconcile the invoices for July", depts), "finance");
  assert.equal(inferDepartment("do something", depts), null, "no vocabulary → no guess");
  assert.equal(inferDepartment("create an instagram campaign", ["technical"]), null,
    "only EXISTING departments are inferred — the caller falls back honestly");
});

test("scenario: public-facing work gets an independent reviewer stage by default", () => {
  let conv = newConversation({ scope: "company", id: "c1" });
  conv = addMessage(conv, { role: "user", text: "need to create a campaign for a promotion -30% off in august. generate the pic and IG post text", mode: "plan", at: 1 });
  const spec = draftMissionSpec(conv, { department: "marketing" });
  assert.equal(spec.task.requireReview, true, "the draft flags review for public-facing content");
  assert.ok(spec.graph.nodes.includes("reviewer"), "the drafted graph contains a reviewer");
  assert.equal(spec.graph.shape, "worker-reviewer");
  // internal work stays lean — no reviewer theater for a refund-policy reply between colleagues
  let c2 = newConversation({ scope: "company", id: "c2" });
  c2 = addMessage(c2, { role: "user", text: "summarize our refund policy for the team wiki", mode: "plan", at: 1 });
  assert.equal(planGraph(draftMissionSpec(c2, { department: "operations" }).task).nodes.some((n) => String(n.node).startsWith("reviewer")), false);
});

test("scenario: the launch gate — nothing executes from draft; approval unlocks it exactly once", () => {
  let conv = newConversation({ scope: "company", id: "c1" });
  conv = addMessage(conv, { role: "user", text: "create the august campaign", mode: "plan", at: 1 });
  const draft = draftMissionSpec(conv, { department: "marketing" });
  assert.equal(modeAllows("execute", "execute", { mission: draft }).allowed, false, "a DRAFT cannot launch");
  const approved = approveMission(draft, { agents: [{ id: "m1", department: "marketing", role: "marketer" }] });
  assert.equal(modeAllows("execute", "execute", { mission: approved }).allowed, true);
});

test("scenario: 'generate the pic' with no image model → the completion says so, in plain words", () => {
  const gaps = unmetDeliverables("generate the pic and IG post text", ["completion:zen/nemotron"], { imageGenAvailable: false });
  assert.deepEqual(gaps, ["image"]);
  const note = deliverableGapNote(gaps);
  assert.match(note, /NOT rendered/);
  assert.match(note, /image-gen/);
  assert.equal(unmetDeliverables("write the IG caption", ["completion:x"], {}).length, 0, "text-only asks have no gap");
  assert.equal(unmetDeliverables("generate the pic", ["completion:x"], { imageGenAvailable: true }).length, 0,
    "a configured image-gen slot closes the gap");
});

test("scenario: the worker prompt carries the COMPANY — no invented 'generic lifestyle brand'", () => {
  const p = missionWorkerPrompt({
    objective: "create the august -30% campaign",
    constraints: [], acceptanceCriteria: [],
    company: { name: "Hotel Soleil", does: "a family-run lakeside hotel", website: "https://soleil.example" },
  });
  assert.match(p, /Hotel Soleil/);
  assert.match(p, /family-run lakeside hotel/);
  assert.match(p, /never invent a different business/);
  const anon = missionWorkerPrompt({ objective: "x" });
  assert.ok(!/Company:/.test(anon), "no company configured → no invented section");
});

test("scenario: model output with emoji split across TCP chunks arrives INTACT (no 🕶��)", async () => {
  const EMOJI = "☀️ SUMMER 🕶️ 30% ☀️";
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    const payload = Buffer.from(JSON.stringify({
      choices: [{ message: { content: `Frame 2: "${EMOJI} Yes, even the new drops"` } }],
      usage: { total_tokens: 1200, prompt_tokens: 800, completion_tokens: 400 },
    }));
    // split INSIDE the multibyte emoji on purpose — the worst case for chunk assembly
    const cut = payload.indexOf(Buffer.from("🕶️")) + 2;
    res.write(payload.subarray(0, cut));
    setTimeout(() => { res.end(payload.subarray(cut)); }, 10);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const r = await chatCompletion({ endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, model: "m", prompt: "x" });
    assert.ok(r.content.includes("🕶️"), "the emoji survives chunking");
    assert.ok(!r.content.includes("�"), "no replacement characters anywhere");
    assert.equal(r.tokens, 1200);
    assert.equal(r.tokenScope, "total");
  } finally { server.close(); }
});

test("scenario: a provider reporting only completion tokens is shown as output-only, not a total", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { completion_tokens: 998 } }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const r = await chatCompletion({ endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, model: "m", prompt: "x" });
    assert.equal(r.tokens, 998);
    assert.equal(r.tokenScope, "output-only", "998 is the OUTPUT count — the run card must not call it the total");
    const eff = efficiencyReport({ plan: [{ node: "worker" }], results: [{ node: "worker", tokens: r.tokens, tokenScope: r.tokenScope }], shape: "single" });
    assert.equal(eff.tokensScope, "partial");
    assert.equal(efficiencyReport({ plan: [], results: [{ node: "worker", tokens: 10, tokenScope: "total" }] }).tokensScope, "total");
  } finally { server.close(); }
});

test("scenario: logs stay bounded snippets — the deliverable is never duplicated into the log pane", () => {
  const huge = "🕶️ summer campaign text. ".repeat(500);          // ~12.5k chars of deliverable
  const line = execLogLine({ node: "worker", output: huge });
  assert.ok(line.length <= 450, `a log line is a snippet (got ${line.length} chars)`);
  assert.ok(line.length < huge.length / 10, "orders of magnitude smaller than the deliverable");
  assert.ok(!line.includes("�"), "the cut never splits an emoji");
  assert.match(line, /^worker: /);
  assert.equal(execLogLine({ node: "gate", gate: true }), "gate: human approval required");
  assert.match(execLogLine({ node: "w", needsConfiguration: true }), /UNCONFIGURED/);
});

test("scenario: the run card says 'stages not used' — 'skipped human-approval' can never be printed", () => {
  assert.equal(CATALOG.en["run.skipped"], "stages not used");
  assert.equal(CATALOG.fr["run.skipped"], "étapes non utilisées");
  assert.equal(CATALOG.de["run.skipped"], "nicht genutzte Stufen");
  for (const locale of ["en", "fr", "de"]) assert.ok(CATALOG[locale]["run.tokensPartial"], `${locale} partial-tokens label`);
});

test("scenario: safeSlice never breaks a surrogate pair (briefs, summaries, snippets)", () => {
  const s = "campaign 🕶️☀️🏖️🍦 text";
  for (let n = 1; n < s.length; n++) assert.ok(!safeSlice(s, n).includes("�"), `cut at ${n}`);
  assert.equal(safeSlice(s, 1000), s);
});

test("scenario: public-facing regex catches the vocabulary and ignores internal work", () => {
  assert.ok(PUBLIC_FACING_RE.test("IG post for the august campaign"));
  assert.ok(PUBLIC_FACING_RE.test("write our launch newsletter"));
  assert.ok(!PUBLIC_FACING_RE.test("summarize the refund policy for the wiki"));
  assert.ok(!PUBLIC_FACING_RE.test("reconcile July invoices"));
});
