// SPDX-License-Identifier: Apache-2.0
// BrainOutput Community Edition — routines: scheduled work (2026-07-31, founder request).
// A routine fires DEFINED work on a DUMB schedule — never an agent heartbeat. The clock
// decides when; the router decides what (smallest graph, same as a chat launch). Results
// land as cards in the routine's thread. Pure logic; zero-dep.
export const ROUTINE_KINDS = ["regulation-watch", "daily-digest", "self-diagnostic", "custom"];

export const ROUTINE_TEMPLATES = [
  {
    kind: "regulation-watch",
    name: "Regulation watch (AI Act & EU digital law)",
    schedule: { type: "interval", minutes: 360 },
    department: "legal-compliance",
    objective: "Assess these new regulation/official-journal items for business impact. For each item that could affect a company deploying AI or software: say what changed, who it affects, and the concrete action to take (terms update, compliance task, software change). If nothing is relevant, say so in one line.",
    config: { feeds: ["https://digital-strategy.ec.europa.eu/en/rss.xml"], seen: [] },
  },
  {
    kind: "daily-digest",
    name: "Daily digest (meetings, mail, follow-ups)",
    schedule: { type: "daily", hour: 8 },
    department: null,
    objective: "",
    config: {},
  },
  {
    kind: "self-diagnostic",
    name: "Self-diagnostic (error-log watch)",
    schedule: { type: "interval", minutes: 60 },
    department: "technical",
    objective: "",
    config: {},
  },
];

export function newRoutine({ id, kind, name = null, schedule = null, department = null, objective = null, config = {}, at = null } = {}) {
  const tpl = ROUTINE_TEMPLATES.find((x) => x.kind === kind);
  if (!tpl && kind !== "custom") throw new Error(`unknown routine kind '${kind}'`);
  const sched = schedule || tpl?.schedule;
  if (!sched) throw new Error("a routine needs a schedule");
  const next = nextRun(sched, at ?? Date.now());
  return {
    id: id || `routine-${Date.now().toString(36)}`,
    kind, name: name || tpl?.name || "Routine",
    schedule: sched,
    department: department ?? tpl?.department ?? null,
    objective: objective ?? tpl?.objective ?? "",
    config: { ...(tpl?.config || {}), ...config },
    enabled: true, lastRunAt: null, lastResult: null, nextRunAt: next, createdAt: at,
  };
}

/** The next fire time after `from` (ms). Daily: next occurrence of `hour` local. Interval: from + minutes. */
export function nextRun(schedule, from = Date.now()) {
  if (schedule.type === "interval") return from + (schedule.minutes || 60) * 60_000;
  if (schedule.type === "daily") {
    const d = new Date(from);
    d.setHours(schedule.hour ?? 8, 0, 0, 0);
    if (d.getTime() <= from) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  throw new Error(`unknown schedule type '${schedule.type}'`);
}

export const isDue = (routine, now = Date.now()) => !!routine.enabled && routine.nextRunAt <= now;

/** Mark fired: advances nextRunAt and records the outcome (persist BEFORE running to avoid double-fire). */
export function markFired(routine, { at = Date.now(), ok = null, note = null } = {}) {
  return { ...routine, lastRunAt: at, lastResult: ok == null ? routine.lastResult : { ok, note, at },
    nextRunAt: nextRun(routine.schedule, at) };
}

/** Minimal RSS/Atom item extraction (regex-level, bounded — feeds are not XML parsers' business here). */
export function parseFeed(xml = "") {
  const items = [];
  const blocks = String(xml).match(/<item[\s>][\s\S]*?<\/item>/g) || String(xml).match(/<entry[\s>][\s\S]*?<\/entry>/g) || [];
  for (const b of blocks.slice(0, 30)) {
    const pick = (tag) => (b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))?.[1] || "")
      .replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, "").trim();
    const title = pick("title"), link = (b.match(/<link[^>]*href="([^"]+)"/)?.[1] || pick("link"));
    const guid = pick("guid") || pick("id") || link || title;
    const date = pick("pubDate") || pick("updated") || pick("published");
    if (title) items.push({ title, link, guid, date, summary: pick("description") || pick("summary") });
  }
  return items;
}

/** New items since the routine last looked (by guid). */
export function unseenItems(routine, items) {
  const seen = new Set(routine.config?.seen || []);
  return items.filter((i) => i.guid && !seen.has(i.guid));
}
