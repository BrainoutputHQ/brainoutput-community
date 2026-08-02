// SPDX-License-Identifier: Apache-2.0
// BrainOutput Community Edition — per-task review against acceptance criteria (2026-08-02, task-pm-06).
// A spine task carrying acceptanceCriteria may flip to done only AFTER the worker's report was
// judged against them: ONE bounded reviewer-slot call with a rigorous, evidence-demanding
// reviewer (never a rubber stamp), parsed FAIL-CLOSED. An unparseable, incomplete or
// contradictory review is no review — the caller blocks the task honestly. The verdict lives
// ON the task record (task.review), not in chat memory. Pure logic; zero-dep.
const MAX_REVIEW_CRITERIA = 20, MAX_EVIDENCE_CHARS = 500;

/**
 * The bounded reviewer prompt. Carries the task objective and EVERY acceptance criterion
 * verbatim (the parser matches the returned criteria back against them — they must
 * round-trip), the worker's result summary, artifact names, and test evidence when present.
 * The reviewer is instructed to judge each criterion independently and to demand evidence:
 * absence of evidence is a fail, never a pass.
 */
export function reviewTaskPrompt({ objective, acceptanceCriteria = [], resultSummary = null, artifacts = [], testEvidence = null } = {}) {
  const criteria = (Array.isArray(acceptanceCriteria) ? acceptanceCriteria : []).map((c) => String(c));
  const arts = (Array.isArray(artifacts) ? artifacts : []).map((a) => String(a)).filter(Boolean);
  return `You are a rigorous reviewer for THIS task — and only this task. A worker reports it done. Judge EVERY acceptance criterion independently and DEMAND EVIDENCE for it in the worker's result summary, the artifacts and the test evidence below: a criterion passes ONLY when that material shows it holds. Never rubber-stamp — absence of evidence is a fail.

TASK OBJECTIVE:
${String(objective || "")}

ACCEPTANCE CRITERIA (judge each one; copy its text EXACTLY into your reply):
${criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}

WORKER'S RESULT SUMMARY:
${String(resultSummary || "(none)")}

ARTIFACTS PRODUCED: ${arts.length ? arts.join(", ") : "(none)"}${testEvidence ? `

TEST EVIDENCE:
${String(testEvidence)}` : ""}

Reply in exactly this form — ONE fenced block, valid JSON inside, nothing else:
\`\`\`review
{"criteria":[{"criterion":"<criterion text, copied verbatim>","verdict":"pass"|"fail","evidence":"<what in the result/artifacts/tests proves it — or what is missing>"}],"overall":"pass"|"fail","note":"<one or two sentences of justification>"}
\`\`\`
Rules: exactly one entry per acceptance criterion, in the order above, criterion text copied verbatim; a verdict is only ever "pass" or "fail"; "overall" is "pass" only when EVERY criterion passes.`;
}

/**
 * Parse the reviewer's fenced ```review block. FAIL-CLOSED — returns null when:
 *  - the block is missing or the JSON unparseable;
 *  - any entry lacks a verdict, or a verdict is not "pass"/"fail";
 *  - the entry criteria do not match the task's acceptanceCriteria one-to-one (tolerant of
 *    whitespace differences, strict on content — a tampered criterion is no match);
 *  - the declared "overall" contradicts the per-criterion verdicts;
 *  - bounds are exceeded (>20 criteria).
 * On success returns { criteria: [{criterion (the task's verbatim string), verdict, evidence}],
 * overall, note (≤maxNote) }.
 */
export function parseTaskReview(output = "", { acceptanceCriteria = [], maxNote = 1000 } = {}) {
  const text = String(output || "");
  const block = text.match(/```review\s*([\s\S]*?)```/);
  if (!block) return null;
  let data;
  try { data = JSON.parse(block[1]); } catch { return null; }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  if (data.overall !== "pass" && data.overall !== "fail") return null;
  if (!Array.isArray(data.criteria) || data.criteria.length > MAX_REVIEW_CRITERIA) return null;
  const expected = (Array.isArray(acceptanceCriteria) ? acceptanceCriteria : []).map((c) => String(c));
  const norm = (s) => String(s).replace(/\s+/g, " ").trim();
  const remaining = expected.map((c) => ({ c, n: norm(c) }));
  const criteria = [];
  for (const entry of data.criteria) {
    if (!entry || typeof entry !== "object" || typeof entry.criterion !== "string") return null;
    if (entry.verdict !== "pass" && entry.verdict !== "fail") return null;
    const j = remaining.findIndex((x) => x.n === norm(entry.criterion));
    if (j < 0) return null;                        // unknown or duplicated criterion — tampered
    criteria.push({ criterion: remaining[j].c, verdict: entry.verdict,
      evidence: String(entry.evidence ?? "").slice(0, MAX_EVIDENCE_CHARS) });
    remaining.splice(j, 1);
  }
  if (remaining.length) return null;               // an unjudged criterion is a missing verdict
  const overall = criteria.some((c) => c.verdict === "fail") ? "fail" : "pass";
  if (overall !== data.overall) return null;       // a contradictory review is no review
  return { criteria, overall, note: String(data.note ?? "").slice(0, maxNote) };
}
