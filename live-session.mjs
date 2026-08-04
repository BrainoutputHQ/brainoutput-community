// SPDX-License-Identifier: Apache-2.0
// BrainOutput Community Edition — live activity registry for the server-backed OpenCode runtime
// (2026-08-04, oc-live-view).
//
// Why this exists: runOpenCodeServer (opencode-server.mjs) drives one whole coding turn inside a
// single async function call — the caller only sees the result once the turn is over. To show a
// user "what the agent is doing right now" while that call is still pending, something has to
// capture the SSE events AS THEY ARRIVE and make them readable from a completely different request
// (the browser's live-view SSE connection, served by web-server.mjs). This module is that shared,
// in-process bulletin board: one bounded, capped record per live OpenCode session.
//
// Two hard rules drive the design:
//   1. NEVER store or expose the OpenCode server's baseURL/port here. The registry holds only an
//      `interrupt` CLOSURE (created by the caller, which alone knows the baseURL) — never the URL
//      itself. web-server.mjs relays through this closure; the browser never sees a port.
//   2. The per-session event buffer is CAPPED (DEFAULT_EVENT_CAP) — a long run can emit thousands
//      of raw SSE frames; only the most recent, PROJECTED (labels, not raw JSON) entries are kept.
import { randomUUID } from "node:crypto";

// Bounded per session — proven necessary: a real run can emit thousands of tool/reasoning events
// over its lifetime (see docs/OPENCODE_SERVER_API.md §7's step-by-step trace, repeated per step).
// Oldest entries are dropped first (a ring-buffer discipline via Array#shift) — recent activity is
// what a live viewer actually wants; `dropped` is exposed so the UI can say so honestly rather than
// silently pretending the visible tail is the whole history.
export const DEFAULT_EVENT_CAP = 300;

// ── Pure event -> label projection ──────────────────────────────────────────────────────────────
// Turns one raw OpenCode SSE event (docs §7: {id, type, durable, data}) into a small, localizable,
// BOUNDED shape the browser can render without ever touching raw JSON. `labelKey` is an i18n.mjs
// key (never English prose baked in here — this module has no locale of its own); `tool`/`file`
// are OPTIONAL data the event actually carried (never invented when absent), clamped so a
// pathological field can never make one projected entry unbounded.
const DETAIL_MAX = 200;
function clampDetail(s) {
  if (s === undefined || s === null) return undefined;
  const str = String(s);
  return str.length > DETAIL_MAX ? `${str.slice(0, DETAIL_MAX)}…` : str;
}
// Best-effort extraction — several plausible field names, because the exact `data` shape for tool
// events is NOT pinned by docs/OPENCODE_SERVER_API.md (only the event ORDER and step/finish shape
// are pinned there). Returns undefined (never a fabricated placeholder) when nothing matches.
function extractTool(data) {
  return clampDetail(data?.tool ?? data?.toolName ?? data?.name ?? data?.title);
}
function extractFile(data) {
  return clampDetail(data?.file ?? data?.path ?? data?.filePath
    ?? data?.input?.file ?? data?.input?.path ?? data?.args?.file ?? data?.args?.path);
}

const EVENT_LABELS = {
  "session.next.model.switched": { kind: "model", labelKey: "live.event.model" },
  "session.next.prompt.admitted": { kind: "prompt", labelKey: "live.event.promptAdmitted" },
  "session.next.prompted": { kind: "prompt", labelKey: "live.event.prompted" },
  "session.next.step.started": { kind: "step", labelKey: "live.event.stepStarted" },
  "session.next.reasoning.started": { kind: "reasoning", labelKey: "live.event.reasoningStarted" },
  "session.next.reasoning.ended": { kind: "reasoning", labelKey: "live.event.reasoningEnded" },
  "session.next.tool.input.started": { kind: "tool", labelKey: "live.event.toolPreparing" },
  "session.next.tool.input.ended": { kind: "tool", labelKey: "live.event.toolPreparing" },
  "session.next.tool.called": { kind: "tool", labelKey: "live.event.toolRunning" },
  "session.next.tool.success": { kind: "tool", labelKey: "live.event.toolDone" },
  "session.next.tool.failed": { kind: "tool", labelKey: "live.event.toolFailed" },
  "session.next.text.started": { kind: "text", labelKey: "live.event.writing" },
  "session.next.text.ended": { kind: "text", labelKey: "live.event.wrote" },
};

/** Pure: raw SSE event -> bounded, localizable projection. Never returns raw JSON; an unrecognized
 *  event type still produces a real (generic) entry — activity is never silently swallowed, only
 *  the verbatim `type` string rides along as non-translated technical detail (same convention as
 *  the rest of CE: static UI chrome is localized, dynamic/diagnostic text is shown verbatim). */
export function projectEvent(evt) {
  if (!evt || typeof evt !== "object") return null;
  const type = typeof evt.type === "string" ? evt.type : "unknown";
  const data = evt.data || {};
  // step.ended is the one event whose label depends on its payload (docs §7 — "stop" is terminal,
  // anything else is an intermediate step boundary that looks identical otherwise).
  let known = EVENT_LABELS[type];
  if (type === "session.next.step.ended")
    known = { kind: "step", labelKey: data.finish === "stop" ? "live.event.finished" : "live.event.stepEnded" };
  const { kind, labelKey } = known || { kind: "other", labelKey: "live.event.other" };
  const entry = { type, kind, labelKey, at: Number(data?.timestamp) || Date.now() };
  const tool = extractTool(data);
  const file = extractFile(data);
  if (tool !== undefined) entry.tool = tool;
  if (file !== undefined) entry.file = file;
  if (data?.finish) entry.finish = clampDetail(data.finish);
  return entry;
}

// ── The registry itself ─────────────────────────────────────────────────────────────────────────
// Factory (not a bare singleton) so tests get a fresh, isolated registry; `liveSessions` below is
// the one process-wide instance web-server.mjs and opencode-server.mjs actually share.
export function createLiveRegistry({ cap = DEFAULT_EVENT_CAP } = {}) {
  const sessions = new Map(); // sessionId -> record

  /** Register a NEW live session. `interrupt` is a zero-arg async closure the CALLER builds — it
   *  is the ONLY thing here that can reach the real OpenCode server, and it never leaves this
   *  process. Returns the session id passed in (idempotent id shape is the caller's choice). */
  function start(sessionId, { interrupt = null } = {}) {
    const rec = { id: sessionId, status: "running", events: [], dropped: 0, seq: 0,
      listeners: new Set(), interrupt, endedReason: null, startedAt: Date.now() };
    sessions.set(sessionId, rec);
    return rec;
  }

  /** Project + append one raw SSE event, capped at `cap` (oldest dropped first), fanned out to any
   *  live subscriber (the browser-facing SSE relay). A push against an unknown/already-ended
   *  session is a harmless no-op — never throws (a stray late event must never crash the caller). */
  function push(sessionId, rawEvent) {
    const rec = sessions.get(sessionId);
    if (!rec || rec.status !== "running") return;
    const projected = projectEvent(rawEvent);
    if (!projected) return;
    rec.seq += 1;
    const entry = { seq: rec.seq, ...projected };
    rec.events.push(entry);
    if (rec.events.length > cap) { rec.events.shift(); rec.dropped += 1; }
    for (const l of rec.listeners) { try { l(entry); } catch { /* one bad subscriber never breaks the rest */ } }
  }

  /** Mark the session over. `status` is one of "done" | "timeout" | "stream-closed" | "failed" —
   *  see opencode-server.mjs for which real outcome maps to which. Notifies every live subscriber
   *  with a null sentinel (the SSE relay's cue to send its own terminal frame and close cleanly),
   *  then drops the listener set — nothing here keeps the session "live" a moment longer than real. */
  function end(sessionId, { status = "done", reason = null } = {}) {
    const rec = sessions.get(sessionId);
    if (!rec || rec.status !== "running") return; // already ended (or never existed) — idempotent
    rec.status = status;
    rec.endedReason = reason;
    for (const l of rec.listeners) { try { l(null); } catch { /* see push() */ } }
    rec.listeners.clear();
  }

  function get(sessionId) { return sessions.get(sessionId) || null; }

  /** Subscribe to live pushes on a RUNNING session; returns an unsubscribe function. Subscribing to
   *  a session that does not exist (or has already ended) is a caller error the caller must check
   *  via get() first — subscribe() itself just returns a no-op unsubscribe rather than throwing. */
  function subscribe(sessionId, listener) {
    const rec = sessions.get(sessionId);
    if (!rec) return () => {};
    rec.listeners.add(listener);
    return () => rec.listeners.delete(listener);
  }

  /** Relay a stop request through the session's own interrupt closure. NEVER claims success unless
   *  the closure itself reports one — a missing session, an already-ended session, or a closure
   *  that throws/returns not-ok are all reported as real failures, never swallowed into a fake ok. */
  async function interrupt(sessionId) {
    const rec = sessions.get(sessionId);
    if (!rec) return { ok: false, reason: "no such live session" };
    if (rec.status !== "running") return { ok: false, reason: `session is not running (status: ${rec.status})` };
    if (!rec.interrupt) return { ok: false, reason: "this session has no interrupt handle" };
    try {
      const res = await rec.interrupt();
      return { ok: !!res?.ok, status: res?.status ?? null, reason: res?.ok ? null : String(res?.text || `HTTP ${res?.status ?? "?"}`) };
    } catch (e) { return { ok: false, reason: String(e?.message || e) }; }
  }

  /** Forget a session entirely (test hygiene / long-running-process hygiene — never required for
   *  correctness since ended sessions are inert, but keeps the Map from growing unbounded across
   *  a very long-lived process). */
  function remove(sessionId) { sessions.delete(sessionId); }

  return { start, push, end, get, subscribe, interrupt, remove, size: () => sessions.size };
}

/** A fresh, unique session-scoped id generator for tests/callers that want one without depending
 *  on the real OpenCode session id shape. Not used for the real runtime (the real `ses_...` id
 *  from createSession() IS the key) — exported only as a small test convenience. */
export function newLiveId() { return `live_${randomUUID()}`; }

// Process-wide singleton — opencode-server.mjs pushes into it, web-server.mjs reads/relays from
// it. Mirrors the rest of CE's singleton-store convention (see store.mjs).
export const liveSessions = createLiveRegistry();
