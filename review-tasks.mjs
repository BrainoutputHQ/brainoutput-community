// SPDX-License-Identifier: Apache-2.0
// BrainOutput Community Edition — per-task review against acceptance criteria (2026-08-02, task-pm-06).
// A spine task carrying acceptanceCriteria may flip to done only AFTER the worker's report was
// judged against them: ONE bounded reviewer-slot call with a rigorous, evidence-demanding
// reviewer (never a rubber stamp), parsed FAIL-CLOSED. An unparseable, incomplete or
// contradictory review is no review — the caller blocks the task honestly. The verdict lives
// ON the task record (task.review), not in chat memory. Pure logic; zero-dep.
const MAX_REVIEW_CRITERIA = 20, MAX_EVIDENCE_CHARS = 500, MAX_RAW_SLICE = 200;

/** The strict-format reminder the caller appends for the ONE bounded retry after an
 *  unparseable review (task-pm-20): the SAME review, the form contract restated as a final
 *  instruction — production-shaped prompts make free models paraphrase; the retry demands
 *  the fenced block ONLY and verbatim criteria. */
export const REVIEW_STRICT_REMINDER = "FINAL INSTRUCTION — STRICT FORMAT: reply with ONLY the fenced ```review block, nothing else — no commentary, no reasoning, no text before or after it. Copy each acceptance criterion's text EXACTLY as given above, character for character, one entry per criterion, in the order given.";

/** A bounded slice of raw reviewer output for the block note when a review cannot be parsed
 *  (task-pm-20): whitespace-collapsed, ≤max chars, VERBATIM model output (never translated)
 *  so a parse failure is diagnosable instead of a black box. The caller renders it esc()'d. */
export function reviewRawSlice(output, max = MAX_RAW_SLICE) {
  const s = String(output || "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * The bounded reviewer prompt. Carries the task objective and EVERY acceptance criterion
 * verbatim (the parser matches the returned criteria back against them — they must
 * round-trip), the worker's result summary, artifact names, the REAL code diff, and test
 * evidence when present. The reviewer is instructed to judge each criterion independently
 * and to demand evidence: absence of evidence is a fail, never a pass.
 *
 * The summary is presented as an unverified CLAIM: a worker can report success having written
 * nothing (a headless coding run whose write permission resolves to "ask" auto-rejects it and
 * still exits 0). The diff and the test exit code are the evidence; the prose is not.
 */
export function reviewTaskPrompt({ objective, acceptanceCriteria = [], resultSummary = null, artifacts = [], testEvidence = null, diff = null } = {}) {
  const criteria = (Array.isArray(acceptanceCriteria) ? acceptanceCriteria : []).map((c) => String(c));
  const arts = (Array.isArray(artifacts) ? artifacts : []).map((a) => String(a)).filter(Boolean);
  return `You are a rigorous reviewer for THIS task — and only this task. A worker reports it done. Judge EVERY acceptance criterion independently and DEMAND EVIDENCE for it in the code diff, the test evidence and the artifacts below: a criterion passes ONLY when that material shows it holds. Never rubber-stamp — absence of evidence is a fail.

The worker's result summary is the worker's own CLAIM about its work — it is NOT evidence. Verify every claim against the code diff and the test results below. Where the diff does not show what the summary claims, that criterion FAILS. An empty diff means no work was done — fail every criterion. Where evidence is marked TRUNCATED or INCOMPLETE you cannot confirm what it would have shown: fail the criteria that depend on it rather than assuming.

TASK OBJECTIVE:
${String(objective || "")}

ACCEPTANCE CRITERIA (judge each one; copy its text EXACTLY into your reply):
${criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}

WORKER'S RESULT SUMMARY (an unverified claim):
${String(resultSummary || "(none)")}

ARTIFACTS PRODUCED: ${arts.length ? arts.join(", ") : "(none)"}${diff ? `

CODE DIFF (the actual change — primary evidence):
${String(diff)}` : ""}${testEvidence ? `

TEST EVIDENCE:
${String(testEvidence)}` : ""}

Reply in exactly this form — ONE fenced block, valid JSON inside, nothing else:
\`\`\`review
{"criteria":[{"criterion":"<criterion text, copied verbatim>","verdict":"pass"|"fail","evidence":"<what in the diff/tests/artifacts proves it — or what is missing>"}],"overall":"pass"|"fail","note":"<one or two sentences of justification>"}
\`\`\`
Rules: exactly one entry per acceptance criterion, in the order above, criterion text copied verbatim; a verdict is only ever "pass" or "fail"; "overall" is "pass" only when EVERY criterion passes.`;
}

/**
 * Parse the reviewer's fenced ```review block. FAIL-CLOSED — returns null when:
 *  - the block is missing or the JSON unparseable;
 *  - any entry lacks a verdict, or a verdict is not "pass"/"fail";
 *  - the entry criteria do not match the task's acceptanceCriteria one-to-one — FORM-normalized
 *    (case, collapsed whitespace, a leading list marker, surrounding quotes/punctuation) but
 *    CONTENT-strict: every word must match, so a reworded, truncated or tampered criterion is
 *    no match;
 *  - the declared "overall" contradicts the per-criterion verdicts;
 *  - bounds are exceeded (>20 criteria).
 * When `diag` (an object) is passed, diag.reason names the failure ("no-block", "json",
 * "shape", "overall-value", "entry", "criterion", "missing", "contradiction") so the caller
 * can build an honest block note.
 * On success returns { criteria: [{criterion (the task's verbatim string), verdict, evidence}],
 * overall, note (≤maxNote) }.
 */
export function parseTaskReview(output = "", { acceptanceCriteria = [], maxNote = 1000, diag = null } = {}) {
  const fail = (reason) => { if (diag && typeof diag === "object") diag.reason = reason; return null; };
  const text = String(output || "");
  const block = text.match(/```review\s*([\s\S]*?)```/);
  if (!block) return fail("no-block");
  let data;
  try { data = JSON.parse(block[1]); } catch { return fail("json"); }
  if (!data || typeof data !== "object" || Array.isArray(data)) return fail("shape");
  if (data.overall !== "pass" && data.overall !== "fail") return fail("overall-value");
  if (!Array.isArray(data.criteria) || data.criteria.length > MAX_REVIEW_CRITERIA) return fail("shape");
  const expected = (Array.isArray(acceptanceCriteria) ? acceptanceCriteria : []).map((c) => String(c));
  // FORM-only normalization: lowercase, collapsed whitespace, a leading list marker and
  // surrounding quotes/punctuation stripped. Content stays strict — equality afterwards
  // means every word matched.
  const norm = (s) => String(s).toLowerCase().replace(/\s+/g, " ").trim()
    .replace(/^\d{1,2}[.)]\s+/, "")
    .replace(/^[\s"'“”‘’`«»]+/, "")
    .replace(/[\s"'“”‘’`«».,;:!?…]+$/, "");
  const remaining = expected.map((c) => ({ c, n: norm(c) }));
  const criteria = [];
  for (const entry of data.criteria) {
    if (!entry || typeof entry !== "object" || typeof entry.criterion !== "string") return fail("entry");
    if (entry.verdict !== "pass" && entry.verdict !== "fail") return fail("entry");
    const j = remaining.findIndex((x) => x.n === norm(entry.criterion));
    if (j < 0) return fail("criterion");           // unknown or duplicated criterion — tampered
    criteria.push({ criterion: remaining[j].c, verdict: entry.verdict,
      evidence: String(entry.evidence ?? "").slice(0, MAX_EVIDENCE_CHARS) });
    remaining.splice(j, 1);
  }
  if (remaining.length) return fail("missing");    // an unjudged criterion is a missing verdict
  const overall = criteria.some((c) => c.verdict === "fail") ? "fail" : "pass";
  if (overall !== data.overall) return fail("contradiction");   // a contradictory review is no review
  return { criteria, overall, note: String(data.note ?? "").slice(0, maxNote) };
}
