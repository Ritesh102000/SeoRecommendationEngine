#!/usr/bin/env node
/**
 * Parse every shipped JS file. Catches syntax errors before you find them as a
 * silent "Service worker registration failed" in chrome://extensions.
 *
 * Uses `node --check` per file, which honours package.json "type": "module",
 * so no experimental flags are needed.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', '.git', 'dist', 'icons']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (extname(full) === '.js' || extname(full) === '.mjs') out.push(full);
  }
  return out;
}

let failed = 0;

for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file);
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status === 0) {
    console.log(`  ok  ${rel}`);
  } else {
    failed++;
    console.error(`FAIL  ${rel}\n${(result.stderr || '').trim().split('\n').slice(0, 6).map((l) => `      ${l}`).join('\n')}`);
  }
}

// Manifest sanity — the things Chrome rejects at load time.
try {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  for (const key of ['manifest_version', 'name', 'version', 'action', 'background', 'icons']) {
    if (!(key in manifest)) throw new Error(`missing "${key}"`);
  }
  if (manifest.manifest_version !== 3) throw new Error('manifest_version must be 3');
  if (!/^\d+(\.\d+){0,3}$/.test(manifest.version)) throw new Error(`invalid version "${manifest.version}"`);
  if (manifest.description.length > 132) throw new Error('description exceeds the 132-char store limit');
  for (const [size, path] of Object.entries(manifest.icons)) {
    statSync(join(ROOT, path)); // throws if the icon is missing
    void size;
  }
  statSync(join(ROOT, manifest.background.service_worker));
  statSync(join(ROOT, manifest.action.default_popup));
  console.log('  ok  manifest.json');
} catch (err) {
  failed++;
  console.error(`FAIL  manifest.json\n      ${err.message}`);
}

if (failed) {
  console.error(`\n${failed} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll files parse; manifest is well-formed.');
