// SPDX-License-Identifier: Apache-2.0
// Drive/file work sources: local folders (verified), WebDAV (verified against a PROPFIND responder),
// and the OAuth providers' request shapes (declared unverified, tested against injected responses).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { localDriveSource, webdavDriveSource, parsePropfind, googleDriveSource, oneDriveSource,
  connectDriveSource, driveProviderOptions, normalizeFile } from "./drive-sources.mjs";
import { createWorkTwin, connectWorkSource, indexFiles, searchFiles, retrieveForRequest, indexMessages } from "./worktwin.mjs";

function fixtureDir() {
  const d = mkdtempSync(join(tmpdir(), "bo-drive-"));
  mkdirSync(join(d, "contracts"), { recursive: true });
  writeFileSync(join(d, "contracts", "acme-terms.md"), "# Acme terms\nPayment terms are net 30 days.");
  writeFileSync(join(d, "notes.txt"), "Remember to confirm the invoice with Dan.");
  writeFileSync(join(d, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(d, ".hidden"), "should be skipped");
  return d;
}

test("a local folder is walked: text is snippeted, binaries are metadata-only, dotfiles skipped", async () => {
  const d = fixtureDir();
  try {
    const src = localDriveSource({ account: "alice", roots: [d] });
    assert.equal(src.verified, true);
    const files = await src.listFiles();
    const names = files.map((f) => f.name).sort();
    assert.deepEqual(names, ["acme-terms.md", "logo.png", "notes.txt"]);
    const md = files.find((f) => f.name === "acme-terms.md");
    assert.match(md.snippet, /net 30 days/);
    assert.equal(md.mimeType, "text/markdown");
    assert.equal(md.folder, "contracts");
    assert.equal(files.find((f) => f.name === "logo.png").snippet, "");   // binary: no snippet
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("reading a file outside the authorized roots is refused", async () => {
  const d = fixtureDir();
  try {
    const src = localDriveSource({ account: "alice", roots: [join(d, "contracts")] });
    assert.match(await src.readFile(join(d, "contracts", "acme-terms.md")), /net 30/);
    await assert.rejects(() => src.readFile(join(d, "notes.txt")), /outside the authorized folders/);
    await assert.rejects(() => src.readFile("/etc/passwd"), /outside the authorized folders/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("PROPFIND parsing handles namespaces and skips collections", () => {
  const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/remote.php/dav/files/alice/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
    <d:response><d:href>/remote.php/dav/files/alice/report.pdf</d:href><d:propstat><d:prop>
      <d:getcontentlength>1024</d:getcontentlength><d:getlastmodified>Mon, 27 Jul 2026 09:00:00 GMT</d:getlastmodified>
      <d:getcontenttype>application/pdf</d:getcontenttype><d:resourcetype/></d:prop></d:propstat></d:response></d:multistatus>`;
  const files = parsePropfind(xml, { accountId: "drive:alice", base: "/remote.php/dav/files/alice" });
  assert.equal(files.length, 1);                                  // the collection is not a file
  assert.equal(files[0].name, "report.pdf");
  assert.equal(files[0].size, 1024);
  assert.equal(files[0].mimeType, "application/pdf");
  assert.ok(files[0].modified > 0);
});

test("the WebDAV client works against a real PROPFIND responder", async () => {
  const server = http.createServer((req, res) => {
    if (req.method === "PROPFIND") {
      res.writeHead(207, { "Content-Type": "application/xml" });
      res.end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/notes.md</d:href>
        <d:propstat><d:prop><d:getcontentlength>42</d:getcontentlength><d:getcontenttype>text/markdown</d:getcontenttype>
        <d:resourcetype/></d:prop></d:propstat></d:response></d:multistatus>`);
    } else { res.writeHead(200); res.end("payment terms are net 30"); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/dav/`;
  try {
    const src = webdavDriveSource({ account: "alice", baseUrl: base, user: "alice", password: "pw" });
    const files = await src.listFiles();
    assert.equal(files.length, 1);
    assert.equal(files[0].name, "notes.md");
    assert.match(await src.readFile("notes.md"), /net 30/);
  } finally { server.close(); }
});

test("Google Drive / OneDrive shapes normalize, and declare themselves unverified", async () => {
  const g = googleDriveSource({ account: "alice", fetchImpl: async () => ({ files: [
    { id: "g1", name: "Contract.pdf", mimeType: "application/pdf", size: "2048", modifiedTime: "2026-07-27T09:00:00Z", webViewLink: "https://drive/x" }] }) });
  assert.equal(g.verified, false);
  const [f] = await g.listFiles();
  assert.equal(f.name, "Contract.pdf");
  assert.equal(f.size, 2048);
  assert.equal(f.accountId, "drive:google:alice");

  const o = oneDriveSource({ account: "alice", fetchImpl: async () => ({ value: [
    { id: "o1", name: "Budget.xlsx", size: 99, file: { mimeType: "application/vnd.ms-excel" },
      lastModifiedDateTime: "2026-07-27T10:00:00Z", parentReference: { path: "/drive/root:/Finance" }, webUrl: "https://od/x" },
    { id: "o2", name: "AFolder", folder: {} }] }) });
  assert.equal(o.verified, false);
  const files = await o.listFiles();
  assert.equal(files.length, 1);                                   // folders filtered out
  assert.equal(files[0].name, "Budget.xlsx");
});

test("the drive factory covers every provider and rejects unknown ones", () => {
  assert.equal(connectDriveSource({ provider: "local", roots: [] }).kind, "drive");
  assert.equal(connectDriveSource({ provider: "nextcloud", account: "a", baseUrl: "http://x/" }).verified, true);
  assert.equal(connectDriveSource({ provider: "google-drive", account: "a" }).verified, false);
  assert.equal(connectDriveSource({ provider: "sharepoint", account: "a", site: "s" }).accountId, "drive:sharepoint:a");
  assert.throws(() => connectDriveSource({ provider: "nope" }), /unknown drive provider/);
  assert.equal(driveProviderOptions().length, 5);
});

test("a Work Twin indexes files as metadata + snippet and searches them with citations", async () => {
  const d = fixtureDir();
  try {
    let t = createWorkTwin({ employee: { id: "alice", name: "Alice", email: "alice@acme.test" } });
    t = connectWorkSource(t, { kind: "drive", account: "alice", resources: ["contracts", "."] });
    const files = await localDriveSource({ account: "alice", roots: [d] }).listFiles();
    t = indexFiles(t, files);
    assert.ok(t.files.length >= 2);
    assert.ok(t.files.every((f) => f.snippet.length <= 400));        // never whole documents
    const hits = searchFiles(t, "payment terms net 30");
    assert.ok(hits.length);
    assert.equal(hits[0].name, "acme-terms.md");
    assert.match(hits[0].citation, /acme-terms\.md \(contracts\)/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("retrieval spans mail AND documents, still capped at k", async () => {
  const d = fixtureDir();
  try {
    let t = createWorkTwin({ employee: { id: "alice", name: "Alice", email: "alice@acme.test" } });
    t = connectWorkSource(t, { kind: "drive", account: "alice", resources: [] });   // unrestricted for this test
    t = indexMessages(t, [{ id: "m1", from: "bob@partner.test", to: ["alice@acme.test"], subject: "Payment terms",
      body: "Confirm the payment terms", folder: "INBOX", accountId: "imap:alice", date: 1 }]);
    t = indexFiles(t, await localDriveSource({ account: "alice", roots: [d] }).listFiles());
    const hits = retrieveForRequest(t, "payment terms", { k: 3 });
    assert.ok(hits.length && hits.length <= 3);
    assert.ok(hits.some((h) => h.subject), "a mail hit");
    assert.ok(hits.some((h) => h.name), "a document hit");
  } finally { rmSync(d, { recursive: true, force: true }); }
});
