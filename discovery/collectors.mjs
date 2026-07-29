#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Deterministic collectors — the ONLY source of Observations (SPEC.md).
//
// A collector reads state and reports it; it never changes anything and never guesses. If a
// platform's native output is not the format a parser was written for, the collector says
// `supported: false` with a reason, because a wrong parse presented as evidence is worse than
// an honest gap. `exec` is injected — this module never touches child_process, which is what
// makes the whole pipeline testable with fixtures instead of a live machine.
import os from "node:os";
import { createHash } from "node:crypto";
import { checkAllowed } from "./scope.mjs";
import { sanitize } from "./firewall.mjs";

/** The only methods a collector may declare (SPEC: passive/API preferred, active gated). */
export const METHODS = ["passive", "active", "api"];

/** This process's platform, reduced to the set we can actually parse. Anything else is honest. */
export const PLATFORM = ["linux", "darwin", "win32"].includes(process.platform) ? process.platform : "unsupported";

/** SPEC: logs are bounded. Hard cap, enforced after the command's own -n as a second wall. */
const LOG_MAX_LINES = 200;

// ── normalization ───────────────────────────────────────────────────────────────────────────────

/** One normalized Observation. `raw` is hashed, never stored — SPEC: "raw?: hash only". */
export function observation({ kind, subject, value, unit = null, collector, method, platform = PLATFORM, at = null, confidence = 1, raw = null } = {}) {
  if (!kind || !subject || !collector) throw new Error("an observation needs kind, subject and collector");
  if (!METHODS.includes(method)) throw new Error(`unknown method '${method}'`);
  const o = {
    id: `${collector}:${kind}:${subject}`,
    kind, subject, value,
    collector, method, platform,
    at: at ?? Date.now(),
    confidence: Math.min(1, Math.max(0, Number(confidence))),
  };
  if (unit !== null) o.unit = unit;
  if (raw !== null && raw !== undefined) {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), "utf8");
    o.raw = { sha256: createHash("sha256").update(buf).digest("hex"), byteLength: buf.length };
  }
  return o;
}

const obs = (ctx, name, fields) => observation({ ...fields, collector: name, platform: ctx.platform, at: ctx.now });

/** exec, but a non-zero exit is an error — a failed command is not evidence of anything. */
async function must(ctx, cmd, args) {
  const r = await ctx.exec(cmd, args);
  if (r.code !== 0) throw new Error(`${cmd} exited ${r.code}: ${String(r.stderr || "").trim().slice(0, 120)}`);
  return r.stdout;
}

/** Evidence that privilege was missing, stated — never a silent gap (SPEC privilege boundary). */
const partialEvidence = (ctx, name, reason) => ({
  supported: true, partial: true, reason,
  observations: [obs(ctx, name, { kind: "collector-status", subject: name, method: "passive",
    value: { state: "partial-evidence", reason }, confidence: 0.2 })],
});

// ── parsers: one per platform per tool. Never reuse one OS's parser on another's output. ────────

/** Linux `df -P -B1`: sizes are bytes. Returns null unless the header proves it. */
export function parseDfLinux(text) {
  const lines = String(text).trim().split("\n");
  if (!/^Filesystem\s+1B-blocks/.test(lines[0] || "")) return null;
  const out = [];
  for (const line of lines.slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 6) continue;
    out.push({ filesystem: f[0], sizeBytes: Number(f[1]), usedBytes: Number(f[2]),
      availBytes: Number(f[3]), usePct: Number(String(f[4]).replace("%", "")), mount: f.slice(5).join(" ") });
  }
  return out.filter((v) => Number.isFinite(v.sizeBytes));
}

/** macOS `df -k`: sizes are 1024-byte blocks — a DIFFERENT unit than Linux's -B1. */
export function parseDfDarwin(text) {
  const lines = String(text).trim().split("\n");
  if (!/^Filesystem\s+1024-blocks/.test(lines[0] || "")) return null;
  const out = [];
  for (const line of lines.slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 9) continue;
    out.push({ filesystem: f[0], sizeBytes: Number(f[1]) * 1024, usedBytes: Number(f[2]) * 1024,
      availBytes: Number(f[3]) * 1024, usePct: Number(String(f[4]).replace("%", "")), mount: f.slice(8).join(" ") });
  }
  return out.filter((v) => Number.isFinite(v.sizeBytes));
}

/** Linux `ip route show`. */
export function parseIpRouteLinux(text) {
  const out = [];
  for (const line of String(text).split("\n")) {
    const t = line.trim().split(/\s+/).filter(Boolean);
    if (!t.length) continue;
    const get = (k) => { const i = t.indexOf(k); return i >= 0 ? t[i + 1] : null; };
    out.push({ destination: t[0], gateway: get("via"), iface: get("dev"), metric: Number(get("metric")) || null });
  }
  return out;
}

/** macOS `netstat -rn`. Refs/Use columns appear on some versions — skip numerics to find Netif. */
export function parseNetstatRoutesDarwin(text) {
  const out = [];
  let inTable = false;
  for (const line of String(text).split("\n")) {
    const t = line.trim().split(/\s+/).filter(Boolean);
    if (!t.length) continue;
    if (t[0] === "Destination") { inTable = true; continue; }
    if (!inTable || t.length < 4) continue;
    let i = 3;
    while (i < t.length - 1 && /^\d+$/.test(t[i])) i++;
    out.push({ destination: t[0], gateway: t[1], flags: t[2], iface: t[i] });
  }
  return out;
}

/** Linux /etc/resolv.conf. */
export function parseResolvConf(text) {
  const nameservers = [], search = [];
  let domain = null;
  for (const line of String(text).split("\n")) {
    const t = line.trim().split(/\s+/);
    if (t[0] === "nameserver" && t[1]) nameservers.push(t[1]);
    else if (t[0] === "search") search.push(...t.slice(1));
    else if (t[0] === "domain" && t[1]) domain = t[1];
  }
  return { nameservers, search, domain };
}

/** macOS `scutil --dns` — nothing like resolv.conf; indexed keys, possibly several resolvers. */
export function parseScutilDns(text) {
  const nameservers = new Set(), search = new Set();
  for (const line of String(text).split("\n")) {
    const n = line.match(/nameserver\[\d+\]\s*:\s*(\S+)/);
    if (n) nameservers.add(n[1]);
    const s = line.match(/search domain\[\d+\]\s*:\s*(\S+)/);
    if (s) search.add(s[1]);
  }
  return { nameservers: [...nameservers], search: [...search], domain: null };
}

/** Linux `systemctl list-units --type=service --no-legend --plain`. */
export function parseSystemctlServices(text) {
  const out = [];
  for (const line of String(text).split("\n")) {
    const t = line.trim().split(/\s+/);
    if (!t[0]?.endsWith(".service")) continue;
    out.push({ unit: t[0], load: t[1], active: t[2], sub: t[3], description: t.slice(4).join(" ") });
  }
  return out;
}

/** macOS `launchctl list` — tab-separated, "-" PID means not running. */
export function parseLaunchctlList(text) {
  const out = [];
  for (const line of String(text).split("\n")) {
    const t = line.trim().split(/\t/);
    if (t.length < 3 || t[0] === "PID") continue;
    out.push({ pid: t[0] === "-" ? null : Number(t[0]), status: Number(t[1]), label: t[2] });
  }
  return out;
}

/** Linux dhclient-style lease file (/var/lib/dhcp/dhclient.leases). */
export function parseDhclientLeases(text) {
  const leases = [];
  for (const b of String(text).match(/lease\s*\{[^}]*\}/g) || []) {
    const g = (re) => (b.match(re) || [])[1] || null;
    leases.push({
      interface: g(/interface\s+"([^"]+)"/),
      address: g(/fixed-address\s+([\d.]+)/),
      routers: (g(/option\s+routers\s+([^;]+)/) || "").split(/[,\s]+/).filter(Boolean),
      dns: (g(/option\s+domain-name-servers\s+([^;]+)/) || "").split(/[,\s]+/).filter(Boolean),
      leaseSeconds: Number(g(/option\s+dhcp-lease-time\s+(\d+)/)) || null,
    });
  }
  return leases;
}

/** macOS `ipconfig getpacket <iface>` — the BOOTP reply, not a lease file. */
export function parseIpconfigGetpacket(text) {
  const g = (re) => (String(text).match(re) || [])[1] || null;
  const braces = (s) => (s || "").replace(/[{}]/g, "").split(/[,\s]+/).filter(Boolean);
  const lt = g(/lease_time \(uint32\):\s*(\S+)/);
  return {
    address: g(/yiaddr\s*=\s*(\S+)/),
    server: g(/server_identifier \(ip\):\s*(\S+)/),
    leaseSeconds: lt ? parseInt(lt, lt.startsWith("0x") ? 16 : 10) : null,
    routers: braces(g(/router \(ip_mult\):\s*(\{[^}]*\})/)),
    dns: braces(g(/domain_name_server \(ip_mult\):\s*(\{[^}]*\})/)),
  };
}

const pemCount = (text) => (String(text).match(/-----BEGIN CERTIFICATE-----/g) || []).length;

/** Read the system log, bounded BEFORE redaction and storage — a log line can hold a credential. */
async function readSystemLog(ctx) {
  if (ctx.platform === "linux") {
    const j = await ctx.exec("journalctl", ["-n", String(LOG_MAX_LINES), "--no-pager"]);
    if (j.code === 0) return { source: "journalctl", text: j.stdout };
    return { source: "/var/log/syslog", text: await must(ctx, "tail", ["-n", String(LOG_MAX_LINES), "/var/log/syslog"]) };
  }
  if (ctx.platform === "darwin")
    return { source: "/var/log/system.log", text: await must(ctx, "tail", ["-n", String(LOG_MAX_LINES), "/var/log/system.log"]) };
  return null;
}

// ── collectors ──────────────────────────────────────────────────────────────────────────────────

/**
 * The host collector set. `platform` lists the OSes with a REAL parser — anything else is
 * reported unsupported, never guessed at. node:os is preferred over shelling out wherever it
 * can answer (cpu, memory, interfaces); those are labeled passive.
 */
export function hostCollectors() {
  return [
    {
      name: "cpu", method: "passive", platform: ["linux", "darwin", "win32"], needsPrivilege: false,
      async run(ctx) {
        const cpus = os.cpus();
        return { supported: true, observations: [obs(ctx, "cpu", { kind: "cpu", subject: os.hostname() || "host", method: "passive",
          value: { model: cpus[0]?.model || "unknown", cores: cpus.length, speedMHz: cpus[0]?.speed ?? null, loadavg: os.loadavg() } })] };
      },
    },
    {
      name: "memory", method: "passive", platform: ["linux", "darwin", "win32"], needsPrivilege: false,
      async run(ctx) {
        return { supported: true, observations: [obs(ctx, "memory", { kind: "memory", subject: "host", method: "passive",
          value: { totalBytes: os.totalmem(), freeBytes: os.freemem(), uptimeSec: os.uptime() } })] };
      },
    },
    {
      name: "disks", method: "passive", platform: ["linux", "darwin"], needsPrivilege: false,
      async run(ctx) {
        if (ctx.platform === "linux") {
          const out = await must(ctx, "df", ["-P", "-B1"]);
          const vols = parseDfLinux(out);
          if (!vols) return { supported: false, reason: "df output was not Linux -B1 format — refusing to parse it as something else" };
          return { supported: true, observations: vols.map((v) => obs(ctx, "disks", { kind: "volume", subject: v.mount, method: "passive", value: v, raw: out })) };
        }
        if (ctx.platform === "darwin") {
          const out = await must(ctx, "df", ["-k"]);
          const vols = parseDfDarwin(out);
          if (!vols) return { supported: false, reason: "df output was not macOS -k format — refusing to parse it as something else" };
          return { supported: true, observations: vols.map((v) => obs(ctx, "disks", { kind: "volume", subject: v.mount, method: "passive", value: v, raw: out })) };
        }
        return { supported: false, reason: `disks has no parser for '${ctx.platform}'` };
      },
    },
    {
      name: "interfaces", method: "passive", platform: ["linux", "darwin", "win32"], needsPrivilege: false,
      async run(ctx) {
        const ifs = os.networkInterfaces();
        return { supported: true, observations: Object.entries(ifs).map(([name, addrs]) =>
          obs(ctx, "interfaces", { kind: "interface", subject: name, method: "passive",
            value: (addrs || []).map((a) => ({ address: a.address, family: a.family, mac: a.mac, internal: a.internal })) })) };
      },
    },
    {
      name: "routes", method: "passive", platform: ["linux", "darwin"], needsPrivilege: false,
      async run(ctx) {
        if (ctx.platform === "linux") {
          const out = await must(ctx, "ip", ["route", "show"]);
          const routes = parseIpRouteLinux(out);
          return { supported: true, observations: routes.map((r) => obs(ctx, "routes", { kind: "route", subject: r.destination, method: "passive", value: r, raw: out })) };
        }
        if (ctx.platform === "darwin") {
          const out = await must(ctx, "netstat", ["-rn"]);
          const routes = parseNetstatRoutesDarwin(out);
          return { supported: true, observations: routes.map((r) => obs(ctx, "routes", { kind: "route", subject: r.destination, method: "passive", value: r, raw: out })) };
        }
        return { supported: false, reason: `routes has no parser for '${ctx.platform}'` };
      },
    },
    {
      name: "dns-config", method: "passive", platform: ["linux", "darwin"], needsPrivilege: false,
      async run(ctx) {
        if (ctx.platform === "linux") {
          const out = await must(ctx, "cat", ["/etc/resolv.conf"]);
          return { supported: true, observations: [obs(ctx, "dns-config", { kind: "dns-config", subject: "resolver", method: "passive", value: parseResolvConf(out), raw: out })] };
        }
        if (ctx.platform === "darwin") {
          const out = await must(ctx, "scutil", ["--dns"]);
          return { supported: true, observations: [obs(ctx, "dns-config", { kind: "dns-config", subject: "resolver", method: "passive", value: parseScutilDns(out), raw: out })] };
        }
        return { supported: false, reason: `dns-config has no parser for '${ctx.platform}'` };
      },
    },
    {
      name: "services", method: "passive", platform: ["linux", "darwin"], needsPrivilege: false,
      async run(ctx) {
        if (ctx.platform === "linux") {
          const out = await must(ctx, "systemctl", ["list-units", "--type=service", "--all", "--no-pager", "--plain", "--no-legend"]);
          return { supported: true, observations: [obs(ctx, "services", { kind: "services", subject: "systemd", method: "passive", value: parseSystemctlServices(out), raw: out })] };
        }
        if (ctx.platform === "darwin") {
          const out = await must(ctx, "launchctl", ["list"]);
          return { supported: true, observations: [obs(ctx, "services", { kind: "services", subject: "launchd", method: "passive", value: parseLaunchctlList(out), raw: out })] };
        }
        return { supported: false, reason: `services has no parser for '${ctx.platform}'` };
      },
    },
    {
      // Lease files are root-readable on Linux. The runtime does NOT run as root: without
      // privilege this degrades to partial evidence with a stated reason, never a silent gap.
      name: "dhcp-lease", method: "passive", platform: ["linux", "darwin"], needsPrivilege: true,
      async run(ctx) {
        if (!["linux", "darwin"].includes(ctx.platform))
          return { supported: false, reason: `dhcp-lease has no parser for '${ctx.platform}'` };
        if (!ctx.privileged)
          return partialEvidence(ctx, "dhcp-lease", "reading DHCP leases needs root; the runtime stays unprivileged, so no lease data was read — invoke the audited privileged helper for the full lease");
        if (ctx.platform === "linux") {
          const out = await must(ctx, "cat", ["/var/lib/dhcp/dhclient.leases"]);
          const leases = parseDhclientLeases(out);
          return { supported: true, observations: leases.map((l, i) =>
            obs(ctx, "dhcp-lease", { kind: "dhcp-lease", subject: l.interface || `lease-${i}`, method: "passive", value: l, raw: out })) };
        }
        const out = await must(ctx, "ipconfig", ["getpacket", "en0"]);
        return { supported: true, observations: [obs(ctx, "dhcp-lease", { kind: "dhcp-lease", subject: "en0", method: "passive", value: parseIpconfigGetpacket(out), raw: out })] };
      },
    },
    {
      name: "certificates", method: "passive", platform: ["linux", "darwin"], needsPrivilege: false,
      async run(ctx) {
        if (ctx.platform === "linux") {
          const out = await must(ctx, "find", ["/etc/ssl/certs", "-maxdepth", "1", "-name", "*.pem"]);
          const names = out.split("\n").map((s) => s.trim()).filter(Boolean);
          return { supported: true, observations: [obs(ctx, "certificates", { kind: "cert-store", subject: "/etc/ssl/certs", method: "passive",
            value: { store: "/etc/ssl/certs", count: names.length, sample: names.slice(0, 10) }, raw: out })] };
        }
        if (ctx.platform === "darwin") {
          const out = await must(ctx, "security", ["find-certificate", "-a", "-p", "/Library/Keychains/System.keychain"]);
          return { supported: true, observations: [obs(ctx, "certificates", { kind: "cert-store", subject: "System.keychain", method: "passive",
            value: { store: "System.keychain", count: pemCount(out) }, raw: out })] };
        }
        return { supported: false, reason: `certificates has no parser for '${ctx.platform}'` };
      },
    },
    {
      name: "logs", method: "passive", platform: ["linux", "darwin"], needsPrivilege: false,
      async run(ctx) {
        const got = await readSystemLog(ctx);
        if (!got) return { supported: false, reason: `logs has no reader for '${ctx.platform}'` };
        // Bound first, redact before anything is returned — SPEC: "logs are bounded and
        // redacted BEFORE storage". The command's own -n is a limit, not a guarantee.
        const all = String(got.text).replace(/\r/g, "").split("\n").filter((l) => l.length);
        const truncated = all.length > LOG_MAX_LINES;
        const kept = all.slice(0, LOG_MAX_LINES).map((l) => sanitize(l));
        return { supported: true, observations: [obs(ctx, "logs", { kind: "log-tail", subject: got.source, method: "passive",
          value: { lines: kept.map((k) => k.text), truncated, redacted: [...new Set(kept.flatMap((k) => k.redacted))] } })] };
      },
    },
  ];
}

// ── orchestration ───────────────────────────────────────────────────────────────────────────────

/** POSIX root check; false elsewhere (win32 has no getuid). */
const detectPrivileged = () => typeof process.getuid === "function" && process.getuid() === 0;

/**
 * Run every host collector against the approved scope. Returns three lists, never throws on a
 * collector's behalf: observations, skipped (with reasons — unsupported or not approved), errors.
 */
export async function collectHost({ exec, platform = PLATFORM, approval = null, now = Date.now(), privileged = detectPrivileged() } = {}) {
  if (typeof exec !== "function") throw new Error("collectHost needs an injected exec(cmd, args)");
  const observations = [], skipped = [], errors = [];
  const ctx = { exec, platform, approval, now, privileged };

  for (const c of hostCollectors()) {
    if (!c.platform.includes(platform)) { skipped.push({ name: c.name, reason: `unsupported on '${platform}'` }); continue; }
    if (approval) {
      const gate = checkAllowed(approval, { collector: c.name, method: c.method }, now);
      if (!gate.allowed) { skipped.push({ name: c.name, reason: gate.reason }); continue; }
    }
    try {
      const r = await c.run(ctx);
      if (!r.supported) { skipped.push({ name: c.name, reason: r.reason }); continue; }
      observations.push(...r.observations);
    } catch (e) {
      errors.push({ name: c.name, error: String(e?.message || e) });
    }
  }
  return { observations, skipped, errors };
}
