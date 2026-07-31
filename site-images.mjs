// SPDX-License-Identifier: Apache-2.0
// BrainOutput Community Edition — fetch images from a company/project website (2026-07-31).
// "The chat should know where to get the pics from": the company (or a project) has a URL;
// when a document mission needs images and none were uploaded, we fetch JPEGs from that
// site — bounded, public-http(s) only, never a private address (SSRF-closed), content-type
// and size checked. Stored beside the uploads so pdf.mjs can embed them.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1\]?|\[?fe80)/i;

export function imageLinks(html, baseUrl) {
  const out = [];
  const re = /<img[^>]+src=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 20) {
    try {
      const u = new URL(m[1], baseUrl);
      if (!/^https?:$/.test(u.protocol)) continue;
      if (PRIVATE_HOST.test(u.hostname)) continue;
      out.push(u.toString());
    } catch {}
  }
  return out;
}

/**
 * Download up to `limit` JPEGs from a website into `dir`, and return the page's own text too —
 * the images become embeddable, the text is what stops a document mission from inventing
 * facts about the business. Returns { images: [{ name, path, size }], pageText }.
 */
export async function fetchSiteImages(url, { dir, limit = 3, fetchImpl = fetch, maxBytes = 1_500_000 } = {}) {
  if (!url || !/^https?:\/\//i.test(url)) throw new Error("a website must be http(s)");
  const html = await (await fetchImpl(url, { signal: AbortSignal.timeout(10000) })).text();
  const pageText = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
  const links = imageLinks(html, url).filter((u) => /\.jpe?g($|\?)/i.test(u));
  const saved = [];
  for (const link of links.slice(0, limit * 2)) {
    if (saved.length >= limit) break;
    try {
      const r = await fetchImpl(link, { signal: AbortSignal.timeout(10000) });
      if (!r.ok || !/image\/jpe?g/i.test(r.headers.get("content-type") || "")) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length || buf.length > maxBytes) continue;
      const base = link.split("/").pop().split("?")[0].replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 50);
      const name = `${Date.now().toString(36)}-${base}`;
      writeFileSync(join(dir, name), buf, { mode: 0o600 });
      saved.push({ name, path: join(dir, name), size: buf.length });
    } catch {}
  }
  return { images: saved, pageText };
}

/** The first URL someone posted in a thread (latest first) — "the chat knows where to look". */
export function urlFromMessages(messages = []) {
  for (const m of [...messages].reverse()) {
    const hit = String(m.text || "").match(/(?:https?:\/\/|www\.)[^\s)>"']+/i);
    if (hit) return hit[0].startsWith("http") ? hit[0] : `https://${hit[0]}`;
  }
  return null;
}
