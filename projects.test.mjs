// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { LOCALES, CATALOG, t, missingKeys } from "./i18n.mjs";
import { newProject, listProjects, findProject, projectThreads, adHocThreads,
  promoteConversation, projectDigest, projectBrief, PROJECT_KIND } from "./projects.mjs";

// ── i18n ──────────────────────────────────────────────────────────────────────

test("every launch locale has exactly the English key set, with no empty values", () => {
  for (const loc of LOCALES) {
    assert.deepEqual(missingKeys(loc), [], `${loc} is missing keys`);
    for (const [k, v] of Object.entries(CATALOG[loc]))
      assert.ok(String(v).trim().length > 0, `${loc}:${k} is empty`);
  }
});

test("t() falls back to English for unknown locales and to the key for unknown keys", () => {
  assert.equal(t("es", "shell.send"), "Send");           // es not a launch locale → en
  assert.equal(t("fr", "shell.send"), "Envoyer");
  assert.equal(t("de", "shell.send"), "Senden");
  assert.equal(t("en", "no.such.key"), "no.such.key");   // visible gap, never undefined
});

// ── projects ──────────────────────────────────────────────────────────────────

const rt = () => ({
  projects: [
    { id: "wf-1", kind: "workflow", name: "refund reply" },     // must be ignored
    { id: "p1", kind: PROJECT_KIND, name: "pdf-saas", createdAt: 1, updatedAt: 5 },
    { id: "p2", kind: PROJECT_KIND, name: "Hotel Site", createdAt: 2, updatedAt: 9 },
  ],
  conversations: [
    { id: "c1", projectId: "p1", updatedAt: 8 },
    { id: "c2", projectId: "p1", updatedAt: 3 },
    { id: "c3", updatedAt: 6 },                                  // ad-hoc
  ],
  missions: [
    { id: "m1", conversationId: "c1", projectId: "p1", status: "done" },
    { id: "m2", conversationId: "c3", status: "draft" },
  ],
  executions: [{ id: "e1", missionId: "m1", createdAt: 7, artifacts: ["a.txt"] }],
  approvals: [{ id: "ap1", missionId: "m1", status: "pending" }],
});

test("projects list only real projects (workflows excluded), newest activity first", () => {
  const l = listProjects(rt());
  assert.deepEqual(l.map((p) => p.id), ["p2", "p1"]);
  assert.ok(newProject({ name: "x" }).id);
  assert.throws(() => newProject({ name: "  " }), /name/);
});

test("find by id or by spoken name, case-insensitive", () => {
  assert.equal(findProject(rt(), "p1").name, "pdf-saas");
  assert.equal(findProject(rt(), "hotel site").id, "p2");
  assert.equal(findProject(rt(), "nope"), null);
});

test("threads split into project vs ad-hoc", () => {
  assert.deepEqual(projectThreads(rt(), "p1").map((c) => c.id), ["c1", "c2"]);
  assert.deepEqual(adHocThreads(rt()).map((c) => c.id), ["c3"]);
});

test("promote an ad-hoc thread: to a new project by name, or to an existing one", () => {
  const r1 = promoteConversation(rt(), { conversationId: "c3", newProjectName: "printer fix", at: 10 });
  assert.equal(r1.created, true);
  assert.equal(r1.conversation.projectId, r1.project.id);
  assert.equal(r1.project.name, "printer fix");

  const r2 = promoteConversation(rt(), { conversationId: "c3", projectId: "hotel site", at: 11 });
  assert.equal(r2.created, false);
  assert.equal(r2.conversation.projectId, "p2");

  assert.throws(() => promoteConversation(rt(), { conversationId: "c9", newProjectName: "x" }), /no conversation/);
  assert.throws(() => promoteConversation(rt(), { conversationId: "c3", projectId: "ghost" }), /no project/);
  assert.throws(() => promoteConversation(rt(), { conversationId: "c3" }), /projectId/);
});

test("digest is the project's memory anchor: threads, missions, runs, artifacts, approvals", () => {
  const d = projectDigest(rt(), "pdf-saas");
  assert.equal(d.threads, 2);
  assert.equal(d.missions, 1);
  assert.deepEqual(d.missionsByStatus, { done: 1 });
  assert.equal(d.executions, 1);
  assert.equal(d.artifacts, 1);
  assert.equal(d.pendingApprovals, 1);
  assert.equal(d.lastActivity, 8);
  assert.equal(projectDigest(rt(), "ghost"), null);
});

test("projectBrief: the cold-start contract — shipped, open, decisions; bounded; never transcripts", () => {
  const r = rt();
  r.tasks = [
    { id: "t1", projectId: "p1", title: "converter", status: "done", result: { ok: true, summary: "3 formats shipped" } },
    { id: "t2", projectId: "p1", title: "stripe keys", status: "todo" },
  ];
  r.conversations.push({ id: "c9", projectId: "p1", pinned: [{ kind: "decision", text: "no Stripe until v2" }] });
  const b = projectBrief(r, "p1");
  assert.match(b, /project "pdf-saas"/);
  assert.match(b, /converter → 3 formats shipped/);
  assert.match(b, /open: stripe keys/);
  assert.match(b, /no Stripe until v2/);
  assert.ok(b.length <= 700);
  assert.equal(projectBrief(r, "ghost"), null);
});
