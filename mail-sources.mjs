// SPDX-License-Identifier: Apache-2.0
// BrainOutput Community Edition — Work Twin work sources (2026-07-28).
//
// One connection abstraction over every workplace source. Each source returns NORMALIZED messages:
//   { id, threadId, accountId, from, to, subject, date, unread, folder, labels, attachments, body }
// and optionally events (calendar). Nothing here holds a mailbox in memory beyond the requested page:
// the Work Twin indexes headers + a snippet and retrieves only what a request needs.
//
// VERIFIED here: local mail (mbox · Maildir · JSON import) and IMAP/SMTP (tested against a real IMAP
// server). NOT VERIFIED here: Google Workspace/Gmail and Microsoft 365/Outlook — they need OAuth
// credentials this environment does not have. Their request shapes are implemented against the public
// REST APIs and marked `verified: false`; treat them as unproven until run against a real account.
import net from "node:net";
import tls from "node:tls";
import https from "node:https";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

// ── normalization ───────────────────────────────────────────────────────────────────────────────

const addr = (v) => (Array.isArray(v) ? v : String(v || "").split(",")).map((s) => String(s).trim()).filter(Boolean);
const emailOf = (s) => (String(s || "").match(/[^<>\s,]+@[^<>\s,]+/) || [String(s || "").trim()])[0];

export function normalizeMessage(raw, { accountId, folder = "INBOX" } = {}) {
  return {
    id: String(raw.id),
    threadId: raw.threadId || raw.references || raw.inReplyTo || String(raw.id),
    accountId,
    from: emailOf(raw.from),
    to: addr(raw.to).map(emailOf),
    subject: raw.subject || "",
    date: raw.date ?? null,
    unread: raw.unread !== undefined ? !!raw.unread : true,
    folder: raw.folder || folder,
    labels: raw.labels || [],
    attachments: raw.attachments || [],
    body: raw.body || raw.snippet || "",
  };
}

/** Parse RFC-822 headers + body from a raw message (used by mbox, Maildir and IMAP). */
export function parseRfc822(rawText, { id, folder = "INBOX" } = {}) {
  const text = String(rawText).replace(/\r\n/g, "\n");
  const split = text.indexOf("\n\n");
  const head = split >= 0 ? text.slice(0, split) : text;
  const body = split >= 0 ? text.slice(split + 2) : "";
  const unfolded = head.replace(/\n[ \t]+/g, " ");
  const h = {};
  for (const line of unfolded.split("\n")) {
    const m = line.match(/^([A-Za-z-]+):\s*(.*)$/);
    if (m) h[m[1].toLowerCase()] = m[2];
  }
  const attachments = [...text.matchAll(/name="?([^"\n;]+\.[A-Za-z0-9]{1,5})"?/g)].map((m) => m[1]);
  return normalizeMessage({
    id: id || h["message-id"] || `${h.subject || "msg"}-${h.date || ""}`,
    threadId: h["in-reply-to"] || (h.references || "").split(/\s+/).filter(Boolean)[0] || h["message-id"] || id,
    from: h.from, to: h.to, subject: h.subject,
    date: h.date ? Date.parse(h.date) || null : null,
    body: body.trim(), attachments: [...new Set(attachments)], folder,
  }, { accountId: null, folder });
}

// ── local mail: mbox · Maildir · JSON import (VERIFIED) ─────────────────────────────────────────

export function parseMbox(content, { folder = "INBOX" } = {}) {
  const parts = String(content).split(/^From .*$/m).map((s) => s.trim()).filter(Boolean);
  return parts.map((p, i) => parseRfc822(p, { id: `mbox-${i + 1}`, folder }));
}

export function readMaildir(dir, { folder = "INBOX" } = {}) {
  const out = [];
  for (const sub of ["cur", "new"]) {
    const d = join(dir, sub);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (!statSync(p).isFile()) continue;
      const msg = parseRfc822(readFileSync(p, "utf8"), { id: f, folder });
      out.push({ ...msg, unread: sub === "new" || !/:2,.*S/.test(f) });   // Maildir 'S' flag = seen
    }
  }
  return out;
}

/**
 * A local / imported mail source: a Maildir directory, an mbox file, or an array of messages
 * (JSON import). Fully local — nothing leaves the machine.
 */
export function localMailSource({ account = "local", dir = null, mbox = null, messages = null, folder = "INBOX" } = {}) {
  const accountId = `local-mail:${account}`;
  return {
    kind: "local-mail", accountId, verified: true,
    async listMessages({ limit = 100 } = {}) {
      let list = [];
      if (messages) list = messages.map((m, i) => normalizeMessage({ id: m.id || `import-${i + 1}`, ...m }, { accountId, folder }));
      else if (mbox) list = parseMbox(readFileSync(mbox, "utf8"), { folder });
      else if (dir) list = readMaildir(dir, { folder });
      return list.map((m) => ({ ...m, accountId })).slice(0, limit);
    },
    async listEvents() { return []; },
    async close() {},
  };
}

// ── IMAP / SMTP (VERIFIED against a real IMAP server) ───────────────────────────────────────────

function makeReader(sock) {
  let buf = Buffer.alloc(0), waiter = null;
  const check = () => { if (waiter && waiter.pred()) { const w = waiter; waiter = null; w.resolve(); } };
  sock.on("data", (d) => { buf = Buffer.concat([buf, d]); check(); });
  return {
    get buffer() { return buf; },
    consume(n) { const out = buf.subarray(0, n); buf = buf.subarray(n); return out; },
    wait(pred, timeoutMs = 15000) {
      return new Promise((resolve, reject) => {
        waiter = { pred, resolve };
        check();
        setTimeout(() => { if (waiter) { waiter = null; reject(new Error("imap: timeout")); } }, timeoutMs).unref?.();
      });
    },
  };
}

/**
 * Read a complete tagged IMAP response as a BUFFER, honouring {N} literals. Bytes matter: a literal
 * length is counted in bytes, so parsing on a decoded string would corrupt any non-ASCII subject.
 */
async function readTagged(reader, tag) {
  const chunks = [];
  for (;;) {
    await reader.wait(() => reader.buffer.includes("\r\n"));
    const idx = reader.buffer.indexOf("\r\n");
    const lineBuf = reader.consume(idx + 2);
    chunks.push(lineBuf);
    const line = lineBuf.toString("utf8");
    const lit = line.match(/\{(\d+)\}\r\n$/);
    if (lit) {
      const n = Number(lit[1]);
      await reader.wait(() => reader.buffer.length >= n);
      chunks.push(reader.consume(n));
      continue;                                   // the remainder of the line follows
    }
    if (line.startsWith(`${tag} `)) return Buffer.concat(chunks);
  }
}

/** Extract the first {N} literal from a response buffer, byte-exactly. */
function firstLiteral(buf) {
  const m = buf.toString("latin1").match(/\{(\d+)\}\r\n/);
  if (!m) return "";
  const start = m.index + m[0].length;
  return buf.subarray(start, start + Number(m[1])).toString("utf8");
}

/** Decode RFC-2047 encoded-words (=?UTF-8?B?..?=) so subjects survive transport. */
function decodeWords(s) {
  return String(s).replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_, cs, enc, txt) => {
    try {
      if (/^b$/i.test(enc)) return Buffer.from(txt, "base64").toString("utf8");
      return txt.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
    } catch { return txt; }
  });
}

/**
 * A minimal, real IMAP client: LOGIN → SELECT → SEARCH → FETCH(headers + snippet). It fetches only
 * headers and a bounded slice of the body — never whole mailboxes.
 */
export function imapSource({ account, host, port = 993, user, password, tls: useTls = true, folder = "INBOX", timeoutMs = 15000 } = {}) {
  const accountId = `imap:${account || user}`;
  let sock = null, reader = null, seq = 0;
  const tagFor = () => `a${++seq}`;

  async function connect() {
    if (sock) return;
    sock = await new Promise((resolve, reject) => {
      const s = useTls
        ? tls.connect({ host, port, servername: host, rejectUnauthorized: false }, () => resolve(s))
        : net.connect({ host, port }, () => resolve(s));
      s.setTimeout(timeoutMs);
      s.on("error", reject);
    });
    reader = makeReader(sock);
    await reader.wait(() => reader.buffer.includes("\r\n"));      // server greeting
    reader.consume(reader.buffer.indexOf("\r\n") + 2);
    const t = tagFor();
    sock.write(`${t} LOGIN "${user}" "${password}"\r\n`);
    const r = (await readTagged(reader, t)).toString("utf8");
    if (!/\sOK/i.test(r.split("\r\n").filter(Boolean).pop() || "")) throw new Error(`imap: login failed — ${r.trim().split("\r\n").pop()}`);
  }

  async function cmd(command) { const t = tagFor(); sock.write(`${t} ${command}\r\n`); return readTagged(reader, t); }
  const asText = async (command) => (await cmd(command)).toString("utf8");

  return {
    kind: "imap", accountId, verified: true,
    async listMessages({ limit = 50, mailbox = folder, snippetBytes = 400 } = {}) {
      await connect();
      await cmd(`SELECT "${mailbox}"`);
      const search = await asText("SEARCH ALL");
      const ids = (search.match(/^\* SEARCH([\d ]*)/m)?.[1] || "").trim().split(/\s+/).filter(Boolean);
      if (!ids.length) return [];
      const unseen = new Set(((await asText("SEARCH UNSEEN")).match(/^\* SEARCH([\d ]*)/m)?.[1] || "").trim().split(/\s+/).filter(Boolean));
      const wanted = ids.slice(-limit);
      const out = [];
      for (const n of wanted) {
        // One section per command: each response then contains exactly ONE literal, which is
        // unambiguous to extract. Only headers plus a bounded body slice are ever fetched.
        const header = firstLiteral(await cmd(`FETCH ${n} (BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES)])`));
        const body = firstLiteral(await cmd(`FETCH ${n} (BODY.PEEK[TEXT]<0.${snippetBytes}>)`));
        const msg = parseRfc822(`${decodeWords(header)}\n\n${body}`, { id: `${accountId}-${n}`, folder: mailbox });
        out.push({ ...msg, accountId, unread: unseen.has(n) });
      }
      return out;
    },
    async listEvents() { return []; },
    async close() { try { if (sock) { await cmd("LOGOUT").catch(() => {}); sock.end(); } } finally { sock = null; reader = null; } },
  };
}

/**
 * SMTP send — the guarded action. It performs no permission logic itself: the Work Twin decides
 * (delegate mode + explicit grant + approval) and only then calls this.
 */
export function smtpSend({ host, port = 587, user = null, password = null, secure = false, timeoutMs = 15000 } = {}) {
  return async function send({ from, to, subject, body, headers = {} }) {
    const sock = await new Promise((resolve, reject) => {
      const s = secure ? tls.connect({ host, port, rejectUnauthorized: false }, () => resolve(s)) : net.connect({ host, port }, () => resolve(s));
      s.setTimeout(timeoutMs); s.on("error", reject);
    });
    const reader = makeReader(sock);
    const expect = async (code) => {
      await reader.wait(() => /\r\n$/.test(reader.buffer.toString("utf8")) && reader.buffer.length > 0);
      const text = reader.consume(reader.buffer.length).toString("utf8");
      if (!new RegExp(`^${code}`, "m").test(text)) throw new Error(`smtp: expected ${code}, got ${text.trim().slice(0, 120)}`);
      return text;
    };
    const say = async (line, code) => { sock.write(`${line}\r\n`); return expect(code); };
    try {
      await expect("220");
      await say(`EHLO brainoutput`, "250");
      if (user) { await say("AUTH LOGIN", "334"); await say(Buffer.from(user).toString("base64"), "334"); await say(Buffer.from(password || "").toString("base64"), "235"); }
      await say(`MAIL FROM:<${from}>`, "250");
      for (const rcpt of addr(to)) await say(`RCPT TO:<${emailOf(rcpt)}>`, "250");
      await say("DATA", "354");
      const hdrs = { From: from, To: addr(to).join(", "),
        Subject: /[^\x00-\x7F]/.test(subject || "") ? `=?UTF-8?B?${Buffer.from(subject).toString("base64")}?=` : (subject || ""),
        "MIME-Version": "1.0", "Content-Type": "text/plain; charset=UTF-8", ...headers };
      const payload = Object.entries(hdrs).map(([k, v]) => `${k}: ${v}`).join("\r\n") + `\r\n\r\n${String(body).replace(/^\./gm, "..")}\r\n.`;
      await say(payload, "250");
      await say("QUIT", "221").catch(() => {});
      return { sent: true };
    } finally { sock.end(); }
  };
}

// ── Google Workspace / Gmail — NOT VERIFIED (needs OAuth) ───────────────────────────────────────

function httpsJson({ host, path, token, method = "GET" }) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host, path, method, headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
      (res) => { let d = ""; res.on("data", (c) => (d += c));
        res.on("end", () => { try { const j = JSON.parse(d || "{}"); res.statusCode < 400 ? resolve(j) : reject(new Error(j.error?.message || `HTTP ${res.statusCode}`)); } catch (e) { reject(e); } }); });
    req.on("error", reject); req.end();
  });
}

/**
 * Gmail via the Google API. STATUS: NOT VERIFIED — no OAuth credential in this environment; the
 * request shapes follow users.messages.list/get but have never been executed here.
 */
export function googleWorkspaceSource({ account, accessToken, fetchImpl = null } = {}) {
  const accountId = `google-workspace:${account}`;
  const call = fetchImpl || ((path) => httpsJson({ host: "gmail.googleapis.com", path, token: accessToken }));
  return {
    kind: "google-workspace", accountId, verified: false,
    async listMessages({ limit = 25, query = "", labelIds = ["INBOX"] } = {}) {
      const list = await call(`/gmail/v1/users/me/messages?maxResults=${limit}&q=${encodeURIComponent(query)}&labelIds=${labelIds.join("&labelIds=")}`);
      const out = [];
      for (const m of list.messages || []) {
        const full = await call(`/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`);
        const h = Object.fromEntries((full.payload?.headers || []).map((x) => [x.name.toLowerCase(), x.value]));
        out.push(normalizeMessage({ id: m.id, threadId: full.threadId, from: h.from, to: h.to, subject: h.subject,
          date: h.date ? Date.parse(h.date) : Number(full.internalDate) || null,
          unread: (full.labelIds || []).includes("UNREAD"), labels: full.labelIds || [], body: full.snippet || "" },
          { accountId, folder: "INBOX" }));
      }
      return out;
    },
    async listEvents({ limit = 10 } = {}) {
      const r = await (fetchImpl || ((p) => httpsJson({ host: "www.googleapis.com", path: p, token: accessToken })))(`/calendar/v3/calendars/primary/events?maxResults=${limit}&singleEvents=true&orderBy=startTime`);
      return (r.items || []).map((e) => ({ id: e.id, title: e.summary, start: Date.parse(e.start?.dateTime || e.start?.date || 0) || null,
        attendees: (e.attendees || []).map((a) => a.email), location: e.location || null }));
    },
    async close() {},
  };
}

/**
 * Microsoft 365 / Outlook via Microsoft Graph. STATUS: NOT VERIFIED — no OAuth credential here.
 */
export function microsoft365Source({ account, accessToken, fetchImpl = null } = {}) {
  const accountId = `microsoft-365:${account}`;
  const call = fetchImpl || ((path) => httpsJson({ host: "graph.microsoft.com", path, token: accessToken }));
  return {
    kind: "microsoft-365", accountId, verified: false,
    async listMessages({ limit = 25, folder = "Inbox" } = {}) {
      const r = await call(`/v1.0/me/mailFolders/${folder}/messages?$top=${limit}&$select=id,conversationId,from,toRecipients,subject,receivedDateTime,isRead,hasAttachments,bodyPreview`);
      return (r.value || []).map((m) => normalizeMessage({
        id: m.id, threadId: m.conversationId, from: m.from?.emailAddress?.address,
        to: (m.toRecipients || []).map((t) => t.emailAddress?.address), subject: m.subject,
        date: m.receivedDateTime ? Date.parse(m.receivedDateTime) : null, unread: !m.isRead,
        attachments: m.hasAttachments ? ["(attachment)"] : [], body: m.bodyPreview || "",
      }, { accountId, folder }));
    },
    async listEvents({ limit = 10 } = {}) {
      const r = await call(`/v1.0/me/events?$top=${limit}&$select=id,subject,start,attendees,location`);
      return (r.value || []).map((e) => ({ id: e.id, title: e.subject, start: e.start?.dateTime ? Date.parse(e.start.dateTime) : null,
        attendees: (e.attendees || []).map((a) => a.emailAddress?.address), location: e.location?.displayName || null }));
    },
    async close() {},
  };
}

/** One factory for every work source. */
export function connectMailSource(spec = {}) {
  switch (spec.kind) {
    case "local-mail": return localMailSource(spec);
    case "imap": return imapSource(spec);
    case "google-workspace": return googleWorkspaceSource(spec);
    case "microsoft-365": return microsoft365Source(spec);
    default: throw new Error(`unknown work source kind '${spec.kind}'`);
  }
}

/** What a user sees when choosing how to connect their work (onboarding). */
export function workSourceOptions() {
  return [
    { key: "google-workspace", label: "Continue with Google", detail: "Gmail + Calendar (OAuth)", verified: false },
    { key: "microsoft-365", label: "Continue with Microsoft", detail: "Outlook + Calendar (OAuth)", verified: false },
    { key: "imap", label: "Connect another email server", detail: "IMAP/SMTP, including self-hosted", verified: true },
    { key: "local-mail", label: "Use local / imported email", detail: "Maildir, mbox or a JSON export — never leaves your machine", verified: true },
    { key: "skip", label: "Skip for now", detail: "You can connect your work later", verified: true },
  ];
}
