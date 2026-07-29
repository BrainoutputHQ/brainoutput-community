#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Rule-based diagnostics. Deterministic, no AI anywhere: observations in, findings out.
// Every finding cites its evidence, states at least one alternative cause, names the next
// verification step, and its remediation requires explicit approval. This module plans;
// it never executes.
import { cidrContains } from "./scope.mjs";

const RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

let seq = 0;

/**
 * The only way a finding comes into existence. The invariants are enforced, not documented:
 * no evidence, no alternative cause, no verification step -> no finding.
 */
export function finding({
  id = null, severity = "medium", title,
  evidence = [], confidence = 0.5, alternativeCauses = [],
  nextVerification = null, remediation = {},
} = {}) {
  if (!title) throw new Error("a finding needs a title");
  if (!(severity in RANK)) throw new Error(`unknown severity '${severity}'`);
  if (!Array.isArray(evidence) || evidence.length === 0)
    throw new Error("a finding must cite at least one observation id as evidence — models may not invent scan results");
  if (!(confidence >= 0 && confidence <= 1)) throw new Error("confidence must be in 0..1");
  if (!Array.isArray(alternativeCauses) || alternativeCauses.length === 0)
    throw new Error("every finding must state at least one alternative cause");
  if (typeof nextVerification !== "string" || nextVerification.length === 0)
    throw new Error("every finding must name the next verification step");
  const steps = remediation.steps ?? [];
  if (remediation.requiresApproval !== undefined && remediation.requiresApproval !== true)
    throw new Error("remediation.requiresApproval must be true — nothing here executes without approval");
  return Object.freeze({
    id: id ?? `F-${++seq}`, severity, title,
    evidence: Object.freeze([...evidence]), confidence,
    alternativeCauses: Object.freeze([...alternativeCauses]),
    nextVerification,
    remediation: Object.freeze({ steps: Object.freeze([...steps]), requiresApproval: true }),
  });
}

const latest = (list) => list.reduce((a, b) => (!a || (b.at ?? 0) > (a.at ?? 0) ? b : a), null);
const groupBy = (obs, keyFn) => {
  const m = new Map();
  for (const o of obs) {
    const k = keyFn(o);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(o);
  }
  return m;
};
const maskToBits = (mask) => String(mask).split(".").reduce((bits, o) => {
  const n = Number(o);
  return bits + (n === 255 ? 8 : n === 254 ? 7 : n === 252 ? 6 : n === 248 ? 5 : n === 240 ? 4 : n === 224 ? 3 : n === 192 ? 2 : n === 128 ? 1 : 0);
}, 0);
const prefixOf = (value) => value?.prefixLength ?? (value?.mask ? maskToBits(value.mask) : null);


/**
 * Pull a scalar out of an Observation value. The schema allows `value` to be a scalar or an
 * object, so a check that assumes one shape either prints "[object Object]" into a finding title
 * or silently never fires. Both happened before this existed.
 */
const scalar = (v, ...keys) => {
  if (v == null || typeof v !== "object") return v;
  for (const k of keys) if (v[k] != null) return v[k];
  return null;
};

// ── printers ──────────────────────────────────────────────────────────────────────────────────

const PRINTER_KINDS = ["printer-reachable", "dns-resolution", "snmp-status", "toner-level", "paper-status", "device-error", "print-queue"];

export function checkPrinter(observations = []) {
  const findings = [];
  const bySubject = groupBy(observations.filter((o) => PRINTER_KINDS.includes(o.kind)), (o) => o.subject);

  for (const [subject, obs] of bySubject) {
    const ofKind = (k) => latest(obs.filter((o) => o.kind === k));

    const reach = ofKind("printer-reachable");
    if (reach?.value && reach.value.reachable === false) {
      findings.push(finding({
        severity: "high", title: `printer ${subject} is unreachable`,
        evidence: [reach.id], confidence: reach.confidence ?? 0.8,
        alternativeCauses: [
          "the printer is powered off or in deep sleep",
          "the network segment between the scanner and the printer is down",
          "the printer's IP changed and the configured target is stale",
        ],
        nextVerification: `ping ${reach.value.ip ?? subject} from the same subnet and read the network status on the printer's control panel`,
        remediation: { steps: [
          "physically confirm power and network link on the device",
          "verify the printer still holds its configured IP (DHCP reservation vs static)",
        ], requiresApproval: true },
      }));
    }

    const dns = ofKind("dns-resolution");
    if (reach?.value?.reachable && reach.value.ip && dns?.value?.ip && dns.value.ip !== reach.value.ip) {
      findings.push(finding({
        severity: "high",
        title: `DNS name for ${subject} resolves to ${dns.value.ip} but ${reach.value.ip} is the address answering`,
        evidence: [reach.id, dns.id], confidence: 0.85,
        alternativeCauses: [
          "a stale A record points at the printer's old address",
          "another device has taken the printer's former IP",
          "the printer took a new DHCP lease and DNS was never updated",
        ],
        nextVerification: `resolve the name from two different resolvers and compare against the address shown on the printer's control panel`,
        remediation: { steps: [
          "correct or remove the stale DNS record after confirming which device owns each address",
          "add a DHCP reservation so the printer's address stops drifting",
        ], requiresApproval: true },
      }));
    }

    const snmp = ofKind("snmp-status");
    if (snmp && !["ok", "running", "idle", "ready"].includes(String(snmp.value).toLowerCase())) {
      findings.push(finding({
        severity: "medium", title: `printer ${subject} reports SNMP status '${scalar(snmp.value, "status", "state") ?? JSON.stringify(snmp.value)}'`,
        evidence: [snmp.id], confidence: 0.7,
        alternativeCauses: [
          "a consumable or hardware fault the printer is reporting accurately",
          "an SNMP agent reporting a stale or vendor-specific status string",
        ],
        nextVerification: "read the printer's front panel / embedded web page status and compare with the SNMP-reported value",
        remediation: { steps: ["clear the reported condition on the device (per vendor instructions)"], requiresApproval: true },
      }));
    }

    const toner = ofKind("toner-level");
    const tonerPct = scalar(toner?.value, "percent", "level");
    if (toner && typeof tonerPct === "number" && tonerPct <= 15) {
      findings.push(finding({
        severity: toner.value <= 5 ? "medium" : "low",
        title: `printer ${subject} toner low (${tonerPct}%)`,
        evidence: [toner.id], confidence: 0.75,
        alternativeCauses: [
          "the cartridge is genuinely near end of life",
          "the printer's level estimate is inaccurate (common with refilled or third-party cartridges)",
        ],
        nextVerification: "print a supplies-status page from the printer and compare with the reported level",
        remediation: { steps: ["stage a replacement cartridge; replace when print quality degrades"], requiresApproval: true },
      }));
    }

    const paper = ofKind("paper-status");
    const paperState = scalar(paper?.value, "status", "state");
    if (paper && ["out", "empty"].includes(paperState)) {
      findings.push(finding({
        severity: "medium", title: `printer ${subject} is out of paper`,
        evidence: [paper.id], confidence: 0.85,
        alternativeCauses: ["tray is empty", "tray is loaded but not seated, or the paper sensor is faulty"],
        nextVerification: "check the tray in person; reseat it and watch whether the alert clears",
        remediation: { steps: ["refill and reseat the paper tray"], requiresApproval: true },
      }));
    }
    if (paper && ["jam", "jammed"].includes(paperState)) {
      findings.push(finding({
        severity: "medium", title: `printer ${subject} reports a paper jam`,
        evidence: [paper.id], confidence: 0.85,
        alternativeCauses: ["physical jam in the paper path", "a dirty or failed paper-path sensor reporting a jam that is not there"],
        nextVerification: "open the indicated cover and inspect the paper path",
        remediation: { steps: ["clear the jam per the vendor's instructions; power-cycle only after the path is clear"], requiresApproval: true },
      }));
    }

    const derr = ofKind("device-error");
    if (derr && derr.value) {
      findings.push(finding({
        severity: "high", title: `printer ${subject} reports device error: ${JSON.stringify(derr.value)}`,
        evidence: [derr.id], confidence: 0.75,
        alternativeCauses: [
          "a genuine hardware fault",
          "a transient error that survives until the device is power-cycled",
        ],
        nextVerification: "read the exact error code on the printer's panel and look it up in the vendor manual",
        remediation: { steps: ["follow the vendor procedure for the reported error code"], requiresApproval: true },
      }));
    }

    const queue = ofKind("print-queue");
    const queueState = scalar(queue?.value, "state", "status");
    if (queue?.value?.paused) {
      findings.push(finding({
        severity: "medium", title: `print queue for ${subject} is paused`,
        evidence: [queue.id], confidence: 0.8,
        alternativeCauses: [
          "someone paused the queue deliberately during an incident and forgot to resume it",
          "the spooler auto-paused after a failed job (CUPS 'on error' policy, or Windows offline state)",
        ],
        nextVerification: "inspect the queue (lpstat -p / Print Management) for the failed job that caused the pause",
        remediation: { steps: ["clear or requeue the failed job, then resume the queue"], requiresApproval: true },
      }));
    }
    if (queue?.value?.port && queue.value.expectedPort && queue.value.port !== queue.value.expectedPort) {
      findings.push(finding({
        severity: "medium",
        title: `print queue for ${subject} points at port '${queue.value.port}' instead of '${queue.value.expectedPort}'`,
        evidence: [queue.id], confidence: 0.8,
        alternativeCauses: [
          "the printer's IP changed and the queue still targets the old port (WSD ports do this silently on Windows)",
          "the queue was re-created against USB while the printer moved to the network",
        ],
        nextVerification: "compare the queue's configured port with the address the printer actually answers on",
        remediation: { steps: ["re-point the queue at a fixed IP port (Standard TCP/IP or socket), not WSD"], requiresApproval: true },
      }));
    }
  }
  return findings;
}

// ── DNS ───────────────────────────────────────────────────────────────────────────────────────

const SLOW_DNS_MS = 500;

export function checkDns(observations = []) {
  const findings = [];
  for (const o of observations) {
    if (o.kind === "dns-resolution" && (o.value?.ok === false || o.value?.error)) {
      findings.push(finding({
        severity: "high", title: `DNS resolution failed for ${o.value?.name ?? o.subject}`,
        evidence: [o.id], confidence: 0.8,
        alternativeCauses: [
          "the record genuinely does not exist (NXDOMAIN)",
          "the configured resolver is up but its upstream forwarder failed",
          "a search-domain / suffix misconfiguration on the querying host",
        ],
        nextVerification: "query the same name directly against the configured resolver and against a known-good public resolver, and compare",
        remediation: { steps: ["fix the record or the resolver chain once the failing stage is identified"], requiresApproval: true },
      }));
    }
    if (o.kind === "dns-forwarder" && o.value?.reachable === false) {
      findings.push(finding({
        severity: "high", title: `DNS forwarder ${o.value?.ip ?? o.subject} is unreachable`,
        evidence: [o.id], confidence: 0.8,
        alternativeCauses: [
          "the forwarder is down or the route to it is broken",
          "ICMP/53 is filtered while DNS itself still works — verify before treating as an outage",
        ],
        nextVerification: "send a real DNS query to the forwarder (dig @forwarder) rather than relying on reachability alone",
        remediation: { steps: ["restore the forwarder or repoint clients at a healthy resolver"], requiresApproval: true },
      }));
    }
    if (o.kind === "dns-resolution" && o.value?.ok === true && typeof o.value.latencyMs === "number" && o.value.latencyMs > SLOW_DNS_MS) {
      findings.push(finding({
        severity: "low", title: `DNS resolution for ${o.value?.name ?? o.subject} is slow (${o.value.latencyMs}ms)`,
        evidence: [o.id], confidence: 0.7,
        alternativeCauses: [
          "the local cache missed and the upstream is far away or loaded",
          "the first configured resolver is dead and queries fall through to the second after a timeout",
        ],
        nextVerification: "time repeated queries for the same name; a fast second answer points at caching, a consistently slow one at the resolver chain",
        remediation: { steps: ["reorder or replace resolvers once the slow stage is identified"], requiresApproval: true },
      }));
    }
  }
  return findings;
}

// ── gateway ───────────────────────────────────────────────────────────────────────────────────

export function checkGateway(observations = []) {
  const findings = [];
  for (const o of observations) {
    if (o.kind === "gateway-reachable" && o.value?.reachable === false) {
      findings.push(finding({
        severity: "high", title: `default gateway ${o.value?.ip ?? o.subject} is unreachable`,
        evidence: [o.id], confidence: 0.85,
        alternativeCauses: [
          "the gateway is down or the link to it has failed",
          "the host's configured gateway address is wrong for its subnet",
          "the gateway filters ICMP while still routing — verify with real traffic",
        ],
        nextVerification: "from the affected host, arping the gateway and try a real connection through it",
        remediation: { steps: ["restore the gateway/link, or correct the host's gateway configuration"], requiresApproval: true },
      }));
    }
    if (o.kind === "default-route" && (o.value === false || o.value?.present === false)) {
      findings.push(finding({
        severity: "high", title: `host ${o.subject} has no default route`,
        evidence: [o.id], confidence: 0.9,
        alternativeCauses: [
          "DHCP did not deliver a gateway (or the lease failed and the host fell back to link-local)",
          "the routing table was changed manually or by VPN software",
        ],
        nextVerification: "inspect the host's routing table and its DHCP lease for the missing gateway option",
        remediation: { steps: ["restore the default route via DHCP renewal or manual configuration"], requiresApproval: true },
      }));
    }
  }
  return findings;
}

// ── duplicate IP ──────────────────────────────────────────────────────────────────────────────

const MAC_OF = (o) => String(o.value?.mac ?? "").toLowerCase().replace(/[^0-9a-f]/g, "");
const IP_OF = (o) => o.value?.ip ?? o.subject;

export function checkDuplicateIp(observations = []) {
  const findings = [];
  const sightings = observations.filter((o) => ["arp-entry", "host-seen"].includes(o.kind) && IP_OF(o) && MAC_OF(o));
  const byIp = groupBy(sightings, IP_OF);
  for (const [ip, obs] of byIp) {
    const macs = [...new Set(obs.map(MAC_OF))];
    if (macs.length < 2) continue;
    findings.push(finding({
      severity: "high",
      title: `duplicate IP: ${ip} was observed with ${macs.length} different MAC addresses`,
      evidence: obs.map((o) => o.id), confidence: 0.9,
      alternativeCauses: [
        "two devices genuinely configured with the same address (ARP conflict)",
        "a device was replaced and the ARP cache has not aged out the old entry",
        "a failover/VRRP pair presenting the address from two interfaces during a transition",
      ],
      nextVerification: `query the switch CAM table for both MACs and locate the two physical ports claiming ${ip}`,
      remediation: { steps: [
        "identify both devices and remove the addressing conflict (static assignment or DHCP reservation)",
      ], requiresApproval: true },
    }));
  }
  return findings;
}

// ── subnet consistency ────────────────────────────────────────────────────────────────────────

export function checkSubnet(observations = []) {
  const findings = [];
  const gateways = observations.filter((o) => o.kind === "gateway" && o.value?.ip && prefixOf(o.value) !== null);
  const hosts = observations.filter((o) => o.kind === "host-address" && o.value?.ip && prefixOf(o.value) !== null);
  for (const h of hosts) {
    for (const g of gateways) {
      const bits = prefixOf(g.value);
      if (h.value.ip.includes(":") || g.value.ip.includes(":")) continue;
      if (!cidrContains(`${g.value.ip}/${bits}`, h.value.ip)) {
        findings.push(finding({
          severity: "high",
          title: `host ${h.subject} (${h.value.ip}/${prefixOf(h.value)}) is not in the gateway's subnet (${g.value.ip}/${bits})`,
          evidence: [h.id, g.id], confidence: 0.85,
          alternativeCauses: [
            "the host's netmask is wrong, so its idea of 'local' disagrees with the gateway's",
            "the host is configured for a different VLAN/subnet than the port it is plugged into",
          ],
          nextVerification: "compare the host's ip/mask and gateway against the subnet documented for that switch port / VLAN",
          remediation: { steps: ["correct the host's address or mask, or move it to the VLAN it is configured for"], requiresApproval: true },
        }));
      }
    }
  }
  return findings;
}

// ── everything ────────────────────────────────────────────────────────────────────────────────

export function runAllChecks(observations = []) {
  const all = [
    ...checkPrinter(observations),
    ...checkDns(observations),
    ...checkGateway(observations),
    ...checkDuplicateIp(observations),
    ...checkSubnet(observations),
  ];
  return all.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}

/**
 * An ordered plan — nothing more. Every step is a plain string plus requiresApproval:true;
 * this module contains no way to execute anything, and returns no executable handles.
 */
export function remediationPlan(findings = []) {
  const ordered = [...findings].sort((a, b) => RANK[a.severity] - RANK[b.severity]);
  const steps = [];
  for (const f of ordered) {
    const actions = f.remediation?.steps?.length
      ? f.remediation.steps
      : [`perform the verification step for finding ${f.id} before changing anything`];
    for (const action of actions) {
      steps.push(Object.freeze({
        order: steps.length + 1,
        findingId: f.id,
        severity: f.severity,
        action: String(action),
        requiresApproval: true,
      }));
    }
  }
  return Object.freeze(steps);
}
