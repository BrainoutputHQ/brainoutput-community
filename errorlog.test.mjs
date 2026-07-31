// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.mjs";
import { recordError, errorPatterns, patternKey } from "./errorlog.mjs";

test("recordError persists bounded, and never throws even on garbage", () => {
  const dir = mkdtempSync(join(tmpdir(), "bo-err-"));
  try {
    const s = new Store(dir);
    recordError(s, { source: "launch", message: "model 'x' failed (500)" });
    recordError(s, { source: "banana", message: null });
    const errs = s.runtime.errors;
    assert.equal(errs.length, 2);
    assert.equal(errs[0].source, "launch");
    assert.equal(errs[1].source, "api", "unknown source normalizes");
    const s2 = new Store(dir);
    assert.equal(s2.runtime.errors.length, 2, "survives a reload");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("patternKey normalizes ids, numbers and paths — one bug, one pattern", () => {
  assert.equal(patternKey("model 'abc12345' failed (500): timeout"), patternKey("model 'zzz99999' failed (500): timeout"));
  assert.notEqual(patternKey("out of memory"), patternKey("timeout"));
});

test("errorPatterns groups, counts, filters by since/minCount, sorts by count", () => {
  const errs = [
    { at: 1, source: "api", message: "feed https://a.eu/1 → HTTP 500" },
    { at: 2, source: "api", message: "feed https://b.eu/2 → HTTP 500" },
    { at: 3, source: "launch", message: "feed https://c.eu/3 → HTTP 500" },
    { at: 4, source: "api", message: "disk full" },
  ];
  const all = errorPatterns(errs);
  assert.equal(all[0].key, "feed URL → HTTP N");
  assert.equal(all[0].count, 3);
  assert.equal(all[1].count, 1);
  assert.equal(errorPatterns(errs, { minCount: 2 }).length, 1);
  assert.equal(errorPatterns(errs, { since: 4 })[0].key, "disk full");
});
