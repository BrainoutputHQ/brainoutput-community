#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// BrainOutput Community Edition — END-TO-END battery against the REAL product (2026-07-31).
// Not a unit test: this spins the actual server in a throwaway store, connects a REAL free
// model (OpenCode Zen, health-checked), onboards a company, and drives the chat API exactly
// like a user — ask, plan, approve, launch — for the scenarios a skeptic tries first:
//   1. ask a question            (the model must actually answer, never the "no model" fallback)
//   2. create a game             (plan → approve → launch → result on the spine)
//   3. create a website          (same path)
//   4. create an ecommerce page  (same path)
// Every scenario asserts: a real reply, the mission completes (or fails LOUDLY — never
// silently), the run is recorded, and the spine task received the result. Exit ≠ 0 on any lie.
//
//   node bo-e2e.mjs              # full battery (needs internet for the free model)
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 4600 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;
const TIMEOUT_MS = 240000;

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  return ok;
};

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "bo-e2e-"));
  const srv = spawn(process.execPath, [join(HERE, "web-server.mjs")],
    { env: { ...process.env, BO_CE_DATA: dir, BO_CE_WEB_PORT: String(PORT) }, stdio: "ignore" });
  const api = async (p, body) => {
    const r = await fetch(`${BASE}${p}`, body
      ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : undefined);
    return { status: r.status, body: await r.json() };
  };
  try {
    for (let i = 0; i < 80; i++) { try { await api("/api/state"); break; } catch { await new Promise((r) => setTimeout(r, 250)); } }

    // ── setup: free model + company, exactly what a new user does ──────────────────────────
    const free = await api("/api/connect-free", {});
    check("a free model answers a real health-check and connects", free.status === 200 && free.body.picked?.model,
      free.body.picked ? `${free.body.picked.provider}/${free.body.picked.model}` : free.body.error || JSON.stringify(free.body).slice(0, 120));
    if (free.status !== 200) throw new Error("cannot continue without a model");

    const ob = await api("/api/onboard", { companyName: "E2E Co", companyDoes: "end-to-end tests", departments: ["technical"] });
    check("company onboards with agents", ob.status === 200 && (ob.body.agents || []).length > 0);

    const proj = await api("/api/project", { name: "e2e-builds" });
    const pid = proj.body.project.id;
    check("project created for the build scenarios", !!pid);

    // ── 1 · ask: the model must ANSWER (the démineur bug: silent fallback, fixed) ─────────
    const ask = await api("/api/chat/send", { scope: "company", mode: "ask",
      text: "Comment dit-on « démineur » en anglais ? Answer in one word." });
    const askReply = ask.body.conversation?.messages?.at(-1)?.text || "";
    check("ask: a real answer arrives (no silent 'no model' fallback)",
      ask.status === 200 && askReply && !/no conversation model is configured/.test(askReply) && !/The conversation model failed/.test(askReply),
      askReply.slice(0, 90).replace(/\n/g, " "));

    // ── 2-4 · build scenarios: plan → approve → launch → spine report ──────────────────────
    const scenarios = [
      ["create a game", "Create a small browser game in one self-contained HTML file (e.g. snake or pong). Output ONLY the code."],
      ["create a website", "Create a one-page landing website for a small café, self-contained HTML. Output ONLY the code."],
      ["create an ecommerce page", "Create a product page for a handmade candle shop, self-contained HTML with a price and a buy button. Output ONLY the code."],
    ];
    for (const [name, objective] of scenarios) {
      console.log(`\n• ${name}`);
      const plan = await api("/api/chat/send", { scope: "department", department: "technical", mode: "plan", text: objective, projectId: pid });
      const mission = plan.body.mission;
      if (!check(`${name}: mission drafted`, !!mission, plan.body.error || "")) continue;
      await api("/api/chat/mission", { missionId: mission.id, action: "approve" });
      const launch = await api("/api/chat/launch", { missionId: mission.id, timeoutMs: TIMEOUT_MS, maxTokens: 2500 });
      if (launch.status !== 200) {
        // An honest failure is acceptable to SEE — but it must be loud, recorded, and on the spine.
        const st = await api("/api/state");
        const task = (st.body.tasks || []).find((t) => t.missionId === mission.id);
        check(`${name}: fails LOUDLY and the spine records it (never silent)`,
          !!launch.body.error && task?.status === "blocked" && task?.result?.ok === false,
          launch.body.error?.slice(0, 100) || "no error surfaced");
        continue;
      }
      const out = (launch.body.execution?.results || []).map((r) => r.output || "").join("\n");
      check(`${name}: mission completes`, launch.body.mission?.status === "done" || launch.body.mission?.status === "awaiting-approval");
      check(`${name}: real output produced`, out.length > 200 && /html|function|<div|document/i.test(out), `${out.length} chars`);
      const st = await api("/api/state");
      const task = (st.body.tasks || []).find((t) => t.missionId === mission.id);
      if (launch.body.mission?.status === "awaiting-approval")
        check(`${name}: gated work waits for the human (spine in-progress, not fake-done)`, task?.status === "in-progress" && !task?.result);
      else
        check(`${name}: the spine received the result`, task?.status === "done" && task?.result?.ok === true,
          task?.result ? `${task.status} · ${(task.result.summary || "").slice(0, 60)}` : `no result (${task?.status})`);
    }

    const failed = results.filter((r) => !r.ok);
    console.log(`\n${"=".repeat(60)}\nE2E BATTERY: ${results.length - failed.length}/${results.length} passed${failed.length ? ` — FAILED: ${failed.map((f) => f.name).join(" | ")}` : ""}`);
    process.exitCode = failed.length ? 1 : 0;
  } finally {
    srv.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}
main().catch((e) => { console.error(`E2E battery crashed: ${e.message}`); process.exit(2); });
