// SPDX-License-Identifier: Apache-2.0
// BrainOutput — EDITION boundary + capability interface (repo architecture decision, 2026-07-28).
//
// Community is the authoritative, PUBLIC base (this repo). Cloud is a SEPARATE, private repo that
// EXTENDS Community by REGISTERING capability providers at runtime — it never edits Community core and
// never lands cloud-specific conditionals here. The hosted product consumes a PINNED, versioned
// Community release; it must not copy or fork this runtime. Zero-dep, pure.

export const EDITION = "community";

// Packages this repo owns (the complete Community runtime).
export const COMMUNITY_PACKAGES = [
  "runtime-core", "agent-schema", "capability-model-router", "execution-graph",
  "connector-sdk", "permissions", "opencode-adapter", "generic-agent-adapter", "local-persistence",
];

// Cloud-only packages — they live in brainoutput-cloud (private) and MUST NOT appear in Community.
export const CLOUD_ONLY_PACKAGES = [
  "control-plane", "tenant-manager", "billing", "hosted-sandbox", "managed-secrets",
  "fleet-provisioning", "enterprise-policy", "cloud-observability",
];

// EDITION CAPABILITY POINTS — the extension seams. Community ships a LOCAL default for each; Cloud may
// register an enhanced provider. Core code resolves a capability through withCapability(), so there are
// no cloud conditionals in the Community core.
export const EDITION_CAPABILITIES = [
  "secrets", "persistence", "sandbox", "observability", "identity", "metering", "tenancy", "deploy", "backups", "billing",
];

// Community DEFAULTS: local, single-tenant, $0. Cloud overrides these via registerCapability().
const COMMUNITY_DEFAULTS = {
  secrets:       { kind: "local-env" },
  persistence:   { kind: "local-json" },
  sandbox:       { kind: "local-opencode" },
  observability: { kind: "local-telemetry" },
  identity:      { kind: "single-user" },
  metering:      { kind: "local-usage" },
  tenancy:       { kind: "single-tenant" },
  deploy:        { kind: "local" },
  backups:       { kind: "none" },
  billing:       { kind: "none" },
};

const registry = new Map();

/** Cloud registers/overrides a capability provider. `name` must be a known capability point. */
export function registerCapability(name, provider) {
  if (!EDITION_CAPABILITIES.includes(name)) throw new Error(`unknown edition capability '${name}'`);
  registry.set(name, provider);
  return provider;
}
export function hasCapability(name) { return registry.has(name); }

/** Resolve a capability: a registered (cloud) provider if present, else the Community local default. */
export function getCapability(name) { return registry.get(name) || COMMUNITY_DEFAULTS[name] || null; }

/** Core code calls this — a cloud provider wins if registered, else the given/community fallback. */
export function withCapability(name, fallback) {
  return registry.get(name) || fallback || COMMUNITY_DEFAULTS[name] || null;
}

export function editionInfo() {
  return {
    edition: EDITION,
    capabilities: EDITION_CAPABILITIES.map((n) => ({
      name: n, provider: (registry.get(n) || COMMUNITY_DEFAULTS[n])?.kind || "unset", cloudProvided: registry.has(n),
    })),
  };
}

/**
 * The manifest EVERY hosted release must record (architecture decision): the pinned Community version
 * and commit it consumes, the Cloud version and commit, the schema/migration version, and the connector
 * catalog version. Returns { ok, missing, manifest }.
 */
export function hostedReleaseManifest(fields = {}) {
  const required = ["communityVersion", "communityCommit", "cloudVersion", "cloudCommit", "schemaVersion", "connectorCatalogVersion"];
  const missing = required.filter((k) => !fields[k]);
  const manifest = Object.fromEntries(required.map((k) => [k, fields[k] ?? null]));
  return { ok: missing.length === 0, missing, manifest };
}
