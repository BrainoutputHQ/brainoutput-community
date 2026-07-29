#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// The privilege boundary.
//
// Some evidence genuinely needs root: a DHCP lease file, an ARP table on some systems, a service
// list. The wrong answer is to run the AI runtime as root so everything "just works" — that hands
// a model-driven process the ability to change the machine, which is exactly what this whole
// design refuses.
//
// So: the runtime stays unprivileged, and a privileged collector is ONE named, allow-listed,
// read-only command run through a small helper. Anything not on the list cannot be run at all,
// no matter what calls in. Every invocation is printed before it runs and recorded.
import { createHash } from "node:crypto";

/**
 * The complete set of privileged commands this slice will ever run. Read-only by construction —
 * there is no entry here that writes, restarts, or reconfigures anything, and adding one would be
 * a visible change to this list rather than a new call site somewhere.
 */
export const PRIVILEGED_ALLOWLIST = {
  "dhcp-lease-linux":   { cmd: "cat",       args: ["/var/lib/dhcp/dhclient.leases"], why: "DHCP lease evidence" },
  "dhcp-lease-darwin":  { cmd: "ipconfig",  args: ["getpacket", "en0"],              why: "DHCP lease evidence" },
  "arp-table-linux":    { cmd: "ip",        args: ["neigh", "show"],                 why: "MAC↔IP correlation" },
  "arp-table-darwin":   { cmd: "arp",       args: ["-an"],                           why: "MAC↔IP correlation" },
  "services-linux":     { cmd: "systemctl", args: ["list-units", "--type=service", "--no-pager", "--plain"], why: "service inventory" },
  "routes-linux":       { cmd: "ip",        args: ["route", "show"],                 why: "default route evidence" },
};

/** Commands that must never be reachable, even if someone adds them to the allowlist by mistake. */
const NEVER = /\b(rm|dd|mkfs|shutdown|reboot|systemctl\s+(start|stop|restart|enable|disable)|iptables|nft|ifconfig\s+\S+\s+(up|down)|route\s+add|netsh|reg\s+add)\b/i;

/**
 * Run one allow-listed privileged collector.
 *
 * `exec` and `elevate` are injected so this is testable and so the elevation mechanism (sudo,
 * a setuid helper, an admin service) is a deployment decision rather than baked in here.
 * Returns partial evidence with a REASON when privilege is unavailable — never a silent gap,
 * because a missing check that looks like a passing check is the worst outcome in a diagnostic.
 */
export async function runPrivileged(name, { exec, elevate = null, privileged = false, audit = null, now = Date.now() } = {}) {
  const spec = PRIVILEGED_ALLOWLIST[name];
  if (!spec) return { ok: false, supported: false, reason: `'${name}' is not an allow-listed privileged collector`, partial: true };

  const shown = `${spec.cmd} ${spec.args.join(" ")}`;
  if (NEVER.test(shown)) return { ok: false, supported: false, reason: `refusing '${shown}': it is not read-only`, partial: true };

  // Show the command BEFORE running it, and record it. A user must always be able to see exactly
  // what was executed on their machine.
  audit?.({ at: now, kind: "privileged-command", name, command: shown, why: spec.why, elevated: !!elevate && !privileged });

  if (!privileged && !elevate)
    return { ok: false, supported: true, reason: `needs administrator/root: ${shown}`, partial: true, command: shown, why: spec.why };

  try {
    const r = privileged ? await exec(spec.cmd, spec.args) : await elevate(spec.cmd, spec.args);
    return { ok: r.code === 0, supported: true, stdout: r.stdout ?? "", command: shown, why: spec.why,
             partial: r.code !== 0, reason: r.code === 0 ? null : `exited ${r.code}` };
  } catch (e) {
    return { ok: false, supported: true, partial: true, command: shown, reason: `could not run: ${e.message}` };
  }
}

/** An append-only audit record. Hash-chained so a deleted entry is detectable. */
export function createAudit() {
  const entries = [];
  let prev = "genesis";
  return {
    record(e) {
      const body = JSON.stringify(e);
      prev = createHash("sha256").update(prev + body).digest("hex");
      entries.push({ ...e, seq: entries.length, chain: prev.slice(0, 16) });
      return entries[entries.length - 1];
    },
    all: () => [...entries],
    /** Recompute the chain: any removed or altered entry breaks it. */
    verify() {
      let p = "genesis";
      for (const e of entries) {
        const { seq, chain, ...body } = e;
        p = createHash("sha256").update(p + JSON.stringify(body)).digest("hex");
        if (p.slice(0, 16) !== chain) return { intact: false, brokenAt: seq };
      }
      return { intact: true, count: entries.length };
    },
  };
}
