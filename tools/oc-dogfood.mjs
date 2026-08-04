#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// tools/oc-dogfood.mjs — DOGFOOD driver for the BrainOutput Community Edition server-backed
// OpenCode runtime (2026-08-04 verification pass).
//
// Drives the REAL product HTTP API end to end against a LIVE CE web server (web-server.mjs)
// started with BO_CE_OPENCODE_SERVER=1 (opt-in server-backed OpenCode runtime) and BO_CE_DATA
// pointed at a throwaway store — never the founder's real ~/.local/share/bo-community.
//
//   node tools/oc-dogfood.mjs
//
// Env overrides:
//   BO_CE_WEB_PORT   port for the CE server (default: random high port)
//   OC_DOGFOOD_DATA  data dir (default: a fresh mkdtemp under /tmp)
//
// Exit 0 does NOT mean "everything worked" — it means the driver ran to completion and printed
// its evidence. Read the printed report; defects are reported, not swallowed.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const PORT = Number(process.env.BO_CE_WEB_PORT || (20000 + crypto.randomInt(0, 20000)));
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = process.env.OC_DOGFOOD_DATA || mkdtempSync(join(tmpdir(), "bo-dogfood-data-"));

const t0 = Date.now();
function ts() { return `+${((Date.now() - t0) / 1000).toFixed(2)}s`; }
function log(...args) { console.log(`[${ts()}]`, ...args); }
function section(name) { console.log(`\n${"=".repeat(70)}\n${name}\n${"=".repeat(70)}`); }

const stages = []; // { name, ok, evidence, ms }
function recordStage(name, ok, evidence, ms) {
  stages.push({ name, ok, evidence, ms });
  log(`STAGE ${ok ? "OK  " : "FAIL"} — ${name} (${ms}ms)`);
  if (evidence) console.log(evidence.split("\n").map((l) => "    " + l).join("\n"));
}

async function apiCall(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
  return { status: res.status, ok: res.ok, json, text };
}

let srv = null;
function startServer() {
  log(`spawning web-server.mjs on port ${PORT}, data dir ${DATA_DIR}`);
  const env = {
    ...process.env,
    BO_CE_DATA: DATA_DIR,
    BO_CE_WEB_PORT: String(PORT),
    BO_CE_OPENCODE_SERVER: "1",
  };
  const p = spawn(process.execPath, [join(ROOT, "web-server.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  p.stdout.setEncoding("utf8"); p.stdout.on("data", (d) => { out += d; });
  p.stderr.setEncoding("utf8"); p.stderr.on("data", (d) => { err += d; });
  srv = { proc: p, getOut: () => out, getErr: () => err };
  return srv;
}

async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (srv.proc.exitCode !== null) throw new Error(`server exited early (code ${srv.proc.exitCode}). stderr: ${srv.getErr().slice(-1000)}`);
    try {
      const r = await apiCall("GET", "/api/state");
      if (r.status === 200) return r.json;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server did not respond within ${timeoutMs}ms. stderr: ${srv.getErr().slice(-1000)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Subscribe to the CE server's own /api/session/{id}/live SSE relay, capture raw frames.
function subscribeLive(sessionId, onEvent) {
  const controller = new AbortController();
  const frames = [];
  const streamPromise = (async () => {
    const res = await fetch(`${BASE}/api/session/${encodeURIComponent(sessionId)}/live`, {
      signal: controller.signal, headers: { accept: "text/event-stream" },
    });
    if (!res.ok || !res.body) throw new Error(`live subscribe failed: HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of frame.split("\n")) {
            if (!line || line.startsWith(":")) continue;
            if (line.startsWith("data:")) {
              const payload = line.slice(5).trim();
              if (!payload) continue;
              frames.push(payload);
              try { onEvent(JSON.parse(payload)); } catch { /* keep raw anyway */ }
            }
          }
        }
      }
    } catch (e) {
      if (!controller.signal.aborted) throw e;
    }
  })();
  return { frames, stop: () => controller.abort(), done: streamPromise };
}

async function main() {
  const report = { dataDir: DATA_DIR, port: PORT };

  // ── Stage 1: start the CE server ────────────────────────────────────────────────────────────
  section("STAGE 1 — start CE server (BO_CE_OPENCODE_SERVER=1)");
  let s1start = Date.now();
  startServer();
  let state;
  try {
    state = await waitForServer();
    recordStage("server start + /api/state", true,
      `codingRuntime: ${JSON.stringify(state.codingRuntime)}\ncompany: ${JSON.stringify(state.company)}`,
      Date.now() - s1start);
  } catch (e) {
    recordStage("server start + /api/state", false, String(e.message || e), Date.now() - s1start);
    throw e;
  }

  try {
    // ── Stage 2: onboard a company (technical department) ─────────────────────────────────────
    section("STAGE 2 — onboard company");
    let s = Date.now();
    const ob = await apiCall("POST", "/api/onboard", {
      companyName: "Dogfood Co", companyDoes: "verification dogfooding", departments: ["technical"],
    });
    recordStage("POST /api/onboard", ob.status === 200 && (ob.json?.agents || []).length > 0,
      `status ${ob.status}\nagents: ${JSON.stringify((ob.json?.agents || []).map((a) => ({ id: a.id, department: a.department, capabilities: a.capabilities })))}`,
      Date.now() - s);
    if (ob.status !== 200) throw new Error("onboarding failed, cannot continue");

    // ── Stage 3: connect the GB10 gateway model ────────────────────────────────────────────────
    section("STAGE 3 — connect the GB10 gateway model (brainoutput-local/coder)");
    s = Date.now();
    const conn = await apiCall("POST", "/api/connect-runtime", {
      runtime: "local-openai", authSource: "local", provider: "brainoutput-local", model: "coder",
      endpoint: "http://192.168.1.14:9000/v1/chat/completions", modelLocation: "local",
    });
    const connRec = (conn.json?.connections || []).find((c) => c.provider === "brainoutput-local" && c.model === "coder");
    recordStage("POST /api/connect-runtime", conn.status === 200 && !!connRec,
      `status ${conn.status}\nconnection: ${JSON.stringify(connRec)}`, Date.now() - s);
    if (!connRec) throw new Error("model connection failed, cannot continue");
    report.connection = connRec;

    // ── Stage 4: assign the connection to the coding + review slots ───────────────────────────
    section("STAGE 4 — assign capability slots (coding-free, high-trust-review)");
    s = Date.now();
    const a1 = await apiCall("POST", "/api/assign", { slot: "coding-free", connectionId: connRec.id });
    const a2 = await apiCall("POST", "/api/assign", { slot: "high-trust-review", connectionId: connRec.id });
    recordStage("POST /api/assign x2", a1.status === 200 && a2.status === 200
      && a1.json?.assignments?.["coding-free"] === connRec.id && a2.json?.assignments?.["high-trust-review"] === connRec.id,
      `assignments: ${JSON.stringify(a2.json?.assignments)}`, Date.now() - s);

    // ── Stage 5: create project ────────────────────────────────────────────────────────────────
    section("STAGE 5 — create project");
    s = Date.now();
    const proj = await apiCall("POST", "/api/project", { name: "oc-dogfood-project" });
    const projectId = proj.json?.project?.id;
    recordStage("POST /api/project", proj.status === 200 && !!projectId,
      `status ${proj.status}\nproject: ${JSON.stringify(proj.json?.project)}`, Date.now() - s);
    if (!projectId) throw new Error("project creation failed, cannot continue");
    report.projectId = projectId;

    // ── Stage 6: plan it ────────────────────────────────────────────────────────────────────────
    section("STAGE 6 — plan the coding task");
    s = Date.now();
    const OBJECTIVE = "Create a tiny Node.js ESM utility: write add-lib.mjs exporting a function " +
      "add(a, b) that returns a + b, and write test/add.test.mjs using node:test + node:assert " +
      "asserting add(2, 3) === 5 and add(-1, 1) === 0. No other files.";
    const planNew = await apiCall("POST", "/api/plan/new", {
      projectId,
      objective: "Dogfood: a tiny tested add() utility, end to end through the real coding runtime.",
      taskDrafts: [{
        title: "Write add-lib.mjs + a real node:test test",
        objective: OBJECTIVE,
        acceptanceCriteria: [
          "add-lib.mjs exists and exports a function add(a,b) that returns a+b",
          "test/add.test.mjs exists, uses node:test, and asserts add(2,3)===5 and add(-1,1)===0",
        ],
        priority: "high",
      }],
    });
    const plan = planNew.json?.plan;
    recordStage("POST /api/plan/new", planNew.status === 200 && plan?.status === "draft",
      `status ${planNew.status}\nplan: ${JSON.stringify(plan)}`, Date.now() - s);
    if (!plan) throw new Error("plan creation failed, cannot continue");
    report.planDraft = plan;

    // ── Stage 7: validate the plan ─────────────────────────────────────────────────────────────
    section("STAGE 7 — validate the plan");
    s = Date.now();
    const planValidate = await apiCall("POST", "/api/plan/validate", { id: plan.id });
    recordStage("POST /api/plan/validate", planValidate.status === 200 && planValidate.json?.plan?.status === "validated",
      `status ${planValidate.status}\nplan status: ${planValidate.json?.plan?.status}`, Date.now() - s);
    if (planValidate.json?.plan?.status !== "validated") throw new Error("plan validation failed, cannot continue");

    // ── Stage 8: materialize into a real spine task ────────────────────────────────────────────
    section("STAGE 8 — materialize the plan into spine tasks");
    s = Date.now();
    const mat = await apiCall("POST", "/api/plan/materialize", { id: plan.id });
    const task = (mat.json?.tasks || [])[0];
    recordStage("POST /api/plan/materialize", mat.status === 200 && !!task,
      `status ${mat.status}\ntask: ${JSON.stringify(task)}\nplan: ${JSON.stringify(mat.json?.plan)}`, Date.now() - s);
    if (!task) throw new Error("materialization failed, cannot continue");
    report.materializedTask = task;
    const taskId = task.id;

    // ── Stage 9: launch the coding task, watch the live SSE relay ──────────────────────────────
    section("STAGE 9 — launch the coding task through the SERVER runtime");
    s = Date.now();
    const launch = await apiCall("POST", "/api/task/launch", { id: taskId, timeoutMs: Number(process.env.BO_DOGFOOD_TASK_WAIT_MS || 180000), maxTokens: 2000 });
    recordStage("POST /api/task/launch (admitted)", launch.status === 200 && launch.json?.started === true,
      `status ${launch.status}\nbody: ${JSON.stringify(launch.json)}`, Date.now() - s);
    if (launch.status !== 200) throw new Error(`launch was rejected: ${JSON.stringify(launch.json)}`);
    const execId = launch.json.execution.id;
    report.execId = execId;

    // Poll /api/execution/{id} until liveSessionId appears (or the run finishes first).
    let liveSessionId = null;
    let exec = null;
    const liveWaitDeadline = Date.now() + 60000;
    while (Date.now() < liveWaitDeadline) {
      const e = await apiCall("GET", `/api/execution/${execId}`);
      exec = e.json;
      if (exec?.liveSessionId) { liveSessionId = exec.liveSessionId; break; }
      if (exec?.status && exec.status !== "running") break; // finished before we ever saw a live id
      await sleep(500);
    }
    report.liveSessionId = liveSessionId;
    log(`liveSessionId: ${liveSessionId || "(none observed)"}`);

    // ── Stage 10: subscribe to the live SSE relay for the running session ─────────────────────
    section("STAGE 10 — GET /api/session/{id}/live SSE relay");
    let liveSub = null;
    if (liveSessionId) {
      s = Date.now();
      liveSub = subscribeLive(liveSessionId, () => {});
      await sleep(3000); // give it a moment to accumulate frames
      recordStage("GET /api/session/{id}/live", liveSub.frames.length > 0,
        `frames captured so far (${liveSub.frames.length}):\n` + liveSub.frames.slice(0, 8).join("\n"),
        Date.now() - s);
    } else {
      recordStage("GET /api/session/{id}/live", false, "no liveSessionId was ever published on the execution record — cannot subscribe", 0);
    }

    // ── Stage 11: wait for the task to reach a terminal state ─────────────────────────────────
    section("STAGE 11 — wait for the task to finish");
    s = Date.now();
    const TASK_DEADLINE = Date.now() + Number(process.env.BO_DOGFOOD_TASK_WAIT_MS || 200000);
    let finalTask = null, finalExec = null;
    while (Date.now() < TASK_DEADLINE) {
      const st = await apiCall("GET", "/api/state");
      finalTask = (st.json?.tasks || []).find((t) => t.id === taskId);
      finalExec = (st.json?.executions || []).find((e) => e.id === execId);
      if (finalTask?.status === "done" || finalTask?.status === "blocked" || finalExec?.status === "failed") break;
      await sleep(1500);
    }
    recordStage("task reaches a terminal state", !!finalTask && (finalTask.status === "done" || finalTask.status === "blocked"),
      `task: ${JSON.stringify(finalTask)}\nexecution.status: ${finalExec?.status}`, Date.now() - s);
    report.finalTask = finalTask;
    report.finalExec = finalExec;

    if (liveSub) {
      await Promise.race([liveSub.done, sleep(2000)]);
      liveSub.stop();
      report.liveFrames = liveSub.frames;
      log(`total live SSE frames captured: ${liveSub.frames.length}`);
    }

    // ── Stage 12: real files in the task workspace ─────────────────────────────────────────────
    section("STAGE 12 — real files in the task workspace");
    s = Date.now();
    const codeWs = join(DATA_DIR, "workspaces", execId);
    const libPath = join(codeWs, "add-lib.mjs");
    const testPath = join(codeWs, "test", "add.test.mjs");
    let libContent = null, testContent = null;
    if (existsSync(libPath)) libContent = readFileSync(libPath, "utf8");
    if (existsSync(testPath)) testContent = readFileSync(testPath, "utf8");
    recordStage("files actually on disk in the task workspace",
      !!libContent && /function\s+add|add\s*=/.test(libContent) && !!testContent && /add\(/.test(testContent),
      `workspace: ${codeWs}\nadd-lib.mjs: ${libContent ? `present (${libContent.length} bytes)\n${libContent.slice(0, 400)}` : "MISSING"}\n` +
      `test/add.test.mjs: ${testContent ? `present (${testContent.length} bytes)\n${testContent.slice(0, 400)}` : "MISSING"}`,
      Date.now() - s);
    report.workspace = codeWs;
    report.libContent = libContent;
    report.testContent = testContent;

    // ── Stage 13: final task record + review verdict ──────────────────────────────────────────
    section("STAGE 13 — final task record + review verdict");
    console.log(JSON.stringify(finalTask, null, 2));

    return report;
  } finally {
    section("CLEANUP");
    if (srv?.proc && srv.proc.exitCode === null) {
      log("sending SIGTERM to CE server...");
      srv.proc.kill("SIGTERM");
      const exited = await Promise.race([
        new Promise((r) => srv.proc.once("exit", () => r(true))),
        sleep(5000).then(() => false),
      ]);
      if (!exited) { log("SIGKILL fallback"); srv.proc.kill("SIGKILL"); }
      log("CE server stopped.");
    }
    log(`stderr tail:\n${srv?.getErr().slice(-2000) || ""}`);
  }
}

main()
  .then((report) => {
    writeFileSync(join(HERE, "..", "docs", "dogfood-run-report.json"), JSON.stringify(report, null, 2));
    section("DRIVER FINISHED — see docs/dogfood-run-report.json for the full captured evidence");
    const failed = stages.filter((s) => !s.ok);
    console.log(`stages: ${stages.length - failed.length}/${stages.length} ok` + (failed.length ? ` — FAILED: ${failed.map((f) => f.name).join(" | ")}` : ""));
    process.exitCode = 0;
  })
  .catch((e) => {
    console.error("\nDRIVER CRASHED:", e && e.stack ? e.stack : e);
    const failed = stages.filter((s) => !s.ok);
    console.log(`stages: ${stages.length - failed.length}/${stages.length} ok` + (failed.length ? ` — FAILED: ${failed.map((f) => f.name).join(" | ")}` : ""));
    process.exitCode = 1;
  });
