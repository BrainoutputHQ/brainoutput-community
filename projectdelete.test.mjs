// SPDX-License-Identifier: Apache-2.0
// Project archive + delete (task-pm-15). Archive = visibility + launch-block only (the record
// gains archivedAt, nothing else moves; unarchive drops the key — a cycle is byte-identical).
// Delete = confirmName must match EXACTLY (else 400, zero state change), running queue /
// execution / mission → 409, then every linked record goes (tasks incl. subtasks, plans,
// conversations, missions, executions, approvals, queues, artifact records) AND the disk
// footprint — upload/artifact files confined to the store dir, execution workspaces confined
// to the approved roots (an escaping path is SKIPPED and reported, never followed) — with an
// honest removed/skipped summary (counts = real before/after deltas).
// Real-server tmp-dir pattern with a stubbed model endpoint (same as runqueue.test.mjs);
// component tests render the real SHELL_PAGE blocks in a vm (same as projheader.test.mjs).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { SHELL_PAGE } from "./shell.mjs";
import { CATALOG, LOCALES, missingKeys } from "./i18n.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 4441, PORT2 = 4442;
const BASE = `http://127.0.0.1:${PORT}`;
let srv, dir, stub;

const post = (path, body, base = BASE) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json().then((j) => ({ status: r.status, body: j })));
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

/** Spawn a web-server against `d` on `port`; resolves once /api/state answers. */
async function startServer(d, port, extraEnv = {}) {
  const s = spawn(process.execPath, [join(HERE, "web-server.mjs")],
    { env: { ...process.env, BO_CE_DATA: d, BO_CE_WEB_PORT: String(port), BO_OPENCODE_BIN: "/nonexistent-opencode", ...extraEnv }, stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    try { await fetch(`http://127.0.0.1:${port}/api/state`); return s; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error("server did not start");
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "bo-projdel-"));
  const { createServer } = await import("node:http");
  stub = createServer((req, res) => {
    let d = ""; req.on("data", (c) => (d += c));
    req.on("end", () => {
      const say = (content) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ choices: [{ message: { content } }] })); };
      const done = "ok — done. " + "Real work output follows: ".repeat(8);
      const mine = (d.match(/YOUR PART \(task \d+\/\d+\): ([^\n]*)/) || [])[1] || "";
      if (mine.includes("SLOWMARK")) return setTimeout(() => say(done), 1800);   // a measurably open run window
      say(done);
    });
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  srv = await startServer(dir, PORT, { BO_CE_FREE_ENDPOINT: `http://127.0.0.1:${stub.address().port}/v1/chat/completions` });
  await post("/api/onboard", { companyName: "Del Co", companyDoes: "tests", departments: ["technical"] });
  const st0 = await state();
  for (const slot of Object.keys(st0.assignments || {})) await post("/api/assign", { slot, connectionId: null });
  const cf = await post("/api/connect-free", {});
  assert.equal(cf.status, 200, JSON.stringify(cf.body).slice(0, 300));
});
after(() => { srv?.kill(); stub?.close(); rmSync(dir, { recursive: true, force: true }); });

// ── 1 · archive: hidden from the sidebar list + task filter; restore; byte-identical cycle ──
test("archive hides the project (sidebar list + task filter), restore brings it back, records byte-identical", async () => {
  const p = await post("/api/project", { name: "arch-cycle" });
  const pid = p.body.project.id;
  assert.ok(!("archivedAt" in p.body.project), "a fresh project carries no archivedAt key");
  const diskBefore = JSON.stringify(JSON.parse(readFileSync(join(dir, "runtime.json"), "utf8")).projects.find((x) => x.id === pid));

  const arch = await post("/api/project/archive", { id: pid });
  assert.equal(arch.status, 200, JSON.stringify(arch.body).slice(0, 300));
  assert.ok(arch.body.project.archivedAt > 0, "the record gained archivedAt");
  const inState = (await state()).projects.find((x) => x.id === pid);
  assert.ok(inState && inState.archivedAt, "state carries the marker (the Archived section reads it)");

  // Unknown project → 404 on both verbs.
  assert.equal((await post("/api/project/archive", { id: "nope" })).status, 404);
  assert.equal((await post("/api/project/unarchive", { id: "nope" })).status, 404);

  // The vm render: an archived project leaves the live list + the task filter, shows in the
  // Archived section with a restore that posts /api/project/unarchive.
  const st = { projects: [
    { id: "p1", kind: "project", name: "Live Proj" },
    { id: pid, kind: "project", name: "arch-cycle", archivedAt: inState.archivedAt },
  ], tasks: [
    { id: "t1", projectId: "p1", title: "live task", status: "todo" },
    { id: "t2", projectId: pid, title: "arch task", status: "todo" },
  ], conversations: [] };
  const { sandbox, h, calls } = makeCtx(st);
  assert.deepEqual(h.liveProjects(st).map((x) => x.id), ["p1"], "archived is out of the sidebar Projects list");
  assert.deepEqual(h.archivedProjects(st).map((x) => x.id), [pid], "…and in the archived set");
  const bar = h.taskFilterBar(st);
  const projSel = bar.children[1];
  assert.ok(projSel.html.includes('value="p1"'), "the live project stays a filter choice");
  assert.ok(!projSel.html.includes(pid), "the archived project is NOT offered in the task filter");
  const row = h.archivedRow(st, st.projects[1]);
  assert.ok(htmlOf(row).includes("arch-cycle"), "the archived row shows the project");
  assert.ok(row.children.some((c) => String(c.html || "").includes("svg")), "…with a restore affordance");
  const restoreBtn = row.children[row.children.length - 1];
  await restoreBtn.onclick({ stopPropagation() {} });
  assert.deepEqual([calls.at(-1)[0], { ...calls.at(-1)[1] }], ["/api/project/unarchive", { id: pid }], "restore posts unarchive");

  // An OLD record (no archivedAt at all) renders exactly like before — migration-safe.
  assert.deepEqual(h.liveProjects({ projects: [{ id: "old", kind: "project", name: "old" }] }).map((x) => x.id), ["old"]);

  // Restore → the project is back everywhere.
  const un = await post("/api/project/unarchive", { id: pid });
  assert.equal(un.status, 200);
  assert.ok(!("archivedAt" in un.body.project), "unarchive drops the key entirely");
  const diskAfter = JSON.stringify(JSON.parse(readFileSync(join(dir, "runtime.json"), "utf8")).projects.find((x) => x.id === pid));
  assert.equal(diskAfter, diskBefore, "archive → unarchive leaves the record BYTE-IDENTICAL");
  assert.equal(sandbox.__alerts.length, 0);
});

// ── 2 · archived = read-only for new work: task launch, queue start, mission launch → 4xx ──
test("archived project refuses task launches, queue starts and mission launches (4xx, localized)", async () => {
  const p = await post("/api/project", { name: "arch-ro" });
  const pid = p.body.project.id;
  const tk = await post("/api/task/new", { title: "arch-ro task", projectId: pid });
  assert.equal(tk.status, 200);
  // A mission bound to the project, approved and ready to launch BEFORE archiving.
  const send = await post("/api/chat/send", { scope: "company", mode: "ask", projectId: pid, text: "build me a widget for arch-ro" });
  assert.equal(send.status, 200, JSON.stringify(send.body).slice(0, 300));
  const mid = send.body.mission.id;
  assert.equal(send.body.mission.projectId, pid);
  assert.equal((await post("/api/chat/mission", { missionId: mid, action: "approve" })).status, 200);

  assert.equal((await post("/api/project/archive", { id: pid })).status, 200);
  const want = CATALOG.en["project.archivedLaunch"].replace("{name}", "arch-ro");

  const tl = await post("/api/task/launch", { id: tk.body.task.id });
  assert.equal(tl.status, 409);
  assert.equal(tl.body.error, want, "the launch-block is the clear localized error");

  const qs = await post("/api/queue/start", { projectId: pid });
  assert.equal(qs.status, 409);
  assert.equal(qs.body.error, want);

  const ml = await post("/api/chat/launch", { missionId: mid });
  assert.equal(ml.status, 409);
  assert.equal(ml.body.error, want);
  const mAfter = (await state()).missions.find((m) => m.id === mid);
  assert.equal(mAfter.status, "approved", "a refused launch never flips the mission to running");

  // The error localizes for real — the server speaks settings.locale.
  await post("/api/settings", { locale: "fr" });
  const fr = await post("/api/queue/start", { projectId: pid });
  assert.equal(fr.body.error, CATALOG.fr["project.archivedLaunch"].replace("{name}", "arch-ro"));
  await post("/api/settings", { locale: "en" });

  // Restore lifts the block: the queue starts for real (and is stopped again for later tests).
  assert.equal((await post("/api/project/unarchive", { id: pid })).status, 200);
  const qs2 = await post("/api/queue/start", { projectId: pid });
  assert.equal(qs2.status, 200, JSON.stringify(qs2.body).slice(0, 300));
  await until(async () => ((await state()).queues.find((q) => q.projectId === pid) || {}).status === "done" || null);
});

// ── 3 · delete guards: wrong confirmName → 400 + zero change; running queue/execution → 409 ──
test("delete: wrong confirmName → 400 with zero state change; running queue → 409; running execution → 409", async () => {
  const p = await post("/api/project", { name: "del-guard" });
  const pid = p.body.project.id;
  const tk = await post("/api/task/new", { title: "guard task", projectId: pid });

  // Wrong name (case-sensitive, whitespace-sensitive) → 400, and NOTHING moved.
  const before = await state();
  const bad = await post("/api/project/delete", { id: pid, confirmName: "Del-Guard" });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, new RegExp(CATALOG.en["project.deleteConfirm"].slice(0, 30).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  for (const bad2 of ["del-guard ", " del-guard", ""])
    assert.equal((await post("/api/project/delete", { id: pid, confirmName: bad2 })).status, 400, `'${bad2}' must not confirm`);
  const afterBad = await state();
  for (const k of ["projects", "tasks", "plans", "conversations", "missions", "executions", "approvals", "queues", "artifacts"])
    assert.deepEqual(afterBad[k], before[k], `${k}: zero state change on a refused delete`);
  assert.equal((await post("/api/project/delete", { id: "ghost", confirmName: "ghost" })).status, 404);

  // Running queue → 409.
  const pq = await post("/api/project", { name: "del-rq" });
  await post("/api/task/new", { title: "SLOWMARK rq task", projectId: pq.body.project.id });
  const start = await post("/api/queue/start", { projectId: pq.body.project.id });
  assert.equal(start.status, 200);
  await until(async () => (await state()).executions.some((e) => e.status === "running") || null);
  const rq = await post("/api/project/delete", { id: pq.body.project.id, confirmName: "del-rq" });
  assert.equal(rq.status, 409);
  assert.match(rq.body.error, /del-rq/);
  assert.ok((await state()).projects.some((x) => x.id === pq.body.project.id), "a refused delete keeps the project");
  await post("/api/queue/stop", { projectId: pq.body.project.id });
  await until(async () => !(await state()).executions.some((e) => e.status === "running") || null);

  // Running execution (no queue) → 409.
  const pe = await post("/api/project", { name: "del-re" });
  const te = await post("/api/task/new", { title: "SLOWMARK re task", projectId: pe.body.project.id });
  const l = await post("/api/task/launch", { id: te.body.task.id });
  assert.equal(l.status, 200, JSON.stringify(l.body).slice(0, 300));
  await until(async () => (await state()).executions.some((e) => e.status === "running") || null);
  const re = await post("/api/project/delete", { id: pe.body.project.id, confirmName: "del-re" });
  assert.equal(re.status, 409);
  await until(async () => !(await state()).executions.some((e) => e.status === "running") || null);
});

// ── 4 · full delete e2e: every record + the disk footprint; a second project untouched ──
test("full delete: records, upload file and workspace go; counts match the real deltas; the neighbor project is untouched", async () => {
  // DEL: tasks incl. a subtask, a plan, a planning thread, a completed mission+execution,
  // an uploads/ file with the projectId, and a workspace dir under the approved root.
  const pd = await post("/api/project", { name: "del-full" });
  const did = pd.body.project.id;
  const t1 = (await post("/api/task/new", { title: "build the DELMARK widget", projectId: did })).body.task;
  const sub = await post("/api/task/new", { title: "sub step", parentId: t1.id });
  assert.equal(sub.status, 200);
  const t2 = (await post("/api/task/new", { title: "del second task", projectId: did })).body.task;
  assert.equal((await post("/api/plan/new", { projectId: did, objective: "del plan", taskDrafts: [{ title: "draft one" }] })).status, 200);
  assert.equal((await post("/api/chat/plan-thread", { projectId: did })).status, 200);
  const launch = await post("/api/task/launch", { id: t1.id });
  assert.equal(launch.status, 200, JSON.stringify(launch.body).slice(0, 300));
  const delExec = await until(async () => {
    const st = await state();
    const t = st.tasks.find((x) => x.id === t1.id);
    const e = st.executions.find((x) => x.missionId === t?.missionId);
    return e && e.status === "done" ? e : null;
  });
  const up = await post("/api/upload", { name: "spec.txt", contentBase64: Buffer.from("del spec").toString("base64"), projectId: did });
  assert.equal(up.status, 200);
  const delFile = join(dir, up.body.artifact.path);
  assert.ok(existsSync(delFile), "the upload file exists before delete");
  const delWs = join(dir, "workspaces", delExec.id);
  mkdirSync(delWs, { recursive: true });
  writeFileSync(join(delWs, "out.txt"), "workspace output");

  // KEEP: the unrelated neighbor with its own task run, file and workspace.
  const pk = await post("/api/project", { name: "keep-full" });
  const kid = pk.body.project.id;
  const k1 = (await post("/api/task/new", { title: "build the KEEPMARK widget", projectId: kid })).body.task;
  assert.equal((await post("/api/task/launch", { id: k1.id })).status, 200);
  const keepExec = await until(async () => {
    const st = await state();
    const t = st.tasks.find((x) => x.id === k1.id);
    const e = st.executions.find((x) => x.missionId === t?.missionId);
    return e && e.status === "done" ? e : null;
  });
  const kup = await post("/api/upload", { name: "keep.txt", contentBase64: Buffer.from("keep").toString("base64"), projectId: kid });
  const keepFile = join(dir, kup.body.artifact.path);
  const keepWs = join(dir, "workspaces", keepExec.id);
  mkdirSync(keepWs, { recursive: true });
  writeFileSync(join(keepWs, "keep-out.txt"), "keep");

  // The honest expectation, from /api/state BEFORE the delete (mirrors the linkage).
  const stB = await state();
  const delConvs = stB.conversations.filter((c) => c.projectId === did);
  const delConvIds = new Set(delConvs.map((c) => c.id));
  const delMissions = stB.missions.filter((m) => m.projectId === did || delConvIds.has(m.conversationId));
  const delMissionIds = new Set(delMissions.map((m) => m.id));
  const expect = {
    tasks: stB.tasks.filter((t) => t.projectId === did).length,
    plans: stB.plans.filter((x) => x.projectId === did).length,
    conversations: delConvs.length,
    missions: delMissions.length,
    executions: stB.executions.filter((e) => delMissionIds.has(e.missionId) || e.projectId === did).length,
    approvals: stB.approvals.filter((a) => delMissionIds.has(a.missionId)).length,
    files: 1, workspaces: 1, knowledgeEntries: 1,
  };
  assert.ok(expect.tasks >= 3 && expect.missions === 1 && expect.executions === 1 && expect.conversations === 1 && expect.plans === 1,
    `fixture sanity: ${JSON.stringify(expect)}`);

  const del = await post("/api/project/delete", { id: did, confirmName: "del-full" });
  assert.equal(del.status, 200, JSON.stringify(del.body).slice(0, 400));
  assert.deepEqual(del.body.removed, expect, "the summary counts ARE the before/after deltas");
  assert.deepEqual(del.body.skipped, [], "nothing was skipped");

  const stA = await state();
  assert.ok(!stA.projects.some((x) => x.id === did), "the project itself is gone");
  for (const t of [t1.id, sub.body.task.id, t2.id]) assert.ok(!stA.tasks.some((x) => x.id === t), `task ${t} gone`);
  assert.ok(!stA.plans.some((x) => x.projectId === did), "plans gone");
  assert.ok(!stA.conversations.some((c) => c.projectId === did), "threads gone");
  assert.ok(!stA.missions.some((m) => delMissionIds.has(m.id)), "missions gone");
  assert.ok(!stA.executions.some((e) => e.id === delExec.id), "executions gone");
  assert.ok(!stA.artifacts.some((a) => a.id === up.body.artifact.id), "the artifact RECORD is gone");
  assert.ok(!stA.queues.some((q) => q.projectId === did), "queue records gone");
  assert.ok(!existsSync(delFile), "the upload FILE is gone from disk");
  assert.ok(!existsSync(delWs), "the execution workspace is gone from disk");
  const disk = JSON.parse(readFileSync(join(dir, "runtime.json"), "utf8"));
  assert.ok(!disk.projects.some((x) => x.id === did) && !disk.tasks.some((t) => t.projectId === did), "persisted on disk too");

  // The neighbor: every record and every byte on disk untouched.
  assert.ok(stA.projects.some((x) => x.id === kid), "the neighbor project stays");
  assert.ok(stA.tasks.some((x) => x.id === k1.id), "the neighbor task stays");
  assert.ok(stA.executions.some((e) => e.id === keepExec.id), "the neighbor execution stays");
  assert.ok(stA.artifacts.some((a) => a.id === kup.body.artifact.id), "the neighbor artifact stays");
  assert.ok(existsSync(keepFile), "the neighbor FILE stays");
  assert.ok(existsSync(keepWs), "the neighbor workspace stays");
});

// ── 5 · confinement + migration (seeded server): escaping paths are skipped, never followed ──
test("confinement: a traversal artifact path and an escaping workspace are skipped+reported, nothing outside the roots touched; an old runtime.json loads", async () => {
  const dir2 = mkdtempSync(join(tmpdir(), "bo-projdel-seed-"));
  try {
    // Disk plants: a real upload (goes), a traversal target OUTSIDE the store (stays),
    // a real workspace (goes) and a workspace escaping the approved root (stays).
    mkdirSync(join(dir2, "uploads"), { recursive: true });
    writeFileSync(join(dir2, "uploads", "ok.txt"), "ok");
    const escapeFile = join(tmpdir(), `bo-pd-escape-${process.pid}.txt`);
    writeFileSync(escapeFile, "do not touch");
    mkdirSync(join(dir2, "workspaces", "exec-ok"), { recursive: true });
    writeFileSync(join(dir2, "workspaces", "exec-ok", "f.txt"), "ws");
    mkdirSync(join(dir2, "ws-escape"), { recursive: true });
    writeFileSync(join(dir2, "ws-escape", "f.txt"), "do not touch either");
    const runtime = {
      projects: [
        { id: "seed-old", kind: "project", name: "seeded old", createdAt: 1, updatedAt: 1 },   // no archivedAt — pre-archive record
        { id: "evil", kind: "project", name: "evil-proj", createdAt: 2, updatedAt: 2 },
        { id: "wf-9", kind: "workflow", name: "a workflow", createdAt: 3, updatedAt: 3 },
      ],
      tasks: [
        { id: "st1", projectId: "seed-old", title: "old task", status: "todo" },
        { id: "et1", projectId: "evil", title: "evil task", status: "todo" },
      ],
      plans: [],
      executions: [
        { id: "exec-ok", missionId: "m-evil", status: "done", results: [], logs: [] },
        { id: "../ws-escape", missionId: "m-evil", status: "done", results: [], logs: [] },   // crafted id → path escapes the root
      ],
      artifacts: [
        { id: "art-ok", kind: "upload", name: "ok.txt", path: "uploads/ok.txt", size: 2, projectId: "evil", createdAt: 4 },
        { id: "art-evil", kind: "upload", name: "evil.txt", path: `../${escapeFile.split("/").pop()}`, size: 3, projectId: "evil", createdAt: 5 },
      ],
      approvals: [{ id: "ap-evil", missionId: "m-evil", kind: "action", status: "pending" }],
      conversations: [{ id: "c-evil", projectId: "evil", messages: [] }],
      missions: [{ id: "m-evil", projectId: "evil", status: "done" }],
      workTwins: [], infraTwins: [], routines: [], errors: [], secrets: {}, queues: [],
    };
    writeFileSync(join(dir2, "runtime.json"), JSON.stringify(runtime, null, 2));
    const srv2 = await startServer(dir2, PORT2);
    try {
      const base2 = `http://127.0.0.1:${PORT2}`;
      const st0 = await fetch(`${base2}/api/state`).then((r) => r.json());
      assert.ok(st0.projects.some((x) => x.id === "seed-old"), "a runtime.json without archivedAt loads and lists normally");

      const del = await post("/api/project/delete", { id: "evil", confirmName: "evil-proj" }, base2);
      assert.equal(del.status, 200, JSON.stringify(del.body).slice(0, 400));
      assert.equal(del.body.removed.files, 1, "only the confined upload file went");
      assert.equal(del.body.removed.workspaces, 1, "only the confined workspace went");
      assert.equal(del.body.removed.approvals, 1, "the linked approval went");
      assert.equal(del.body.removed.executions, 2, "both execution RECORDS went (record ≠ disk)");
      assert.equal(del.body.skipped.length, 2, `both escapes reported: ${JSON.stringify(del.body.skipped)}`);
      assert.ok(del.body.skipped.some((s) => s.includes("evil.txt")), "the traversal file is named in skipped[]");
      assert.ok(del.body.skipped.some((s) => s.includes("workspace")), "the escaping workspace is named in skipped[]");
      assert.ok(existsSync(escapeFile), "the traversal target was NEVER touched");
      assert.ok(existsSync(join(dir2, "ws-escape", "f.txt")), "the escaping workspace was NEVER touched");
      assert.ok(!existsSync(join(dir2, "uploads", "ok.txt")), "the confined upload is gone");
      assert.ok(!existsSync(join(dir2, "workspaces", "exec-ok")), "the confined workspace is gone");

      const stA = await fetch(`${base2}/api/state`).then((r) => r.json());
      assert.ok(!stA.artifacts.some((a) => a.id === "art-evil"), "the traversal artifact RECORD still went (store data, not disk)");
      assert.ok(!stA.projects.some((x) => x.id === "evil") && !stA.missions.some((m) => m.id === "m-evil"));
      assert.ok(stA.projects.some((x) => x.id === "seed-old") && stA.tasks.some((t) => t.id === "st1"), "the old project is untouched");
      assert.ok(stA.projects.some((x) => x.id === "wf-9") === false, "workflows never surface as projects");
      const disk = JSON.parse(readFileSync(join(dir2, "runtime.json"), "utf8"));
      assert.ok(disk.projects.some((x) => x.id === "wf-9"), "the workflow RECORD was never touched");
    } finally { srv2.kill(); }
    rmSync(escapeFile, { force: true });
  } finally { rmSync(dir2, { recursive: true, force: true }); }
});

// ── component tests: the header menu + the delete confirm, rendered in a vm ──

const TL_START = SHELL_PAGE.indexOf("// ── task list helpers");
const TL_END = SHELL_PAGE.indexOf("/** A foldable settings section", TL_START);
const B_START = SHELL_PAGE.indexOf("// ── task board (task-pm-08)");
const B_END = SHELL_PAGE.indexOf("// Theme: LIGHT is the default", B_START);
const PC_START = SHELL_PAGE.indexOf("/** A durable Plan");
const D_START = SHELL_PAGE.indexOf("// ── task detail (task-pm-09)");
const PV = SHELL_PAGE.indexOf("// ── project view: the task spine", D_START);
const PV_END = SHELL_PAGE.indexOf("// ── settings:", PV);
assert.ok(TL_START > 0 && TL_END > TL_START && B_START > 0 && B_END > B_START && PC_START > 0 && D_START > PC_START && PV > D_START && PV_END > PV,
  "all shell blocks are in place");
const BLOCKS = [
  SHELL_PAGE.slice(TL_START, TL_END),
  SHELL_PAGE.slice(B_START, B_END),
  SHELL_PAGE.slice(PC_START, D_START),
  SHELL_PAGE.slice(D_START, PV),
  SHELL_PAGE.slice(PV, PV_END),
].join("\n");

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const htmlOf = (n) => (n == null ? "" : typeof n === "string" ? n : (n.html || "") + (n.children || []).map(htmlOf).join(""));

function makeCtx(st = {}, locale = "en", apiImpl = null) {
  const stub = () => ({ onclick: null, onchange: null, oninput: null, onkeydown: null, value: "", textContent: "", placeholder: "", disabled: false, style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {} }, appendChild() {}, children: [] });
  const calls = [];
  const sandbox = {
    t: (k) => CATALOG[locale][k] || CATALOG.en[k] || k,
    esc,
    S: { state: st },
    __renders: 0,
    __alerts: [],
    render() { sandbox.__renders++; },
    alert(m) { sandbox.__alerts.push(String(m)); },
    refresh: async () => {},
    api: async (p, body) => { calls.push([p, body]); return apiImpl ? apiImpl(p, body) : {}; },
    I: (n) => `<svg data-ic="${n}"></svg>`,
    el(h) {
      const node = { html: h, children: [], value: "", textContent: "", placeholder: "", disabled: false, style: {}, dataset: {},
        classList: { add() {}, remove() {}, toggle() {} },
        appendChild(c) { node.children.push(c); return c; },
        querySelector() { return stub(); },
        querySelectorAll() { return []; } };
      Object.defineProperty(node, "innerHTML", {
        get() { return node.html; },
        set(v) { if (v === "") node.children.length = 0; else node.html = v; },
      });
      return node;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(BLOCKS + "\n;globalThis.__h={liveProjects,archivedProjects,archivedRow,taskFilterBar,projectMenu,projectDeleteConfirm,projectHeader,projectView};", sandbox);
  return { sandbox, h: sandbox.__h, calls };
}

test("project menu: archive/restore post the right endpoint; delete opens the typed-name confirm", async () => {
  const proj = { id: "p1", kind: "project", name: "Portal" };
  const { sandbox, h, calls } = makeCtx({ projects: [proj] });
  const menu = h.projectMenu(sandbox.S.state, proj);
  const dd = menu.children[0].children[0];           // details → the menu panel
  const [archBtn, delBtn] = dd.children;
  assert.ok(htmlOf(archBtn).includes(CATALOG.en["project.archive"]), "the archive item is labeled");
  assert.ok(htmlOf(delBtn).includes(CATALOG.en["project.delete"]), "the delete item is labeled");
  await archBtn.onclick();
  assert.deepEqual([calls.at(-1)[0], { ...calls.at(-1)[1] }], ["/api/project/archive", { id: "p1" }], "archive posts");
  assert.equal(sandbox.__renders, 1, "a successful archive re-renders from the server state");

  // An archived project offers Restore, posting unarchive.
  const archProj = { ...proj, archivedAt: 123 };
  const menu2 = h.projectMenu(sandbox.S.state, archProj);
  const [restoreBtn] = menu2.children[0].children[0].children;
  assert.ok(htmlOf(restoreBtn).includes(CATALOG.en["project.unarchive"]), "restore is offered when archived");
  await restoreBtn.onclick();
  assert.deepEqual([calls.at(-1)[0], { ...calls.at(-1)[1] }], ["/api/project/unarchive", { id: "p1" }], "restore posts unarchive");

  // Delete swaps the menu for the confirm; cancel returns to the menu.
  delBtn.onclick();
  assert.ok(menu.children[0].html.includes("id=pdel"), "delete opens the confirm, not the API");
  const confirm = menu.children[0];
  const cancel = confirm.children[1].children[1];
  cancel.onclick();
  assert.ok(menu.children[0].html.includes("<details"), "cancel returns to the menu without posting");
  assert.ok(!calls.some(([p]) => p === "/api/project/delete"), "cancel never posts a delete");
});

test("delete confirm: button disabled until the EXACT name; success navigates to chat/ad-hoc; errors surface in place", async () => {
  const proj = { id: "p1", kind: "project", name: "Portal" };
  let failNext = false;
  const { sandbox, h, calls } = makeCtx({ projects: [proj] }, "en",
    async () => (failNext ? { error: "Project \"Portal\" has running work" } : { projects: [], removed: { tasks: 1 } }));
  sandbox.S.projectId = "p1"; sandbox.S.convId = "c1"; sandbox.S.view = "chat";
  const d = h.projectDeleteConfirm(proj, {});
  assert.ok(d.html.includes(esc(CATALOG.en["project.deleteWarning"].replace("{name}", "Portal"))), "the warning names the project (escaped)");
  assert.ok(d.html.includes(CATALOG.en["project.deleteConfirmLabel"]), "the typed-name instruction shows");
  const [inp, bar] = d.children;
  const [go, , msg] = bar.children;
  assert.equal(go.disabled, true, "disabled out of the gate");
  assert.equal(inp.placeholder, "Portal", "the input names exactly what must be typed");

  inp.value = "portal"; inp.oninput();
  assert.equal(go.disabled, true, "case mismatch stays disabled");
  inp.value = "Portal "; inp.oninput();
  assert.equal(go.disabled, true, "trailing space stays disabled");
  inp.value = "Portal"; inp.oninput();
  assert.equal(go.disabled, false, "the exact name enables the button");

  // Server refusal → the error surfaces in place, no navigation, no re-render.
  failNext = true;
  const before = sandbox.__renders;
  await go.onclick();
  assert.equal(msg.textContent, 'Project "Portal" has running work', "the server error shows in place");
  assert.equal(sandbox.__renders, before, "a refused delete never navigates/re-renders");
  assert.equal(sandbox.S.projectId, "p1", "still on the project");

  // Success → the project is gone from the state and the UI lands honestly on chat/ad-hoc.
  failNext = false;
  await go.onclick();
  assert.deepEqual([calls.at(-1)[0], { ...calls.at(-1)[1] }], ["/api/project/delete", { id: "p1", confirmName: "Portal" }],
    "the exact typed name is what gets posted");
  assert.equal(sandbox.S.projectId, null, "the deleted project is no longer selected");
  assert.equal(sandbox.S.convId, null, "no stale conversation selection");
  assert.equal(sandbox.S.view, "chat", "lands on the chat/ad-hoc surface");
  assert.equal(sandbox.S.state.removed.tasks, 1, "the server state (with the honest summary) is adopted");
  assert.equal(sandbox.__renders, before + 1, "one honest re-render");
});

test("XSS sweep: an evil project name can never inject through the menu, confirm or archived row", () => {
  const EVIL = '</div><img src=x onerror=alert(1)>';
  const proj = { id: "p1", kind: "project", name: EVIL, archivedAt: 1 };
  const { sandbox, h } = makeCtx({ projects: [proj] });
  const all = htmlOf(h.projectMenu(sandbox.S.state, proj)) + htmlOf(h.projectDeleteConfirm(proj, {})) + htmlOf(h.archivedRow(sandbox.S.state, proj));
  assert.ok(!all.includes(EVIL), "no raw payload anywhere");
  assert.ok(all.includes(esc(EVIL)), "the payload shows as escaped text");
});

test("i18n parity (fr/de) for the archive/delete keys; the page still parses", () => {
  for (const loc of LOCALES) assert.deepEqual(missingKeys(loc), [], `${loc} is missing keys`);
  const KEYS = ["shell.archived", "project.menu", "project.archive", "project.unarchive", "project.delete",
    "project.deleteWarning", "project.deleteConfirmLabel", "project.deleteButton",
    "project.archivedLaunch", "project.deleteRunning", "project.deleteConfirm"];
  for (const loc of LOCALES) for (const k of KEYS)
    assert.ok(CATALOG[loc][k] && CATALOG[loc][k] !== k, `${loc}:${k} has a real translation`);

  const proj = { id: "p1", kind: "project", name: "Portail", archivedAt: 1 };
  const fr = makeCtx({ projects: [proj] }, "fr");
  assert.ok(htmlOf(fr.h.projectMenu(fr.sandbox.S.state, proj)).includes(CATALOG.fr["project.unarchive"]), "fr: restore localizes");
  assert.ok(htmlOf(fr.h.projectDeleteConfirm(proj, {})).includes(CATALOG.fr["project.deleteButton"]), "fr: the delete button localizes");
  const de = makeCtx({ projects: [proj] }, "de");
  assert.ok(htmlOf(de.h.projectDeleteConfirm(proj, {})).includes(esc(CATALOG.de["project.deleteWarning"].replace("{name}", "Portail"))), "de: the warning localizes");
  assert.ok(htmlOf(de.h.archivedRow(de.sandbox.S.state, proj)).includes("svg"), "de: the archived row renders");

  const page = SHELL_PAGE.replace("__BO_I18N__", "{}").replaceAll("__BO_LOCALE__", "en").replace("__BO_CSRF__", "x");
  const js = page.split("<script>")[1].split("</scr" + "ipt>")[0];
  new vm.Script(js);   // parse guard — a template-literal slip can never blank the page
});
