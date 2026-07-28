// SPDX-License-Identifier: Apache-2.0
// Edition boundary — the interface + the guard that keeps hosted-only code OUT of Community.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  EDITION, EDITION_CAPABILITIES, CLOUD_ONLY_PACKAGES, COMMUNITY_PACKAGES,
  registerCapability, hasCapability, getCapability, withCapability, editionInfo, hostedReleaseManifest,
} from "./editions.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

test("Community is the base edition; every capability point has a local default", () => {
  assert.equal(EDITION, "community");
  const info = editionInfo();
  assert.equal(info.edition, "community");
  for (const c of info.capabilities) {
    assert.notEqual(c.provider, "unset"); // a community default exists for each
    assert.equal(c.cloudProvided, false); // nothing cloud registered in Community
  }
});

test("Cloud extends via registerCapability without Community conditionals", () => {
  assert.throws(() => registerCapability("not-a-capability", {}), /unknown edition capability/);
  assert.equal(withCapability("secrets").kind, "local-env"); // default
  registerCapability("secrets", { kind: "vault" });          // Cloud overrides
  assert.equal(hasCapability("secrets"), true);
  assert.equal(getCapability("secrets").kind, "vault");
  assert.equal(withCapability("secrets").kind, "vault");
});

test("hosted release manifest requires community+cloud version/commit, schema, connector catalog", () => {
  const bad = hostedReleaseManifest({ communityVersion: "0.1.0" });
  assert.equal(bad.ok, false);
  assert.ok(bad.missing.includes("cloudCommit") && bad.missing.includes("schemaVersion"));
  const good = hostedReleaseManifest({
    communityVersion: "0.1.0", communityCommit: "abc", cloudVersion: "0.0.1", cloudCommit: "def",
    schemaVersion: "3", connectorCatalogVersion: "1",
  });
  assert.equal(good.ok, true);
});

test("GUARD: no Community source imports a cloud package or implements a cloud-only module", () => {
  const cloudNames = CLOUD_ONLY_PACKAGES.map((p) => p.replace(/-/g, "[-_]?"));
  const importRe = new RegExp(`from\\s+["'][^"']*(brainoutput-cloud|${cloudNames.join("|")})`, "i");
  const files = readdirSync(HERE).filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs"));
  for (const f of files) {
    const src = readFileSync(join(HERE, f), "utf8");
    assert.doesNotMatch(src, importRe, `${f} imports a cloud-only package — cloud code must live in brainoutput-cloud`);
    // a source file must not be NAMED after a cloud-only package (that would be a cloud module here)
    assert.ok(!CLOUD_ONLY_PACKAGES.includes(f.replace(/\.mjs$/, "")), `${f} is a cloud-only module in Community`);
  }
});

test("the package lists are disjoint (no package is both Community and Cloud)", () => {
  const overlap = COMMUNITY_PACKAGES.filter((p) => CLOUD_ONLY_PACKAGES.includes(p));
  assert.deepEqual(overlap, []);
});
