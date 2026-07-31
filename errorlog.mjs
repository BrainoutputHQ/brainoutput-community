// SPDX-License-Identifier: Apache-2.0
// BrainOutput Community Edition — runtime error log (2026-07-31, founder: monitor error logs
// for automatic bug fixing). Every failure the runtime sees lands here, bounded, and gets
// grouped into PATTERNS so a flood of the same bug reads as one problem, not two hundred
// log lines. Pure logic; the diagnostics routine consumes errorPatterns().
export const ERROR_SOURCES = ["api", "launch", "routine", "feed", "connector", "scheduler", "uncaught"];

let seq = 0;
/** Append an error (bounded by the store's history limits). Never throws — logging must not kill. */
export function recordError(store, { source = "api", message, stack = null, at = Date.now() } = {}) {
  try {
    const rec = { id: `err-${at.toString(36)}-${(seq += 1)}`, source: ERROR_SOURCES.includes(source) ? source : "api",
      message: String(message || "unknown error").slice(0, 300), stack: stack ? String(stack).slice(0, 500) : null, at };
    store.runtime.errors = [...(store.runtime.errors || []), rec];
    store.saveRuntime();
    return rec;
  } catch { return null; }
}

/** Normalize a message into a pattern key: urls, ids, numbers and paths vary — bugs don't. */
export function patternKey(message = "") {
  return String(message)
    .replace(/https?:\/\/\S+/gi, "URL")
    .replace(/[0-9a-z]{8,}/gi, (m) => (/\d/.test(m) ? "#" : m))
    .replace(/\d+/g, "N")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/**
 * Group errors into patterns, newest first: [{ key, count, source, firstAt, lastAt, sample }].
 * A pattern seen ≥ `minCount` times is a candidate for automatic attention.
 */
export function errorPatterns(errors = [], { since = 0, minCount = 1 } = {}) {
  const groups = new Map();
  for (const e of errors) {
    if ((e.at || 0) < since) continue;
    const key = patternKey(e.message);
    const g = groups.get(key) || { key, count: 0, source: e.source, firstAt: e.at, lastAt: 0, sample: e.message };
    g.count += 1;
    g.lastAt = Math.max(g.lastAt, e.at || 0);
    groups.set(key, g);
  }
  return [...groups.values()].filter((g) => g.count >= minCount).sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);
}
