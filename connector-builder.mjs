// SPDX-License-Identifier: Apache-2.0
// BrainOutput Community Edition — custom app connector builder (2026-08-01, first-use gap:
// "I'm a hotel, I use Lodgify, it's not in BrainOutput — let me click add-app and be GUIDED").
//
// A custom connector is CONFIG + a sealed credential + the standard permission schema — never
// arbitrary LLM-written code executed by the runtime. The builder mission may SCAFFOLD reference
// code into the workspace (real files, artifacts), but what RUNS is the generic OpenAPI read
// adapter against the validated configuration. Defaults are read-only; elevated scopes need
// explicit grants; secrets are sealed by the server, never stored in the exportable definition.
import { newConnector } from "./connectors.mjs";

export const CUSTOM_AUTH = ["api-key", "oauth", "none"];

const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40);

/**
 * Draft a custom connector spec from the user's answers. `auth` picks the credential story:
 * api-key (most SaaS/PMS), oauth (needs the customer's own OAuth app — say so up front), none
 * (public/self-hosted without auth).
 */
export function draftConnectorSpec({ name, baseUrl = null, auth = "api-key", dataDescription = null } = {}) {
  if (!name || !String(name).trim()) throw new Error("a connector needs the app's name (e.g. Lodgify)");
  if (!CUSTOM_AUTH.includes(auth)) throw new Error(`unknown auth '${auth}' — one of ${CUSTOM_AUTH.join(", ")}`);
  const id = `custom-${slug(name)}`;
  const configFields = [
    { key: "baseUrl", label: "API base URL", required: true, example: "https://api.lodgify.com/v2" },
    ...(auth === "oauth"
      ? [{ key: "tokenUrl", label: "OAuth token URL", required: true }, { key: "clientId", label: "OAuth client id", required: true }]
      : []),
  ];
  const secretFields =
    auth === "api-key" ? [{ key: "apiKey", label: "API key / token", how: "stored sealed (encrypted at rest), never in exports" }]
    : auth === "oauth" ? [{ key: "clientSecret", label: "OAuth client secret", how: "stored sealed (encrypted at rest), never in exports" }]
    : [];
  return {
    id, name: String(name).trim(), label: `${name} (custom)`,
    mechanism: auth === "oauth" ? "oauth" : "openapi",
    connector: "generic-openapi",            // the runtime adapter that executes reads
    category: "custom",
    scopes: ["read"],                        // custom connectors are READ-ONLY, period (v1)
    baseUrl: baseUrl || null,
    dataDescription: dataDescription || null,
    configFields, secretFields,
    status: "needs-config",
    createdAt: null,
  };
}

/** The guided setup text — where to get credentials, and the security rules that apply. */
export function connectorGuide(spec) {
  const steps = [
    `1. In ${spec.name}, open the developer/API settings and create an API key (often “Settings → Integrations” or “Developer → API keys”).`,
    `2. Paste the API base URL${spec.baseUrl ? ` (${spec.baseUrl})` : ""} and the key here — the key is sealed (encrypted at rest) and never leaves this machine or any export.`,
    `3. BrainOutput probes the endpoint read-only and reports exactly what it got — a failed probe is shown, never hidden.`,
    `4. The connector starts READ-ONLY. Writes (creating or changing anything in ${spec.name}) are a separate explicit grant, with approval, and are not part of a custom connector yet.`,
  ];
  if (spec.mechanism === "oauth")
    steps.splice(0, 2, `1. ${spec.name} uses OAuth — create an OAuth app in your ${spec.name} developer console (you own the app and its credentials; BrainOutput never holds a shared one).`, `2. Paste the token URL, client id and client secret here — sealed, local, never exported.`);
  return steps.join("\n");
}

/** What must be configured before the connector can go ready. */
export function missingConfig(spec, config = {}, hasSecret = false) {
  const missing = spec.configFields.filter((f) => f.required && !config[f.key]).map((f) => f.key);
  if (spec.secretFields.length && !hasSecret) missing.push(spec.secretFields[0].key);
  return missing;
}

/** The connectors.mjs-compatible record: the permission schema applies exactly as for built-ins. */
export function toConnectorRecord(spec) {
  const c = newConnector("generic-openapi", { id: `connector:${spec.id}` });
  return { ...c, label: spec.label, custom: { id: spec.id, name: spec.name, baseUrl: spec.baseUrl } };
}

/** The deterministic build plan shown BEFORE approval — the “plan to approve”. */
export function connectorBuildPlan(spec) {
  return [
    `Scaffold the ${spec.name} connector module (config schema, read-only read function, error taxonomy) into the company workspace as REAL FILES`,
    `Write a smoke test that runs offline (mocked endpoint)`,
    `Register the connector with read-only permissions and its configuration schema`,
    `Collect credentials through the guided setup (sealed) and run a live verification probe`,
  ];
}
