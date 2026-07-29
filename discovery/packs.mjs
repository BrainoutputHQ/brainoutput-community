#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Diagnostic pack interfaces.
//
// INTERFACES ONLY in this slice. Every pack here returns an explicit non-answer —
// `unsupported`, `credentials-required` or `partial-evidence` — because the alternative is a
// tool that appears to have checked your Active Directory and silently checked nothing. A blank
// result that looks like a clean bill of health is the single most dangerous output a diagnostic
// can produce, so there is no code path here that returns "ok" without evidence.
//
// A pack becomes real by implementing collect(); the shape it must satisfy is fixed here first so
// that vendor differences stay behind one boundary.

export const PACK_STATUS = ["unsupported", "credentials-required", "partial-evidence", "ok"];

/**
 * @typedef {Object} PackResult
 * @property {string} pack
 * @property {"unsupported"|"credentials-required"|"partial-evidence"|"ok"} status
 * @property {string} reason              — always present unless status === "ok"
 * @property {Array}  observations        — normalized Observations, never raw vendor output
 * @property {Array}  findings
 * @property {string[]} needs             — exactly what would make this pack work
 */

const stub = (pack, { needs = [], reason, status = "unsupported", notes = null }) => ({
  pack, status, reason, needs, notes, observations: [], findings: [],
});

/**
 * Every pack declares its vendor surface honestly. `vendors` is what an implementation is
 * expected to cover FIRST — not a support claim, and the code says so.
 */
export const PACKS = {
  "switch-vlan-poe": {
    title: "Switches, VLANs and PoE",
    readOnly: true,
    vendors: ["cisco-ios", "aruba-cx", "ubiquiti-unifi", "mikrotik", "generic-snmp"],
    needs: ["SNMPv3 credentials (v2c only as an explicitly accepted compatibility mode)", "management IP in an approved scope"],
    collect: async () => stub("switch-vlan-poe", {
      status: "credentials-required",
      reason: "switch inspection needs read-only SNMPv3 credentials; none are configured",
      needs: ["SNMPv3 user with read-only auth+priv"],
      notes: "SNMPv2c community strings are supported only as a deliberate compatibility choice and are never displayed or logged",
    }),
  },
  "active-directory-entra": {
    title: "Active Directory / Entra ID",
    readOnly: true,
    vendors: ["ad-ldap", "entra-graph"],
    needs: ["read-only delegated scopes", "a service account with directory READ only"],
    collect: async () => stub("active-directory-entra", {
      status: "credentials-required",
      reason: "directory evidence needs read-only delegated scopes; none are configured",
      needs: ["Directory.Read.All (delegated) or an LDAP read-only bind"],
      notes: "collects only evidence relevant to the open diagnostic — never a broad directory export, and never password hashes",
    }),
  },
  "ipbx-sip": {
    title: "IPBX / SIP / voice",
    readOnly: true,
    vendors: ["asterisk", "freepbx", "3cx", "generic-sip"],
    needs: ["PBX management API credentials", "SIP registrar reachable in an approved scope"],
    collect: async () => stub("ipbx-sip", {
      status: "unsupported",
      reason: "voice diagnostics are not implemented in this slice",
      needs: ["reachability + DNS + NTP + SIP registration evidence first"],
      notes: "when implemented: NO test calls and NO trunk changes without explicit approval",
    }),
  },
  wifi: {
    title: "Wi-Fi",
    readOnly: true,
    vendors: ["unifi", "aruba", "meraki", "os-native"],
    needs: ["controller API credentials, or OS-native scan permission"],
    collect: async () => stub("wifi", { reason: "Wi-Fi diagnostics are not implemented in this slice", needs: ["controller API or OS scan permission"] }),
  },
  "servers-backups": {
    title: "Servers and backups",
    readOnly: true,
    vendors: ["proxmox", "veeam", "restic", "borg"],
    needs: ["backup tool API or a read-only status export"],
    collect: async () => stub("servers-backups", {
      reason: "backup verification is not implemented in this slice",
      needs: ["a read-only status endpoint or export"],
      notes: "a backup that has never been restore-tested is not a verified backup, and this pack must say so rather than report 'ok'",
    }),
  },
  "business-apps": {
    title: "Odoo · Zendesk · Jira · GitHub · Microsoft 365",
    readOnly: true,
    vendors: ["odoo", "zendesk", "jira", "github", "microsoft-365"],
    needs: ["per-app OAuth with read-only scopes"],
    collect: async () => stub("business-apps", {
      status: "credentials-required",
      reason: "business-application evidence needs each app's read-only OAuth grant",
      needs: ["read-only OAuth per app; respect rate limits, pagination and tenant boundaries"],
    }),
  },
  "remote-site": {
    title: "Remote sites",
    readOnly: true,
    vendors: [],
    needs: ["a signed, least-privilege remote collector node"],
    collect: async () => stub("remote-site", {
      reason: "this CLI can only see networks it can actually reach — it will not pretend otherwise",
      needs: ["a signed remote collector deployed at the site"],
      notes: "deferred deliberately: claiming to discover an unreachable network would be a fabricated result",
    }),
  },
};

/** Run a pack by name. An unknown pack is an error, not an empty success. */
export async function runPack(name, ctx = {}) {
  const p = PACKS[name];
  if (!p) throw new Error(`unknown diagnostic pack '${name}'`);
  const r = await p.collect(ctx);
  if (!PACK_STATUS.includes(r.status)) throw new Error(`pack '${name}' returned an invalid status`);
  if (r.status !== "ok" && !r.reason) throw new Error(`pack '${name}' must state why it is not 'ok'`);
  return r;
}

/** What `brainoutput diagnose --packs` prints: the honest support matrix. */
export function packMatrix() {
  return Object.entries(PACKS).map(([key, p]) => ({
    pack: key, title: p.title, readOnly: p.readOnly,
    firstVendors: p.vendors, needs: p.needs, implemented: false,
  }));
}
