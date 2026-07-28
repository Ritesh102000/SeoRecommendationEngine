/**
 * MV3 service worker.
 *
 * The popup can be dismissed at any moment (clicking outside closes it), so all
 * network work happens here and every result is written to chrome.storage
 * before it is returned. Reopening the popup restores the last scan instead of
 * starting over.
 */

import { extractFromHtml } from './src/html-extract.js';

const FETCH_TIMEOUT_MS = 15000;
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_CONCURRENT = 3;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const CACHE_PREFIX = 'page:';

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    await chrome.storage.local.set({ competitors: [] });
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;

  switch (msg.type) {
    case 'FETCH_COMPETITORS':
      fetchCompetitors(msg.urls || [], msg.force === true)
        .then((results) => sendResponse({ ok: true, results }))
        .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
      return true; // keep the message channel open for the async reply

    case 'CLEAR_CACHE':
      clearCache()
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;

    default:
      return false;
  }
});

async function fetchCompetitors(urls, force) {
  const unique = [];
  const seen = new Set();
  for (const raw of urls) {
    const normalized = normalizeUrl(raw);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(normalized);
  }

  const results = new Array(unique.length);
  let cursor = 0;

  const worker = async () => {
    while (cursor < unique.length) {
      const index = cursor++;
      const url = unique[index];
      results[index] = await fetchOne(url, force);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENT, unique.length) }, worker),
  );

  return results;
}

async function fetchOne(url, force) {
  try {
    if (!force) {
      const cached = await readCache(url);
      if (cached) return { url, ok: true, cached: true, page: cached };
    }

    const granted = await hasHostPermission(url);
    if (!granted) {
      return { url, ok: false, error: 'Permission not granted for this site.', code: 'PERMISSION' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let response;
    try {
      response = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        credentials: 'omit',
        cache: 'no-cache',
        headers: { Accept: 'text/html,application/xhtml+xml' },
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      return { url, ok: false, error: `HTTP ${response.status} ${response.statusText}`.trim(), code: 'HTTP' };
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType && !/text\/html|application\/xhtml/i.test(contentType)) {
      return { url, ok: false, error: `Not an HTML page (${contentType.split(';')[0]})`, code: 'TYPE' };
    }

    const html = await readCapped(response);
    const page = extractFromHtml(html, response.url || url);

    if (!page.title && page.wordCount < 20) {
      return {
        url,
        ok: false,
        code: 'EMPTY',
        error: 'Page returned almost no server-rendered content (likely client-side rendered).',
      };
    }

    await writeCache(url, page);
    return { url, ok: true, cached: false, page };
  } catch (err) {
    const name = err && err.name;
    if (name === 'AbortError') return { url, ok: false, error: 'Timed out after 15s', code: 'TIMEOUT' };
    return { url, ok: false, error: String(err && err.message ? err.message : err), code: 'NETWORK' };
  }
}

/** Read the body but stop early if the page is unreasonably large. */
async function readCapped(response) {
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let received = 0;
  let out = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    out += decoder.decode(value, { stream: true });
    if (received >= MAX_BYTES) {
      try { await reader.cancel(); } catch { /* already closed */ }
      break;
    }
  }
  out += decoder.decode();
  return out;
}

function normalizeUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname.includes('.')) return null;
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

async function hasHostPermission(url) {
  try {
    const origin = new URL(url).origin + '/*';
    return await chrome.permissions.contains({ origins: [origin] });
  } catch {
    return false;
  }
}

async function readCache(url) {
  const key = CACHE_PREFIX + url;
  const store = await chrome.storage.local.get(key);
  const entry = store[key];
  if (!entry) return null;
  if (Date.now() - entry.savedAt > CACHE_TTL_MS) {
    await chrome.storage.local.remove(key);
    return null;
  }
  return entry.page;
}

async function writeCache(url, page) {
  try {
    await chrome.storage.local.set({ [CACHE_PREFIX + url]: { savedAt: Date.now(), page } });
  } catch {
    // Quota exceeded — drop the oldest half of the cache and move on.
    await pruneCache();
  }
}

async function pruneCache() {
  const all = await chrome.storage.local.get(null);
  const entries = Object.entries(all)
    .filter(([k]) => k.startsWith(CACHE_PREFIX))
    .sort((a, b) => (a[1].savedAt || 0) - (b[1].savedAt || 0));
  const drop = entries.slice(0, Math.ceil(entries.length / 2)).map(([k]) => k);
  if (drop.length) await chrome.storage.local.remove(drop);
}

async function clearCache() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX));
  if (keys.length) await chrome.storage.local.remove(keys);
}
