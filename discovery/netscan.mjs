#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Authorized local-network discovery.
//
// Every probe passes through checkAllowed() from scope.mjs — this module has no opinion of its
// own about what may be touched. All network I/O is injected (`connect`, `resolveHostname`),
// which keeps the safety property testable: a refused target can be *proven* to never reach
// the network, because the network is a function the test hands in.
import { checkAllowed, parseCidr, cidrContains, APPROVED_PORTS, PORT_PRIORITY } from "./scope.mjs";

// ── OUI table ─────────────────────────────────────────────────────────────────────────────────
// Small, deliberate, best-effort. Unknown -> null. A wrong vendor is worse than no vendor.
const OUI = {
  "0019bb": "HP",             "3c5282": "HP",             "a01d48": "HP",
  "001e8f": "Canon",          "f48139": "Canon",
  "008077": "Brother",        "30055c": "Brother",
  "000048": "Epson",          "0026ab": "Epson",
  "0000aa": "Xerox",          "080037": "Xerox",
  "000074": "Ricoh",          "002673": "Ricoh",
  "00173c": "Kyocera",
  "000400": "Lexmark",
  "00206b": "Konica Minolta",
  "001b54": "Cisco",          "000c41": "Cisco",
  "245a4c": "Ubiquiti",       "dc9fdb": "Ubiquiti",       "0418d6": "Ubiquiti",
  "000b86": "Aruba",          "d8c7c8": "Aruba",
  "000585": "Juniper",        "0010db": "Juniper",
  "001f33": "Netgear",        "a00460": "Netgear",
  "50c7bf": "TP-Link",        "f4f26d": "TP-Link",
  "001b63": "Apple",          "3c15c2": "Apple",          "a4b197": "Apple",
  "001422": "Dell",           "b82a72": "Dell",           "549f35": "Dell",
  "0013e8": "Intel",          "3cfdfe": "Intel",          "aced5c": "Intel",
  "6c0b84": "Lenovo",
  "0003ff": "Microsoft",      "7c1e52": "Microsoft",
  "0012fb": "Samsung",
  "b827eb": "Raspberry Pi",   "dca632": "Raspberry Pi",   "e45f01": "Raspberry Pi",
  "000c29": "VMware",         "005056": "VMware",
  "001132": "Synology",
  "00089b": "QNAP",           "245ebe": "QNAP",
};

const normalizeMac = (mac) => String(mac ?? "").toLowerCase().replace(/[^0-9a-f]/g, "");

/** Best-effort OUI vendor lookup. Returns null when the prefix is not in the table — never a guess. */
export function vendorFromMac(mac) {
  const hex = normalizeMac(mac);
  if (hex.length < 6) return null;
  return OUI[hex.slice(0, 6)] ?? null;
}

// ── device typing ─────────────────────────────────────────────────────────────────────────────

const PRINTER_VENDORS = new Set(["HP", "Canon", "Brother", "Epson", "Xerox", "Ricoh", "Kyocera", "Lexmark", "Konica Minolta"]);
const NETWORK_VENDORS = new Set(["Cisco", "Ubiquiti", "Aruba", "Juniper", "Netgear", "TP-Link"]);

/**
 * Conservative classification. "unknown" is a correct answer; a wrong label is not.
 * Returns { type, confidence } with confidence in 0..1.
 */
export function deviceType({ ports = [], vendor = null, hostname = null } = {}) {
  const p = new Set(ports);
  const host = String(hostname ?? "").toLowerCase();

  const printPorts = [631, 515, 9100].filter((x) => p.has(x)).length;
  if (printPorts > 0) {
    let conf = 0.55 + 0.1 * (printPorts - 1);
    if (vendor && PRINTER_VENDORS.has(vendor)) conf += 0.25;
    if (/print|prn|laser|inkjet|mfp|copier/.test(host)) conf += 0.1;
    return { type: "printer", confidence: Math.min(conf, 0.95) };
  }
  if (vendor && PRINTER_VENDORS.has(vendor) && (p.has(80) || p.has(443)))
    return { type: "printer", confidence: 0.5 };

  if (/(^|[^a-z])(router|gateway|gw|rt-\d|firewall)([^a-z]|$)/.test(host)) return { type: "router", confidence: 0.65 };
  if (/(^|[^a-z])(switch|sw-\d)([^a-z]|$)/.test(host)) return { type: "switch", confidence: 0.65 };
  if (p.has(53) && p.size <= 3) return { type: "router", confidence: 0.45 };
  if (vendor && NETWORK_VENDORS.has(vendor) && p.size <= 4) return { type: "switch", confidence: 0.35 };

  if (/(^|[^a-z])(srv|server|dc\d|db|nas)([^a-z]|$)/.test(host)) return { type: "server", confidence: 0.6 };
  if (p.has(22) && (p.has(80) || p.has(443) || p.size >= 3)) return { type: "server", confidence: 0.45 };
  if (/(^|[^a-z])(desktop|laptop|pc-\d|wks)([^a-z]|$)/.test(host)) return { type: "workstation", confidence: 0.55 };
  if ((p.has(3389) || p.has(445) || p.has(139)) && !p.has(22)) return { type: "workstation", confidence: 0.4 };

  return { type: "unknown", confidence: 0 };
}

// ── sweep ─────────────────────────────────────────────────────────────────────────────────────

const intToV4 = (n) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join(".");

const sleep = (ms, signal) => new Promise((res, rej) => {
  if (signal?.aborted) return rej(Object.assign(new Error("aborted"), { aborted: true }));
  const t = setTimeout(() => { cleanup(); res(); }, ms);
  const onAbort = () => { cleanup(); rej(Object.assign(new Error("aborted"), { aborted: true })); };
  const cleanup = () => { clearTimeout(t); signal?.removeEventListener("abort", onAbort); };
  signal?.addEventListener("abort", onAbort, { once: true });
});

/**
 * Authorized sweep. `connect` is injected: async ({host, port, timeoutMs}) => boolean.
 * checkAllowed() is consulted before EVERY probe; a denial is recorded in `refused`, never
 * silently skipped. IPv6 ranges are never enumerated — only explicitly named hosts and ARP
 * neighbours are probed.
 */
export async function sweep({
  approval, cidrs = [], connect, resolveHostname = null, arpTable = [],
  now = Date.now(), signal = null, ports = null,
} = {}) {
  if (typeof connect !== "function") throw new Error("sweep requires an injected `connect` — this module never opens sockets itself");
  const clock = () => (typeof now === "function" ? now() : now);
  const limits = approval?.limits ?? { concurrency: 4, perHostDelayMs: 120, timeoutMs: 1500, maxHosts: 256, portsPerHost: 8 };

  const observations = [];
  const refused = [];
  const hosts = new Map();
  let seq = 0;
  const obs = (kind, subject, value, method = "active", confidence = 1) => {
    const o = { id: `obs-${++seq}`, kind, subject, value, collector: "netscan", method, platform: "network", at: clock(), confidence };
    observations.push(o);
    return o;
  };
  const hostEntry = (ip) => {
    if (!hosts.has(ip)) hosts.set(ip, { ip, mac: null, vendor: null, hostname: null, openPorts: [] });
    return hosts.get(ip);
  };

  // ── target list ──
  const parsed = cidrs.map(parseCidr).filter(Boolean);
  const v6Scopes = parsed.filter((c) => c.family === 6);
  const targets = [];
  const seen = new Set();
  const addTarget = (ip, mac = null) => {
    if (seen.has(ip) || targets.length >= limits.maxHosts) return;
    seen.add(ip);
    targets.push({ ip, mac });
  };

  for (const c of parsed) {
    if (c.family !== 4) continue;
    const usable = c.size > 2 ? c.size - 2 : c.size;
    for (let i = 0; i < usable && targets.length < limits.maxHosts; i++) {
      const offset = c.size > 2 ? i + 1 : i;
      addTarget(intToV4((c.base + offset) >>> 0));
    }
  }
  // IPv6: explicitly approved hosts only, never the range itself.
  for (const h of approval?.hosts ?? []) {
    if (h.includes(":") && v6Scopes.some((c) => cidrContains(c, h))) addTarget(h);
  }

  // ── ARP: passive evidence, and the only source of IPv6 neighbours ──
  for (const e of arpTable ?? []) {
    if (!e?.ip) continue;
    const verdict = checkAllowed(approval, { target: e.ip, method: "passive" }, clock());
    if (!verdict.allowed) {
      refused.push({ target: e.ip, port: null, method: "passive", reason: verdict.reason });
      continue;
    }
    const vendor = vendorFromMac(e.mac);
    obs("arp-entry", e.ip, { ip: e.ip, mac: e.mac ?? null, vendor }, "passive", 0.9);
    const h = hostEntry(e.ip);
    h.mac = e.mac ?? h.mac;
    h.vendor = vendor ?? h.vendor;
    if (e.hostname && !h.hostname) h.hostname = e.hostname;
    if (e.ip.includes(":") && v6Scopes.some((c) => cidrContains(c, e.ip))) addTarget(e.ip, e.mac ?? null);
  }

  // ── probe list: every (host, port) gated individually ──
  // Priority order, not numeric order: portsPerHost truncates, and numeric order would drop the
  // printer ports (631, 9100) that this diagnostic exists for.
  const portList = (ports ?? PORT_PRIORITY.filter((p) => APPROVED_PORTS[p])).slice(0, limits.portsPerHost);
  const tasks = [];
  for (const t of targets) {
    for (const port of portList) {
      const verdict = checkAllowed(approval, { target: t.ip, port, method: "active" }, clock());
      if (!verdict.allowed) {
        refused.push({ target: t.ip, port, method: "active", reason: verdict.reason });
        continue;
      }
      tasks.push({ ip: t.ip, port });
    }
  }

  // ── bounded-concurrency run with per-host delay and cancellation ──
  let aborted = signal?.aborted ?? false;
  const lastProbeAt = new Map();
  let idx = 0, active = 0;

  await new Promise((resolve) => {
    const done = () => resolve();
    const launch = () => {
      if (signal?.aborted) aborted = true;
      while (!aborted && active < limits.concurrency && idx < tasks.length) {
        const task = tasks[idx++];
        active++;
        (async () => {
          const last = lastProbeAt.get(task.ip) ?? -Infinity;
          const gap = limits.perHostDelayMs - (Date.now() - last);
          if (gap > 0) await sleep(gap, signal);
          if (signal?.aborted) throw Object.assign(new Error("aborted"), { aborted: true });
          lastProbeAt.set(task.ip, Date.now());
          const open = await connect({ host: task.ip, port: task.port, timeoutMs: limits.timeoutMs });
          if (open) {
            const h = hostEntry(task.ip);
            h.openPorts.push(task.port);
            obs("port-open", `${task.ip}:${task.port}`, { ip: task.ip, host: task.ip, port: task.port, service: APPROVED_PORTS[task.port] ?? null });
          }
        })()
          .catch((err) => { if (err?.aborted) aborted = true; })
          .finally(() => { active--; (aborted && active === 0) || (idx >= tasks.length && active === 0) ? done() : launch(); });
      }
      if ((aborted || idx >= tasks.length) && active === 0) done();
    };
    launch();
  });

  // ── reverse DNS for hosts that answered, gated like any other query ──
  if (!aborted && typeof resolveHostname === "function") {
    for (const h of hosts.values()) {
      if (signal?.aborted) { aborted = true; break; }
      if (h.openPorts.length === 0 && !h.mac) continue;
      const verdict = checkAllowed(approval, { target: h.ip, method: "active" }, clock());
      if (!verdict.allowed) {
        refused.push({ target: h.ip, port: null, method: "active", reason: verdict.reason });
        continue;
      }
      try {
        const name = await resolveHostname(h.ip);
        if (name) {
          h.hostname = h.hostname ?? name;
          obs("hostname", h.ip, { ip: h.ip, host: h.ip, hostname: name, name }, "active", 0.8);
        }
      } catch { /* resolution failure is the resolver's answer; nothing to record */ }
    }
  }

  for (const h of hosts.values()) {
    h.openPorts.sort((a, b) => a - b);
    h.device = deviceType({ ports: h.openPorts, vendor: h.vendor, hostname: h.hostname });
  }

  return { observations, hosts: [...hosts.values()], refused, aborted };
}
