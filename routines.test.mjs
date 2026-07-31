// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { newRoutine, nextRun, isDue, markFired, parseFeed, unseenItems, ROUTINE_TEMPLATES } from "./routines.mjs";

test("templates are sane; custom needs a schedule; unknown kinds refused", () => {
  for (const tpl of ROUTINE_TEMPLATES) {
    const r = newRoutine({ kind: tpl.kind, at: 1000 });
    assert.equal(r.enabled, true);
    assert.ok(r.nextRunAt > 1000);
  }
  assert.ok(newRoutine({ kind: "custom", schedule: { type: "interval", minutes: 30 }, at: 0 }).nextRunAt === 30 * 60000);
  assert.throws(() => newRoutine({ kind: "custom", at: 0 }), /schedule/);
  assert.throws(() => newRoutine({ kind: "banana", at: 0 }), /unknown/);
});

test("interval schedules fire every N minutes; daily fires at the next occurrence of the hour", () => {
  assert.equal(nextRun({ type: "interval", minutes: 60 }, 0), 3600000);
  const at = new Date("2026-07-31T05:30:00").getTime();
  const n = nextRun({ type: "daily", hour: 8 }, at);
  assert.equal(new Date(n).getHours(), 8);
  assert.ok(n > at);
  const late = new Date("2026-07-31T23:00:00").getTime();
  const n2 = nextRun({ type: "daily", hour: 8 }, late);
  assert.ok(n2 > late, "past the hour → tomorrow");
});

test("isDue + markFired advances and never double-fires", () => {
  const r = newRoutine({ kind: "daily-digest", at: Date.now() - 1000 });
  assert.equal(isDue(r), false);
  const due = { ...r, nextRunAt: Date.now() - 1 };
  assert.equal(isDue(due), true);
  assert.equal(isDue({ ...due, enabled: false }), false);
  const fired = markFired(due, { at: Date.now(), ok: true });
  assert.equal(isDue(fired), false);
  assert.ok(fired.nextRunAt > Date.now());
  assert.equal(fired.lastResult.ok, true);
});

test("feed parsing: RSS items and Atom entries, CDATA stripped", () => {
  const rss = `<rss><channel><item><title><![CDATA[AI Act enters into force]]></title><link>https://x.eu/1</link><guid>g1</guid><pubDate>Thu, 31 Jul 2026</pubDate></item><item><title>Other</title><guid>g2</guid></item></channel></rss>`;
  const items = parseFeed(rss);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "AI Act enters into force");
  assert.equal(items[0].guid, "g1");
  const atom = `<feed><entry><title>Entry</title><id>e1</id><link href="https://x.eu/2"/></entry></feed>`;
  assert.equal(parseFeed(atom)[0].guid, "e1");
});

test("unseenItems keeps only new guids", () => {
  const r = { config: { seen: ["g1"] } };
  const out = unseenItems(r, [{ guid: "g1" }, { guid: "g2" }, { guid: null, title: "x" }]);
  assert.deepEqual(out.map((i) => i.guid), ["g2"]);
});
