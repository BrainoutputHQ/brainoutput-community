#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Infrastructure Twin — what discovery knows about ONE site's assets, built only from evidence.
//
// Everything a twin asserts traces to an Observation; nothing here is inferred by a model.
// Correlation is a deterministic identity rule: MAC > serial > certFingerprint > hostname > IP.
// The rule that outranks convenience: an IP ALONE never merges two assets. DHCP reassigns
// addresses daily, and merging on IP silently fuses two machines into one — every finding derived
// from that fused asset becomes fiction. When evidence conflicts we keep BOTH assets and mark
// `uncertain`: a technician can resolve uncertainty, but a silent guess cannot be undone.
//
// Pure logic: no I/O, no clock beyond an injected `now`. Zero-dep ESM.

/** Default evidence lifetime. Stale evidence is reported AS STALE, never presented as current. */
export const DEFAULT_STALE_AFTER_MS = 24 * 3600 * 1000;

/** Bound the observation log — an unbounded log means an unbounded store file. Newest wins. */
export const OBSERVATION_LIMIT = 5000;

// Hard identifiers are properties of the hardware itself. Hostnames and IPs are names a network
// assigns — they corroborate identity, they never outrank hardware evidence.
const HARD_KEYS = ["mac", "serial", "certFingerprint"];
const MATCH_KEYS = [...HARD_KEYS, "hostname"];

const normMac = (m) => String(m || "").toLowerCase().replace(/[^0-9a-f]/g, "");

/** Pull the identity signals out of an observation's value, normalized for comparison. */
export function identifiersOf(observation = {}) {
  const v = observation.value || {};
  const ips = [...(Array.isArray(v.ips) ? v.ips : []), ...(v.ip ? [v.ip] : [])]
    .map((x) => String(x)).filter(Boolean);
  return {
    mac: v.mac ? normMac(v.mac) : null,
    serial: v.serial ? String(v.serial) : null,
    certFingerprint: v.certFingerprint ? String(v.certFingerprint).toLowerCase() : null,
    hostname: v.hostname ? String(v.hostname).toLowerCase() : null,
    ips: [...new Set(ips)],
    vendor: v.vendor || null,
  };
}

export function createTwin({ site, at = Date.now() } = {}) {
  if (!site) throw new Error("infra twin: a site name is required");
  return { id: `infra:${site}`, kind: "infra-twin", site,
    assets: [], observations: [], findings: [], createdAt: at, updatedAt: at };
}

// ── correlation — the one place identity is decided ─────────────────────────────────────────────

function spawn(assets, observation, ids, uncertain) {
  // The id is derived from the STRONGEST signal so the same hardware keeps the same id across
  // runs; on collision (conflicting evidence) we suffix rather than overwrite the other asset.
  const strong = ids.mac ? `mac:${ids.mac}` : ids.serial ? `serial:${ids.serial}`
    : ids.certFingerprint ? `cert:${ids.certFingerprint}` : ids.hostname ? `host:${ids.hostname}`
    : ids.ips[0] ? `ip:${ids.ips[0]}` : `obs:${observation.id}`;
  const taken = new Set(assets.map((a) => a.id));
  let id = strong, n = 2;
  while (taken.has(id)) id = `${strong}#${n++}`;
  return {
    id, kind: observation.value?.assetKind || "host",
    identifiers: { mac: ids.mac, serial: ids.serial, hostname: ids.hostname,
      ip: [...ids.ips], certFingerprint: ids.certFingerprint, vendor: ids.vendor },
    firstSeen: observation.at ?? null, lastSeen: observation.at ?? null,
    observations: [observation.id],
    ...(uncertain ? { uncertain } : {}),
  };
}

function absorb(asset, observation, ids) {
  const at = observation.at ?? null;
  return {
    ...asset,
    identifiers: {
      ...asset.identifiers,
      // Never overwrite a hard identifier here: absorb() only runs when nothing contradicted,
      // so an empty field is filled and a set field is kept.
      mac: asset.identifiers.mac || ids.mac,
      serial: asset.identifiers.serial || ids.serial,
      certFingerprint: asset.identifiers.certFingerprint || ids.certFingerprint,
      hostname: ids.hostname || asset.identifiers.hostname,
      ip: [...new Set([...(asset.identifiers.ip || []), ...ids.ips])],
      vendor: asset.identifiers.vendor || ids.vendor,
    },
    lastSeen: at != null ? Math.max(asset.lastSeen ?? 0, at) : asset.lastSeen,
    observations: [...asset.observations, observation.id],
  };
}

/**
 * Correlate one observation with the known assets. Returns { assets, asset, decision, reason? }.
 * Identity precedence: MAC > serial > certFingerprint > hostname. IP is deliberately NOT a match
 * key: it only ever gets ATTACHED to an asset already identified by something stronger.
 */
export function correlate(assets, observation) {
  const ids = identifiersOf(observation);
  const byKey = {};
  for (const key of MATCH_KEYS)
    if (ids[key]) byKey[key] = assets.filter((a) => a.identifiers[key] === ids[key]);
  const matched = [...new Map(Object.values(byKey).flat().map((a) => [a.id, a])).values()];

  // Two DIFFERENT assets each claim a piece of this evidence. Never fuse them: attach the
  // observation to the strongest claim and mark every claimant uncertain for a human to resolve.
  if (matched.length > 1) {
    const strongest = byKey.mac?.[0] || byKey.serial?.[0] || byKey.certFingerprint?.[0] || byKey.hostname?.[0];
    const reason = `conflicting identity: evidence matches both ${matched.map((a) => a.id).join(" and ")}`;
    return {
      assets: assets.map((a) => !matched.includes(a) ? a
        : { ...(a === strongest ? absorb(a, observation, ids) : a), uncertain: reason }),
      asset: strongest.id, decision: "conflict", reason,
    };
  }

  const target = matched[0];
  if (target) {
    // One asset matches — but a DIFFERENT hard identifier in the same observation contradicts it.
    // Same MAC with a different serial means two devices (or a spoof): keep both, flag both.
    for (const key of HARD_KEYS) {
      if (ids[key] && target.identifiers[key] && ids[key] !== target.identifiers[key]) {
        const reason = `conflicting ${key}: observed '${ids[key]}' but ${target.id} has '${target.identifiers[key]}'`;
        const fresh = spawn(assets, observation, ids, reason);
        return {
          assets: [...assets.map((a) => (a === target ? { ...a, uncertain: reason } : a)), fresh],
          asset: fresh.id, decision: "conflict", reason,
        };
      }
    }
    return { assets: assets.map((a) => (a === target ? absorb(a, observation, ids) : a)),
      asset: target.id, decision: "merged" };
  }

  // No strong signal matched. Even if the IP is already known on another asset, we do NOT merge
  // on IP alone — that is the DHCP trap this module exists to avoid.
  const fresh = spawn(assets, observation, ids);
  return { assets: [...assets, fresh], asset: fresh.id, decision: "created" };
}

/** Merge a batch of observations into the twin, re-correlating assets. Returns a NEW twin. */
export function ingest(twin, observations = [], { now = Date.now(), selfHost = "this-host" } = {}) {
  let assets = twin.assets;
  for (const obs of observations) {
    const ids = identifiersOf(obs);
    // An observation carrying NO identifier is a fact about the machine we are running on — cpu,
    // memory, a mounted disk. Correlating it as its own asset would turn one laptop into forty
    // "assets" and make the inventory meaningless. Attribute it to the local host instead.
    if (!ids.mac && !ids.serial && !ids.certFingerprint && !ids.hostname && !(ids.ip || []).length) {
      const local = { ...obs, value: { ...(typeof obs.value === "object" && obs.value ? obs.value : { value: obs.value }), hostname: selfHost } };
      assets = correlate(assets, local).assets;
      continue;
    }
    assets = correlate(assets, obs).assets;
  }
  const log = [...twin.observations, ...observations];
  return { ...twin, assets,
    observations: log.length > OBSERVATION_LIMIT ? log.slice(log.length - OBSERVATION_LIMIT) : log,
    updatedAt: now };
}

// ── freshness ───────────────────────────────────────────────────────────────────────────────────

export function isStale(observation, { now = Date.now(), staleAfterMs = DEFAULT_STALE_AFTER_MS } = {}) {
  return observation.at == null || now - observation.at > staleAfterMs;
}

/** How fresh is this twin's evidence? Stale observations are NAMED, never silently counted. */
export function freshness(twin, { now = Date.now(), staleAfterMs = DEFAULT_STALE_AFTER_MS } = {}) {
  const stale = twin.observations.filter((o) => isStale(o, { now, staleAfterMs }));
  return {
    asOf: now, staleAfterMs,
    total: twin.observations.length,
    fresh: twin.observations.length - stale.length,
    stale: stale.length,
    staleObservations: stale.map((o) => ({ id: o.id, ageMs: now - (o.at ?? 0) })),
  };
}

// ── derived views ───────────────────────────────────────────────────────────────────────────────

// Observation kinds that state a dependency, and the value field holding the target reference.
const DEPENDENCIES = { gateway: "gateway", dns: "dns", "print-queue": "queue" };

/** Assets as nodes; dependencies (host→gateway, host→dns, printer→queue) as evidenced edges. */
export function topology(twin) {
  const nodes = twin.assets.map((a) => ({ id: a.id, kind: a.kind,
    hostname: a.identifiers.hostname, ip: a.identifiers.ip, uncertain: !!a.uncertain }));
  const byIp = new Map();
  const byHost = new Map();
  for (const a of twin.assets) {
    for (const ip of a.identifiers.ip || []) if (!byIp.has(ip)) byIp.set(ip, a.id);
    if (a.identifiers.hostname && !byHost.has(a.identifiers.hostname)) byHost.set(a.identifiers.hostname, a.id);
  }
  const obsById = new Map(twin.observations.map((o) => [o.id, o]));
  const edges = [];
  const seen = new Set();
  for (const a of twin.assets) {
    for (const obsId of a.observations) {
      const obs = obsById.get(obsId);
      const field = obs && DEPENDENCIES[obs.kind];
      const ref = field && String(obs.value?.[field] || obs.value?.target || "");
      if (!ref) continue;
      const key = `${a.id}|${DEPENDENCIES[obs.kind]}|${ref}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const to = byIp.get(ref) || byHost.get(ref.toLowerCase()) || null;
      // An edge to something we have not identified is kept with its raw reference — reported
      // as unresolved, never drawn as if it were a known asset.
      edges.push({ from: a.id, to, toRef: to ? undefined : ref, kind: DEPENDENCIES[obs.kind], evidence: obs.id });
    }
  }
  return { nodes, edges };
}

/** One compact printable row per asset, column-aligned, uncertainty visible at a glance. */
export function inventory(twin) {
  const head = ["asset", "kind", "hostname", "mac", "ip", "last seen", "flags"];
  const rows = twin.assets.map((a) => [
    a.id, a.kind, a.identifiers.hostname || "-", a.identifiers.mac || "-",
    (a.identifiers.ip || []).join(",") || "-",
    a.lastSeen != null ? new Date(a.lastSeen).toISOString() : "-",
    a.uncertain ? "UNCERTAIN" : "",
  ]);
  const width = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (r) => r.map((c, i) => String(c).padEnd(width[i])).join("  ").trimEnd();
  return [line(head), ...rows.map(line)].join("\n");
}

// ── persistence (store.runtime.infraTwins) ──────────────────────────────────────────────────────

/** Upsert the twin into the store and persist. Survives a restart like any other runtime record. */
export function saveTwin(store, twin) {
  const list = (store.runtime.infraTwins ||= []);
  const i = list.findIndex((t) => t.id === twin.id);
  if (i >= 0) list[i] = twin; else list.push(twin);
  store.saveRuntime();
  return twin;
}

/** Load a twin by site, or the most recently updated one. Null when none exists — never a guess. */
export function loadTwin(store, { site = null } = {}) {
  const list = store.runtime.infraTwins || [];
  if (site) return list.find((t) => t.site === site) || null;
  return list.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] || null;
}
