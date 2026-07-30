// SPDX-License-Identifier: Apache-2.0
// `bo ask` — CLI ad-hoc asks land in the shell as threads (optionally under a project).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "./store.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let dir;
before(() => { dir = mkdtempSync(join(tmpdir(), "bo-ask-")); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

const ask = (args) => spawnSync(process.execPath, [join(HERE, "bo-community.mjs"), "ask", ...args],
  { env: { ...process.env, BO_CE_DATA: dir }, encoding: "utf8" });
const runtime = () => JSON.parse(readFileSync(join(dir, "runtime.json"), "utf8"));

test("an ask with no model and no knowledge still answers, and saves an ad-hoc thread", () => {
  const r = ask(["why", "can't", "I", "reach", "the", "printer?"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /No matching company knowledge/);
  assert.match(r.stdout, /ad-hoc/);
  const convs = runtime().conversations;
  assert.equal(convs.length, 1);
  assert.equal(convs[0].projectId, null);
  assert.equal(convs[0].messages[0].text, "why can't I reach the printer?");
  assert.equal(convs[0].messages[1].role, "assistant");
});

test("--project tags the thread; unknown project exits 2 with the project list", async () => {
  const s = new Store(dir);
  s.addProject({ id: "p1", kind: "project", name: "office-infra", createdAt: 1, updatedAt: 1 });
  s.saveRuntime();

  const r = ask(["--project", "office-infra", "what", "vlan", "is", "the", "printer", "on?"]);
  assert.equal(r.status, 0, r.stderr);
  const tagged = runtime().conversations.find((c) => c.projectId === "p1");
  assert.ok(tagged, "thread carries the project");
  assert.equal(tagged.messages[0].text, "what vlan is the printer on?");

  const bad = ask(["--project", "ghost", "hello"]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /no project 'ghost'/);
  assert.match(bad.stderr, /office-infra/);
});
