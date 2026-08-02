// SPDX-License-Identifier: Apache-2.0
// Task board (task-pm-08): a per-project board view — one column per status, top-level tasks as
// cards (subtasks inside their parent's card with their own status marker + move control),
// drag-and-drop AND a keyboard move select, both moving through POST /api/task/status with the
// UI updating only after the API confirms. The list/board toggle persists server-side per
// project via /api/settings (settings.taskViewByProject). Component tests follow the vm/
// parse-guard pattern (tasklist.test.mjs); the move flow + settings persistence run against a
// real server in a tmp dir (escalation.test.mjs pattern).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SHELL_PAGE } from "./shell.mjs";
import { CATALOG, LOCALES, missingKeys } from "./i18n.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 4412;
const BASE = `http://127.0.0.1:${PORT}`;
let srv, dir;

// Extract the REAL blocks from the page: the task-list helpers (prioDot, blockedBadge,
// labelChips) and the new board block — rendered in a vm, no browser needed.
const TL_START = SHELL_PAGE.indexOf("// ── task list helpers");
const TL_END = SHELL_PAGE.indexOf("/** A foldable settings section", TL_START);
const B_START = SHELL_PAGE.indexOf("// ── task board (task-pm-08)");
const B_END = SHELL_PAGE.indexOf("// Theme: LIGHT is the default", B_START);
assert.ok(TL_START > 0 && TL_END > TL_START, "the task-list helper block is in the shell");
assert.ok(B_START > 0 && B_END > B_START, "the task-board block is in the shell");
const BLOCKS = SHELL_PAGE.slice(TL_START, TL_END) + "\n" + SHELL_PAGE.slice(B_START, B_END);

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** A vm context with the same helpers the shell gives its components. el() is a fake that keeps
 *  the HTML string and tracks appended children, so cards, subtask rows, move selects and
 *  columns stay reachable; api/alert/render are stubbed (overridable per test). */
function makeCtx(state = {}, locale = "en", apiImpl = null) {
  const sandbox = {
    t: (k) => CATALOG[locale][k] || CATALOG.en[k] || k,
    esc,
    S: { state },
    __renders: 0, __alerts: [], __apiCalls: [],
    render() { sandbox.__renders++; },
    alert(m) { sandbox.__alerts.push(String(m)); },
    api: apiImpl || (async (p, body) => { sandbox.__apiCalls.push([p, body]); return { ok: true }; }),
    el(h) {
      return { html: h, children: [], value: "", style: {}, classList: { add() {}, remove() {} },
        appendChild(c) { this.children.push(c); } };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(BLOCKS + "\n;globalThis.__h={BOARD_COLS,taskViewOf,moveTask,moveSel,boardSubRow,boardCard,taskBoard,prioDot,blockedBadge,labelChips};", sandbox);
  return { sandbox, h: sandbox.__h };
}

const colOf = (board, status) => board.children.find((c) => (c.html || "").includes(`data-status="${status}"`));
const cardsOf = (col) => col.children.slice(1).filter((c) => (c.html || "").startsWith("<div class=bcard"));
const cardIds = (col) => cardsOf(col).map((c) => c.html.match(/data-id="([^"]+)"/)[1]);
const countOf = (col) => Number(col.children[0].html.match(/bcnt>(\d+)</)[1]);
const flush = () => new Promise((r) => setTimeout(r, 0));

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "bo-taskboard-"));
  srv = spawn(process.execPath, [join(HERE, "web-server.mjs")],
    { env: { ...process.env, BO_CE_DATA: dir, BO_CE_WEB_PORT: String(PORT),
      BO_OPENCODE_BIN: "/nonexistent-opencode" }, stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    try { await fetch(`${BASE}/api/state`); return; } catch { await new Promise((r) => setTimeout(r, 250)); if (i === 59) throw new Error("server did not start"); }
  }
});
after(() => { srv?.kill(); rmSync(dir, { recursive: true, force: true }); });

const post = (path, body) => fetch(`${BASE}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json().then((j) => ({ status: r.status, body: j })));
const state = () => fetch(`${BASE}/api/state`).then((r) => r.json());

test("board columns reflect real statuses: fixed order, honest top-level counts, exactly their tasks", () => {
  const st = { tasks: [
    { id: "t1", title: "Todo A", status: "todo", projectId: "p1", priority: "high" },
    { id: "t2", title: "Todo B", status: "todo", projectId: "p1" },
    { id: "t3", title: "Doing", status: "in-progress", projectId: "p1" },
    { id: "t4", title: "Stuck", status: "blocked", projectId: "p1" },
    { id: "t5", title: "Finished", status: "done", projectId: "p1" },
    { id: "t6", title: "Todo with an open blocker", status: "todo", projectId: "p1", dependsOn: ["t3"] },
  ] };
  const { h } = makeCtx(st);
  const board = h.taskBoard(st, st.tasks);
  assert.equal(board.children.length, 4, "one column per status");
  assert.deepEqual(board.children.map((c) => c.html.match(/data-status="([^"]+)"/)[1]),
    ["todo", "in-progress", "blocked", "done"], "the column order is fixed");

  assert.equal(countOf(colOf(board, "todo")), 3, "honest todo count (top-level only)");
  assert.equal(countOf(colOf(board, "in-progress")), 1);
  assert.equal(countOf(colOf(board, "blocked")), 1);
  assert.equal(countOf(colOf(board, "done")), 1);
  assert.deepEqual(cardIds(colOf(board, "todo")), ["t1", "t2", "t6"], "the todo column holds exactly its tasks");
  assert.deepEqual(cardIds(colOf(board, "in-progress")), ["t3"]);
  assert.deepEqual(cardIds(colOf(board, "blocked")), ["t4"]);
  assert.deepEqual(cardIds(colOf(board, "done")), ["t5"]);

  // Headers carry the localized status name.
  assert.ok(colOf(board, "todo").children[0].html.includes(CATALOG.en["task.status.todo"]));
  // Blocked-column honesty: status is truth — t6 has an OPEN blocker but status todo, so it
  // stays in todo; its blocked-by badge rides along as context, never as an auto-move.
  const t6card = cardsOf(colOf(board, "todo")).find((c) => c.html.includes('data-id="t6"'));
  assert.ok(t6card, "the open-blocker task shows in todo");
  assert.match(t6card.html, /bbadge/, "…with its blocked-by badge");
  assert.ok(t6card.html.includes("Doing"), "the badge tooltip names the blocker");
  assert.deepEqual(cardIds(colOf(board, "blocked")), ["t4"], "nothing auto-moved into blocked");
  // Cards show priority dot, title, labels, assignee hooks.
  assert.match(cardsOf(colOf(board, "todo"))[0].html, /pdot/, "priority dot on the card");
});

test("subtasks render inside the parent card with a status marker — never as their own column card", () => {
  const st = { tasks: [
    { id: "p", title: "Parent", status: "todo", projectId: "p1" },
    { id: "s1", title: "Sub done", status: "done", projectId: "p1", parentId: "p" },
    { id: "s2", title: "Sub open", status: "todo", projectId: "p1", parentId: "p" },
  ] };
  const { h } = makeCtx(st);
  const board = h.taskBoard(st, st.tasks);
  for (const c of board.children) {
    assert.deepEqual(cardIds(c), c.html.includes('data-status="todo"') ? ["p"] : [],
      `column ${c.html.match(/data-status="([^"]+)"/)[1]} holds only top-level tasks`);
    assert.equal(countOf(c), c.html.includes('data-status="todo"') ? 1 : 0, "counts are top-level only");
  }
  const card = cardsOf(colOf(board, "todo"))[0];
  const subs = card.children.filter((c) => (c.html || "").startsWith('<div class="bsub'));
  assert.equal(subs.length, 2, "both subtasks render inside the parent's card");
  assert.match(subs[0].html, />✓</, "a done subtask gets the ✓ marker");
  assert.match(subs[1].html, />○</, "an open subtask gets the ○ marker");
  assert.ok(subs[0].html.includes("Sub done") && subs[1].html.includes("Sub open"));
  assert.ok(!cardIds(colOf(board, "done")).includes("s1"), "the done subtask is not a done-column card");
});

test("the move control sits on every card AND every subtask row, offering the other 3 statuses", () => {
  const st = { tasks: [
    { id: "p", title: "Parent", status: "todo" },
    { id: "s1", title: "Sub", status: "in-progress", parentId: "p" },
  ] };
  const { h } = makeCtx(st);
  const card = h.boardCard(st, st.tasks[0], [st.tasks[1]]);
  const sel = card.children.find((c) => (c.html || "").startsWith("<select"));
  assert.ok(sel, "the card carries a move select");
  assert.ok(sel.html.includes('value="in-progress"') && sel.html.includes('value="blocked"') && sel.html.includes('value="done"'),
    "the card's select offers the other three statuses");
  assert.ok(!sel.html.includes('value="todo"'), "…not its current one");
  assert.ok(sel.html.includes(CATALOG.en["task.move"]), "the control is localized");
  assert.ok(sel.html.includes('aria-label='), "keyboard/screen-reader accessible");

  const subRow = card.children.find((c) => (c.html || "").startsWith('<div class="bsub'));
  const subSel = subRow.children.find((c) => (c.html || "").startsWith("<select"));
  assert.ok(subSel, "the subtask row carries its own move select");
  assert.ok(subSel.html.includes('value="todo"') && subSel.html.includes('value="blocked"') && subSel.html.includes('value="done"'));
  assert.ok(!subSel.html.includes('value="in-progress"'), "the sub's own status is excluded");
  // Localized option labels, not raw status ids.
  assert.ok(subSel.html.includes(CATALOG.en["task.status.done"]));
});

test("move flow on a real server: POST confirms → re-render shows the new column; a bad status keeps the card and surfaces the error", async () => {
  const p = await post("/api/project", { name: "board-proj" });
  const pid = p.body.project.id;
  const mk = await post("/api/task/new", { title: "board move me", projectId: pid });
  const tid = mk.body.task.id;
  // The vm speaks to the REAL server: the same /api/task/status the page posts to.
  const realApi = async (path, body) => (await post(path, body)).body;
  let ctx = makeCtx(await state(), "en", realApi);

  let board = ctx.h.taskBoard(ctx.sandbox.S.state, (ctx.sandbox.S.state.tasks || []).filter((x) => x.projectId === pid));
  assert.deepEqual(cardIds(colOf(board, "todo")), [tid], "the new task starts in todo");

  // MOVE: the API confirms, S.state is replaced from the response, and a re-render lands the
  // card in the new column with honest counts.
  const ok = await ctx.h.moveTask({ id: tid, status: "todo" }, "in-progress");
  assert.equal(ok, true);
  assert.equal(ctx.sandbox.S.state.tasks.find((x) => x.id === tid).status, "in-progress", "S.state came from the server response");
  assert.equal((await state()).tasks.find((x) => x.id === tid).status, "in-progress", "the server persisted it");
  assert.ok(ctx.sandbox.__renders >= 1, "the UI re-rendered AFTER confirmation");
  ctx = makeCtx(ctx.sandbox.S.state, "en", realApi);
  board = ctx.h.taskBoard(ctx.sandbox.S.state, ctx.sandbox.S.state.tasks.filter((x) => x.projectId === pid));
  assert.deepEqual(cardIds(colOf(board, "in-progress")), [tid], "the card shows in the new column");
  assert.deepEqual(cardIds(colOf(board, "todo")), [], "…and left the old one");
  assert.equal(countOf(colOf(board, "todo")), 0);

  // FAILURE: a bad status → the API rejects; the card stays, the error is surfaced.
  const before = ctx.sandbox.S.state;
  const bad = await ctx.h.moveTask({ id: tid, status: "in-progress" }, "bogus");
  assert.equal(bad, false);
  assert.equal(ctx.sandbox.S.state, before, "S.state untouched on failure — no optimistic lie");
  assert.equal(ctx.sandbox.__alerts.length, 1, "the error was surfaced");
  assert.match(ctx.sandbox.__alerts[0], /unknown task status/);
  assert.equal((await state()).tasks.find((x) => x.id === tid).status, "in-progress", "the server never moved it");
  board = ctx.h.taskBoard(ctx.sandbox.S.state, ctx.sandbox.S.state.tasks.filter((x) => x.projectId === pid));
  assert.deepEqual(cardIds(colOf(board, "in-progress")), [tid], "the card stayed put");
});

test("toggle: the list/board choice persists server-side per project (survives a state reload)", async () => {
  const a = (await post("/api/project", { name: "proj A" })).body.project.id;
  const b = (await post("/api/project", { name: "proj B" })).body.project.id;

  const r1 = await post("/api/settings", { taskViewByProject: { [a]: "board" } });
  assert.equal(r1.status, 200, JSON.stringify(r1.body).slice(0, 300));
  assert.equal(r1.body.settings.taskViewByProject[a], "board", "the server stored the choice");

  // A second project merges — it never wipes the first project's choice.
  const r2 = await post("/api/settings", { taskViewByProject: { [b]: "list" } });
  assert.equal(r2.body.settings.taskViewByProject[a], "board", "per-project merge keeps A");
  assert.equal(r2.body.settings.taskViewByProject[b], "list");
  assert.equal(r2.body.settings.mode, "regular", "other settings keys untouched");

  // Reload state fresh from the server — the choice is durable, not session memory.
  const reloaded = await state();
  assert.equal(reloaded.settings.taskViewByProject[a], "board", "board for A survives the reload");
  assert.equal(reloaded.settings.taskViewByProject[b], "list", "list for B survives the reload");

  const { h } = makeCtx(reloaded);
  assert.equal(h.taskViewOf(reloaded, a), "board", "A renders the board");
  assert.equal(h.taskViewOf(reloaded, b), "list", "B renders the list");
  assert.equal(h.taskViewOf(reloaded, "never-set"), "list", "default is list");

  // Fail-closed validation.
  assert.equal((await post("/api/settings", { taskViewByProject: { [a]: "kanban" } })).status, 400);
  assert.equal((await post("/api/settings", { taskViewByProject: "board" })).status, 400);
  assert.equal((await state()).settings.taskViewByProject[a], "board", "a rejected patch changes nothing");

  // The shell wires the toggle through the same endpoint (source pins).
  assert.ok(SHELL_PAGE.includes("taskViewByProject:{[proj.id]:b.dataset.v}"), "the toggle posts the per-project choice");
  assert.ok(SHELL_PAGE.includes("taskViewOf(s,proj.id)"), "the project view reads the persisted choice");
  assert.ok(SHELL_PAGE.includes("pt.appendChild(taskBoard(s,tasks))"), "board mode renders the board");
});

test("drag data: the card is draggable, carries the task id; a drop maps the column to its status", async () => {
  const st = { tasks: [
    { id: "d1", title: "Drag me", status: "todo" },
    { id: "d2", title: "Other", status: "done" },
  ] };
  const { sandbox, h } = makeCtx(st);
  const board = h.taskBoard(st, st.tasks);
  const card = cardsOf(colOf(board, "todo"))[0];
  assert.match(card.html, /draggable="true"/, "the card is draggable");
  assert.match(card.html, /data-id="d1"/, "the card carries the task id");

  // dragstart puts the id on the dataTransfer.
  const dt = { data: {}, effectAllowed: "", setData(k, v) { this.data[k] = v; }, getData(k) { return this.data[k]; } };
  card.ondragstart({ dataTransfer: dt });
  assert.equal(dt.data["text/plain"], "d1", "the drag payload is the task id");
  assert.equal(dt.effectAllowed, "move");

  // Dropping on the blocked column posts {id, status:'blocked'} — column → status mapping.
  colOf(board, "blocked").ondrop({ preventDefault() {}, dataTransfer: dt });
  await flush();
  assert.equal(JSON.stringify(sandbox.__apiCalls), JSON.stringify([["/api/task/status", { id: "d1", status: "blocked" }]]),
    "the drop moved the dragged task to the column's status");

  // Dropping on the task's OWN column is a no-op (no spurious POST).
  colOf(board, "todo").ondrop({ preventDefault() {}, dataTransfer: dt });
  await flush();
  assert.equal(sandbox.__apiCalls.length, 1, "same-column drop does nothing");
  // Unknown drag payloads are ignored.
  colOf(board, "done").ondrop({ preventDefault() {}, dataTransfer: { getData: () => "ghost" } });
  await flush();
  assert.equal(sandbox.__apiCalls.length, 1, "an unknown id never posts");
});

test("XSS sweep: malicious title / label / assignee / blocker name render escaped", () => {
  const EVIL_T = '</div><img src=x onerror=alert(1)>';
  const EVIL_L = '</span><img src=y onerror=alert(2)>';
  const EVIL_A = '<script>alert(3)</script>';
  const EVIL_B = '</span><img src=z onerror=alert(4)>';
  const st = { tasks: [
    { id: "blk", title: EVIL_B, status: "todo" },
    { id: "v", title: EVIL_T, status: "todo", labels: ["web", EVIL_L], assignee: EVIL_A, dependsOn: ["blk"], priority: "urgent" },
    { id: "s", title: EVIL_T, status: "todo", parentId: "v" },
  ] };
  const { h } = makeCtx(st);
  const card = h.boardCard(st, st.tasks[1], [st.tasks[2]]);
  const html = card.html + card.children.map((c) => c.html || "").join("\n");
  for (const evil of [EVIL_T, EVIL_L, EVIL_A, EVIL_B])
    assert.ok(!html.includes(evil), `raw payload NOT rendered: ${evil.slice(0, 30)}`);
  assert.ok(html.includes(esc(EVIL_T)), "the escaped title shows as text (card + subtask row)");
  assert.ok(html.includes(esc(EVIL_L)), "the escaped label chip shows as text");
  assert.ok(html.includes(esc(EVIL_A)), "the escaped assignee shows as text");
  assert.ok(html.includes(esc(EVIL_B)), "the escaped blocker name shows in the badge tooltip");
});

test("i18n parity (fr/de) for all new keys, and the page script still parses", () => {
  for (const loc of LOCALES) assert.deepEqual(missingKeys(loc), [], `${loc} is missing keys`);
  const KEYS = ["project.view.list", "project.view.board", "board.empty", "task.move",
    "task.status.todo", "task.status.in-progress", "task.status.blocked", "task.status.done"];
  for (const loc of LOCALES) for (const k of KEYS)
    assert.ok(CATALOG[loc][k] && CATALOG[loc][k] !== k, `${loc}:${k} has a real translation`);
  // The board chrome localizes for real: a French board has French columns + move control.
  const { h } = makeCtx({ tasks: [{ id: "x", title: "t", status: "todo" }] }, "fr");
  const board = h.taskBoard({ tasks: [{ id: "x", title: "t", status: "todo" }] }, [{ id: "x", title: "t", status: "todo" }]);
  assert.ok(colOf(board, "todo").children[0].html.includes(CATALOG.fr["task.status.todo"]));
  const card = cardsOf(colOf(board, "todo"))[0];
  assert.ok(card.children.some((c) => (c.html || "").includes(CATALOG.fr["task.move"])));

  const page = SHELL_PAGE.replace("__BO_I18N__", "{}").replaceAll("__BO_LOCALE__", "en").replace("__BO_CSRF__", "x");
  const js = page.split("<script>")[1].split("</scr" + "ipt>")[0];
  new vm.Script(js);   // parse guard — a template-literal slip can never blank the page
});

test("the settings endpoint merges taskViewByProject server-side (source pin)", () => {
  const src = readFileSync(join(HERE, "web-server.mjs"), "utf8");
  assert.ok(src.includes("patch.taskViewByProject"), "the whitelist accepts the key");
  assert.ok(src.includes("next.taskViewByProject = { ...(next.taskViewByProject || {})"), "per-project merge, not a clobber");
});
