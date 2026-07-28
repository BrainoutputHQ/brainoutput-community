// SPDX-License-Identifier: Apache-2.0
// BrainOutput Community Edition — drive / file work sources (2026-07-28).
//
// One abstraction over document storage, returning NORMALIZED files:
//   { id, name, path, mimeType, size, modified, accountId, folder, snippet }
// A Work Twin indexes file METADATA plus a bounded text snippet — never whole documents — so a drive
// never becomes model context. Only authorized folders are ever read.
//
// VERIFIED here: local folders, and the WebDAV client against a local PROPFIND responder (protocol +
// parsing). NOT VERIFIED: Google Drive, OneDrive and SharePoint need OAuth credentials this
// environment does not have — their request shapes are implemented and unit-tested against injected
// responses, and they declare `verified: false`.
import http from "node:http";
import https from "node:https";
import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join, extname, basename, relative } from "node:path";

// Text-ish files we can snippet; everything else is indexed by name/metadata only.
const TEXTY = new Set([".txt", ".md", ".markdown", ".csv", ".json", ".yaml", ".yml", ".log", ".html", ".xml", ".ics", ".tsv"]);
const MIME = { ".pdf": "application/pdf", ".md": "text/markdown", ".txt": "text/plain", ".csv": "text/csv",
  ".json": "application/json", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".png": "image/png", ".jpg": "image/jpeg" };

export function normalizeFile(raw, { accountId, folder = null } = {}) {
  return {
    id: String(raw.id ?? raw.path ?? raw.name),
    name: raw.name || basename(String(raw.path || "")),
    path: raw.path || raw.name || null,
    mimeType: raw.mimeType || MIME[extname(String(raw.name || raw.path || "")).toLowerCase()] || "application/octet-stream",
    size: raw.size ?? null,
    modified: raw.modified ?? null,
    accountId,
    folder: raw.folder ?? folder,
    snippet: String(raw.snippet || "").slice(0, 400),
    webUrl: raw.webUrl || null,
  };
}

// ── local folder (VERIFIED) ─────────────────────────────────────────────────────────────────────

/** A folder on this machine. Nothing leaves the device; only `roots` are ever read. */
export function localDriveSource({ account = "local", roots = [], maxDepth = 4, snippetChars = 400 } = {}) {
  const accountId = `drive:${account}`;
  const walk = (root, dir, depth, out) => {
    if (depth > maxDepth) return out;
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;                       // skip dotfiles
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(root, p, depth + 1, out); continue; }
      let st;
      try { st = statSync(p); } catch { continue; }
      let snippet = "";
      if (TEXTY.has(extname(e.name).toLowerCase()) && st.size <= 512 * 1024) {
        try { snippet = readFileSync(p, "utf8").slice(0, snippetChars); } catch {}
      }
      out.push(normalizeFile({ id: p, name: e.name, path: p, size: st.size, modified: st.mtimeMs,
        folder: relative(root, dir) || ".", snippet }, { accountId }));
    }
    return out;
  };
  return {
    kind: "drive", accountId, verified: true, roots,
    async listFiles({ limit = 200 } = {}) {
      const out = [];
      for (const r of roots) if (existsSync(r)) walk(r, r, 0, out);
      return out.sort((a, b) => (b.modified || 0) - (a.modified || 0)).slice(0, limit);
    },
    /** Read one authorized file — refuses anything outside the configured roots. */
    async readFile(path, { maxBytes = 200_000 } = {}) {
      const ok = roots.some((r) => {
        const rel = relative(r, path);
        return rel && !rel.startsWith("..") && !join(r, rel).startsWith("..");
      });
      if (!ok) throw new Error(`refused: '${path}' is outside the authorized folders`);
      return readFileSync(path, "utf8").slice(0, maxBytes);
    },
    async close() {},
  };
}

// ── WebDAV / Nextcloud (client VERIFIED against a PROPFIND responder) ───────────────────────────

function davRequest({ url, method = "PROPFIND", headers = {}, body = "", timeoutMs = 15000 }) {
  const u = new URL(url);
  const lib = u.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(u, { method, timeout: timeoutMs, headers: { "Content-Type": "application/xml", ...headers } },
      (res) => { let d = ""; res.on("data", (c) => (d += c));
        res.on("end", () => (res.statusCode < 400 ? resolve({ status: res.statusCode, body: d })
          : reject(new Error(`webdav ${method} ${res.statusCode}`)))); });
    req.on("error", reject); req.on("timeout", () => req.destroy(new Error("webdav: timeout")));
    if (body) req.write(body);
    req.end();
  });
}

/** Parse a PROPFIND multistatus body into normalized files (namespace-prefix agnostic). */
export function parsePropfind(xml, { accountId, base = "" } = {}) {
  const out = [];
  const responses = String(xml).split(/<[a-zA-Z0-9]*:?response[\s>]/i).slice(1);
  for (const r of responses) {
    const pick = (tag) => (r.match(new RegExp(`<[a-zA-Z0-9]*:?${tag}[^>]*>([\\s\\S]*?)</[a-zA-Z0-9]*:?${tag}>`, "i")) || [])[1]?.trim();
    const href = decodeURIComponent(pick("href") || "");
    if (!href) continue;
    const isCollection = /<[a-zA-Z0-9]*:?collection\s*\/?>/i.test(r);
    if (isCollection) continue;                                   // directories are not files
    const name = href.replace(/\/$/, "").split("/").pop();
    const len = pick("getcontentlength");
    const mod = pick("getlastmodified");
    out.push(normalizeFile({ id: href, name, path: href.replace(base, "") || href,
      mimeType: pick("getcontenttype") || undefined, size: len ? Number(len) : null,
      modified: mod ? Date.parse(mod) || null : null }, { accountId }));
  }
  return out;
}

/** Nextcloud / ownCloud / any WebDAV share. Credentials are the user's own (Basic auth or a token). */
export function webdavDriveSource({ account, baseUrl, user = null, password = null, folder = "/" } = {}) {
  const accountId = `drive:${account}`;
  const auth = user ? { Authorization: `Basic ${Buffer.from(`${user}:${password || ""}`).toString("base64")}` } : {};
  return {
    kind: "drive", accountId, verified: true, baseUrl,
    async listFiles({ limit = 200, path = folder, depth = 1 } = {}) {
      const url = new URL(path.replace(/^\//, ""), baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
      const { body } = await davRequest({ url, headers: { Depth: String(depth), ...auth },
        body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getcontentlength/><d:getlastmodified/><d:getcontenttype/><d:resourcetype/></d:prop></d:propfind>` });
      return parsePropfind(body, { accountId, base: new URL(baseUrl).pathname }).slice(0, limit);
    },
    async readFile(path, { maxBytes = 200_000 } = {}) {
      const url = new URL(String(path).replace(/^\//, ""), baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
      const { body } = await davRequest({ url, method: "GET", headers: auth });
      return body.slice(0, maxBytes);
    },
    async close() {},
  };
}

// ── Google Drive · OneDrive · SharePoint — NOT VERIFIED (need OAuth) ────────────────────────────

function apiJson({ host, path, token }) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host, path, method: "GET", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
      (res) => { let d = ""; res.on("data", (c) => (d += c));
        res.on("end", () => { try { const j = JSON.parse(d || "{}"); res.statusCode < 400 ? resolve(j) : reject(new Error(j.error?.message || `HTTP ${res.statusCode}`)); } catch (e) { reject(e); } }); });
    req.on("error", reject); req.end();
  });
}

/** Google Drive. STATUS: NOT VERIFIED — no OAuth credential in this environment. */
export function googleDriveSource({ account, accessToken, fetchImpl = null } = {}) {
  const accountId = `drive:google:${account}`;
  const call = fetchImpl || ((p) => apiJson({ host: "www.googleapis.com", path: p, token: accessToken }));
  return {
    kind: "drive", accountId, verified: false,
    async listFiles({ limit = 100, query = "" } = {}) {
      const q = encodeURIComponent(query ? `name contains '${query.replace(/'/g, "")}' and trashed=false` : "trashed=false");
      const r = await call(`/drive/v3/files?pageSize=${limit}&q=${q}&fields=files(id,name,mimeType,size,modifiedTime,webViewLink,parents)`);
      return (r.files || []).map((f) => normalizeFile({ id: f.id, name: f.name, path: f.name, mimeType: f.mimeType,
        size: f.size ? Number(f.size) : null, modified: f.modifiedTime ? Date.parse(f.modifiedTime) : null,
        webUrl: f.webViewLink }, { accountId }));
    },
    async close() {},
  };
}

/** OneDrive / SharePoint via Microsoft Graph. STATUS: NOT VERIFIED — needs OAuth. */
export function oneDriveSource({ account, accessToken, site = null, fetchImpl = null } = {}) {
  const accountId = `drive:${site ? "sharepoint" : "onedrive"}:${account}`;
  const call = fetchImpl || ((p) => apiJson({ host: "graph.microsoft.com", path: p, token: accessToken }));
  const root = site ? `/v1.0/sites/${site}/drive` : "/v1.0/me/drive";
  return {
    kind: "drive", accountId, verified: false,
    async listFiles({ limit = 100, path = "root" } = {}) {
      const r = await call(`${root}/${path}/children?$top=${limit}&$select=id,name,size,lastModifiedDateTime,file,webUrl,parentReference`);
      return (r.value || []).filter((f) => f.file).map((f) => normalizeFile({ id: f.id, name: f.name,
        path: `${f.parentReference?.path || ""}/${f.name}`, mimeType: f.file?.mimeType, size: f.size ?? null,
        modified: f.lastModifiedDateTime ? Date.parse(f.lastModifiedDateTime) : null, webUrl: f.webUrl }, { accountId }));
    },
    async close() {},
  };
}

export function connectDriveSource(spec = {}) {
  switch (spec.provider) {
    case "local": return localDriveSource(spec);
    case "webdav": case "nextcloud": return webdavDriveSource(spec);
    case "google-drive": return googleDriveSource(spec);
    case "onedrive": case "sharepoint": return oneDriveSource({ ...spec, site: spec.provider === "sharepoint" ? spec.site : null });
    default: throw new Error(`unknown drive provider '${spec.provider}'`);
  }
}

export function driveProviderOptions() {
  return [
    { key: "local", label: "A folder on this computer", verified: true },
    { key: "nextcloud", label: "Nextcloud / WebDAV", verified: true },
    { key: "google-drive", label: "Google Drive", verified: false, needs: "your Google OAuth credentials" },
    { key: "onedrive", label: "OneDrive", verified: false, needs: "your Microsoft OAuth credentials" },
    { key: "sharepoint", label: "SharePoint", verified: false, needs: "your Microsoft OAuth credentials" },
  ];
}
