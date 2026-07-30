// SPDX-License-Identifier: Apache-2.0
// BrainOutput Community Edition — Plane dispatcher core (2026-07-30, Directive 6 D6-6).
// The internal ops loop: an issue assigned in Plane → ONE executor works it → the result is
// commented back on the issue. Coordination is API calls, never agent chatter (Directive-5
// lesson: coordination costs zero tokens; tokens are for execution only).
//
// Executor-agnostic by injection: in production `runIssue` is the sandboxed OpenCode/Kimi
// path; in tests it is a stub. Commenting is a WRITE — with `requireApproval` the tick queues
// comments for a human instead of posting (the gate decides), matching the connector schema.
//
//   await dispatcherTick({ listIssues, runIssue, postComment, seen })
//   → { worked: [{ issue, ok, error? }], skipped, pending: [{ issue, html }] }
//
// `seen` is caller-persisted (e.g. runtime.json): an issue is worked exactly once — a failure
// is recorded, never silently retried into a loop.

export async function dispatcherTick({ listIssues, runIssue, postComment = null,
  seen = new Map(), maxPerTick = 3, requireApproval = false } = {}) {
  if (typeof listIssues !== "function") throw new Error("dispatcherTick needs listIssues()");
  if (typeof runIssue !== "function") throw new Error("dispatcherTick needs runIssue()");
  if (!requireApproval && typeof postComment !== "function")
    throw new Error("dispatcherTick needs postComment() — or requireApproval: true to queue instead");

  const issues = (await listIssues()).filter((i) => i && i.id && !seen.has(i.id)).slice(0, maxPerTick);
  const worked = [];
  const pending = [];

  for (const issue of issues) {
    let ok = false, error = null, html = null;
    try {
      const r = await runIssue(issue);
      ok = !!r?.ok;
      error = ok ? null : (r?.error || "the executor did not complete the issue");
      html = r?.commentHtml || null;
    } catch (e) { error = String(e.message || e); }

    if (ok && html) {
      if (requireApproval) pending.push({ issue, html });
      else await postComment(issue, html);
    }
    // Recorded either way: exactly-once means a failed issue is not retried forever — a human
    // re-arms it by clearing its id from `seen`.
    seen.set(issue.id, ok ? "done" : "failed");
    worked.push({ issue, ok, ...(error ? { error } : {}), queued: !!(ok && html && requireApproval) });
  }
  return { worked, skipped: 0, pending };
}

/** Serialize `seen` for a JSON store, and restore it. */
export const seenToJSON = (seen) => Object.fromEntries(seen);
export const seenFromJSON = (obj) => new Map(Object.entries(obj || {}));
