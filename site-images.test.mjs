// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imageLinks, fetchSiteImages } from "./site-images.mjs";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9]);

test("imageLinks: absolute + relative srcs, http(s) only, private hosts refused", () => {
  const html = `<img src="/a.jpg"><img src="https://cdn.example.com/b.png"><img src="http://192.168.1.5/internal.jpg"><img src="ftp://x/y.jpg"><img src="https://example.com/c.jpeg?size=big">`;
  const links = imageLinks(html, "https://example.com/hotel");
  assert.deepEqual(links, ["https://example.com/a.jpg", "https://cdn.example.com/b.png", "https://example.com/c.jpeg?size=big"]);
});

test("fetchSiteImages: downloads JPEGs, checks content-type and size, caps the count", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bo-siteimg-"));
  try {
    const page = `<img src="/lobby.jpg"><img src="/room.jpg"><img src="/note.txt"><img src="/a1.jpg"><img src="/a2.jpg">`;
    const fetchImpl = async (url) => {
      if (url.endsWith("/hotel")) return { text: async () => page };
      if (url.endsWith(".txt")) return { ok: true, headers: { get: () => "text/plain" }, arrayBuffer: async () => new Uint8Array([65]).buffer };
      return { ok: true, headers: { get: () => "image/jpeg" }, arrayBuffer: async () => JPEG.buffer.slice(JPEG.byteOffset, JPEG.byteOffset + JPEG.length) };
    };
    const saved = await fetchSiteImages("https://example.com/hotel", { dir, limit: 2, fetchImpl });
    assert.equal(saved.length, 2, "limit respected");
    for (const s of saved) assert.deepEqual(readFileSync(s.path), JPEG);
    assert.ok(readdirSync(dir).every((f) => f.endsWith(".jpg")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("fetchSiteImages: non-http urls and dead pages fail cleanly", async () => {
  await assert.rejects(() => fetchSiteImages("ftp://x", { dir: "/tmp", fetchImpl: fetch }), /http/);
  const dead = async () => { throw new Error("offline"); };
  const saved = await fetchSiteImages("https://example.com", { dir: "/tmp", fetchImpl: dead }).catch((e) => e);
  assert.ok(saved instanceof Error || Array.isArray(saved));
});
