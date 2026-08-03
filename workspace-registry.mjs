// SPDX-License-Identifier: Apache-2.0
// BrainOutput Community Edition — approved-workspace registry (prod-readiness gap: repo registry).
// A coding executor (real OpenCode) may only touch paths INSIDE an approved root. Anything that
// resolves outside every root — path traversal, an absolute host path, or a symlink escape — is
// refused fail-closed BEFORE the executor is spawned. Pure logic + fs realpath; ESM, zero-dep.
import { realpathSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { resolve, sep, join } from "node:path";
import { homedir } from "node:os";

const HOME = process.env.HOME || homedir();

// Default approved root = the CE data dir's workspaces/ (mirrors store.mjs DEFAULT_DIR). Extra roots
// may be added via BO_CE_WORKSPACE_ROOTS (colon-separated absolute paths) or an explicit `extra` arg.
export function approvedWorkspaceRoots(extra = []) {
  const data = process.env.BO_CE_DATA || join(HOME, ".local", "share", "bo-community");
  const roots = [resolve(data, "workspaces")];
  for (const r of extra) if (r) roots.push(resolve(r));
  const env = process.env.BO_CE_WORKSPACE_ROOTS;
  if (env) for (const r of env.split(":").filter(Boolean)) roots.push(resolve(r));
  return [...new Set(roots)];
}

// Canonicalize a path that may not exist yet: realpath the longest EXISTING ancestor (resolving any
// symlink along the way), then re-append the not-yet-created tail. This closes symlink-escape holes
// (e.g. an approved dir containing a symlink that points outside the root).
export function canonical(p) {
  let cur = resolve(p);
  const tail = [];
  while (!existsSync(cur)) {
    const parent = resolve(cur, "..");
    if (parent === cur) break;                 // reached filesystem root
    tail.unshift(cur.slice(parent.length + 1));
    cur = parent;
  }
  const base = existsSync(cur) ? realpathSync(cur) : cur;
  return tail.length ? resolve(base, ...tail) : base;
}

// True iff `child` is the root itself or strictly contained within it (canonicalized on both sides).
export function within(child, root) {
  const c = canonical(child);
  const r = canonical(root);
  return c === r || c.startsWith(r + sep);
}

// Resolve a requested workspace against the approved roots. Returns the canonical path, or THROWS
// (fail-closed) when there are no roots or the path escapes all of them. create=true makes the dir.
export function resolveApprovedWorkspace(requested, { roots, create = false } = {}) {
  if (!requested) throw new Error("workspace path required");
  if (!roots || !roots.length) throw new Error("no approved workspace roots configured — refused (fail-closed)");
  const target = canonical(requested);
  if (!roots.some((root) => within(target, root)))
    throw new Error(`workspace "${requested}" is outside every approved root — refused (fail-closed)`);
  if (create) mkdirSync(target, { recursive: true });
  return target;
}

/**
 * Delete a path (file or directory tree) ONLY when it sits inside one of the approved roots
 * (task-pm-15 project delete). Fail-closed like the resolver above: a path that escapes every
 * root — traversal, an absolute host path, or a symlink pointing out — is NEVER followed; it is
 * reported, not touched. Honest outcome: { removed: true } only when something was actually
 * deleted, { removed: false } when the path was confined but absent, { skipped: reason } otherwise.
 */
export function removeConfined(requested, { roots } = {}) {
  if (!requested) return { skipped: "no path given" };
  if (!roots || !roots.length) return { skipped: "no approved roots configured — refused (fail-closed)" };
  const target = canonical(requested);
  if (!roots.some((root) => within(target, root)))
    return { skipped: `"${requested}" is outside every approved root — skipped (fail-closed)` };
  if (!existsSync(target)) return { removed: false };
  rmSync(target, { recursive: true, force: true });
  return { removed: true };
}
