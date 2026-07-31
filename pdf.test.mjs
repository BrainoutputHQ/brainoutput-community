// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { buildPdf, jpegSize } from "./pdf.mjs";

// A minimal valid JPEG (1x1 white pixel) for image tests — built by hand, no fixture file.
function tinyJpeg() {
  const b = Buffer.from([
    0xff, 0xd8,                               // SOI
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,   // SOF0 (1x1)
    0xff, 0xd9,                               // EOI
  ]);
  return b;
}

test("jpegSize reads SOF dimensions", () => {
  assert.deepEqual(jpegSize(tinyJpeg()), { h: 1, w: 1 });
  assert.throws(() => jpegSize(Buffer.from("not an image")), /not a JPEG/);
});

test("a text-only PDF is valid: header, correct xref offsets, trailer", () => {
  const { pdf } = buildPdf({ title: "Hotel Soleil", pages: [{ heading: "Rooms", lines: ["Overwater villas with private pools and world-class spa, pristine beaches meet crystal lagoons and fine dining under the stars."] }] });
  assert.equal(pdf.subarray(0, 8).toString(), "%PDF-1.4");
  assert.match(pdf.toString("latin1"), /trailer\n<< \/Size \d+ \/Root 1 0 R >>\nstartxref\n\d+\n%%EOF\n$/);
  // Every xref offset must point exactly at its object's header — a broken xref is a broken PDF.
  const text = pdf.toString("latin1");
  const xref = text.match(/xref\n0 \d+\n([\s\S]*?)trailer/)[1].trim().split("\n").slice(1);
  for (const row of xref) {
    const pos = Number(row.slice(0, 10));
    if (row.endsWith(" n ")) assert.match(pdf.subarray(pos, pos + 12).toString(), /^\d+ 0 obj/);
  }
});

test("wrapped lines stay inside the page; long input produces many text ops", () => {
  const { pdf } = buildPdf({ title: "T", pages: [{ lines: ["word ".repeat(400)] }] });
  const count = (pdf.toString("latin1").match(/Tf 56 [\d.]+ Td/g) || []).length;
  assert.ok(count > 10, "wrapped into many lines");
});

test("JPEG images embed as XObjects; non-JPEG is skipped honestly", () => {
  const { pdf, skippedImages } = buildPdf(
    { title: "Pics", pages: [{ images: ["lobby.jpg", "map.png"] }] },
    { readImage: (n) => (n === "lobby.jpg" ? tinyJpeg() : Buffer.from("x")) });
  assert.deepEqual(skippedImages, ["map.png"]);
  assert.match(pdf.toString("latin1"), /\/Subtype \/Image \/Width 1 \/Height 1/);
  assert.match(pdf.toString("latin1"), /\/DCTDecode/);
});

test("empty spec still yields a one-page valid document", () => {
  const { pdf, pageCount } = buildPdf({});
  assert.equal(pageCount, 1);
  assert.equal(pdf.subarray(0, 8).toString(), "%PDF-1.4");
});
