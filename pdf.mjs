// SPDX-License-Identifier: Apache-2.0
// BrainOutput Community Edition — minimal REAL PDF writer, zero-dep (2026-07-31).
// A "create a PDF" mission must deliver a PDF, not code that could make one. This renders a
// structured spec into a valid PDF 1.4 file: A4 pages, headings, wrapped text lines, and
// embedded JPEG images (e.g. uploaded hotel photos). PNG is skipped honestly (JPEG only).
import { readFileSync } from "node:fs";
import { join } from "node:path";

const A4 = { w: 595.28, h: 841.89 };
const MARGIN = 56;
const escPdf = (s) => String(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

/** Wrap a line to fit a width at a font size (approximation: 0.5em per char). */
function wrap(text, fontSize, maxWidth) {
  const maxChars = Math.max(8, Math.floor(maxWidth / (fontSize * 0.5)));
  const words = String(text).split(/\s+/);
  const lines = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > maxChars) { if (cur) lines.push(cur); cur = w; }
    else cur = (cur + " " + w).trim();
  }
  if (cur) lines.push(cur);
  return lines;
}

/** JPEG dimensions from SOF markers (needed for the image XObject). */
export function jpegSize(buf) {
  let i = 2;
  while (i < buf.length - 9) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  throw new Error("not a JPEG (SOF marker not found)");
}

/**
 * spec: { title, pages: [{ heading?, lines?: string[], images?: string[] }] }
 * imagesDir: where uploaded files live (only .jpg/.jpeg are embedded; others are skipped + noted).
 * Returns { pdf: Buffer, skippedImages: string[] }.
 */
export function buildPdf(spec, { imagesDir = null, readImage = null } = {}) {
  const skipped = [];
  const pages = spec?.pages?.length ? spec.pages : [{ heading: spec?.title || "Document", lines: [] }];

  // ── plan objects ──────────────────────────────────────────────────────────
  // 1 catalog · 2 pages · 3 font · 4..3+N page objects · then content + images
  const objects = []; // {num, body: string|Buffer}
  const pageObjs = [];
  let nextNum = 4;
  const contentObjs = [];
  const imageObjs = [];

  for (const [pi, page] of pages.entries()) {
    const ops = [];
    let y = A4.h - MARGIN;
    if (pi === 0 && spec.title) {
      ops.push(`BT /F1 24 Tf ${MARGIN} ${y} Td (${escPdf(spec.title)}) Tj ET`);
      y -= 40;
    }
    if (page.heading) {
      ops.push(`BT /F1 16 Tf ${MARGIN} ${y} Td (${escPdf(page.heading)}) Tj ET`);
      y -= 26;
    }
    for (const line of page.lines || []) {
      for (const wrapped of wrap(line, 10, A4.w - 2 * MARGIN)) {
        if (y < MARGIN + 20) break;
        ops.push(`BT /F1 10 Tf ${MARGIN} ${y} Td (${escPdf(wrapped)}) Tj ET`);
        y -= 14;
      }
      y -= 4;
    }
    const xObjects = [];
    for (const name of page.images || []) {
      try {
        if (!/\.jpe?g$/i.test(name)) { skipped.push(name); continue; }
        const buf = readImage ? readImage(name) : readFileSync(join(imagesDir, name));
        const { w, h } = jpegSize(buf);
        const imgNum = nextNum++;
        imageObjs.push({ num: imgNum, buf, w, h });
        const dispW = Math.min(A4.w - 2 * MARGIN, 300);
        const dispH = (dispW * h) / w;
        if (y - dispH < MARGIN) continue;
        xObjects.push({ num: imgNum, w: dispW, h: dispH, y: y - dispH });
        y -= dispH + 16;
      } catch { skipped.push(name); }
    }
    for (const xo of xObjects)
      ops.push(`q ${xo.w} 0 0 ${xo.h} ${MARGIN} ${xo.y} cm /Im${xo.num} Do Q`);
    const contentNum = nextNum++;
    const stream = ops.join("\n");
    contentObjs.push({ num: contentNum, stream });
    const pageNum = nextNum++;
    pageObjs.push({ num: pageNum, contentNum, images: xObjects });
  }

  objects.push({ num: 1, body: `<< /Type /Catalog /Pages 2 0 R >>` });
  objects.push({ num: 2, body: `<< /Type /Pages /Kids [${pageObjs.map((p) => `${p.num} 0 R`).join(" ")}] /Count ${pageObjs.length} >>` });
  objects.push({ num: 3, body: `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>` });
  for (const p of pageObjs) {
    const xo = p.images.length ? ` /XObject << ${p.images.map((i) => `/Im${i.num} ${i.num} 0 R`).join(" ")} >>` : "";
    objects.push({ num: p.num, body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.w} ${A4.h}] /Resources << /Font << /F1 3 0 R >>${xo} >> /Contents ${p.contentNum} 0 R >>` });
  }
  for (const c of contentObjs)
    objects.push({ num: c.num, body: Buffer.concat([Buffer.from(`<< /Length ${Buffer.byteLength(c.stream)} >>\nstream\n`), Buffer.from(c.stream), Buffer.from("\nendstream")]) });
  for (const im of imageObjs)
    objects.push({ num: im.num, body: Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.buf.length} >>\nstream\n`), im.buf, Buffer.from("\nendstream")]) });
  objects.sort((a, b) => a.num - b.num);

  // ── serialize with a CORRECT xref table (offsets are what make a PDF a PDF) ──
  const chunks = [Buffer.from("%PDF-1.4\n")];
  const offsets = [];
  let pos = chunks[0].length;
  for (const o of objects) {
    offsets.push({ num: o.num, pos });
    const head = Buffer.from(`${o.num} 0 obj\n`);
    const body = Buffer.isBuffer(o.body) ? o.body : Buffer.from(o.body);
    const tail = Buffer.from("\nendobj\n");
    chunks.push(head, body, tail);
    pos += head.length + body.length + tail.length;
  }
  const xrefPos = pos;
  const maxNum = Math.max(...objects.map((o) => o.num));
  let xref = `xref\n0 ${maxNum + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxNum; n++) {
    const off = offsets.find((o) => o.num === n);
    xref += `${String(off ? off.pos : 0).padStart(10, "0")} 00000 ${off ? "n" : "f"} \n`;
  }
  const trailer = `trailer\n<< /Size ${maxNum + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  chunks.push(Buffer.from(xref + trailer));
  return { pdf: Buffer.concat(chunks), skippedImages: skipped, pageCount: pageObjs.length };
}
