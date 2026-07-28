// SPDX-License-Identifier: Apache-2.0
// Work Twin — modes, permissions, attribution/audit, context discipline, capabilities. `node --test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WORK_TWIN_MODES, modeScopes, createWorkTwin, setMode, connectWorkSource, grantTwinScope,
  twinPermission, auditRecord, draftAttribution, indexMessages, retrieveForRequest,
  prioritySummary, unansweredThreads, extractCommitments, meetingBrief, followUpSuggestions,
  draftReply, sendDraft, emailToMission, taskPacket, onConnectorEvent, sleep,
} from "./worktwin.mjs";
import { newConnector, grantScope } from "./connectors.mjs";

const EMP = { id: "alice", name: "Alice Martin", email: "alice@acme.test" };
const MSGS = [
  { id: "m1", threadId: "t1", accountId: "imap:alice", from: "bob@partner.test", to: ["alice@acme.test"],
    subject: "Contract review — urgent", date: 1000, unread: true, folder: "INBOX",
    body: "Can you confirm the payment terms by Friday? I will send the annex tomorrow.", attachments: ["annex.pdf"] },
  { id: "m2", threadId: "t2", accountId: "imap:alice", from: "alice@acme.test", to: ["carol@acme.test"],
    subject: "Re: Roadmap", date: 2000, unread: false, folder: "INBOX", body: "Thanks, sent." },
  { id: "m3", threadId: "t3", accountId: "imap:alice", from: "dan@vendor.test", to: ["alice@acme.test"],
    subject: "Invoice question", date: 1500, unread: true, folder: "INBOX", body: "Please advise on invoice 42." },
  { id: "m4", threadId: "t4", accountId: "imap:alice", from: "spam@x.test", to: ["alice@acme.test"],
    subject: "Newsletter", date: 900, unread: true, folder: "Promotions", body: "weekly digest" },
];
const twinWith = (mode = "mirror", resources = ["INBOX"]) => {
  let t = createWorkTwin({ employee: EMP });
  t = connectWorkSource(t, { kind: "imap", account: "alice", resources });
  t = indexMessages(t, MSGS);
  return setMode(t, mode);
};

test("a Work Twin is bound to an employee, starts in MIRROR and DORMANT with nothing granted", () => {
  const t = createWorkTwin({ employee: EMP });
  assert.equal(t.employee.id, "alice");
  assert.equal(t.mode, "mirror");
  assert.equal(t.activation, "dormant");
  assert.deepEqual(t.grants, []);
  assert.deepEqual(t.accounts, []);
  assert.equal(t.kind, "work-twin");                        // distinct from a departmental agent
  assert.throws(() => createWorkTwin({}), /employee identity is required/);
  assert.deepEqual(WORK_TWIN_MODES, ["mirror", "copilot", "delegate"]);
});

test("modes are a ceiling: mirror reads, copilot drafts, delegate may act", () => {
  assert.deepEqual(modeScopes("mirror"), ["read"]);
  assert.deepEqual(modeScopes("copilot"), ["read", "draft"]);
  assert.ok(modeScopes("delegate").includes("communicate"));
  assert.ok(!modeScopes("delegate").includes("sensitive"));  // never granted by mode alone

  const mirror = twinWith("mirror");
  assert.equal(twinPermission(mirror, { action: "search-mail" }).allowed, true);
  assert.equal(twinPermission(mirror, { action: "draft-reply" }).allowed, false);   // no drafting in mirror
  assert.equal(twinPermission(mirror, { action: "send-email" }).allowed, false);

  const copilot = twinWith("copilot");
  assert.equal(twinPermission(copilot, { action: "draft-reply" }).allowed, true);
  assert.equal(twinPermission(copilot, { action: "send-email" }).allowed, false);   // never sends
});

test("delegate STILL needs an explicit grant, and sending needs approval", () => {
  let t = twinWith("delegate");
  assert.equal(twinPermission(t, { action: "send-email" }).allowed, false);          // mode alone is not enough
  t = grantTwinScope(t, { scope: "communicate", action: "send-email" });
  const p = twinPermission(t, { action: "send-email" });
  assert.equal(p.allowed, true);
  assert.equal(p.requiresApproval, true);                                            // never silent
});

test("sensitive actions are refused unless explicitly granted, and always need a human", () => {
  let t = twinWith("delegate");
  const del = twinPermission(t, { action: "delete-mailbox" });
  assert.equal(del.allowed, false);
  assert.match(del.reason, /sensitive/);
  assert.throws(() => grantTwinScope(t, { scope: "read" }), /elevated scopes only/);
  t = grantTwinScope(t, { scope: "sensitive", action: "delete-mailbox" });
  assert.equal(t.grants.at(-1).approval, "human");                                   // forced human
});

test("a twin can never exceed the backing connector's permissions", () => {
  let t = twinWith("delegate");
  t = grantTwinScope(t, { scope: "communicate", action: "send-reply" });
  // account backed by a READ-ONLY connector
  const acc = t.accounts[0];
  t = { ...t, accounts: [{ ...acc, connector: newConnector("generic-chat") }] };
  const denied = twinPermission(t, { action: "send-reply", accountId: acc.id });
  assert.equal(denied.allowed, false);
  assert.match(denied.reason, /connector denied/);
  // once the connector grants communicate, it passes — still with approval
  t = { ...t, accounts: [{ ...acc, connector: grantScope(newConnector("generic-chat"), { scope: "communicate", principal: { level: "organization" } }) }] };
  const ok = twinPermission(t, { action: "send-reply", accountId: acc.id });
  assert.equal(ok.allowed, true);
  assert.equal(ok.requiresApproval, true);
});

test("NO SILENT IMPERSONATION: drafts carry attribution and are never marked sent", () => {
  const t = twinWith("copilot");
  const r = draftReply(t, { messageRef: "imap:alice:m1", body: "Confirming terms.", model: "qwen2.5:7b", runtime: "local-openai" });
  assert.equal(r.ok, true);
  assert.equal(r.draft.attribution.onBehalfOf.id, "alice");
  assert.equal(r.draft.attribution.preparedBy.workTwin, t.id);
  assert.equal(r.draft.attribution.sent, false);
  assert.match(r.draft.attribution.disclosure, /on behalf of Alice Martin/);
  assert.equal(r.draft.requiresApprovalToSend, true);
  assert.equal(r.draft.subject, "Re: Contract review — urgent");
  // audit captures employee, twin, model, account, permission, approval and sources
  assert.equal(r.audit.representedEmployee.id, "alice");
  assert.equal(r.audit.workTwin.id, t.id);
  assert.equal(r.audit.model, "qwen2.5:7b");
  assert.equal(r.audit.account, "imap:alice");
  assert.ok(r.audit.sources.length);
});

test("send is refused without grant, held without approval, authorized only with both", () => {
  let t = twinWith("copilot");
  const draft = draftReply(t, { messageRef: "imap:alice:m1" }).draft;
  const noGrant = sendDraft(t, { draft, accountId: "imap:alice" });
  assert.equal(noGrant.ok, false);
  assert.equal(noGrant.audit.result, "refused");

  t = grantTwinScope(setMode(t, "delegate"), { scope: "communicate", action: "send-email" });
  const held = sendDraft(t, { draft, accountId: "imap:alice" });
  assert.equal(held.ok, false);
  assert.equal(held.audit.result, "held-for-approval");

  const sent = sendDraft(t, { draft, accountId: "imap:alice", approval: { status: "approved" } });
  assert.equal(sent.ok, true);
  assert.equal(sent.audit.approval, "approved");
});

test("THE MAILBOX IS NOT CONTEXT: retrieval is relevant-only, compact and source-referenced", () => {
  const t = twinWith("mirror");
  const hits = retrieveForRequest(t, "invoice question", { k: 2 });
  assert.ok(hits.length && hits.length <= 2);
  assert.match(hits[0].citation, /dan@vendor.test/);
  assert.ok(hits[0].ref && hits[0].snippet !== undefined);
  assert.equal(hits.length < t.index.length, true);             // never the whole mailbox
  // the index holds snippets, not full bodies
  assert.ok(t.index.every((e) => e.snippet.length <= 240));
});

test("permitted resources gate what the twin can even see", () => {
  const t = twinWith("mirror", ["INBOX"]);                       // Promotions not permitted
  assert.equal(retrieveForRequest(t, "newsletter digest", { k: 5 }).length, 0);
  const wide = twinWith("mirror", ["INBOX", "Promotions"]);
  assert.ok(retrieveForRequest(wide, "newsletter digest", { k: 5 }).length > 0);
});

test("priority summary explains WHY each message is prioritized", () => {
  const items = prioritySummary(twinWith("mirror"));
  assert.ok(items.length >= 2);
  const top = items[0];
  assert.ok(top.reasons.includes("addressed directly to you"));
  assert.ok(top.reasons.some((r) => /time pressure|question/.test(r)));
});

test("unanswered detection: threads where someone else spoke last", () => {
  const t = twinWith("mirror");
  const un = unansweredThreads(t, { now: 1000 + 72 * 3600000 });
  const subjects = un.map((u) => u.subject);
  assert.ok(subjects.includes("Contract review — urgent"));
  assert.ok(subjects.includes("Invoice question"));
  assert.ok(!subjects.includes("Re: Roadmap"));                  // we replied last
  assert.ok(un[0].waitingHours > 0);
});

test("commitments, requests and deadlines are extracted with their sources", () => {
  const c = extractCommitments(twinWith("mirror"));
  const commit = c.find((x) => x.kind === "commitment");
  const req = c.find((x) => x.kind === "request");
  assert.ok(commit && /i will send/i.test(commit.text));
  assert.ok(req && /can you|please/i.test(req.text));
  assert.ok(c.every((x) => x.ref && x.citation));
  assert.ok(c.some((x) => x.deadline));                          // "Friday"/"tomorrow" picked up
});

test("meeting brief pulls related mail, commitments and open requests per event", () => {
  const briefs = meetingBrief(twinWith("mirror"), [
    { id: "e1", title: "Contract review", start: 5000, attendees: ["bob@partner.test"] },
  ]);
  assert.equal(briefs.length, 1);
  assert.ok(briefs[0].relatedMessages.length);
  assert.ok(briefs[0].sources.length);
  assert.equal(briefs[0].event.title, "Contract review");
});

test("follow-ups combine replies owed and requests made of the employee", () => {
  const f = followUpSuggestions(twinWith("mirror"), { now: 1000 + 72 * 3600000, olderThanHours: 24 });
  assert.ok(f.some((x) => x.kind === "reply-owed"));
  assert.ok(f.some((x) => x.kind === "request-of-you"));
});

test("an email becomes a structured mission carrying its origin and reference", () => {
  const m = emailToMission(twinWith("mirror"), { messageRef: "imap:alice:m1", department: "legal-compliance",
    constraints: ["do not commit to a date"], criteria: ["payment terms confirmed"] });
  assert.equal(m.department, "legal-compliance");
  assert.equal(m.origin.kind, "email");
  assert.equal(m.origin.ref, "imap:alice:m1");
  assert.deepEqual(m.constraints, ["do not commit to a date"]);
  assert.deepEqual(m.acceptanceCriteria, ["payment terms confirmed"]);
  assert.equal(m.status, "draft");
  assert.ok(m.references[0].citation.includes("bob@partner.test"));
  assert.throws(() => emailToMission(twinWith("mirror"), { messageRef: "nope" }), /not in the permitted index/);
});

test("delegation sends a COMPACT packet — never the mailbox or a transcript", () => {
  const t = twinWith("copilot");
  const hits = retrieveForRequest(t, "contract payment terms", { k: 2 });
  const p = taskPacket(t, { department: "technical", objective: "Assess the delivery commitment",
    facts: ["Partner asks to confirm payment terms by Friday"], sources: hits, constraints: ["no external send"], permissions: ["read"] });
  assert.equal(p.department, "technical");
  assert.equal(p.mailboxForwarded, false);
  assert.equal(p.transcriptForwarded, false);
  assert.ok(p.sources.length && p.sources.length <= 12);
  assert.equal(p.from.onBehalfOf, "alice");
  assert.throws(() => taskPacket(t, { objective: "x" }), /department is required/);
});

test("dormancy: no polling — the twin wakes on a connector event and sleeps again", () => {
  const t = twinWith("mirror");
  const idle = onConnectorEvent(t, { type: "heartbeat" });
  assert.equal(idle.woke, false);
  const woke = onConnectorEvent(t, { type: "message.received", messages: [{ id: "m9", from: "x@y.test", subject: "New", body: "hello", accountId: "imap:alice", folder: "INBOX" }] });
  assert.equal(woke.woke, true);
  assert.equal(woke.twin.activation, "active");
  assert.equal(woke.twin.index.length, t.index.length + 1);
  assert.equal(sleep(woke.twin).activation, "dormant");
});

test("audit records are complete enough to answer 'who did what on whose behalf'", () => {
  const t = twinWith("copilot");
  const rec = auditRecord(t, { action: "draft-reply", permission: "draft", model: "m", runtime: "local-openai",
    accountId: "imap:alice", sources: [{ ref: "imap:alice:m1" }], result: "ok", at: 123 });
  for (const k of ["representedEmployee", "workTwin", "model", "runtime", "account", "action", "permission", "approval", "sources"])
    assert.ok(k in rec, `audit missing ${k}`);
  assert.equal(draftAttribution(t).sent, false);
});

test("action names are canonical: a grant for what the user SEES matches what is checked", async () => {
  const { canonicalAction } = await import("./worktwin.mjs");
  assert.equal(canonicalAction("send-draft"), "send-email");
  assert.equal(canonicalAction("send-reply"), "send-email");
  let t = setMode(twinWith("copilot"), "delegate");
  t = grantTwinScope(t, { scope: "communicate", action: "send-draft" });   // granted by API name
  const p = twinPermission(t, { action: "send-email" });                    // checked by internal name
  assert.equal(p.allowed, true);
  assert.equal(p.requiresApproval, true);
  // and the reverse direction
  let t2 = grantTwinScope(setMode(twinWith("copilot"), "delegate"), { scope: "communicate", action: "send-email" });
  assert.equal(twinPermission(t2, { action: "send-draft" }).allowed, true);
});
