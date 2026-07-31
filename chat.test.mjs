// SPDX-License-Identifier: Apache-2.0
// Command Center chat core — scopes, modes, MissionSpec, token efficiency. Zero-dep: `node --test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHAT_MODES, newConversation, addMessage, pin, resolveMention, rollSummary, retrieveRelevant,
  compactContext, draftMissionSpec, editMissionSpec, validateMissionSpec, approveMission, rejectMission,
  modeAllows, missionComposer, reviewMission, saveAsWorkflow, looksLikeWork,
} from "./chat.mjs";

const AGENTS = [{ id: "eng-architect", department: "technical", role: "architect" }, { id: "cs-agent", department: "customer-service", role: "support" }];

test("scopes: company, department and agent conversations (agent/department require a target)", () => {
  assert.equal(newConversation({ scope: "company" }).scope, "company");
  assert.equal(newConversation({ scope: "department", department: "finance" }).department, "finance");
  assert.equal(newConversation({ scope: "agent", agentId: "cs-agent" }).agentId, "cs-agent");
  assert.throws(() => newConversation({ scope: "agent" }), /needs an agentId/);
  assert.throws(() => newConversation({ scope: "nope" }), /unknown chat scope/);
});

test("@mention retargets to a named agent", () => {
  assert.equal(resolveMention("hey @eng-architect can you look?", AGENTS).id, "eng-architect");
  assert.equal(resolveMention("no mention here", AGENTS), null);
});

test("token efficiency: rolling summary keeps a tail and advances the watermark", () => {
  let c = newConversation({ scope: "company" });
  for (let i = 0; i < 12; i++) c = addMessage(c, { text: `message number ${i}` });
  const rolled = rollSummary(c, { every: 10, keepTail: 4 });
  assert.ok(rolled.summary && rolled.summary.length > 0);
  assert.equal(rolled.summarizedThrough, 8);          // 12 - keepTail
  assert.equal(rollSummary(rolled, { every: 10 }).summary, rolled.summary); // no churn until `every` more
});

test("token efficiency: retrieval returns only relevant messages", () => {
  let c = newConversation({ scope: "company" });
  c = addMessage(c, { text: "we need a refund policy page in Spanish" });
  c = addMessage(c, { text: "unrelated chatter about the office plants" });
  c = addMessage(c, { text: "the refund window should be 30 days" });
  const hits = retrieveRelevant(c, "refund window", { k: 2 });
  assert.equal(hits.length, 2);
  assert.ok(hits.every((m) => /refund/.test(m.text)));
});

test("the executor never receives the transcript — only summary, pins, relevant msgs and artifact REFS", () => {
  let c = newConversation({ scope: "company" });
  for (let i = 0; i < 6; i++) c = addMessage(c, { text: `secret internal chatter ${i}` });
  c = addMessage(c, { text: "build a slugify function" });
  c = pin(c, { kind: "constraint", text: "no external dependencies" });
  const ctx = compactContext(c, { query: "slugify", k: 2, artifacts: [{ id: "art1", ref: "file:PLAN.md" }] });
  assert.equal(ctx.transcriptForwarded, false);
  assert.ok(ctx.relevant.length <= 2);
  assert.deepEqual(ctx.artifactRefs, ["file:PLAN.md"]);      // reference, not content
  assert.equal(ctx.pinned[0].text, "no external dependencies");
  assert.equal(ctx.messageCount, 7);                          // counted, not forwarded
});

test("MissionSpec: conversation becomes structured durable state", () => {
  let c = newConversation({ scope: "department", department: "technical" });
  c = addMessage(c, { text: "Add a slugify(title) helper and a unit test", mode: "plan" });
  c = pin(c, { kind: "constraint", text: "zero dependencies" });
  c = pin(c, { kind: "decision", text: "use the free coding model" });
  c = pin(c, { kind: "criterion", text: "a passing unit test exists" });
  const spec = draftMissionSpec(c, { agents: ["eng-architect"], capabilities: ["coding-free"], tools: ["repo"] });
  assert.match(spec.objective, /slugify/);
  assert.equal(spec.department, "technical");
  assert.deepEqual(spec.constraints, ["zero dependencies"]);
  assert.deepEqual(spec.decisions, ["use the free coding model"]);
  assert.deepEqual(spec.acceptanceCriteria, ["a passing unit test exists"]);
  assert.equal(spec.status, "draft");
  assert.ok(spec.graph.shape);                                 // smallest sufficient graph attached
  assert.equal(spec.conversationId, c.id);
});

test("a bounded task gets NO planner and NO reviewer (smallest sufficient graph)", () => {
  let c = addMessage(newConversation({ scope: "department", department: "customer-service" }), { text: "reply to a password question" });
  const spec = draftMissionSpec(c, {});
  assert.equal(spec.graph.shape, "single");
  assert.ok(!spec.graph.nodes.includes("planner"));
  assert.ok(!spec.graph.nodes.includes("reviewer"));
});

test("a policy-bound mission adds a reviewer + approval gate automatically", () => {
  const policies = { "legal-copy-review": { appliesTo: { departments: ["marketing"] }, criteria: ["claims honest"], escalation: "human", autoApproveWhenClear: true } };
  let c = addMessage(newConversation({ scope: "department", department: "marketing" }), { text: "publish the launch post" });
  const spec = draftMissionSpec(c, { policies });
  assert.ok(spec.graph.nodes.includes("reviewer"));
  assert.equal(spec.approvals.humanApprovalRequired, true);
  assert.deepEqual(spec.policies, ["legal-copy-review"]);
});

test("mission lifecycle: edit only as draft, approve requires objective+department", () => {
  let c = addMessage(newConversation({ scope: "department", department: "technical" }), { text: "ship it" });
  let spec = draftMissionSpec(c, {});
  spec = editMissionSpec(spec, { objective: "Ship the release notes", tools: ["repo"] });
  assert.equal(spec.objective, "Ship the release notes");
  assert.equal(validateMissionSpec(spec).ok, true);
  const approved = approveMission(spec);
  assert.equal(approved.status, "approved");
  // An approved mission CAN be edited — a failed launch leaves a mission there, and refusing made
  // it permanently unusable. Editing returns it to draft so the old approval is never reused for
  // changed work.
  const reopened = editMissionSpec(approved, { objective: "x" });
  assert.equal(reopened.status, "draft");
  assert.equal(reopened.approvedBy, null);
  assert.equal(reopened.objective, "x");
  // A rejected or completed mission still cannot be edited.
  assert.throws(() => editMissionSpec({ ...approved, status: "rejected" }, { objective: "x" }), /only draft, approved, failed/);
  // And an unknown patch key is now an error rather than a silent no-op.
  assert.throws(() => editMissionSpec(spec, { agent: "a-analyst" }), /unknown field\(s\) in patch: agent/);
  assert.equal(rejectMission(spec, { reason: "wrong scope" }).status, "rejected");
  const bad = { ...spec, objective: "", status: "draft" };
  assert.throws(() => approveMission(bad), /objective is required/);
});

test("modes: ask is read-only; plan may draft; execute needs an APPROVED mission", () => {
  assert.equal(modeAllows("ask", "rag-query").allowed, true);
  assert.equal(modeAllows("ask", "external-write").allowed, false);
  assert.equal(modeAllows("plan", "draft-plan").allowed, true);
  assert.equal(modeAllows("plan", "external-write").allowed, false);   // planning never writes externally
  const draft = { status: "draft" }, approved = { status: "approved" };
  assert.equal(modeAllows("execute", "execute", { mission: draft }).allowed, false);
  assert.equal(modeAllows("execute", "execute", { mission: approved }).allowed, true);
  assert.equal(modeAllows("execute", "execute", {}).allowed, false);   // no mission at all
  assert.deepEqual(CHAT_MODES, ["ask", "plan", "execute", "review"]);
});

test("composer shows the pre-flight summary with provider/cost per stage — and no funding line", () => {
  let c = addMessage(newConversation({ scope: "department", department: "technical" }), { text: "build it" });
  const spec = approveMission(editMissionSpec(draftMissionSpec(c, { agents: ["eng-architect"], tools: ["repo"] }), {}));
  const view = missionComposer(spec, {
    plan: [{ node: "worker", model: { model: "qwen2.5:7b", provider: "ollama", costSource: "local-compute" } }],
    stagesSkipped: ["planner", "reviewer"],
  });
  assert.equal(view.stages[0].provider, "ollama");
  assert.equal(view.stages[0].costSource, "local-compute");
  // The composer must advertise the action values /api/chat/mission ACCEPTS. It used to list
  // "approve-and-launch" and "save-as-workflow", both of which the endpoint rejects with a 400.
  assert.deepEqual(view.actions, ["edit", "approve", "reject", "cancel", "save-workflow"]);
  assert.deepEqual(view.stagesSkipped, ["planner", "reviewer"]);
  assert.equal(JSON.stringify(view).includes("BrainOutput-funded"), false); // internal policy, never shown
});

test("review compares results with the acceptance criteria and flags when a reviewer is justified", () => {
  const spec = { id: "m1", acceptanceCriteria: ["slugify function exists", "unit test passes"], policies: [], task: {} };
  const good = reviewMission(spec, [{ output: "added slugify function and a unit test that passes" }]);
  assert.equal(good.allMet, true);
  assert.equal(good.independentReviewJustified, false);
  const bad = reviewMission(spec, [{ output: "nothing was produced" }]);
  assert.equal(bad.allMet, false);
  assert.ok(bad.unmet.length);
  assert.equal(bad.independentReviewJustified, true);
});

test("save-as-workflow strips the conversation-specific objective", () => {
  const spec = { objective: "Do the thing", department: "ops", agents: ["a"], requiredCapabilities: [], modelAssignments: {},
    tools: [], dataSources: [], permissions: [], approvals: {}, acceptanceCriteria: [], constraints: [], task: { summary: "Do the thing", tags: [] } };
  const wf = saveAsWorkflow(spec, { name: "Weekly report" });
  assert.equal(wf.name, "Weekly report");
  assert.equal(wf.task.summary, undefined);
  assert.equal(wf.department, "ops");
});

test("looksLikeWork: imperatives and 'X-moi' forms are work; questions are not", () => {
  for (const s of ["crée-moi un démineur", "crée moi un jeu snake en html", "Create a landing page",
    "build me a game", "fais un site vitrine", "write a slugify function", "erstelle eine Website"])
    assert.equal(looksLikeWork(s), true, s);
  for (const s of ["comment créer un compte ?", "how do I create a website?", "c'est quoi un démineur ?",
    "what is a minesweeper", "pourquoi le build échoue ?"])
    assert.equal(looksLikeWork(s), false, s);
});
