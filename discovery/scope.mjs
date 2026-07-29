#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Approved scope — the gate every collector passes through.
//
// This module is deliberately the least clever thing in the slice. It answers one question,
// "may I touch this?", and it answers NO by default. A model never calls into it to widen a
// scope; the scope is a value the user approved, and code checks against it.
//
// Everything here is pure: no I/O, no network, no clock beyond an injected `now`. That is what
// makes the safety properties testable rather than asserted.

/** The only modes. `observe` is read-only and is the default everywhere. */
export const MODES = ["observe", "act"];

/** Intensity caps. Conservative on purpose — a discovery tool that disrupts a network is worse
 *  than one that is slow. `gentle` is the default and is what the acceptance test uses. */
export const INTENSITY = {
  gentle:   { concurrency: 4,  perHostDelayMs: 120, timeoutMs: 1500, maxHosts: 256,  portsPerHost: 8  },
  standard: { concurrency: 16, perHostDelayMs: 40,  timeoutMs: 1200, maxHosts: 1024, portsPerHost: 16 },
};

/** Ports we are ever willing to probe, and why. Anything not here is not probed, full stop. */
export const APPROVED_PORTS = {
  22:   "ssh",      53:   "dns",     80:   "http",    443:  "https",
  139:  "netbios",  445:  "smb",     515:  "lpd",     631:  "ipp",
  161:  "snmp",     9100: "jetdirect",
  5060: "sip",      3389: "rdp",
};

/** Actions that are never permitted, in any mode, by any approval. */
export const FORBIDDEN = [
  "exploit", "brute-force", "credential-spray", "password-hash-dump",
  "modify-device", "restart-service", "change-dhcp", "change-dns", "change-vlan",
  "change-ad", "change-printer", "change-pbx", "reboot", "firmware-update",
];

/** What may leave the machine. Ordered least → most. */
export const SYNC_MODES = ["local-only", "status-and-findings", "selected-evidence", "full-authorized"];

// ── CIDR ────────────────────────────────────────────────────────────────────────────────────────

const v4ToInt = (ip) => ip.split(".").reduce((a, o) => (a << 8 >>> 0) + Number(o) >>> 0, 0) >>> 0;
const isV4 = (s) => /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(s) && s.split(".").every((o) => Number(o) <= 255);

/** Expand an IPv6 address to 8 groups of 4 hex digits, or null if malformed. */
function v6Groups(addr) {
  const s = String(addr).toLowerCase().split("%")[0];
  if (!/^[0-9a-f:]*$/.test(s) || (s.match(/::/g) || []).length > 1) return null;
  let [head, tail] = s.includes("::") ? s.split("::") : [s, null];
  const h = head ? head.split(":").filter(Boolean) : [];
  const t = tail ? tail.split(":").filter(Boolean) : [];
  if (tail === null && h.length !== 8) return null;
  if (h.length + t.length > 8) return null;
  const mid = Array(8 - h.length - t.length).fill("0");
  const all = [...h, ...(tail === null ? [] : mid), ...t];
  if (all.length !== 8) return null;
  if (!all.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return all.map((g) => g.padStart(4, "0"));
}

/**
 * Parse "10.0.0.0/24" or "2001:db8::/64". Refuses anything it does not fully understand — an
 * unparseable scope must never widen into "allow", so this returns null and the caller refuses.
 */
export function parseCidr(cidr) {
  const [addr, bitsRaw] = String(cidr).split("/");
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0) return null;
  if (isV4(addr)) {
    if (bits > 32) return null;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    // >>> 0 is load-bearing: & yields a SIGNED int32, so any address above 2^31 (anything from
    // 128.x up, which includes 192.168.x) goes negative here while the containment test below is
    // unsigned. Without this they never compare equal and every such range silently matches
    // NOTHING — a scope bug that fails closed, but fails wrong.
    const base = (v4ToInt(addr) & mask) >>> 0;
    return { family: 4, base, bits, mask, size: 2 ** (32 - bits) };
  }
  const g = v6Groups(addr);
  if (!g || bits > 128) return null;
  // Compare as a hex string prefix — exact, and avoids BigInt arithmetic for a containment test.
  const hex = g.join("");
  const nibbles = Math.floor(bits / 4);
  const remBits = bits % 4;
  return { family: 6, hex, bits, prefix: hex.slice(0, nibbles), remBits,
           remNibble: remBits ? parseInt(hex[nibbles] || "0", 16) >> (4 - remBits) : null,
           size: 2 ** Math.min(64, 128 - bits) };
}

/** Is `ip` inside `cidr`? False for anything malformed on either side. */
export function cidrContains(cidr, ip) {
  const c = typeof cidr === "string" ? parseCidr(cidr) : cidr;
  if (!c) return false;
  if (c.family === 4) {
    if (!isV4(ip)) return false;
    return (v4ToInt(ip) & c.mask) >>> 0 === c.base;
  }
  const g = v6Groups(ip);
  if (!g) return false;
  const hex = g.join("");
  const nibbles = Math.floor(c.bits / 4);
  if (hex.slice(0, nibbles) !== c.prefix) return false;
  if (c.remNibble === null) return true;
  return (parseInt(hex[nibbles] || "0", 16) >> (4 - (c.bits % 4))) === c.remNibble;
}

// ── approval ────────────────────────────────────────────────────────────────────────────────────

/**
 * An approval is an explicit, inspectable value. Nothing is implied: a field left out is a
 * capability NOT granted. It is created by a human answering the confirmation prompt, stored,
 * and shown back before every run.
 */
export function createApproval({
  cidrs = [], hosts = [], accounts = [], collectors = [],
  intensity = "gentle", mode = "observe", sync = "local-only",
  allowActive = false, approvedBy = null, at = Date.now(), ttlMs = 24 * 3600 * 1000,
} = {}) {
  if (!MODES.includes(mode)) throw new Error(`unknown mode '${mode}'`);
  if (!INTENSITY[intensity]) throw new Error(`unknown intensity '${intensity}'`);
  if (!SYNC_MODES.includes(sync)) throw new Error(`unknown sync mode '${sync}'`);
  if (!approvedBy) throw new Error("an approval must record who gave it");
  for (const c of cidrs) if (!parseCidr(c)) throw new Error(`'${c}' is not a CIDR I can parse — refusing to guess at a network range`);

  const limits = INTENSITY[intensity];
  const total = cidrs.reduce((n, c) => n + Math.min(parseCidr(c).size, 65536), 0);
  if (total > limits.maxHosts)
    throw new Error(`approved ranges cover ~${total} addresses; ${intensity} intensity allows ${limits.maxHosts}. Narrow the range or raise intensity deliberately.`);

  return Object.freeze({
    cidrs: Object.freeze([...cidrs]), hosts: Object.freeze([...hosts]),
    accounts: Object.freeze([...accounts]), collectors: Object.freeze([...collectors]),
    intensity, mode, sync, allowActive: !!allowActive, approvedBy, at, ttlMs,
    limits: Object.freeze({ ...limits }),
  });
}

export const approvalExpired = (a, now = Date.now()) => now > a.at + a.ttlMs;

/**
 * The single choke point. Returns `{ allowed: true }` or a REASON. Callers must not proceed on
 * anything else — there is no third state and no "probably fine".
 */
export function checkAllowed(approval, request = {}, now = Date.now()) {
  const { action = "observe", target = null, port = null, collector = null, method = "passive" } = request;
  const deny = (reason) => ({ allowed: false, reason });

  if (!approval) return deny("no approval exists — run `brainoutput discover --approve` first");
  if (approvalExpired(approval, now)) return deny("this approval has expired; re-confirm the scope");
  if (FORBIDDEN.includes(action)) return deny(`'${action}' is never permitted by any approval`);
  if (action !== "observe" && approval.mode !== "act") return deny(`mode is 'observe'; '${action}' would change something`);
  if (collector && approval.collectors.length && !approval.collectors.includes(collector))
    return deny(`collector '${collector}' was not approved`);
  if (method === "active" && !approval.allowActive)
    return deny("active probing was not approved — passive collectors only");
  if (port !== null && !APPROVED_PORTS[port]) return deny(`port ${port} is not on the approved list`);

  if (target) {
    const named = approval.hosts.includes(target);
    const inRange = approval.cidrs.some((c) => cidrContains(c, target));
    if (!named && !inRange) return deny(`${target} is outside every approved range`);
  }
  return { allowed: true };
}

/** What a human is asked to confirm, in plain words, before anything runs. */
export function describeApproval(a) {
  return [
    `mode        ${a.mode}${a.mode === "observe" ? " (read-only)" : "  ← CAN CHANGE THINGS"}`,
    `ranges      ${a.cidrs.join(", ") || "none"}`,
    `hosts       ${a.hosts.join(", ") || "none"}`,
    `accounts    ${a.accounts.join(", ") || "none"}`,
    `collectors  ${a.collectors.join(", ") || "all approved-by-default"}`,
    `intensity   ${a.intensity} (≤${a.limits.concurrency} at once, ${a.limits.timeoutMs}ms timeout, ≤${a.limits.maxHosts} hosts)`,
    `probing     ${a.allowActive ? "active probing ALLOWED" : "passive only"}`,
    `leaves box  ${a.sync}`,
    `expires     ${new Date(a.at + a.ttlMs).toISOString()}`,
  ].join("\n");
}
