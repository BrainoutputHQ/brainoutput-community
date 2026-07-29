#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// AI Firewall — what a model is allowed to be told.
//
// The ordering here is the whole point: **deterministic controls decide, the model does not**.
// A model cannot widen its own access, cannot ask for raw evidence, and cannot see a credential.
// Everything it receives has already been redacted, classified and bounded by this module.
//
// Sensitivity classes:
//   public     — safe anywhere
//   internal   — topology, hostnames, private IPs: local model, or sanitized summary externally
//   sensitive  — credentials, keys, personal data: NEVER leaves, NEVER reaches a model raw
import { createHash } from "node:crypto";

export const CLASSES = ["public", "internal", "sensitive"];

/**
 * Patterns that mark something as sensitive. Deliberately broad: a false positive costs a
 * redacted string in a prompt, a false negative costs a leaked credential.
 */
const SENSITIVE_PATTERNS = [
  { re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, label: "email" },
  { re: /\bsnmp[_-]?(community|string)\s*[:=]\s*\S+/gi,          label: "snmp-community" },
  { re: /\b(password|passwd|pwd|secret|api[_-]?key|token)\s*[:=]\s*\S+/gi, label: "credential" },
  { re: /\bBearer\s+[A-Za-z0-9._-]{16,}/gi,                      label: "bearer" },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, label: "private-key" },
  { re: /\b[0-9a-f]{32,}\b/gi,                                   label: "hash-or-key" },
  { re: /\$[0-9a-z]\$[^\s:]{8,}/gi,                              label: "password-hash" },
];

/** Things that are internal-only rather than secret: they may reach a LOCAL model, never outside. */
const INTERNAL_PATTERNS = [
  { re: /\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g, label: "private-ipv4" },
  { re: /\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/gi, label: "mac" },
  { re: /\bfe80::[0-9a-f:]+/gi,                  label: "link-local-ipv6" },
];

/** Redact sensitive values in place, reporting what was found. Never returns the original. */
export function sanitize(text) {
  let out = String(text ?? "");
  const found = [];
  for (const { re, label } of SENSITIVE_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, (m) => {
      found.push(label);
      // keep a stable fingerprint so two occurrences can be correlated without revealing either
      return `[${label}:${createHash("sha256").update(m).digest("hex").slice(0, 8)}]`;
    });
  }
  return { text: out, redacted: [...new Set(found)] };
}

/** Classify a value by the most sensitive thing it contains. */
export function classify(text) {
  const s = String(text ?? "");
  for (const { re } of SENSITIVE_PATTERNS) { re.lastIndex = 0; if (re.test(s)) return "sensitive"; }
  for (const { re } of INTERNAL_PATTERNS) { re.lastIndex = 0; if (re.test(s)) return "internal"; }
  return "public";
}

/**
 * The gate a model prompt passes through.
 *
 * `destination` is "local" or "external". External inference on internal topology is BLOCKED by
 * default — not warned about — because that is the decision a customer would make if asked, and
 * the model is not entitled to make it for them.
 */
export function guardPrompt({ text, destination = "local", allowExternalInternal = false, maxChars = 12000 }) {
  const cls = classify(text);
  const { text: clean, redacted } = sanitize(text);

  if (cls === "sensitive" && destination === "external")
    return { allowed: false, reason: "this evidence contains credentials or personal data and may not leave the machine", classification: cls, redacted };
  if (cls === "internal" && destination === "external" && !allowExternalInternal)
    return { allowed: false, reason: "this is internal topology; external inference is blocked. Use a local model, or approve a sanitized summary.", classification: cls, redacted };

  // Bound the payload. Whole event logs must never be shipped into a context window.
  let bounded = clean, truncated = false;
  if (bounded.length > maxChars) { bounded = bounded.slice(0, maxChars); truncated = true; }
  return { allowed: true, text: bounded, classification: cls, redacted, truncated };
}

/**
 * Build the ONLY payload a model is given for explanation.
 *
 * It receives findings that deterministic rules already produced, plus the observations those
 * findings cite — nothing else. It cannot request more, because there is no channel to.
 */
export function explanationPayload({ findings = [], observations = [], destination = "local", maxChars = 12000 } = {}) {
  const cited = new Set(findings.flatMap((f) => f.evidence || []));
  const relevant = observations.filter((o) => cited.has(o.id));
  const body = [
    "FINDINGS (produced by deterministic checks — do not invent, add or remove any):",
    ...findings.map((f) => `- [${f.severity}] ${f.title} (confidence ${f.confidence}) evidence=${(f.evidence || []).join(",")}`),
    "",
    "EVIDENCE (the only facts you may use):",
    ...relevant.map((o) => `- ${o.id} ${o.kind}/${o.subject} = ${JSON.stringify(o.value)} [${o.collector} ${o.method} @${new Date(o.at).toISOString()}]`),
  ].join("\n");

  const g = guardPrompt({ text: body, destination, maxChars });
  return {
    ...g,
    instruction:
      "Explain and correlate ONLY the findings above, using ONLY the listed evidence. " +
      "You may group findings, rank them and describe likely causes. " +
      "You must NOT invent scan results, add findings, assert anything not present in the evidence, " +
      "or claim a check was run that is not listed. If the evidence is insufficient, say so.",
  };
}

/**
 * Validate what a model returned. A model that invents a finding gets it dropped — the
 * deterministic set is authoritative and the explanation is advisory by construction.
 */
export function acceptExplanation({ findings = [], explanation = "" } = {}) {
  const known = new Set(findings.map((f) => f.id));
  const claimed = [...String(explanation).matchAll(/\bF-[A-Za-z0-9_-]+/g)].map((m) => m[0]);
  const invented = claimed.filter((id) => !known.has(id));
  return {
    text: String(explanation),
    invented,
    trustworthy: invented.length === 0,
    note: invented.length ? `the model referenced ${invented.length} finding id(s) that do not exist; its explanation is shown but carries no authority` : null,
  };
}
