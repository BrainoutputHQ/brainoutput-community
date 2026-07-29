#!/usr/bin/env node --test
// SPDX-License-Identifier: Apache-2.0
//
// Teams source. Payloads below are the EXACT ones from the Graph v1.0 documentation for
// channel-list-messages (retrieved 2026-07-29), including the system message with `from: null`
// that the docs return in the very first example — the shape a naive client crashes on.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  microsoftTeamsSource, normalizeTeamsMessage, htmlToText,
  connectChatSource, chatSourceOptions, TEAMS_SCOPES, GRAPH_PAGE_MAX,
} from "./chat-sources.mjs";

// Verbatim from the documented example response.
const DOC_MESSAGES = {
  value: [
    {
      id: "1616965872395", replyToId: null, messageType: "message",
      createdDateTime: "2021-03-28T21:11:12.395Z", subject: null,
      webUrl: "https://teams.microsoft.com/l/message/19%3Aabc%40thread.tacv2/1616965872395",
      from: { application: null, device: null, user: { id: "8ea0e38b", displayName: "Robin Kline", userIdentityType: "aadUser" } },
      body: { contentType: "html", content: 'Hello World <at id="0">Jane Smith</at>' },
      attachments: [],
      mentions: [{ id: 0, mentionText: "Jane Smith", mentioned: { user: { id: "ef1c916a", displayName: "Jane Smith" } } }],
    },
    {
      // system event: `from` is NULL and the body is a marker element
      id: "1616883610266", replyToId: null, messageType: "systemEventMessage",
      createdDateTime: "2021-03-28T03:50:10.266Z", subject: null, from: null,
      body: { contentType: "html", content: "<systemEventMessage/>" },
      attachments: [], mentions: [],
      eventDetail: { "@odata.type": "#microsoft.graph.teamDescriptionUpdatedEventMessageDetail" },
    },
  ],
};

test("htmlToText survives the bodies Graph actually sends", () => {
  assert.equal(htmlToText('Hello World <at id="0">Jane Smith</at>'), "Hello World Jane Smith");
  assert.equal(htmlToText("<div><p>One</p><p>Two</p></div>"), "One\nTwo");
  assert.equal(htmlToText("a &amp; b &lt;c&gt; &quot;d&quot;&nbsp;e"), 'a & b <c> "d" e');
  // script/style content must not leak into the index as text
  assert.equal(htmlToText("<style>.x{color:red}</style>Visible"), "Visible");
  assert.equal(htmlToText("<script>alert(1)</script>Visible"), "Visible");
  assert.equal(htmlToText(null), "");
  assert.equal(htmlToText(""), "");
});

test("a system message with from:null normalizes instead of throwing", () => {
  const sys = DOC_MESSAGES.value[1];
  const m = normalizeTeamsMessage(sys, { accountId: "microsoft-teams:acme", channel: "General" });
  assert.equal(m.system, true);
  assert.equal(m.from, "(system)");
  assert.equal(m.id, "1616883610266");
});

test("a real message keeps sender, mentions, thread and link", () => {
  const m = normalizeTeamsMessage(DOC_MESSAGES.value[0], { accountId: "microsoft-teams:acme", channel: "General", teamName: "Sales" });
  assert.equal(m.from, "Robin Kline");
  assert.equal(m.body, "Hello World Jane Smith");        // html reduced to text
  assert.deepEqual(m.mentions, ["Jane Smith"]);
  assert.equal(m.threadId, "1616965872395");             // a root message is its own thread
  assert.equal(m.channel, "General");
  assert.equal(m.teamName, "Sales");
  assert.equal(m.system, false);
  assert.match(m.url, /teams\.microsoft\.com/);
});

test("a reply is threaded onto its root, so a Q and its answer stay together", () => {
  const reply = { id: "1616989753153", replyToId: "1616963377068", messageType: "message",
    createdDateTime: "2021-03-29T03:49:13.153Z", from: { user: { displayName: "Robin Kline" } },
    body: { contentType: "text", content: "Reply3" }, attachments: [], mentions: [] };
  const m = normalizeTeamsMessage(reply, { accountId: "a" });
  assert.equal(m.threadId, "1616963377068");
  assert.equal(m.body, "Reply3");
});

test("listMessages drops system noise by default and can include it on request", async () => {
  const src = microsoftTeamsSource({ account: "acme", accessToken: "t", fetchImpl: async () => DOC_MESSAGES });
  const clean = await src.listMessages({ teamId: "T", channelId: "C", channel: "General" });
  assert.equal(clean.length, 1);
  assert.equal(clean[0].from, "Robin Kline");
  const all = await src.listMessages({ teamId: "T", channelId: "C", includeSystem: true });
  assert.equal(all.length, 2);
});

test("$top is clamped to Graph's documented maximum", async () => {
  const seen = [];
  const src = microsoftTeamsSource({ account: "a", accessToken: "t", fetchImpl: async (p) => { seen.push(p); return { value: [] }; } });
  await src.listMessages({ teamId: "T", channelId: "C", limit: 5000 });
  await src.listMessages({ teamId: "T", channelId: "C", limit: 0 });
  assert.match(seen[0], new RegExp(`\\$top=${GRAPH_PAGE_MAX}$`));   // not 5000 — Graph would 400
  assert.match(seen[1], /\$top=1$/);
});

test("listMessages refuses without both ids rather than calling a malformed path", async () => {
  const src = microsoftTeamsSource({ account: "a", accessToken: "t", fetchImpl: async () => ({ value: [] }) });
  await assert.rejects(() => src.listMessages({ teamId: "T" }), /teamId and channelId/);
});

test("posting REFUSES without an approved authorization — read never becomes write", async () => {
  let posted = false;
  const src = microsoftTeamsSource({ account: "a", accessToken: "t", postImpl: async () => { posted = true; return { id: "1" }; } });
  await assert.rejects(() => src.sendMessage({ teamId: "T", channelId: "C", text: "hi" }), /approved authorization/);
  await assert.rejects(() => src.sendMessage({ teamId: "T", channelId: "C", text: "hi", authorization: { approved: false } }), /approved authorization/);
  assert.equal(posted, false, "nothing may reach Graph without approval");
  const ok = await src.sendMessage({ teamId: "T", channelId: "C", text: "hi", authorization: { approved: true } });
  assert.equal(posted, true);
  assert.equal(ok.id, "1");
});

test("read scopes never include the ability to post", () => {
  for (const s of TEAMS_SCOPES.read) assert.doesNotMatch(s, /Send|ReadWrite/);
  assert.ok(TEAMS_SCOPES.communicate.includes("ChannelMessage.Send"));
  // the two sets must be disjoint, so granting read cannot smuggle in communicate
  assert.equal(TEAMS_SCOPES.read.filter((s) => TEAMS_SCOPES.communicate.includes(s)).length, 0);
});

test("teams and channels list through the documented shapes", async () => {
  const src = microsoftTeamsSource({ account: "a", accessToken: "t", fetchImpl: async (p) =>
    p.includes("joinedTeams") ? { value: [{ id: "T1", displayName: "Sales", description: "d" }] }
                              : { value: [{ id: "C1", displayName: "General" }] } });
  assert.deepEqual(await src.listTeams(), [{ id: "T1", name: "Sales", description: "d" }]);
  assert.deepEqual(await src.listChannels("T1"), [{ id: "C1", name: "General", description: "" }]);
});

test("a Graph error is a FAILURE, never a silent empty result", async () => {
  const src = microsoftTeamsSource({ account: "a", accessToken: "t",
    fetchImpl: async () => { throw new Error("Microsoft Graph 403 Forbidden: insufficient privileges"); } });
  await assert.rejects(() => src.listMessages({ teamId: "T", channelId: "C" }), /403|privileges/);
});

test("the source declares itself unverified — no live tenant has confirmed it", () => {
  const src = microsoftTeamsSource({ account: "a", accessToken: "t" });
  assert.equal(src.verified, false);
  assert.equal(src.kind, "microsoft-teams");
  assert.equal(connectChatSource({ kind: "microsoft-teams", account: "a", accessToken: "t" }).kind, "microsoft-teams");
  assert.throws(() => connectChatSource({ kind: "nope" }), /unknown chat source/);
  const teams = chatSourceOptions().find((o) => o.key === "microsoft-teams");
  assert.equal(teams.verified, false);
  assert.match(teams.needs, /Entra/);
});
