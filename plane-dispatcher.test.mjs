// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatcherTick, seenToJSON, seenFromJSON } from "./plane-dispatcher.mjs";

const issues = (...ids) => ids.map((id) => ({ id, name: `issue ${id}` }));

test("a new issue is worked once and its result commented; a second tick skips it", async () => {
  const posted = [];
  const seen = new Map();
  const tick = () => dispatcherTick({
    listIssues: async () => issues("i1"),
    runIssue: async (i) => ({ ok: true, commentHtml: `<p>done: ${i.name}</p>` }),
    postComment: async (i, html) => posted.push([i.id, html]),
    seen,
  });
  const first = await tick();
  assert.equal(first.worked.length, 1);
  assert.equal(first.worked[0].ok, true);
  assert.deepEqual(posted, [["i1", "<p>done: issue i1</p>"]]);
  assert.equal(seen.get("i1"), "done");

  const second = await tick();
  assert.equal(second.worked.length, 0);
  assert.equal(posted.length, 1, "no double comment");
});

test("a failed issue is recorded, not retried forever, and never commented", async () => {
  const posted = [];
  const seen = new Map();
  const tick = () => dispatcherTick({
    listIssues: async () => issues("i2"),
    runIssue: async () => { throw new Error("sandbox exploded"); },
    postComment: async (i, html) => posted.push([i.id, html]),
    seen,
  });
  const first = await tick();
  assert.equal(first.worked[0].ok, false);
  assert.match(first.worked[0].error, /sandbox exploded/);
  assert.equal(seen.get("i2"), "failed");
  assert.equal(posted.length, 0);
  assert.equal((await tick()).worked.length, 0);
});

test("requireApproval queues comments for a human instead of posting", async () => {
  const seen = new Map();
  const r = await dispatcherTick({
    listIssues: async () => issues("i3"),
    runIssue: async () => ({ ok: true, commentHtml: "<p>ready</p>" }),
    requireApproval: true,
    seen,
  });
  assert.equal(r.pending.length, 1);
  assert.equal(r.pending[0].issue.id, "i3");
  assert.equal(r.worked[0].queued, true);
});

test("maxPerTick bounds the batch; wiring is validated", async () => {
  const seen = new Map();
  const r = await dispatcherTick({
    listIssues: async () => issues("a", "b", "c", "d", "e"),
    runIssue: async () => ({ ok: true, commentHtml: "<p>x</p>" }),
    postComment: async () => {},
    seen, maxPerTick: 2,
  });
  assert.equal(r.worked.length, 2);
  assert.equal(seen.size, 2);

  await assert.rejects(() => dispatcherTick({}), /listIssues/);
  await assert.rejects(() => dispatcherTick({ listIssues: async () => [] }), /runIssue/);
  await assert.rejects(() => dispatcherTick({ listIssues: async () => [], runIssue: async () => ({}) }), /postComment/);
});

test("seen survives a JSON round-trip (caller persists it)", () => {
  const seen = new Map([["i1", "done"], ["i2", "failed"]]);
  const back = seenFromJSON(JSON.parse(JSON.stringify(seenToJSON(seen))));
  assert.deepEqual([...back.entries()], [["i1", "done"], ["i2", "failed"]]);
});
