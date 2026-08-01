// SPDX-License-Identifier: Apache-2.0
// BrainOutput Community Edition — the files-spec protocol (2026-08-01).
// "Build me a dashboard" must land as REAL FILES, not a code wall in the chat. Same contract as
// the PDF protocol (file spec → real file, never "code that could make one"): the model emits a
// fenced `files` block, we write the files into the execution workspace, path-traversal-proof,
// bounded, and they become downloadable artifacts. Zero-dep.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const FILES_SPEC_INSTRUCTION = `

Deliver REAL FILES, not descriptions of files. Output ONLY a fenced block:
\`\`\`files
[{"path": "index.html", "content": "<!doctype html>…"}, {"path": "styles.css", "content": "…"}]
\`\`\`
Rules: relative paths only; complete file contents (every file runnable/openable as-is); no commentary outside the block.`;

const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript",
  ".ts": "text/plain", ".tsx": "text/plain", ".jsx": "text/plain", ".json": "application/json",
  ".md": "text/markdown", ".svg": "image/svg+xml", ".py": "text/plain", ".txt": "text/plain", ".csv": "text/csv" };

/** Write a fenced `files` block into destDir. Returns { files: [{name, bytes}], errors: [..] }. */
export function writeFilesSpec(text = "", destDir, { maxFiles = 24, maxBytesPerFile = 200_000 } = {}) {
  const m = String(text).match(/```files\s*([\s\S]*?)```/);
  if (!m) return { files: [], errors: [] };
  let arr;
  try { arr = JSON.parse(m[1]); } catch { return { files: [], errors: ["the files block was not parseable JSON"] }; }
  if (!Array.isArray(arr)) return { files: [], errors: ["the files block is not an array"] };
  const files = [], errors = [];
  for (const f of arr.slice(0, maxFiles)) {
    const p = String(f?.path || "");
    // Hard path rules: relative, no traversal, no absolute, no backslashes.
    if (!p || p.startsWith("/") || p.startsWith("~") || p.includes("..") || p.includes("\\")) {
      errors.push(`refused path '${p || "(empty)"}'`);
      continue;
    }
    const content = String(f.content ?? "").slice(0, maxBytesPerFile);
    const dest = join(destDir, p);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content, { mode: 0o600 });
    const ext = p.slice(p.lastIndexOf("."));
    files.push({ name: p, bytes: Buffer.byteLength(content), mime: MIME[ext] || "text/plain" });
  }
  return { files, errors };
}
