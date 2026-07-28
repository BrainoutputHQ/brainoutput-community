// SPDX-License-Identifier: Apache-2.0
// Work sources — normalization, local mail (mbox/Maildir/import), and REAL IMAP/SMTP.
// The IMAP tests SKIP (never silently pass) when no server is configured: BO_TEST_IMAP=host:port.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRfc822, parseMbox, readMaildir, localMailSource, connectMailSource,
  workSourceOptions, imapSource, smtpSend, googleWorkspaceSource, microsoft365Source } from "./mail-sources.mjs";

const RAW = `From: Bob <bob@partner.test>
To: alice@acme.test
Subject: Contract review
Date: Mon, 27 Jul 2026 09:00:00 +0000
Message-ID: <m1@partner.test>

Can you confirm the payment terms by Friday?
`;

test("RFC-822 parsing normalizes addresses, subject, date and body", () => {
  const m = parseRfc822(RAW, { id: "x1" });
  assert.equal(m.from, "bob@partner.test");
  assert.deepEqual(m.to, ["alice@acme.test"]);
  assert.equal(m.subject, "Contract review");
  assert.ok(m.date > 0);
  assert.match(m.body, /payment terms/);
});

test("mbox and Maildir are parsed; Maildir flags decide unread", () => {
  assert.equal(parseMbox(`From bob@partner.test Mon Jul 27 09:00:00 2026\n${RAW}`).length, 1);
  const dir = mkdtempSync(join(tmpdir(), "bo-maildir-"));
  try {
    mkdirSync(join(dir, "new"), { recursive: true }); mkdirSync(join(dir, "cur"), { recursive: true });
    writeFileSync(join(dir, "new", "1234.msg"), RAW);
    writeFileSync(join(dir, "cur", "5678.msg:2,S"), RAW);
    const msgs = readMaildir(dir);
    assert.equal(msgs.length, 2);
    assert.equal(msgs.filter((m) => m.unread).length, 1);      // the 'S' (seen) one is read
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a local source can be an in-memory import — nothing leaves the machine", async () => {
  const src = localMailSource({ account: "alice", messages: [{ id: "i1", from: "x@y.test", to: "alice@acme.test", subject: "Hi", body: "hello" }] });
  const msgs = await src.listMessages();
  assert.equal(src.verified, true);
  assert.equal(msgs[0].accountId, "local-mail:alice");
  assert.equal(msgs[0].from, "x@y.test");
});

test("the factory covers the four slice sources and rejects unknown kinds", () => {
  assert.equal(connectMailSource({ kind: "local-mail" }).kind, "local-mail");
  assert.equal(connectMailSource({ kind: "imap", account: "a", host: "h", user: "u", password: "p" }).kind, "imap");
  assert.throws(() => connectMailSource({ kind: "nope" }), /unknown work source/);
  const opts = workSourceOptions().map((o) => o.key);
  for (const k of ["google-workspace", "microsoft-365", "imap", "local-mail", "skip"]) assert.ok(opts.includes(k));
});

test("cloud sources are declared UNVERIFIED (no OAuth credential in this environment)", () => {
  assert.equal(googleWorkspaceSource({ account: "a", accessToken: "t" }).verified, false);
  assert.equal(microsoft365Source({ account: "a", accessToken: "t" }).verified, false);
});

test("Gmail/Graph shapes normalize correctly against injected responses", async () => {
  const g = googleWorkspaceSource({ account: "alice", fetchImpl: async (p) =>
    p.includes("/messages?") ? { messages: [{ id: "g1" }] }
      : { threadId: "t9", internalDate: "1700000000000", labelIds: ["INBOX", "UNREAD"], snippet: "hi there",
          payload: { headers: [{ name: "From", value: "bob@partner.test" }, { name: "Subject", value: "Hello" }, { name: "To", value: "alice@acme.test" }] } } });
  const [m] = await g.listMessages({ limit: 1 });
  assert.equal(m.from, "bob@partner.test");
  assert.equal(m.unread, true);
  assert.equal(m.accountId, "google-workspace:alice");

  const ms = microsoft365Source({ account: "alice", fetchImpl: async () => ({ value: [{ id: "o1", conversationId: "c1",
    from: { emailAddress: { address: "dan@vendor.test" } }, toRecipients: [{ emailAddress: { address: "alice@acme.test" } }],
    subject: "Invoice", receivedDateTime: "2026-07-27T09:00:00Z", isRead: false, hasAttachments: true, bodyPreview: "see attached" }] }) });
  const [o] = await ms.listMessages({ limit: 1 });
  assert.equal(o.from, "dan@vendor.test");
  assert.equal(o.unread, true);
  assert.deepEqual(o.attachments, ["(attachment)"]);
});

const IMAP = process.env.BO_TEST_IMAP;           // e.g. 127.0.0.1:3143
const SMTP = process.env.BO_TEST_SMTP;           // e.g. 127.0.0.1:3025
test("REAL IMAP/SMTP round-trip: send, fetch, decode headers and body", { skip: !(IMAP && SMTP) && "set BO_TEST_IMAP and BO_TEST_SMTP" }, async () => {
  const [ih, ip] = IMAP.split(":"), [sh, sp] = SMTP.split(":");
  const to = `t${Date.now()}@acme.test`;
  const send = smtpSend({ host: sh, port: Number(sp) });
  await send({ from: "bob@partner.test", to, subject: "Révision — urgent ✅", body: "Confirmez avant vendredi ?" });
  const src = imapSource({ account: "t", host: ih, port: Number(ip), user: to, password: "pw", tls: false });
  try {
    const msgs = await src.listMessages({ limit: 5 });
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].from, "bob@partner.test");
    assert.equal(msgs[0].subject, "Révision — urgent ✅");     // RFC-2047 + UTF-8 survive
    assert.match(msgs[0].body, /vendredi/);
    assert.equal(msgs[0].unread, true);
    assert.equal(msgs[0].accountId, `imap:t`);
  } finally { await src.close(); }
});
