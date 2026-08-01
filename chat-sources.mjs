#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Workplace chat as a work source. Microsoft Teams first, because that is what most companies
// actually run — Slack is the loud default in tech, Microsoft 365 is the default everywhere else.
//
// Teams speaks Microsoft Graph, the same API this repo already uses for Outlook mail and
// OneDrive/SharePoint, so a tenant that authorizes one has authorized the transport for all three.
//
// STATUS: shapes are built against the CURRENT documented Graph v1.0 responses
// (learn.microsoft.com/graph/api/channel-list-messages, retrieved 2026-07-29) and unit-tested
// against those exact payloads — including the awkward ones the docs show and naive clients miss:
// a system message with `from: null`, and HTML bodies. It is NOT verified against a live tenant:
// that needs an Entra app registration, which is a founder credential. `verified: false` says so
// everywhere it surfaces.
//
// Normalizes to the same message shape as mail, so a Work Twin indexes Teams exactly like a
// mailbox: metadata plus a bounded snippet, never whole conversations.
import { normalizeMessage } from "./mail-sources.mjs";
import { request as httpsRequest } from "node:https";

const GRAPH = "graph.microsoft.com";

/** Graph caps $top at 50 for channel messages; asking for more is an error, not more data. */
export const GRAPH_PAGE_MAX = 50;

function graphJson({ host = GRAPH, path, token, method = "GET", body = null }) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = httpsRequest(
      { host, path, method, headers: {
        authorization: `Bearer ${token}`, accept: "application/json",
        ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
      } },
      (res) => {
        res.setEncoding("utf8");
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          let parsed = null;
          try { parsed = d ? JSON.parse(d) : {}; } catch { /* fall through to the raw body */ }
          if (res.statusCode >= 400) {
            // Surface Graph's own message. A silent empty result here would look like "no messages"
            // and quietly hide an expired token or a missing consent grant.
            const g = parsed?.error;
            return reject(new Error(`Microsoft Graph ${res.statusCode} ${g?.code || ""}: ${g?.message || d.slice(0, 200)}`.trim()));
          }
          resolve(parsed ?? {});
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Graph returns message bodies as `contentType: "html"` far more often than "text". Indexing raw
 * markup would poison retrieval with tag soup and inflate every snippet, so reduce to text.
 * Deliberately small and defensive rather than a parser: strip script/style with their contents
 * first, turn breaks into newlines, drop remaining tags, then decode the handful of entities Graph
 * actually emits.
 */
export function htmlToText(html) {
  if (!html) return "";
  return String(html)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, " ")
    // A block tag becomes a newline and the tag AFTER it becomes a space, so without this every
    // paragraph would start with a stray leading space in the index and in every snippet.
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * A Graph chatMessage → the shape the Work Twin already indexes.
 *
 * `from` is null on system event messages (team renamed, member added). The docs show it; a naive
 * `m.from.user.displayName` throws on the third message of the very first example response.
 */
export function normalizeTeamsMessage(m, { accountId, channel = "", teamName = "" } = {}) {
  const user = m.from?.user || null;
  const system = !user || m.messageType === "systemEventMessage" || !!m.eventDetail;
  const text = m.body?.contentType === "html" ? htmlToText(m.body?.content) : m.body?.content || "";
  return {
    ...normalizeMessage({
      id: m.id,
      // A reply belongs to its root message's thread; a root message is its own thread.
      threadId: m.replyToId || m.id,
      from: user?.displayName || user?.id || "(system)",
      to: (m.mentions || []).map((x) => x.mentioned?.user?.displayName).filter(Boolean),
      subject: m.subject || "",
      date: m.createdDateTime ? Date.parse(m.createdDateTime) : null,
      unread: true,
      attachments: (m.attachments || []).map((a) => a.name || a.id || "(attachment)"),
      body: text,
    }, { accountId, folder: channel }),
    channel,
    teamName,
    system,
    url: m.webUrl || null,
    mentions: (m.mentions || []).map((x) => x.mentioned?.user?.displayName).filter(Boolean),
  };
}

/**
 * Microsoft Teams via Graph. STATUS: NOT VERIFIED — needs an Entra app registration.
 *
 * Read-only by default, like every source here. Posting is a separate `communicate` scope the Work
 * Twin must be granted AND approved for; `sendMessage` refuses unless the caller passes an explicit
 * authorization, so a mis-scoped token can never turn a read connector into a poster.
 */
export function microsoftTeamsSource({ account, accessToken, fetchImpl = null, postImpl = null } = {}) {
  const accountId = `microsoft-teams:${account}`;
  const get = fetchImpl || ((path) => graphJson({ path, token: accessToken }));
  const post = postImpl || ((path, body) => graphJson({ path, token: accessToken, method: "POST", body }));
  const cap = (n) => Math.min(Math.max(1, Number(n) || 1), GRAPH_PAGE_MAX);

  return {
    kind: "microsoft-teams",
    accountId,
    verified: false,

    /** Teams the signed-in user belongs to. */
    async listTeams() {
      const r = await get(`/v1.0/me/joinedTeams`);
      return (r.value || []).map((t) => ({ id: t.id, name: t.displayName, description: t.description || "" }));
    },

    async listChannels(teamId) {
      const r = await get(`/v1.0/teams/${encodeURIComponent(teamId)}/channels`);
      return (r.value || []).map((c) => ({ id: c.id, name: c.displayName, description: c.description || "" }));
    },

    /**
     * Channel messages. `includeSystem` defaults false: "X added Y to the team" is noise in a
     * retrieval index and would crowd out real conversation in a capped result set.
     */
    async listMessages({ teamId, channelId, limit = 25, channel = "", teamName = "", includeSystem = false } = {}) {
      if (!teamId || !channelId) throw new Error("listMessages needs teamId and channelId");
      const r = await get(`/v1.0/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages?$top=${cap(limit)}`);
      const all = (r.value || []).map((m) => normalizeTeamsMessage(m, { accountId, channel, teamName }));
      return includeSystem ? all : all.filter((m) => !m.system);
    },

    /** Replies to one message — where the actual answer to a question usually lives. */
    async listReplies({ teamId, channelId, messageId, limit = 25, channel = "", teamName = "" } = {}) {
      const r = await get(`/v1.0/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/replies?$top=${cap(limit)}`);
      return (r.value || []).map((m) => normalizeTeamsMessage(m, { accountId, channel, teamName })).filter((m) => !m.system);
    },

    /** 1:1 and group chats. */
    async listChats({ limit = 20 } = {}) {
      const r = await get(`/v1.0/me/chats?$top=${cap(limit)}`);
      return (r.value || []).map((c) => ({ id: c.id, type: c.chatType, topic: c.topic || "", lastUpdated: c.lastUpdatedDateTime ? Date.parse(c.lastUpdatedDateTime) : null }));
    },

    async listChatMessages({ chatId, limit = 25 } = {}) {
      const r = await get(`/v1.0/chats/${encodeURIComponent(chatId)}/messages?$top=${cap(limit)}`);
      return (r.value || []).map((m) => normalizeTeamsMessage(m, { accountId, channel: `chat:${chatId}` })).filter((m) => !m.system);
    },

    /**
     * Post to a channel. Requires an explicit authorization object — the same shape the Work Twin's
     * guarded-send path produces after mode + grant + human approval. Without it this refuses, so
     * read access can never silently become write access.
     */
    async sendMessage({ teamId, channelId, text, authorization = null } = {}) {
      if (!authorization?.approved) throw new Error("posting to Teams needs an approved authorization (mode + communicate grant + human approval)");
      if (!teamId || !channelId || !text) throw new Error("sendMessage needs teamId, channelId and text");
      const r = await post(`/v1.0/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages`,
        { body: { contentType: "text", content: String(text) } });
      return { id: r.id || null, sentAt: r.createdDateTime ? Date.parse(r.createdDateTime) : null, url: r.webUrl || null };
    },

    async close() {},
  };
}

/**
 * The delegated Graph permissions each capability needs, so an admin sees exactly what they are
 * consenting to and why — and can grant read without ever granting post.
 */
export const TEAMS_SCOPES = {
  read: ["User.Read", "Team.ReadBasic.All", "Channel.ReadBasic.All", "ChannelMessage.Read.All", "Chat.Read"],
  communicate: ["ChannelMessage.Send", "ChatMessage.Send"],
};

/** One factory, matching connectMailSource/connectDriveSource. */
export function connectChatSource(spec = {}) {
  switch (spec.kind) {
    case "microsoft-teams": return microsoftTeamsSource(spec);
    default: throw new Error(`unknown chat source kind '${spec.kind}'`);
  }
}

/** What a user sees when choosing a workplace-chat source. */
export function chatSourceOptions() {
  return [
    { key: "microsoft-teams", label: "Microsoft Teams", detail: "Channels, replies and chats via Microsoft Graph", verified: false, needs: "your Microsoft Entra app registration" },
    { key: "slack", label: "Slack", detail: "Channels and threads", verified: false, needs: "your Slack app token" },
    { key: "discord", label: "Discord", detail: "Channels", verified: false, needs: "your Discord bot token" },
    { key: "mattermost", label: "Mattermost", detail: "Channels (self-hosted, open source)", verified: false, needs: "your Mattermost token" },
  ];
}
