// SPDX-License-Identifier: Apache-2.0
// Scale: a real mailbox is tens of thousands of messages, not the three in a fixture. These pin the
// bound on the index and the fact that search does NOT scan the whole mailbox per query — the naive
// version measured 823 ms per chat turn at 50k messages.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorkTwin, connectWorkSource, indexMessages, indexFiles, retrieveForRequest,
  searchFiles, unansweredThreads, INDEX_LIMITS } from "./worktwin.mjs";

const WORDS = ["contract","invoice","payment","terms","renewal","deadline","proposal","budget","meeting","review"];
const mkMail = (n, from = 0) => Array.from({ length: n }, (_, k) => {
  const i = from + k;
  return { id: `m${i}`, threadId: `t${i % 500}`, accountId: "imap:a", from: `s${i % 300}@p.test`,
    to: ["a@acme.test"], subject: `${WORDS[i % WORDS.length]} ${WORDS[(i + 3) % WORDS.length]} #${i}`,
    date: 1_700_000_000_000 + i * 60000, unread: i % 4 === 0, folder: "INBOX",
    body: `Please confirm the ${WORDS[(i + 5) % WORDS.length]} before Friday. Ref ${i}.` };
});
const twin = () => connectWorkSource(createWorkTwin({ employee: { id: "a", name: "A", email: "a@acme.test" } }),
  { kind: "imap", account: "a", resources: [] });

test("the index is bounded and keeps the NEWEST messages", () => {
  const over = INDEX_LIMITS.messages + 2500;
  const t = indexMessages(twin(), mkMail(over));
  assert.equal(t.index.length, INDEX_LIMITS.messages);
  // the newest survived, the oldest were dropped
  const dates = t.index.map((e) => e.date);
  assert.equal(Math.max(...dates), 1_700_000_000_000 + (over - 1) * 60000);
  assert.ok(Math.min(...dates) > 1_700_000_000_000, "oldest messages must be the ones dropped");
});

test("documents are bounded too, newest first", () => {
  const over = INDEX_LIMITS.files + 500;
  const t = indexFiles(twin(), Array.from({ length: over }, (_, i) => ({
    id: `f${i}`, name: `doc-${i}.md`, path: `/d/${i}.md`, accountId: "drive:a",
    modified: 1_700_000_000_000 + i * 1000, snippet: `budget ${WORDS[i % WORDS.length]}` })));
  assert.equal(t.files.length, INDEX_LIMITS.files);
  assert.equal(Math.max(...t.files.map((f) => f.modified)), 1_700_000_000_000 + (over - 1) * 1000);
});

test("search does not scan the mailbox: 20k messages stays far below a linear scan", () => {
  const t = indexMessages(twin(), mkMail(20000));
  retrieveForRequest(t, "contract renewal", { k: 5 });                 // warm the postings
  const started = performance.now();
  for (let i = 0; i < 20; i++) retrieveForRequest(t, "contract payment renewal terms", { k: 5 });
  const per = (performance.now() - started) / 20;
  // The naive full-scan version was ~330 ms per query at this size; 60 ms is a generous ceiling that
  // still fails loudly if the inverted index is ever bypassed.
  assert.ok(per < 60, `retrieval took ${per.toFixed(1)} ms/query — the inverted index is not being used`);
  const hits = retrieveForRequest(t, "contract renewal", { k: 5 });
  assert.ok(hits.length && hits.length <= 5);
  assert.ok(hits.every((h) => h.ref && h.citation));
});

test("results stay CORRECT at scale — the right message is still found", () => {
  let t = indexMessages(twin(), mkMail(5000));
  t = indexMessages(t, [{ id: "needle", threadId: "tz", accountId: "imap:a", from: "vip@partner.test",
    to: ["a@acme.test"], subject: "Zanzibar warehouse lease", date: 1_800_000_000_000, folder: "INBOX",
    body: "The Zanzibar lease needs your signature." }]);
  const hits = retrieveForRequest(t, "Zanzibar lease", { k: 3 });
  assert.equal(hits[0].subject, "Zanzibar warehouse lease");
  assert.match(hits[0].citation, /vip@partner\.test/);
});

test("a fresh index invalidates the cached postings (no stale results)", () => {
  let t = indexMessages(twin(), mkMail(2000));
  assert.equal(retrieveForRequest(t, "Zanzibar", { k: 3 }).length, 0);
  t = indexMessages(t, [{ id: "z", threadId: "tz", accountId: "imap:a", from: "v@p.test", to: ["a@acme.test"],
    subject: "Zanzibar", date: 1_800_000_000_000, folder: "INBOX", body: "Zanzibar" }]);
  assert.equal(retrieveForRequest(t, "Zanzibar", { k: 3 }).length, 1);   // new content is visible at once
});

test("thread analysis stays usable on a large mailbox", () => {
  const t = indexMessages(twin(), mkMail(20000));
  const started = performance.now();
  const un = unansweredThreads(t, { now: 1_900_000_000_000, olderThanHours: 0 });
  assert.ok(performance.now() - started < 400);
  assert.ok(un.length > 0);
  assert.ok(un.every((x) => x.ref && x.subject));
});
