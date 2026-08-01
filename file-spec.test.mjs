// The files-spec protocol: real files on disk, path-traversal-proof, errors shown never hidden.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFilesSpec } from "./file-spec.mjs";

const dir = () => mkdtempSync(join(tmpdir(), "bo-filespec-"));

test("a valid block writes every file with its content and mime", () => {
  const d = dir();
  try {
    const out = writeFilesSpec('```files\n[{"path": "index.html", "content": "<h1>Hi</h1>"}, {"path": "css/main.css", "content": "body{}"}, {"path": "app.ts", "content": "let x=1"}]\n```', d);
    assert.equal(out.errors.length, 0);
    assert.equal(out.files.length, 3);
    assert.equal(readFileSync(join(d, "index.html"), "utf8"), "<h1>Hi</h1>");
    assert.equal(readFileSync(join(d, "css", "main.css"), "utf8"), "body{}");
    assert.equal(out.files[2].mime, "text/plain");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("traversal, absolute, and backslash paths are refused — others still write", () => {
  const d = dir();
  try {
    const out = writeFilesSpec('```files\n[{"path": "../evil.txt", "content": "x"}, {"path": "/abs.txt", "content": "x"}, {"path": "win\\\\sys.txt", "content": "x"}, {"path": "ok.txt", "content": "fine"}]\n```', d);
    assert.deepEqual(out.files.map((f) => f.name), ["ok.txt"]);
    assert.equal(out.errors.length, 3);
    assert.equal(existsSync(join(d, "..", "evil.txt")), false);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("unparseable or non-array blocks are errors, never a silent fake write", () => {
  const d = dir();
  try {
    assert.deepEqual(writeFilesSpec("```files\nnot json\n```", d).errors.length, 1);
    assert.deepEqual(writeFilesSpec('```files\n{"a":1}\n```', d).errors.length, 1);
    assert.deepEqual(writeFilesSpec("no block at all", d).errors.length, 0);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("file count is bounded", () => {
  const d = dir();
  try {
    const many = Array.from({ length: 40 }, (_, i) => ({ path: `f${i}.txt`, content: "x" }));
    const out = writeFilesSpec("```files\n" + JSON.stringify(many) + "\n```", d);
    assert.equal(out.files.length, 24);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
