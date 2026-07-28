// SPDX-License-Identifier: Apache-2.0
// BrainOutput Community Edition — read-only RAG / chat knowledge (item 6, 2026-07-28).
// Connect documents or chat sources as READ-ONLY knowledge: pick resources/channels, index them into a
// searchable, CITED store, control which departments/agents may read, configure retention, and keep a
// clear separation between READING, DRAFTING and SENDING. Reading a connected chat is allowed by
// default; writing/sending goes through the connector permission schema (grant + approval). Zero-dep.
import { newConnector, resolvePermission } from "./connectors.mjs";

const tokenize = (s) => (String(s).toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w.length > 2);

function splitChunks(text, max) {
  const paras = String(text).split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const out = [];
  for (const p of paras) {
    if (p.length <= max) { out.push(p); continue; }
    for (let i = 0; i < p.length; i += max) out.push(p.slice(i, i + max).trim());
  }
  return out.filter(Boolean);
}

/** Connect a document or chat source as READ-ONLY knowledge (item 6). Pure. */
export function connectRagSource({ id, kind = "file", connector, label, resources = [], channels = [], accessControl = {}, retentionDays = null } = {}) {
  const key = connector || (kind === "chat" ? "generic-chat" : "generic-rag");
  const conn = newConnector(key, { id: id ? `conn:${id}` : undefined, resources: [...resources, ...channels] });
  return {
    id: id || `rag:${key}`, kind, label: label || conn.label,
    connector: conn,                                     // read-only by default (no elevated grants)
    resources: kind === "chat" ? channels : resources,   // the SELECTED docs or channels
    accessControl: { departments: accessControl.departments || null, agents: accessControl.agents || null }, // null = all
    retentionDays,                                       // null = keep indefinitely
    chunks: [],
  };
}

/** Department/agent access control — may this agent read this source? */
export function canRead(source, agent = {}) {
  const ac = source.accessControl || {};
  if (ac.agents && ac.agents.length) return ac.agents.includes(agent.id);
  if (ac.departments && ac.departments.length) return ac.departments.includes(agent.department);
  return true;
}

/** Chunk + index documents/messages into a searchable, cited store. Deterministic (pass `now`). */
export function indexDocuments(source, docs = [], { now = null, maxChunkChars = 500 } = {}) {
  const chunks = [];
  for (const d of docs) {
    const pieces = splitChunks(d.text || "", maxChunkChars);
    pieces.forEach((piece, i) => {
      const locator = source.kind === "chat"
        ? `${d.channel || d.resource || "chat"}#${d.id}`
        : `${d.resource || d.id}${pieces.length > 1 ? " ¶" + (i + 1) : ""}`;
      chunks.push({ id: `${source.id}:${d.id}:${i}`, sourceId: source.id, resource: d.resource || d.channel || d.id,
        locator, text: piece, terms: tokenize(piece), indexedAt: now });
    });
  }
  return { ...source, chunks: [...source.chunks, ...chunks] };
}

/** Retention — a chunk is expired if older than the source's retentionDays. */
export function retentionExpired(chunk, source, now) {
  if (!source.retentionDays || chunk.indexedAt == null || now == null) return false;
  return now - chunk.indexedAt > source.retentionDays * 86400000;
}
export function pruneRetention(source, now) {
  return { ...source, chunks: (source.chunks || []).filter((c) => !retentionExpired(c, source, now)) };
}

function scoreChunk(terms, qterms) {
  const tf = {}; for (const t of terms) tf[t] = (tf[t] || 0) + 1;
  let s = 0; for (const q of qterms) if (tf[q]) s += 1 + Math.log(1 + tf[q]);
  return s;
}

/**
 * READ-only search across the sources this agent may read. Returns cited results, most relevant first;
 * every result carries its source + locator so answers can cite. Never mutates a source.
 */
export function searchRag(sources, query, { agent = {}, topK = 5, now = null } = {}) {
  const qterms = new Set(tokenize(query));
  const results = [];
  for (const source of sources) {
    if (!canRead(source, agent)) continue;
    for (const c of source.chunks || []) {
      if (retentionExpired(c, source, now)) continue;
      const score = scoreChunk(c.terms, qterms);
      if (score > 0) results.push({ text: c.text, source: source.label, resource: c.resource, locator: c.locator,
        citation: `${source.label} — ${c.locator}`, score: +score.toFixed(3) });
    }
  }
  return results.sort((a, b) => b.score - a.score).slice(0, topK);
}

/**
 * The read ≠ draft ≠ send separation. Reading/searching a connected source is allowed by default;
 * drafting a reply from it is allowed (nothing leaves); SENDING/replying goes through the connector's
 * `communicate` permission — an explicit grant + human approval (item 4). Pure — returns a decision.
 */
export function ragActionPlan(source, req = {}) {
  const intent = req.intent || "read";
  if (intent === "read" || intent === "search") {
    const ok = canRead(source, req.agent);
    return { intent, allowed: ok, scope: "read", requiresApproval: false,
      reason: ok ? "reading is allowed (read-only knowledge)" : "no read access for this agent/department" };
  }
  if (intent === "draft")
    return { intent, allowed: true, scope: "draft", requiresApproval: false, reason: "drafting a reply is allowed (not sent)" };
  // send / reply — the connector's communicate scope decides.
  const d = resolvePermission(source.connector, { action: "send-reply", agent: req.agent, channel: req.channel });
  return { intent, allowed: d.allowed, scope: "communicate", requiresApproval: d.requiresApproval, reason: d.reason };
}
