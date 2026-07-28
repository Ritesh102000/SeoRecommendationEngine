#!/usr/bin/env node
/**
 * Build the upload bundle for the Chrome Web Store.
 *
 *   npm run build   →   dist/seo-lens-v<version>.zip
 *
 * Writes the ZIP directly (deflate via node:zlib) so packaging needs no
 * external `zip` binary and behaves identically on macOS, Linux and Windows.
 */

import { deflateRawSync, crc32 as zlibCrc32 } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync, statSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

/** Exactly what Chrome loads — tools, tests and docs stay out of the bundle. */
const INCLUDE = [
  'manifest.json',
  'popup.html',
  'popup.css',
  'popup.js',
  'background.js',
  'src/analyze.js',
  'src/audit.js',
  'src/extract-page.js',
  'src/html-extract.js',
  'src/kmeans.js',
  'src/nlp.js',
  'icons/icon16.png',
  'icons/icon32.png',
  'icons/icon48.png',
  'icons/icon128.png',
];

// node:zlib exposes crc32 from v20.15; fall back to a local table otherwise.
const crc32 = zlibCrc32 ?? (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();

function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2));
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function buildZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRawSync(entry.data, { level: 9 });
    const crc = crc32(entry.data);
    const { time, day } = dosDateTime(entry.date);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);       // version needed
    local.writeUInt16LE(0, 6);        // flags
    local.writeUInt16LE(8, 8);        // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);       // extra length
    locals.push(local, nameBuf, compressed);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);          // version made by
    cd.writeUInt16LE(20, 6);          // version needed
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(day, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(compressed.length, 20);
    cd.writeUInt32LE(entry.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);          // extra
    cd.writeUInt16LE(0, 32);          // comment
    cd.writeUInt16LE(0, 34);          // disk number
    cd.writeUInt16LE(0, 36);          // internal attrs
    // External attrs: regular file, mode 0644. The >>>0 matters — JS bitwise
    // ops are signed 32-bit and this shift overflows into negative territory.
    cd.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

// ------------------------------------------------------------------- main ---
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const now = new Date();

const entries = INCLUDE.map((name) => {
  const full = join(ROOT, name);
  statSync(full); // throws with a clear ENOENT if a listed file is missing
  return { name, data: readFileSync(full), date: now };
});

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

const zip = buildZip(entries);
const out = join(DIST, `seo-lens-v${manifest.version}.zip`);
writeFileSync(out, zip);

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log(`Packaged ${entries.length} files → ${out.replace(ROOT + '/', '')} (${kb(zip.length)})`);
for (const e of entries) console.log(`  ${e.name.padEnd(28)} ${kb(e.data.length)}`);
console.log(`\nUpload this zip at https://chrome.google.com/webstore/devconsole`);
