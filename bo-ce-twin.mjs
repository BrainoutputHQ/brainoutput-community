#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// BrainOutput Community Edition — Work Twin demo (2026-07-28).
// Runs the whole Work Twin story on IMPORTED local mail: no server, no credentials, no model required.
// It shows what the twin may and may not do in each mode, and proves that nothing is ever sent silently.
import {
  createWorkTwin, setMode, connectWorkSource, grantTwinScope, twinPermission, indexMessages,
  prioritySummary, unansweredThreads, extractCommitments, meetingBrief, followUpSuggestions,
  draftReply, sendDraft, emailToMission, taskPacket, retrieveForRequest, withAudit, onConnectorEvent,
} from "./worktwin.mjs";
import { localMailSource, localCalendarSource } from "./mail-sources.mjs";

const line = (s = "") => console.log(s);
const rule = (t) => line(`\n${t}\n${"─".repeat(Math.min(72, t.length + 8))}`);

const MAIL = [
  { id: "1", threadId: "t1", from: "bob@partner.test", to: ["alice@acme.test"], date: Date.now() - 72 * 3600e3,
    subject: "Contract review — urgent", unread: true, folder: "INBOX", attachments: ["annex.pdf"],
    body: "Can you confirm the payment terms by Friday? I will send the annex tomorrow." },
  { id: "2", threadId: "t2", from: "alice@acme.test", to: ["carol@acme.test"], date: Date.now() - 40 * 3600e3,
    subject: "Re: Roadmap", unread: false, folder: "INBOX", body: "Thanks — sent the updated plan." },
  { id: "3", threadId: "t3", from: "dan@vendor.test", to: ["alice@acme.test"], date: Date.now() - 26 * 3600e3,
    subject: "Invoice question", unread: true, folder: "INBOX", body: "Please advise on invoice 42 before month end." },
  { id: "4", threadId: "t4", from: "news@list.test", to: ["alice@acme.test"], date: Date.now() - 5 * 3600e3,
    subject: "Weekly digest", unread: true, folder: "Promotions", body: "This week in tech…" },
];
const ICS = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:ev1", "SUMMARY:Contract review with Bob",
  `DTSTART:${new Date(Date.now() + 20 * 3600e3).toISOString().replace(/[-:]|\.\d+/g, "")}`,
  "ATTENDEE;CN=Bob:mailto:bob@partner.test", "LOCATION:Room 2", "END:VEVENT", "END:VCALENDAR"].join("\r\n");

(async () => {
  line("BrainOutput Community Edition — Work Twin demo");
  line("Everything below runs locally on imported mail. No account, no credentials, no model needed.");

  // 1 — create the twin. Mirror + dormant + nothing granted.
  let twin = createWorkTwin({ employee: { id: "alice", name: "Alice Martin", email: "alice@acme.test" } });
  twin = connectWorkSource(twin, { kind: "local-mail", account: "alice", resources: ["INBOX"] });  // Promotions NOT authorized
  const mail = await localMailSource({ account: "alice", messages: MAIL }).listMessages();
  twin = indexMessages(twin, mail.map((m) => ({ ...m, accountId: "local-mail:alice" })));
  const events = await localCalendarSource({ icsText: ICS }).listEvents();

  rule("1 · The twin starts read-only and dormant");
  line(`   ${twin.name} represents ${twin.employee.name} (${twin.employee.email})`);
  line(`   mode: ${twin.mode} · activation: ${twin.activation} · grants: ${twin.grants.length}`);
  line(`   authorized folders: ${twin.resources.join(", ")}  (Promotions is NOT authorized)`);
  line(`   indexed: ${twin.index.length} of ${MAIL.length} messages — only what you authorized`);

  rule("2 · Mirror mode — read, search, summarize");
  for (const p of prioritySummary(twin).slice(0, 3))
    line(`   • ${p.subject} — ${p.from}  [${p.reasons.join(", ") || "no signal"}]`);
  line("   unanswered:");
  for (const u of unansweredThreads(twin, { olderThanHours: 0 }))
    line(`   • ${u.subject} — ${u.from} (waiting ${u.waitingHours}h)`);
  line("   commitments and deadlines:");
  for (const c of extractCommitments(twin).slice(0, 3))
    line(`   • (${c.kind}) ${c.text}${c.deadline ? ` — due ${c.deadline}` : ""}  [${c.citation}]`);

  rule("3 · Meeting preparation (mail + calendar)");
  for (const b of meetingBrief(twin, events)) {
    line(`   ${b.event.title} — ${b.relatedMessages.length} related message(s), ${b.commitments.length} commitment(s), ${b.openRequests.length} open request(s)`);
    for (const r of b.relatedMessages) line(`      ↳ ${r.citation}`);
  }

  rule("4 · Mirror cannot draft — the mode is a ceiling");
  const refused = draftReply(twin, { messageRef: twin.index[0].ref });
  line(`   ${refused.reason}`);

  rule("5 · Copilot prepares a draft — attributed, never sent");
  twin = setMode(twin, "copilot");
  const d = draftReply(twin, { messageRef: twin.index[0].ref, body: "Confirmed: payment terms are net 30." });
  twin = withAudit(twin, d.audit);
  line(`   to: ${d.draft.to}`);
  line(`   subject: ${d.draft.subject}`);
  line(`   body: ${d.draft.body}`);
  line(`   ${d.draft.attribution.disclosure}`);
  line(`   sources: ${d.draft.sources.join(" | ")}`);

  rule("6 · Sending is guarded at every step");
  let s1 = sendDraft(twin, { draft: d.draft });
  line(`   copilot            → ${s1.ok ? "sent" : "refused: " + s1.reason}`);
  twin = setMode(twin, "delegate");
  let s2 = sendDraft(twin, { draft: d.draft });
  line(`   delegate, no grant → ${s2.ok ? "sent" : "refused: " + s2.reason}`);
  twin = grantTwinScope(twin, { scope: "communicate", action: "send-draft" });
  let s3 = sendDraft(twin, { draft: d.draft });
  line(`   granted, no approval → ${s3.ok ? "sent" : "held: " + s3.reason}`);
  const s4 = sendDraft(twin, { draft: d.draft, approval: { status: "approved", approvedBy: "alice" } });
  twin = withAudit(twin, s4.audit);
  line(`   granted + approved  → ${s4.ok ? "AUTHORIZED to send" : "refused"}`);

  rule("7 · Turning work into company work");
  const mission = emailToMission(twin, { messageRef: twin.index[0].ref, department: "legal-compliance",
    criteria: ["payment terms confirmed in writing"] });
  line(`   mission: ${mission.objective.slice(0, 64)}…`);
  line(`   department: ${mission.department} · graph: ${mission.graph.shape} (${mission.graph.nodes.join(" → ")})`);
  const packet = taskPacket(twin, { department: "technical", objective: "Assess the delivery commitment",
    facts: ["Partner asks to confirm payment terms by Friday"], sources: retrieveForRequest(twin, "payment terms", { k: 2 }),
    constraints: ["do not contact the partner"], permissions: ["read"] });
  line(`   delegation packet → ${packet.department}: ${packet.facts.length} fact(s), ${packet.sources.length} source(s)`);
  line(`   mailbox forwarded: ${packet.mailboxForwarded} · transcript forwarded: ${packet.transcriptForwarded}`);

  rule("8 · Audit — who did what, on whose behalf");
  for (const a of twin.audit)
    line(`   ${a.action.padEnd(12)} by ${a.workTwin.name} for ${a.representedEmployee.name} · permission=${a.permission} · approval=${a.approval} · sources=${a.sources.length}`);

  rule("9 · Dormancy — nothing polls");
  const idle = onConnectorEvent(twin, { type: "heartbeat" });
  line(`   heartbeat        → ${idle.woke ? "woke" : "ignored"} (${idle.reason})`);
  const woke = onConnectorEvent(twin, { type: "message.received", messages: [{ id: "9", from: "x@y.test", subject: "New", body: "hi", folder: "INBOX", accountId: "local-mail:alice" }] });
  line(`   message.received → ${woke.woke ? "woke and indexed" : "ignored"} (now ${woke.twin.index.length} messages)`);

  line("\n✓ Read-only by default · drafts always attributed · nothing sent without a grant AND approval.");
})();
