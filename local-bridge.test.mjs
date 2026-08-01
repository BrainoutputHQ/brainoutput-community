// The local bridge: pairing discipline, credential verification, grant enforcement (both sides),
// the fixed verb set, and the full poll → call → result loop with a real executor.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalNodes, bridgePair, bridgeLoop, makeLocalExec, BRIDGE_VERBS, PAIR_CODE_TTL_MS } from "./local-bridge.mjs";

const NOW = 1_800_000_000_000;
const nodes = () => new LocalNodes({ clock: () => NOW });

test("pairing codes are single-use and expire; verification is constant-time", () => {
  const n = nodes();
  const { code } = n.issueCode({ now: NOW });
  const { nodeId, credential } = n.redeemCode(code, { name: "laptop", grants: ["/home/me/docs"], now: NOW });
  assert.match(nodeId, /^node-/);
  assert.equal(n.verifyNode(nodeId, credential), true);
  assert.equal(n.verifyNode(nodeId, credential + "x"), false);
  assert.throws(() => n.redeemCode(code, { now: NOW }), /already used/);
  assert.throws(() => n.redeemCode("NOPE-0000", { now: NOW }), /unknown pairing code/);
  const late = new LocalNodes({ clock: () => NOW + PAIR_CODE_TTL_MS + 1 });
  const c2 = n.issueCode({ now: NOW });
  late.codes = n.codes;
  assert.throws(() => late.redeemCode(c2.code, { now: NOW + PAIR_CODE_TTL_MS + 1 }), /expired/);
});

test("grants are enforced server-side BEFORE the bridge is asked, and again in the executor", async () => {
  const n = nodes();
  const { code } = n.issueCode({ now: NOW });
  const { nodeId } = n.redeemCode(code, { grants: ["/granted"], now: NOW });
  n.nodes.get(nodeId).lastSeenAt = NOW;                          // simulate an online node
  await assert.rejects(() => n.call(nodeId, "read-file", { path: "/etc/passwd" }, { now: NOW }), /outside this node's granted/);
  await assert.rejects(() => n.call(nodeId, "format-disk", {}, { now: NOW }), /unknown bridge verb/);
  assert.deepEqual(BRIDGE_VERBS, ["list-models", "complete", "list-files", "read-file"], "the protocol is exactly four verbs");
  const exec = makeLocalExec({ allow: ["/granted"] });
  await assert.rejects(() => exec("read-file", { path: "/granted/../etc/hosts" }), /outside the granted folders/);
});

test("revoke kills the node immediately (held polls dropped, calls refused)", async () => {
  const n = nodes();
  const { code } = n.issueCode({ now: NOW });
  const { nodeId, credential } = n.redeemCode(code, { now: NOW });
  n.nodes.get(nodeId).lastSeenAt = NOW;
  n.revoke(nodeId, { now: NOW });
  assert.equal(n.verifyNode(nodeId, credential), false);
  await assert.rejects(() => n.call(nodeId, "list-models", {}, { now: NOW }), /not paired/);
  assert.equal(n.listPublic({ now: NOW }).length, 0, "revoked nodes disappear from the UI");
});

test("the full loop: pair → poll → call → local exec → result (files stay inside the grant)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bo-bridge-"));
  mkdirSync(join(dir, "contracts"));
  writeFileSync(join(dir, "contracts", "rates.txt"), "august -30% lake rooms");
  try {
    const n = new LocalNodes();
    // a fake HTTP-less transport wired straight to the registry, like the endpoints do
    const post = async (path, body) => {
      if (path === "/api/local/pair") {
        try { return n.redeemCode(body.code, { name: body.name, grants: body.grants }); } catch (e) { return { error: e.message }; }
      }
      if (path === "/api/local/poll") {
        if (!n.verifyNode(body.nodeId, body.credential)) return { error: "unauthorized" };
        return n.poll(body.nodeId, { holdMs: 50 });
      }
      if (path === "/api/local/result") return n.postResult(body.nodeId, body);
      throw new Error("unknown path " + path);
    };
    const node = await bridgePair({ url: "test", code: n.issueCode().code, name: "laptop", grants: [dir], post });
    const exec = makeLocalExec({ allow: [dir] });
    // run ONE poll iteration in the background; the server call lands in it
    const loopP = bridgeLoop({ url: "test", nodeId: node.nodeId, credential: node.credential, exec, post, once: true, holdMs: 50 });
    await new Promise((r) => setTimeout(r, 20));               // let the poll open
    assert.equal(n.online(node.nodeId), true, "polling marks the node online");
    const files = await n.call(node.nodeId, "list-files", { root: dir }, { timeoutMs: 2000 });
    await loopP;
    assert.ok(files.files.some((f) => f.name === "rates.txt"));
    const loop2 = bridgeLoop({ url: "test", nodeId: node.nodeId, credential: node.credential, exec, post, once: true, holdMs: 50 });
    await new Promise((r) => setTimeout(r, 20));
    const read = await n.call(node.nodeId, "read-file", { path: join(dir, "contracts", "rates.txt") }, { timeoutMs: 2000 });
    await loop2;
    assert.match(read.content, /lake rooms/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the executor's model verbs talk to local ollama only (stubbed here)", async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push(url);
    if (url.endsWith("/api/tags")) return { json: async () => ({ models: [{ name: "qwen3:8b" }] }) };
    return { ok: true, json: async () => ({ message: { content: "local answer" }, eval_count: 10, prompt_eval_count: 20 }) };
  };
  const exec = makeLocalExec({ fetchImpl });
  assert.deepEqual((await exec("list-models")).models, ["qwen3:8b"]);
  const r = await exec("complete", { model: "qwen3:8b", prompt: "hi" });
  assert.equal(r.content, "local answer");
  assert.equal(r.tokens, 30);
  assert.equal(r.tokenScope, "total");
  assert.ok(calls.every((u) => u.startsWith("http://127.0.0.1:11434")), "nothing leaves the machine");
});
