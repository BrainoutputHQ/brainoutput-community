#!/usr/bin/env node --test
// SPDX-License-Identifier: Apache-2.0
// Tests for the approved-workspace registry: coding executors may only touch paths inside an
// approved root; everything else is refused fail-closed BEFORE the executor runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveApprovedWorkspace, within, approvedWorkspaceRoots } from "./workspace-registry.mjs";

const base = mkdtempSync(join(tmpdir(), "ce-wsreg-"));
const root = join(base, "workspaces");
mkdirSync(root, { recursive: true });

test("a path inside an approved root is accepted and canonicalized", () => {
  const ws = resolveApprovedWorkspace(join(root, "task-1"), { roots: [root], create: true });
  assert.equal(ws, resolve(root, "task-1"));
});

test("a not-yet-existing nested path inside the root is accepted", () => {
  const ws = resolveApprovedWorkspace(join(root, "a", "b", "c"), { roots: [root] });
  assert.ok(ws.startsWith(resolve(root)));
});

test("path traversal escaping the root is refused fail-closed", () => {
  assert.throws(() => resolveApprovedWorkspace(join(root, "..", "..", "etc"), { roots: [root] }), /outside every approved root/);
});

test("an absolute host path outside the root is refused", () => {
  assert.throws(() => resolveApprovedWorkspace("/etc", { roots: [root] }), /outside every approved root/);
  assert.throws(() => resolveApprovedWorkspace(join(base, "sibling"), { roots: [root] }), /outside every approved root/);
});

test("a symlink inside the root pointing outside is refused (canonicalized)", () => {
  const outside = join(base, "outside"); mkdirSync(outside, { recursive: true });
  const link = join(root, "escape"); symlinkSync(outside, link);
  assert.throws(() => resolveApprovedWorkspace(join(link, "x"), { roots: [root] }), /outside every approved root/);
});

test("no configured roots ⇒ refused fail-closed (never a wide-open default)", () => {
  assert.throws(() => resolveApprovedWorkspace(join(root, "task"), { roots: [] }), /no approved workspace roots/);
});

test("within() matches the root itself and rejects a prefix-sibling", () => {
  assert.ok(within(root, root));
  assert.ok(!within(root + "-evil", root));   // /workspaces-evil must NOT count as inside /workspaces
});

test("approvedWorkspaceRoots() always includes the CE data workspaces dir and honors extras", () => {
  const roots = approvedWorkspaceRoots([join(base, "gen")]);
  assert.ok(roots.some((r) => r.endsWith("workspaces")));
  assert.ok(roots.includes(resolve(base, "gen")));
});

test.after(() => rmSync(base, { recursive: true, force: true }));
