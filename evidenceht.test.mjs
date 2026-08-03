// SPDX-License-Identifier: Apache-2.0
// Truncation-aware evidence diffs (task-pm-21). LIVE INCIDENT: a 6KB new-file diff was head-cut
// at the cap and the reviewer failed a real criterion — "the diff is TRUNCATED mid-way through
// the second room card… I cannot confirm the page contains 3 rooms" — because the 3rd room and
// the footer never reached it. The file was fine; the evidence wasn't. Over-cap diffs are now
// HEAD + TAIL with an explicit elision marker carrying REAL counts, the last line is never
// silently dropped, and every diff block states its true total size.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectDiff, headTailEvidence } from "./work-evidence.mjs";
import { reviewTaskPrompt, parseTaskReview } from "./review-tasks.mjs";

const dirs = [];
function repo() {
  const d = mkdtempSync(join(tmpdir(), "bo-eviht-"));
  dirs.push(d);
  mkdirSync(join(d, "src"), { recursive: true });
  writeFileSync(join(d, "src", "existing.js"), "export const a = 1;\n");
  execFileSync("git", ["-C", d, "init", "-q"]);
  execFileSync("git", ["-C", d, "add", "-A"]);
  execFileSync("git", ["-C", d, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "pre"]);
  return d;
}
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** Split an annotated head+tail block into { meta, head, tail, elided, total } — independently. */
function dissect(text) {
  const m = text.match(/^(\[[^\n]+\])\n([\s\S]*?)\n… \[TRUNCATED head\+tail — elided (\d+) of (\d+) total chars; the middle is omitted, evidence is INCOMPLETE; the file is complete on disk\] …\n([\s\S]*)$/);
  assert.ok(m, `the block is meta + head + elision marker + tail: ${text.slice(0, 120)}…`);
  return { meta: m[1], head: m[2], elided: Number(m[3]), total: Number(m[4]), tail: m[5] };
}

test("under-cap: content byte-identical after the unconditional size line, NO elision marker", () => {
  const s = "--- NEW FILE: a.js ---\nline one\nline two\nlast line\n";
  const r = headTailEvidence(s, 12000);
  assert.equal(r.truncated, false);
  assert.equal(r.text, `[diff size: ${s.length} chars, ${s.split("\n").length} lines]\n${s}`,
    "metadata line + the original content, byte for byte");
  assert.ok(!/TRUNCATED|elided/.test(r.text), "no elision marker under the cap");
});

test("under-cap via collectDiff: the size line states the TRUE totals, no marker", () => {
  const d = repo();
  writeFileSync(join(d, "src", "added.js"), "export const v = 7;\n");
  const diff = collectDiff({ workspace: d });
  const m = diff.text.match(/^\[diff size: (\d+) chars, (\d+) lines\]\n/);
  assert.ok(m, "the metadata line leads the diff block");
  const body = diff.text.slice(m[0].length);
  assert.equal(Number(m[1]), body.length, "the char count is the true total");
  assert.equal(Number(m[2]), body.split("\n").length, "the line count is the true total");
  assert.ok(!/TRUNCATED|elided/.test(diff.text));
  assert.equal(diff.truncated, false);
  assert.ok(body.includes("export const v = 7;"));
});

test("over-cap: head + marker with EXACT counts + tail incl. the last line, line-aligned, bounded", () => {
  const lines = Array.from({ length: 200 }, (_, i) => `line-${String(i).padStart(4, "0")}-${"x".repeat(50)}`);
  const s = lines.join("\n");                       // 200 × 60 chars + newlines = 12 059
  const max = 2000;
  const r = headTailEvidence(s, max);
  assert.equal(r.truncated, true);
  const { meta, head, elided, total, tail } = dissect(r.text);

  assert.equal(total, s.length, "the marker's total is the true original size");
  assert.equal(elided, s.length - head.length - tail.length, "the elided count is exact");
  assert.equal(meta, `[diff size: ${s.length} chars, ${lines.length} lines]`);

  assert.ok(s.startsWith(head), "the head is a verbatim prefix of the original");
  assert.ok(s.endsWith(tail), "the tail is a verbatim suffix of the original");
  assert.equal(s[head.length], "\n", "the head ends ON a line boundary — no half-line");
  assert.equal(s[s.length - tail.length - 1], "\n", "the tail starts ON a line boundary — no half-line");

  assert.ok(head.includes(lines[0]), "the first line is present");
  assert.ok(tail.includes(lines.at(-1)), "the LAST line of the original is never dropped");
  assert.ok(!head.includes("line-0100") && !tail.includes("line-0100"), "the middle is genuinely elided");

  assert.ok(r.text.length <= max + 200, `total fed size stays capped (${r.text.length} ≤ ${max}+200)`);
});

test("over-cap via collectDiff: room 1 AND room 3 + the footer last line both reach the reviewer", () => {
  const d = repo();
  const card = (n) => [`<div class="room">`, `  <h2>ROOM-${n}</h2>`,
    ...Array.from({ length: 15 }, (_, i) => `  <p>room ${n} feature ${i} — spacious and bright</p>`), `</div>`].join("\n");
  const page = ["<html><body>", card(1), card(2), card(3), "</body></html> <!-- FOOTER-LAST-LINE -->"].join("\n");
  assert.ok(page.length > 2000, `a diff that exceeds the cap (${page.length})`);
  writeFileSync(join(d, "src", "existing.js"), page);   // a tracked modification — ONE head+tail layer
  const diff = collectDiff({ workspace: d, maxBytes: 2000 });
  assert.equal(diff.truncated, true);
  assert.ok(diff.text.includes("ROOM-1"), "the head (room 1) is present");
  assert.ok(diff.text.includes("ROOM-3"), "the tail (room 3) is present — the head-cut lost exactly this");
  assert.ok(diff.text.includes("FOOTER-LAST-LINE"), "the original last line is present");
  assert.ok(!diff.text.includes("ROOM-2"), "the middle (room 2) is what the elision marker covers");
  const { elided, total } = dissect(diff.text);
  assert.ok(elided > 0 && total > page.length, "real counts, computed from the assembled diff");
});

test("the live incident: a 6KB NEW FILE cut at the per-file cap still shows its tail (3rd room + footer)", () => {
  const d = repo();
  const card = (n) => `<div class="room"><h2>ROOM-${n}</h2><p>${"a lovely room. ".repeat(120)}</p></div>`;
  const footer = `<footer>BOOK-NOW-FOOTER</footer>`;
  const page = ["<html><body>", card(1), card(2), card(3), footer, ""].join("\n");
  assert.ok(page.length > 4000 && page.length < 12000, `the 6KB shape that triggered the incident (${page.length})`);
  writeFileSync(join(d, "src", "rooms.html"), page);
  const diff = collectDiff({ workspace: d });       // default caps: 4000/file, 12000 total
  assert.ok(diff.text.includes("ROOM-1"), "the file head is present");
  assert.ok(diff.text.includes("ROOM-3"), "the 3rd room now reaches the reviewer");
  assert.ok(diff.text.includes("BOOK-NOW-FOOTER"), "the footer — the file's last line — reaches the reviewer");
  assert.ok(/TRUNCATED head\+tail — elided \d+ of \d+ total chars/.test(diff.text),
    "the elision is DECLARED with real counts, never a silent cut");
  const fm = diff.text.match(/\[file size: (\d+) chars, (\d+) lines\]/);
  assert.ok(fm && Number(fm[1]) === page.length, "the per-file metadata states the file's TRUE size");
});

test("a no-newline blob is still bounded and declared (the pathological single-line case)", () => {
  const s = `head-${"x".repeat(4000)}-tail`;
  const r = headTailEvidence(s, 500);
  assert.equal(r.truncated, true);
  assert.ok(r.text.length <= 500 + 200, "bounded");
  assert.ok(r.text.includes("head-") && r.text.includes("-tail"), "both ends of the blob survive");
  assert.ok(/elided \d+ of 4010 total chars/.test(r.text));
});

test("reviewTaskPrompt passes the annotated diff through UNCHANGED — no re-truncation of the tail", () => {
  const lines = Array.from({ length: 200 }, (_, i) => `line-${String(i).padStart(4, "0")}-${"x".repeat(50)}`);
  const annotated = headTailEvidence(lines.join("\n"), 2000).text;
  const p = reviewTaskPrompt({ objective: "O", acceptanceCriteria: ["the page contains 3 rooms"],
    resultSummary: "done", diff: annotated });
  assert.ok(p.includes(annotated), "the FULL annotated diff — head, marker AND tail — is embedded verbatim");
  const lastLine = lines.at(-1);
  assert.ok(p.indexOf(lastLine) > p.indexOf("TRUNCATED head+tail"), "the tail was not sliced off afterwards");
});

test("an elided diff in the prompt still yields a parseable review referencing TAIL content", () => {
  const lines = Array.from({ length: 200 }, (_, i) => `line-${String(i).padStart(4, "0")}-${"x".repeat(50)}`);
  lines[199] = "FOOTER-LAST-LINE xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
  const annotated = headTailEvidence(lines.join("\n"), 2000).text;
  assert.ok(annotated.includes("FOOTER-LAST-LINE"), "fixture sanity: the tail content is in the evidence");
  const ac = ["the page contains 3 rooms", "the footer is present"];
  const p = reviewTaskPrompt({ objective: "build the rooms page", acceptanceCriteria: ac, diff: annotated });
  assert.ok(p.includes("FOOTER-LAST-LINE"), "the reviewer can see the tail content in the prompt");
  // The model's verdict REFERENCES tail content — exactly the verdict that was impossible before.
  const verdict = "```review\n" + JSON.stringify({ criteria: [
    { criterion: ac[0], verdict: "pass", evidence: "the diff tail shows the third room card after the elision marker" },
    { criterion: ac[1], verdict: "pass", evidence: "FOOTER-LAST-LINE appears in the diff tail — the last line survived" }],
    overall: "pass", note: "head+tail evidence covers both ends of the change" }) + "\n```";
  const parsed = parseTaskReview(verdict, { acceptanceCriteria: ac });
  assert.equal(parsed.overall, "pass");
  assert.deepEqual(parsed.criteria.map((c) => c.criterion), ac);
  assert.match(parsed.criteria[1].evidence, /FOOTER-LAST-LINE/);
});
