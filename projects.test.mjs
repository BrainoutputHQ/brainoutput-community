// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { LOCALES, CATALOG, t, missingKeys } from "./i18n.mjs";
import { newProject, listProjects, findProject, projectThreads, adHocThreads,
  promoteConversation, projectDigest, projectBrief, projectUpdate, PROJECT_KIND, PROJECT_STATES } from "./projects.mjs";

// ── i18n ──────────────────────────────────────────────────────────────────────

test("every launch locale has exactly the English key set, with no empty values", () => {
  for (const loc of LOCALES) {
    assert.deepEqual(missingKeys(loc), [], `${loc} is missing keys`);
    for (const [k, v] of Object.entries(CATALOG[loc]))
      assert.ok(String(v).trim().length > 0, `${loc}:${k} is empty`);
  }
});

test("slot labels: every engine slot has a plain-language label in every locale, no dashes", async () => {
  const { KNOWN_SLOTS, slotLabel, SLOT_LABELS } = await import("./i18n.mjs");
  assert.ok(KNOWN_SLOTS.length >= 10);
  for (const loc of LOCALES) {
    for (const slot of KNOWN_SLOTS) {
      const [label, help] = slotLabel(loc, slot);
      assert.ok(label && !label.includes("-"), `${loc}:${slot} label must be plain, got '${label}'`);
      assert.ok(help.length > 10, `${loc}:${slot} needs a real explanation`);
    }
    // locale parity: same slot set as English
    assert.deepEqual(Object.keys(SLOT_LABELS[loc]).sort(), Object.keys(SLOT_LABELS.en).sort(), `${loc} slot set differs`);
  }
  // unknown slots never show a raw dash-name
  assert.equal(slotLabel("en", "future-slot-x")[0].includes("-"), false);
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
  assert.match(b, /"converter" → 3 formats shipped/);
  assert.match(b, /open tasks \(1\): "stripe keys"/);
  assert.match(b, /no Stripe until v2/);
  assert.ok(b.length <= 700);
  assert.equal(projectBrief(r, "ghost"), null);
});

// ── project header fields (task-pm-10): objective + state ─────────────────────

test("PROJECT_STATES is the planned/active/done enum", () => {
  assert.deepEqual(PROJECT_STATES, ["planned", "active", "done"]);
});

test("newProject: objective/state stored only when set and valid — an old record keeps NEITHER key", () => {
  const bare = newProject({ name: "legacy", at: 1 });
  assert.ok(!("objective" in bare) && !("state" in bare), "no undefined keys forced onto the record");

  const p = newProject({ name: "pdf-saas", objective: "  sell pdfs to hotels ", state: "active", at: 2 });
  assert.equal(p.objective, "sell pdfs to hotels", "the objective is trimmed");
  assert.equal(p.state, "active");

  assert.ok(!("objective" in newProject({ name: "x", objective: "   " })), "a blank objective stays unset");
  assert.ok(!("state" in newProject({ name: "x", state: null })), "state null stays unset");
  assert.throws(() => newProject({ name: "x", state: "banana" }), /state.*planned, active, done/);
  assert.throws(() => newProject({ name: "x", objective: "o".repeat(2001) }), /2000/);
  assert.equal(newProject({ name: "x", objective: "o".repeat(2000) }).objective.length, 2000, "the cap itself is allowed");
});

test("projectUpdate: set, validate, clear — pure (the store record is never mutated)", () => {
  const r = rt();
  const upd = projectUpdate(r, "p1", { objective: "sell pdfs", state: "active", at: 10 });
  assert.equal(upd.objective, "sell pdfs");
  assert.equal(upd.state, "active");
  assert.equal(upd.updatedAt, 10);
  assert.equal(upd.name, "pdf-saas", "the other fields carry over");
  assert.ok(!("objective" in r.projects[1]) && !("state" in r.projects[1]), "pure — the input record is untouched");

  // validation: bad state / unknown project / over-long objective all throw
  assert.throws(() => projectUpdate(r, "p1", { state: "banana" }), /state/);
  assert.throws(() => projectUpdate(r, "p1", { state: "" }), /state/, "an empty-string state is not 'absent' — it is invalid");
  assert.throws(() => projectUpdate(r, "ghost", { state: "active" }), /no project/);
  assert.throws(() => projectUpdate(r, "p1", { objective: "x".repeat(2001) }), /objective/);

  // clearing: state null → unset (null); objective ""/null → cleared (null)
  const c1 = projectUpdate(r, "p1", { state: null, at: 11 });
  assert.equal(c1.state, null);
  const withObj = projectUpdate(r, "p1", { objective: "keep me", at: 12 });
  const r2 = { ...r, projects: r.projects.map((p) => (p.id === "p1" ? withObj : p)) };
  assert.equal(projectUpdate(r2, "p1", { objective: "" }).objective, null);
  assert.equal(projectUpdate(r2, "p1", { objective: null }).objective, null);

  // an empty patch forces NO keys onto an old record; a patch touching one field leaves the other absent
  const legacy = { id: "p9", kind: PROJECT_KIND, name: "legacy", createdAt: 1, updatedAt: 2 };
  const r3 = { projects: [legacy] };
  const same = projectUpdate(r3, "p9", {});
  assert.ok(!("objective" in same) && !("state" in same), "an empty patch adds nothing");
  const onlyObj = projectUpdate(r3, "p9", { objective: "new objective" });
  assert.equal(onlyObj.objective, "new objective");
  assert.ok(!("state" in onlyObj), "the state stays absent, never fabricated");
});
