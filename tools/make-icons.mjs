#!/usr/bin/env node
/**
 * Generate the extension's PNG icons from code.
 *
 * Chrome only accepts raster icons in the manifest, so rather than checking in
 * opaque binaries we render them here: a rounded gradient tile with a
 * magnifying glass over three bars. Run `npm run icons` after changing the art.
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
const SIZES = [16, 32, 48, 128];
const SUPERSAMPLE = 4;

// ------------------------------------------------------------- PNG encoder --
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** @param {Uint8Array} rgba length = width * height * 4 */
function encodePng(rgba, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0 (None)
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------- art ----
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;

/** Signed distance to a rounded rectangle centred in an S×S box. */
function roundedRectSdf(x, y, S, radius) {
  const half = S / 2;
  const dx = Math.abs(x - half) - (half - radius);
  const dy = Math.abs(y - half) - (half - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

/** Signed distance to a capsule (thick line segment). */
function capsuleSdf(px, py, ax, ay, bx, by, r) {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const t = clamp01((apx * abx + apy * aby) / (abx * abx + aby * aby));
  return Math.hypot(apx - abx * t, apy - aby * t) - r;
}

function renderTile(S) {
  // Supersampled RGBA buffer, premultiplied compositing done manually.
  const px = new Float64Array(S * S * 4);

  const cx = S * 0.43;
  const cy = S * 0.43;
  const ringR = S * 0.235;
  const ringT = S * 0.072;
  const handleR = S * 0.045;

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const fx = x + 0.5;
      const fy = y + 0.5;

      // Background tile.
      const d = roundedRectSdf(fx, fy, S, S * 0.235);
      const bgAlpha = clamp01(0.5 - d);
      const t = clamp01((fx / S) * 0.6 + (fy / S) * 0.4);
      let r = lerp(0x63, 0x0e, t);
      let g = lerp(0x66, 0xa5, t);
      let b = lerp(0xf1, 0xe9, t);
      let a = bgAlpha;

      // Foreground: magnifier ring + handle + three bars, all white.
      const ringD = Math.abs(Math.hypot(fx - cx, fy - cy) - ringR) - ringT / 2;
      const hx = cx + ringR * 0.72;
      const hy = cy + ringR * 0.72;
      const handleD = capsuleSdf(fx, fy, hx, hy, S * 0.82, S * 0.82, handleR);

      let fgD = Math.min(ringD, handleD);

      // Bars inside the lens.
      const barW = S * 0.036;
      const barBottom = cy + ringR * 0.5;
      const bars = [
        [cx - ringR * 0.42, barBottom - ringR * 0.42],
        [cx, barBottom - ringR * 0.78],
        [cx + ringR * 0.42, barBottom - ringR * 0.6],
      ];
      for (const [bxc, byTop] of bars) {
        fgD = Math.min(fgD, capsuleSdf(fx, fy, bxc, byTop, bxc, barBottom, barW));
      }

      const fgAlpha = clamp01(0.5 - fgD) * bgAlpha;
      if (fgAlpha > 0) {
        r = lerp(r, 255, fgAlpha);
        g = lerp(g, 255, fgAlpha);
        b = lerp(b, 255, fgAlpha);
        a = Math.max(a, fgAlpha);
      }

      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
      px[i + 3] = a * 255;
    }
  }
  return px;
}

/** Box-downsample the supersampled buffer to the final size. */
function downsample(src, S, size) {
  const factor = S / size;
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < factor; sy++) {
        for (let sx = 0; sx < factor; sx++) {
          const i = ((y * factor + sy) * S + (x * factor + sx)) * 4;
          const alpha = src[i + 3] / 255;
          r += src[i] * alpha;
          g += src[i + 1] * alpha;
          b += src[i + 2] * alpha;
          a += alpha;
        }
      }
      const n = factor * factor;
      const o = (y * size + x) * 4;
      // Un-premultiply so edges stay clean against any background.
      out[o] = a > 0 ? Math.round(r / a) : 0;
      out[o + 1] = a > 0 ? Math.round(g / a) : 0;
      out[o + 2] = a > 0 ? Math.round(b / a) : 0;
      out[o + 3] = Math.round((a / n) * 255);
    }
  }
  return out;
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const S = size * SUPERSAMPLE;
  const png = encodePng(downsample(renderTile(S), S, size), size, size);
  const path = resolve(OUT_DIR, `icon${size}.png`);
  writeFileSync(path, png);
  console.log(`wrote ${path} (${png.length} bytes)`);
}
