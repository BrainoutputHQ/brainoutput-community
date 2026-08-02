// SPDX-License-Identifier: Apache-2.0
// Task list surfaces (task-pm-07): priority indicators, blocked-by badges, label chips, and the
// status × project × assignee filters in the sidebar Tasks section. Component tests follow the
// vm/parse-guard pattern (escalation.test.mjs): the REAL helper block + issueRow are extracted
// from SHELL_PAGE and rendered in a vm against /api/state-shaped fixtures — no browser needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { SHELL_PAGE } from "./shell.mjs";
import { CATALOG, LOCALES, missingKeys } from "./i18n.mjs";

const start = SHELL_PAGE.indexOf("// ── task list helpers");
const end = SHELL_PAGE.indexOf("/** A foldable settings section", start);
assert.ok(start > 0 && end > start, "the task-list helper block is in the shell");
const HELPERS = SHELL_PAGE.slice(start, end);

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** A vm context with the same helpers the shell gives its components. el() is a fake that keeps
 *  the HTML string and tracks appended children, so filter selects stay reachable. */
function makeCtx(state = {}, locale = "en") {
  const sandbox = {
    t: (k) => CATALOG[locale][k] || CATALOG.en[k] || k,
    esc,
    S: { state },
    __renders: 0,
    render() { sandbox.__renders++; },
    el(h) { const e = { html: h, children: [], value: "", style: {}, appendChild(c) { this.children.push(c); } }; return e; },
  };
  vm.createContext(sandbox);
  vm.runInContext(HELPERS + "\n;globalThis.__h={PRIO_COLOR,prioDot,taskById,openBlockers,blockedBadge,labelChips,taskFilter,taskFilterBar,issueRow};", sandbox);
  return { sandbox, h: sandbox.__h };
}

test("priority indicator: one dot per priority, four distinct colors, urgent/high distinct, none → nothing", () => {
  const { h } = makeCtx();
  for (const p of ["urgent", "high", "medium", "low"]) {
    const html = h.prioDot(p);
    assert.match(html, /class=pdot/, `${p} renders the dot`);
    assert.ok(html.includes(CATALOG.en[`task.priority.${p}`]), `tooltip carries the localized name (${p})`);
  }
  const colors = ["urgent", "high", "medium", "low"].map((p) => h.prioDot(p).match(/background:([^;"]+)/)[1]);
  assert.equal(new Set(colors).size, 4, "every priority is visually distinct");
  assert.notEqual(colors[0], colors[1], "urgent ≠ high");
  assert.equal(h.prioDot("none"), "");
  assert.equal(h.prioDot(undefined), "");
  assert.equal(h.prioDot("bogus"), "");

  // Sidebar rows: the dot is in the row, and a running task keeps its live dot.
  const run = h.issueRow({ id: "t1", title: "x", status: "in-progress", priority: "urgent", projectId: "p1" });
  assert.match(run.html, /sdot run/, "the live running dot stays");
  assert.match(run.html, /pdot/);
  assert.ok(!h.issueRow({ id: "t2", title: "y", status: "todo", priority: "none" }).html.includes("pdot"), "'none' shows nothing");
  assert.ok(!h.issueRow({ id: "t3", title: "z", status: "todo" }).html.includes("pdot"), "old records without priority show nothing");

  // Localization flows through t() — a French tooltip names the priority in French.
  const { h: hfr } = makeCtx({}, "fr");
  assert.ok(hfr.prioDot("urgent").includes(CATALOG.fr["task.priority.urgent"]));
});

test("blocked-by badge: exactly when a dependsOn is OPEN; tooltip names the open blockers, esc()'d", () => {
  const state = { tasks: [
    { id: "b1", title: "Base <img src=x onerror=alert(1)>", status: "todo" },
    { id: "b2", title: "Other dep", status: "done" },
    { id: "tk-blocked", title: "Blocked task", status: "todo", dependsOn: ["b1", "b2"] },
    { id: "tk-clear", title: "Clear task", status: "todo", dependsOn: ["b2"] },
    { id: "tk-plain", title: "Plain old task", status: "todo" },
    { id: "tk-ghost", title: "Ghost dep", status: "todo", dependsOn: ["nope"] },
    { id: "tk-stblocked", title: "Status-blocked only", status: "blocked" },
  ] };
  const { h } = makeCtx(state);

  const badge = h.blockedBadge(state, state.tasks[2]);
  assert.match(badge, /bbadge/, "badge appears when a dep is open");
  assert.ok(badge.includes(CATALOG.en["task.blockedBy"]));
  assert.ok(badge.includes("Base &lt;img src=x onerror=alert(1)&gt;"), "blocker titles in the tooltip, escaped");
  assert.ok(!badge.includes("<img src=x"), "never the raw markup");
  assert.ok(!badge.includes("Other dep"), "done deps are not named as blockers");
  assert.match(h.issueRow(state.tasks[2]).html, /bbadge/, "the badge lands in the sidebar row");

  for (const [i, why] of [[3, "all deps done"], [4, "no dependsOn (old record)"], [5, "unknown dep id"], [6, "status=blocked without open deps"]])
    assert.equal(h.blockedBadge(state, state.tasks[i]), "", `no badge: ${why}`);
  // An in-progress or blocked dep still blocks — only 'done' clears.
  state.tasks[0].status = "in-progress";
  assert.match(h.blockedBadge(state, state.tasks[2]), /bbadge/);
  state.tasks[0].status = "blocked";
  assert.match(h.blockedBadge(state, state.tasks[2]), /bbadge/);
  state.tasks[0].status = "done";
  assert.equal(h.blockedBadge(state, state.tasks[2]), "", "last open dep done → badge gone");
});

test("label chips render esc()'d — a stored label can never inject markup", () => {
  const EVIL = '</span><img src=x onerror=alert(1)>';
  const { h } = makeCtx();
  const html = h.labelChips({ labels: ["web", EVIL] });
  assert.ok(html.includes(">web<"), "plain label renders as a chip");
  assert.match(html, /tchip/);
  assert.ok(!html.includes(EVIL), "the raw payload is NOT rendered");
  assert.ok(html.includes("&lt;/span&gt;&lt;img src=x onerror=alert(1)&gt;"), "the escaped payload shows as text");
  assert.equal(h.labelChips({}), "", "old records without labels render nothing");
  assert.equal(h.labelChips({ labels: [] }), "");
  // The project task rows actually wire priority + blocked-by + labels (source pin).
  const row = SHELL_PAGE.slice(SHELL_PAGE.indexOf("function taskRow("), SHELL_PAGE.indexOf("const srow="));
  assert.ok(row.includes("prioDot(tk.priority)"), "project rows show the priority dot");
  assert.ok(row.includes("blockedBadge(S.state||{},tk)"), "project rows show the blocked-by badge");
  assert.ok(row.includes("labelChips(tk)"), "project rows show label chips");
});

test("filters combine (AND): status × project × assignee over a fixture matrix", () => {
  const { h } = makeCtx();
  const T = [
    { id: "a", status: "todo", projectId: "p1", assignee: "ann" },
    { id: "b", status: "in-progress", projectId: "p1", assignee: "bob" },
    { id: "c", status: "blocked", projectId: "p2", assignee: "ann" },
    { id: "d", status: "done", projectId: "p2", assignee: "bob" },
    { id: "e", status: "todo", projectId: "p2", assignee: null },
    { id: "f", status: "todo", projectId: null, assignee: "ann" },
  ];
  const F = (f) => h.taskFilter(T, f).map((x) => x.id);
  assert.deepEqual(F({}), ["a", "b", "c", "d", "e", "f"], "empty filter = everything");
  assert.deepEqual(F({ status: "all", projectId: "all", assignee: "all" }), ["a", "b", "c", "d", "e", "f"]);
  assert.deepEqual(F({ status: "todo" }), ["a", "e", "f"]);
  assert.deepEqual(F({ status: "done" }), ["d"]);
  assert.deepEqual(F({ status: "blocked" }), ["c"]);
  assert.deepEqual(F({ status: "todo", projectId: "p2" }), ["e"], "status AND project");
  assert.deepEqual(F({ status: "todo", projectId: "p2", assignee: "ann" }), [], "AND excludes the null-assignee task");
  assert.deepEqual(F({ assignee: "ann" }), ["a", "c", "f"]);
  assert.deepEqual(F({ projectId: "p1", assignee: "bob" }), ["b"], "project AND assignee");
  assert.deepEqual(F({ status: "blocked", projectId: "p2", assignee: "ann" }), ["c"], "all three combine");
  assert.deepEqual(F({ status: "blocked", assignee: "bob" }), []);
  assert.deepEqual(F({ status: "todo", projectId: "p1" }), ["a"], "a null-project task is excluded by a project pick");
});

test("filter selection survives a render() round-trip (in-memory session S)", () => {
  const state = {
    tasks: [
      { id: "a", status: "todo", projectId: "p1", assignee: "ann" },
      { id: "b", status: "done", projectId: "p2", assignee: "bob" },
      { id: "c", status: "todo", projectId: "p1", assignee: null },
    ],
    projects: [{ id: "p1", name: "One <b>" }, { id: "p2", name: "Two" }],
  };
  const { sandbox, h } = makeCtx(state);

  let bar = h.taskFilterBar(state);
  let [st, pj, asg] = bar.children;
  assert.equal(st.value, "all"); assert.equal(pj.value, "all"); assert.equal(asg.value, "all");
  // The three selects: statuses from the catalog, one project per project-with-tasks, one option
  // per distinct (non-null) assignee — every dynamic value esc()'d.
  assert.ok(st.html.includes(CATALOG.en["tasks.filter.allStatuses"]));
  assert.ok(st.html.includes('value="in-progress"') && st.html.includes(CATALOG.en["task.status.in-progress"]));
  assert.ok(pj.html.includes('value="p1"') && pj.html.includes('value="p2"'));
  assert.ok(pj.html.includes("One &lt;b&gt;") && !pj.html.includes("One <b>"), "project names esc()'d");
  assert.ok(asg.html.includes('value="ann"') && asg.html.includes('value="bob"'));
  assert.ok(!asg.html.includes("null"), "a null assignee never becomes an option");

  // The user picks all three filters — each change persists to S and re-renders.
  st.value = "done"; st.onchange();
  pj.value = "p2"; pj.onchange();
  asg.value = "bob"; asg.onchange();
  assert.equal(sandbox.__renders, 3, "every change re-renders");
  assert.deepEqual({ ...sandbox.S.taskFilter }, { status: "done", projectId: "p2", assignee: "bob" });

  // render() rebuilds the bar from scratch — the selection is read back out of S.
  bar = h.taskFilterBar(state);
  [st, pj, asg] = bar.children;
  assert.equal(st.value, "done", "status selection survives the round-trip");
  assert.equal(pj.value, "p2", "project selection survives the round-trip");
  assert.equal(asg.value, "bob", "assignee selection survives the round-trip");
  assert.deepEqual(h.taskFilter(state.tasks, sandbox.S.taskFilter).map((x) => x.id), ["b"], "the persisted filter applies");

  // A pick that no longer exists (project deleted / no tasks left) auto-heals to 'all'.
  sandbox.S.taskFilter.projectId = "ghost";
  bar = h.taskFilterBar(state);
  assert.equal(bar.children[1].value, "all", "a stale project pick auto-heals");
  assert.equal(sandbox.S.taskFilter.projectId, "all");
});

test("the sidebar wires the bar + the filter into the Tasks section (source pins)", () => {
  assert.ok(SHELL_PAGE.includes("id=taskfilters"), "the filter bar container is in the page");
  assert.ok(SHELL_PAGE.includes("taskFilter((s.tasks||[])"), "the sidebar list runs through taskFilter");
  assert.ok(SHELL_PAGE.includes("S.taskFilter"), "the selection lives in session state");
  assert.ok(SHELL_PAGE.includes("getElementById('taskfilters').style.display=searching?'none'"), "the bar hides during chat search");
});

test("i18n parity (fr/de missingKeys empty) and the page script still parses", () => {
  for (const loc of LOCALES) assert.deepEqual(missingKeys(loc), [], `${loc} is missing keys`);
  const KEYS = ["task.priority.urgent", "task.priority.high", "task.priority.medium", "task.priority.low",
    "task.priority.none", "task.blockedBy", "tasks.filter.status", "tasks.filter.project",
    "tasks.filter.assignee", "tasks.filter.allStatuses", "tasks.filter.allProjects", "tasks.filter.allAssignees"];
  for (const loc of LOCALES) for (const k of KEYS)
    assert.ok(CATALOG[loc][k] && CATALOG[loc][k] !== k, `${loc}:${k} has a real translation`);

  const page = SHELL_PAGE.replace("__BO_I18N__", "{}").replaceAll("__BO_LOCALE__", "en").replace("__BO_CSRF__", "x");
  const js = page.split("<script>")[1].split("</scr" + "ipt>")[0];
  new vm.Script(js);   // parse guard — a template-literal slip can never blank the page
});
