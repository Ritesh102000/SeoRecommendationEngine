/**
 * Popup controller: scan the active tab, fetch competitors via the service
 * worker, run the analysis, render everything.
 */

import { collectPageData } from './src/extract-page.js';
import { auditPage } from './src/audit.js';
import { analyze, STATUS_META } from './src/analyze.js';

const $ = (id) => document.getElementById(id);

const state = {
  tab: null,
  page: null,
  audit: null,
  analysis: null,
  competitors: [],      // [{ url, status: 'pending'|'ok'|'error', error?, page? }]
  kwLimit: 40,
  kwSort: 'score',
  kwSortDir: -1,
  scanning: false,
};

const PAGE_STATUS_CLASS = { ok: 'ok', error: 'err', pending: 'pending' };

// ---------------------------------------------------------------- bootstrap --
init();

async function init() {
  wireEvents();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tab = tab;

  if (tab?.url) {
    try {
      $('page-host').textContent = new URL(tab.url).hostname;
    } catch {
      $('page-host').textContent = tab.url.slice(0, 40);
    }
  }

  const stored = await chrome.storage.local.get(['competitors', 'lastScan']);
  state.competitors = (stored.competitors || []).map((url) => ({ url, status: 'pending' }));
  renderCompetitors();

  // Restore the previous scan if it was for this same URL. Competitor bodies
  // are not persisted, so the restored view is on-page-only until the user
  // re-runs (which usually hits the worker's cache and needs no network).
  if (stored.lastScan && stored.lastScan.url === tab?.url && stored.lastScan.page) {
    state.page = stored.lastScan.page;
    state.audit = stored.lastScan.audit;
    rerunAnalysis();
    showResults();
    renderSuggestions();
    setStatus(
      state.competitors.length
        ? `Restored scan from ${timeAgo(stored.lastScan.at)}. Re-run analysis to pull competitor data back in.`
        : `Restored scan from ${timeAgo(stored.lastScan.at)}. Rescan for fresh data.`,
    );
  }

  if (!isScannable(tab?.url)) {
    $('scan-btn').disabled = true;
    setStatus('This page cannot be scanned. Chrome blocks extensions on internal pages, the Web Store and local files.', true);
  }
}

function wireEvents() {
  $('scan-btn').addEventListener('click', runScan);
  $('export-btn').addEventListener('click', exportJson);

  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => selectTab(btn.dataset.tab));
  });

  $('kw-search').addEventListener('input', () => { state.kwLimit = 40; renderKeywords(); });
  $('kw-filter').addEventListener('change', () => { state.kwLimit = 40; renderKeywords(); });
  $('kw-more').addEventListener('click', () => { state.kwLimit += 60; renderKeywords(); });

  document.querySelectorAll('.kw-table th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (state.kwSort === key) state.kwSortDir *= -1;
      else { state.kwSort = key; state.kwSortDir = -1; }
      renderKeywords();
    });
  });

  $('comp-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const value = $('comp-input').value;
    $('comp-input').value = '';
    addCompetitor(value);
  });

  $('comp-rescan').addEventListener('click', () => fetchAndAnalyze(false));
  $('comp-refresh').addEventListener('click', () => fetchAndAnalyze(true));
}

// -------------------------------------------------------------------- scan --
function isScannable(url) {
  if (!url) return false;
  return /^https?:\/\//i.test(url);
}

async function runScan() {
  if (state.scanning) return;
  if (!isScannable(state.tab?.url)) return;

  state.scanning = true;
  $('scan-btn').disabled = true;
  setStatus('<span class="spinner"></span>Reading page…');

  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: state.tab.id },
      func: collectPageData,
    });

    const page = injection?.result;
    if (!page || !page.ok) throw new Error('Could not read the page contents.');

    state.page = page;
    state.audit = auditPage(page);
    rerunAnalysis(); // on-page-only pass so the UI is populated immediately
    showResults();
    renderSuggestions();

    await fetchAndAnalyze(false);
  } catch (err) {
    const msg = String(err?.message || err);
    setStatus(
      /Cannot access|Missing host permission|frame/i.test(msg)
        ? 'Chrome would not let the extension read this page. Reload the tab and try again.'
        : `Scan failed: ${msg}`,
      true,
    );
  } finally {
    state.scanning = false;
    $('scan-btn').disabled = false;
  }
}

/** Fetch every competitor page, then re-run the keyword analysis. */
async function fetchAndAnalyze(force) {
  if (!state.page) {
    setStatus('Scan the page first.', true);
    return;
  }

  const urls = state.competitors.map((c) => c.url);
  if (urls.length === 0) {
    rerunAnalysis();
    renderAll();
    setStatus('Scanned. Add competitor URLs to unlock gap analysis and clustering.');
    return;
  }

  const permission = await ensurePermissions(urls);
  if (!permission.granted) {
    setStatus(
      permission.needsGesture
        ? 'Chrome needs a direct click to grant site access — press "Re-run analysis" again.'
        : 'Access to those sites was denied, so they could not be fetched.',
      true,
    );
    rerunAnalysis();
    renderAll();
    return;
  }

  state.competitors = state.competitors.map((c) => ({ ...c, status: 'pending', error: null }));
  renderCompetitors();
  setStatus(`<span class="spinner"></span>Fetching ${urls.length} competitor page${urls.length === 1 ? '' : 's'}…`);

  const response = await chrome.runtime.sendMessage({ type: 'FETCH_COMPETITORS', urls, force });

  if (!response?.ok) {
    setStatus(`Competitor fetch failed: ${response?.error || 'unknown error'}`, true);
    state.competitors = state.competitors.map((c) => ({ ...c, status: 'error', error: 'fetch failed' }));
    renderCompetitors();
    return;
  }

  const byUrl = new Map(response.results.map((r) => [r.url, r]));
  state.competitors = state.competitors.map((c) => {
    const r = byUrl.get(c.url) || findLoose(response.results, c.url);
    if (!r) return { ...c, status: 'error', error: 'no response' };
    return r.ok
      ? { url: c.url, status: 'ok', page: r.page, cached: r.cached }
      : { url: c.url, status: 'error', error: r.error };
  });

  rerunAnalysis();
  renderAll();

  const okCount = state.competitors.filter((c) => c.status === 'ok').length;
  const failed = state.competitors.length - okCount;
  setStatus(
    failed
      ? `Analysed against ${okCount} competitor${okCount === 1 ? '' : 's'} — ${failed} could not be fetched (see Competitors tab).`
      : `Analysed against ${okCount} competitor${okCount === 1 ? '' : 's'}.`,
    false,
  );

  await persist();
}

/** The service worker normalises URLs, so match on origin+path if exact fails. */
function findLoose(results, url) {
  try {
    const target = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    return results.find((r) => {
      try {
        const u = new URL(r.url);
        return u.hostname === target.hostname && u.pathname === target.pathname;
      } catch { return false; }
    });
  } catch { return undefined; }
}

function rerunAnalysis() {
  const pages = state.competitors.filter((c) => c.status === 'ok' && c.page).map((c) => c.page);
  state.analysis = analyze(state.page, pages);
}

/**
 * Normally a no-op: hosts are granted when the competitor is added. This only
 * has work to do if a permission was revoked, or the list was restored from a
 * previous session.
 * @returns {Promise<{granted: boolean, needsGesture?: boolean}>}
 */
async function ensurePermissions(urls) {
  const origins = [];
  for (const url of urls) {
    try {
      const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
      origins.push(`${u.origin}/*`);
    } catch { /* skip malformed */ }
  }
  if (origins.length === 0) return { granted: true };

  if (await chrome.permissions.contains({ origins })) return { granted: true };

  try {
    return { granted: await chrome.permissions.request({ origins }) };
  } catch (err) {
    // Chrome throws rather than returning false when the user gesture has
    // already been spent, which is a different problem from a refusal.
    return { granted: false, needsGesture: /gesture/i.test(String(err?.message || err)) };
  }
}

async function persist() {
  try {
    await chrome.storage.local.set({
      competitors: state.competitors.map((c) => c.url),
      lastScan: {
        url: state.tab?.url,
        at: Date.now(),
        page: state.page,
        audit: state.audit,
        // Competitor page bodies live in the service worker's 6h cache, so only
        // the URLs are persisted here — storing both would double the footprint.
        competitors: state.competitors.map((c) => ({ url: c.url, status: 'pending' })),
      },
    });
  } catch {
    // Storage full — the scan still works, it just won't be restorable.
  }
}

// ------------------------------------------------------------- competitors --
/**
 * Add a competitor and ask for access to that host straight away.
 *
 * The permission request has to fire on the user's actual click:
 * chrome.permissions.request() needs a live user gesture, and by the time the
 * analysis run reaches it — several awaits later — that gesture is gone.
 * Granting here means the later run only ever calls permissions.contains().
 */
function addCompetitor(raw) {
  const value = String(raw || '').trim();
  if (!value) return;
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    if (!url.hostname.includes('.')) throw new Error('bad host');
    url.hash = '';
  } catch {
    setStatus(`"${value}" is not a valid URL.`, true);
    return;
  }
  const normalized = url.toString();

  if (state.competitors.some((c) => c.url === normalized)) {
    setStatus('That URL is already in the list.');
    return;
  }
  if (state.page && normalized.startsWith(state.page.origin)) {
    setStatus('That is the site you are scanning — add a different domain.', true);
    return;
  }
  if (state.competitors.length >= 10) {
    setStatus('10 competitors is the maximum.', true);
    return;
  }

  // Fired synchronously on the click — do not await anything before this.
  chrome.permissions.request({ origins: [`${url.origin}/*`] })
    .then((granted) => {
      if (granted) {
        setStatus('Added. Press "Re-run analysis" when your list is ready.');
      } else {
        setStatus(`Added, but access to ${url.hostname} was denied — it cannot be fetched until you allow it.`, true);
      }
    })
    .catch(() => {
      // Popups are sometimes dismissed by the permission dialog itself; the
      // URL is saved either way, so reopening and re-running picks it up.
      setStatus('Added. Press "Re-run analysis" and approve access when asked.');
    });

  state.competitors.push({ url: normalized, status: 'pending' });
  renderCompetitors();
  chrome.storage.local.set({ competitors: state.competitors.map((c) => c.url) });
}

function removeCompetitor(url) {
  state.competitors = state.competitors.filter((c) => c.url !== url);
  renderCompetitors();
  chrome.storage.local.set({ competitors: state.competitors.map((c) => c.url) });
}

/** Suggest competitor candidates from the external domains the page links to. */
const IGNORED_HOSTS = /(google|facebook|twitter|x\.com|instagram|linkedin|youtube|tiktok|pinterest|reddit|github|gstatic|googleapis|cloudflare|amazonaws|cdn|fonts|wp\.com|gravatar|doubleclick|shopify|wixstatic|squarespace|vimeo|apple\.com|microsoft\.com|adobe\.com|paypal|stripe)/i;

function renderSuggestions() {
  const host = $('comp-suggestions');
  host.innerHTML = '';
  const hosts = state.page?.links?.externalHosts || [];
  const existing = new Set(state.competitors.map((c) => {
    try { return new URL(c.url).hostname; } catch { return c.url; }
  }));

  const candidates = hosts
    .filter((h) => !IGNORED_HOSTS.test(h.host))
    .filter((h) => !existing.has(h.host))
    .filter((h) => h.host !== state.page?.hostname)
    .slice(0, 6);

  if (candidates.length === 0) return;

  const title = document.createElement('div');
  title.className = 'suggest-title';
  title.textContent = 'Domains this page links to — possible competitors:';
  host.appendChild(title);

  const wrap = document.createElement('div');
  wrap.className = 'chips';
  candidates.forEach((c) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'suggest-chip';
    btn.textContent = c.host;
    btn.addEventListener('click', () => {
      addCompetitor(`https://${c.host}`);
      renderSuggestions();
    });
    wrap.appendChild(btn);
  });
  host.appendChild(wrap);
}

function renderCompetitors() {
  const list = $('comp-list');
  list.innerHTML = '';

  if (state.competitors.length === 0) {
    const li = document.createElement('li');
    li.className = 'muted small';
    li.textContent = 'No competitors added yet.';
    list.appendChild(li);
    return;
  }

  state.competitors.forEach((c) => {
    const li = document.createElement('li');
    li.className = 'comp-item';

    const url = document.createElement('span');
    url.className = 'comp-url';
    url.textContent = displayUrl(c.url);
    url.title = c.url;

    const badge = document.createElement('span');
    badge.className = `comp-state ${PAGE_STATUS_CLASS[c.status] || 'pending'}`;
    badge.textContent = c.status === 'ok'
      ? `${c.page?.wordCount ?? 0} words`
      : c.status === 'error' ? 'failed' : 'not fetched';
    if (c.status === 'error' && c.error) badge.title = c.error;

    const remove = document.createElement('button');
    remove.className = 'comp-remove';
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = 'Remove';
    remove.addEventListener('click', () => removeCompetitor(c.url));

    li.append(url, badge, remove);
    list.appendChild(li);

    if (c.status === 'error' && c.error) {
      const err = document.createElement('li');
      err.className = 'muted small';
      err.style.paddingLeft = '9px';
      err.textContent = `↳ ${c.error}`;
      list.appendChild(err);
    }
  });
}

// ------------------------------------------------------------------ render --
function showResults() {
  $('empty').hidden = true;
  $('results').hidden = false;
  $('export-btn').hidden = false;
  $('scan-btn').textContent = 'Rescan';
  renderAll();
}

function renderAll() {
  renderScore();
  renderIssues();
  renderKeywords();
  renderClusters();
  renderCompetitors();
  renderBenchmarks();
}

/** How this page's shape compares to the median competitor in the set. */
function renderBenchmarks() {
  const host = $('benchmarks');
  host.innerHTML = '';
  const rows = state.analysis?.benchmarks;
  if (!rows || rows.length === 0) return;

  const title = document.createElement('div');
  title.className = 'section-title';
  title.textContent = 'Category benchmarks (median)';
  host.appendChild(title);

  const table = document.createElement('table');
  table.className = 'kw-table';

  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  ['Metric', 'You', 'Category'].forEach((label, i) => {
    const th = document.createElement('th');
    th.textContent = label;
    if (i > 0) th.className = 'num';
    hr.appendChild(th);
  });
  thead.appendChild(hr);

  const tbody = document.createElement('tbody');
  rows.forEach((r) => {
    const tr = document.createElement('tr');

    const name = document.createElement('td');
    name.textContent = r.metric;

    const you = document.createElement('td');
    you.className = 'num';
    you.textContent = formatMetric(r.you, r.format);

    const cat = document.createElement('td');
    cat.className = 'num';
    cat.textContent = formatMetric(r.category, r.format);

    if (r.higherIsBetter === true && r.category > 0) {
      const ratio = r.you / r.category;
      you.style.color = ratio >= 0.9 ? 'var(--ok)' : ratio >= 0.6 ? 'var(--warning)' : 'var(--critical)';
      you.title = ratio < 0.6 ? `Well below the category median` : '';
    }

    tr.append(name, you, cat);
    tbody.appendChild(tr);
  });

  table.append(thead, tbody);
  host.appendChild(table);
}

function formatMetric(value, format) {
  if (format === 'percent') return `${Math.round(value)}%`;
  if (format === 'chars') return `${value} ch`;
  return String(value);
}

function renderScore() {
  const a = state.audit;
  if (!a) return;

  const circumference = 2 * Math.PI * 52;
  const ring = $('ring-value');
  ring.style.strokeDasharray = String(circumference);
  ring.style.strokeDashoffset = String(circumference * (1 - a.score / 100));
  ring.style.stroke = a.score >= 80 ? 'var(--ok)' : a.score >= 60 ? 'var(--warning)' : 'var(--critical)';

  $('score-value').textContent = a.score;
  $('score-grade').textContent = `grade ${a.grade}`;
  $('score-headline').textContent = headlineFor(a.score);
  $('score-sub').textContent = `${a.findings.length} issue${a.findings.length === 1 ? '' : 's'} found on ${displayUrl(state.page.url)}`;

  $('count-critical').textContent = a.counts.critical;
  $('count-warning').textContent = a.counts.warning;
  $('count-notice').textContent = a.counts.notice;
  $('count-passed').textContent = a.counts.passed;
}

function headlineFor(score) {
  if (score >= 90) return 'Strong on-page SEO';
  if (score >= 75) return 'Solid, with room to improve';
  if (score >= 60) return 'Needs work';
  return 'Significant issues';
}

function renderIssues() {
  const recHost = $('recommendations');
  recHost.innerHTML = '';

  const recs = state.analysis?.recommendations || [];
  if (recs.length) {
    const title = document.createElement('div');
    title.className = 'section-title';
    title.textContent = 'Recommended actions';
    recHost.appendChild(title);

    recs.forEach((r) => {
      const card = document.createElement('div');
      card.className = 'rec';

      const head = document.createElement('div');
      head.className = 'rec-head';
      const prio = document.createElement('span');
      prio.className = `prio ${r.priority}`;
      prio.textContent = r.priority;
      const t = document.createElement('span');
      t.className = 'rec-title';
      t.textContent = r.title;
      head.append(prio, t);

      const p = document.createElement('p');
      p.textContent = r.detail;
      card.append(head, p);

      if (r.example) {
        const ex = document.createElement('div');
        ex.className = 'example';
        ex.textContent = r.example;
        card.appendChild(ex);
      }
      recHost.appendChild(card);
    });
  }

  const host = $('findings');
  host.innerHTML = '';
  const findings = state.audit?.findings || [];

  const title = document.createElement('div');
  title.className = 'section-title';
  title.textContent = findings.length ? `On-page issues (${findings.length})` : 'On-page issues';
  host.appendChild(title);

  if (findings.length === 0) {
    const p = document.createElement('p');
    p.className = 'muted small';
    p.textContent = 'No issues found — every check passed.';
    host.appendChild(p);
  }

  findings.forEach((f) => {
    const d = document.createElement('details');
    d.className = 'finding';

    const s = document.createElement('summary');
    const dot = document.createElement('span');
    dot.className = `dot ${f.severity}`;
    const label = document.createElement('span');
    label.textContent = f.title;
    s.append(dot, label);

    const body = document.createElement('div');
    body.className = 'finding-body';
    const detail = document.createElement('p');
    detail.textContent = f.detail;
    const fix = document.createElement('div');
    fix.className = 'fix';
    const b = document.createElement('b');
    b.textContent = 'Fix: ';
    fix.append(b, document.createTextNode(f.fix));
    body.append(detail, fix);

    if (f.value) {
      const v = document.createElement('div');
      v.className = 'value';
      v.textContent = f.value;
      body.appendChild(v);
    }

    d.append(s, body);
    host.appendChild(d);
  });

  const passed = state.audit?.passed || [];
  $('passed-count').textContent = passed.length;
  const ul = $('passed-list');
  ul.innerHTML = '';
  passed.forEach((p) => {
    const li = document.createElement('li');
    li.textContent = p.label;
    ul.appendChild(li);
  });
  $('passed-wrap').hidden = passed.length === 0;
}

function keywordFilter(list) {
  const q = $('kw-search').value.trim().toLowerCase();
  const mode = $('kw-filter').value;
  return list.filter((k) => {
    if (q && !k.term.includes(q)) return false;
    if (mode === 'gap') return k.status === 'missing' || k.status === 'absent';
    if (mode === 'underused') return k.status === 'underused';
    if (mode === 'defend') return k.status === 'defend' || k.status === 'primary';
    if (mode === 'unique') return k.status === 'unique';
    return true;
  });
}

function renderKeywords() {
  const body = $('kw-body');
  body.innerHTML = '';

  const all = state.analysis?.keywords || [];
  const compCount = state.analysis?.stats?.competitorCount || 0;
  const note = $('kw-note');
  note.hidden = false;
  note.textContent = compCount === 0
    ? 'No competitors fetched yet — these are ranked by on-page prominence only. Add competitors to score gaps and demand.'
    : `Ranked across ${compCount} competitor page${compCount === 1 ? '' : 's'}. "Cat." is the share of them using the term; "You" is how strongly this page uses it.`;

  const filtered = keywordFilter(all).sort((a, b) => {
    const key = state.kwSort;
    return (a[key] - b[key]) * state.kwSortDir;
  });

  if (filtered.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 4;
    td.className = 'muted small';
    td.textContent = 'No keywords match this filter.';
    tr.appendChild(td);
    body.appendChild(tr);
    $('kw-more').hidden = true;
    return;
  }

  filtered.slice(0, state.kwLimit).forEach((k) => {
    const tr = document.createElement('tr');

    const termCell = document.createElement('td');
    const term = document.createElement('div');
    term.className = 'kw-term';
    term.textContent = k.term;
    termCell.appendChild(term);

    const meta = STATUS_META[k.status];
    if (meta) {
      const badge = document.createElement('span');
      badge.className = `kw-status ${meta.tone}`;
      badge.textContent = meta.label;
      badge.title = meta.hint;
      termCell.appendChild(badge);

      if ((k.status === 'missing' || k.status === 'underused') && k.placements.length) {
        const hint = document.createElement('div');
        hint.className = 'kw-hint';
        hint.textContent = `Add to: ${k.placements.slice(0, 2).join(', ')}`;
        termCell.appendChild(hint);
      }
    }

    const cov = document.createElement('td');
    cov.className = 'num';
    cov.textContent = compCount ? `${Math.round(k.coverage * 100)}%` : '—';
    cov.title = `${k.compDf} of ${compCount} competitor pages use this`;

    const you = document.createElement('td');
    you.className = 'num';
    you.textContent = k.targetStrength ? k.targetStrength.toFixed(2) : '0';

    const score = document.createElement('td');
    score.className = 'num';
    const sv = document.createElement('div');
    sv.className = 'kw-score';
    sv.textContent = k.score;
    const bar = document.createElement('div');
    bar.className = 'bar';
    const fill = document.createElement('i');
    fill.style.width = `${Math.min(100, k.score)}%`;
    bar.appendChild(fill);
    score.append(sv, bar);

    tr.append(termCell, cov, you, score);
    body.appendChild(tr);
  });

  $('kw-more').hidden = filtered.length <= state.kwLimit;
  $('kw-more').textContent = `Show more (${filtered.length - state.kwLimit} remaining)`;
}

function renderClusters() {
  const host = $('clusters');
  const meta = $('cluster-meta');
  host.innerHTML = '';

  const clusters = state.analysis?.clusters || [];
  if (clusters.length === 0) {
    meta.textContent = state.analysis?.stats.competitorCount
      ? 'Not enough distinct keywords to cluster. Try a content-heavier page.'
      : 'Add competitor URLs, then re-run — clustering compares your keyword profile against theirs.';
    $('opportunity-map').innerHTML = '';
    return;
  }

  const k = clusters.length;
  const sil = clusters[0]?.silhouette;
  meta.textContent = `k-means grouped ${state.analysis.stats.clusteredCount} keywords into ${k} topic clusters` +
    (Number.isFinite(sil) && sil > -1 ? ` (k chosen by silhouette score: ${sil.toFixed(2)}).` : '.');

  renderOpportunityMap(clusters);

  clusters.forEach((c) => {
    const card = document.createElement('div');
    card.className = 'cluster';

    const head = document.createElement('div');
    head.className = 'cluster-head';
    const name = document.createElement('span');
    name.className = 'cluster-name';
    name.textContent = c.label;
    const theme = document.createElement('span');
    theme.className = `cluster-theme theme-${c.theme.key}`;
    theme.textContent = c.theme.label;
    head.append(name, theme);

    const advice = document.createElement('div');
    advice.className = 'cluster-advice';
    advice.textContent = c.theme.advice;

    const chips = document.createElement('div');
    chips.className = 'chips';
    c.members.slice(0, 12).forEach((m) => {
      const chip = document.createElement('span');
      chip.className = m.targetStrength > 0 ? 'chip' : 'chip dim';
      chip.textContent = m.term;
      chip.title = `${STATUS_META[m.status]?.label || ''} · score ${m.score}`;
      chips.appendChild(chip);
    });
    if (c.members.length > 12) {
      const more = document.createElement('span');
      more.className = 'chip dim';
      more.textContent = `+${c.members.length - 12} more`;
      chips.appendChild(more);
    }

    const stats = document.createElement('div');
    stats.className = 'cluster-stats';
    stats.append(
      statSpan(`${c.size} keywords`),
      statSpan(`category coverage ${Math.round(c.avgCoverage * 100)}%`),
      statSpan(`your weight ${c.avgTarget.toFixed(2)}`),
    );

    card.append(head, advice, chips, stats);
    host.appendChild(card);
  });
}

function statSpan(text) {
  const s = document.createElement('span');
  s.textContent = text;
  return s;
}

const CLUSTER_COLORS = ['#6366f1', '#0ea5e9', '#2dd4a7', '#f5a524', '#f0556d', '#a855f7', '#14b8a6', '#eab308'];

/**
 * Quadrant scatter: x = how strongly this page uses the term,
 * y = how much the category demands it. Top-left = the gaps worth filling.
 */
function renderOpportunityMap(clusters) {
  const host = $('opportunity-map');
  host.innerHTML = '';
  if (!state.analysis?.stats.competitorCount) return;

  const W = 396;
  const H = 200;
  const PAD = { top: 14, right: 12, bottom: 24, left: 34 };
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'map-svg');

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  // Inset by a dot radius so the many terms sitting at exactly 0 stay inside
  // the plot instead of being clipped by the axis.
  const INSET = 5;
  const x = (v) => PAD.left + INSET + Math.max(0, Math.min(1, v)) * (plotW - INSET * 2);
  const y = (v) => PAD.top + INSET + (1 - Math.max(0, Math.min(1, v))) * (plotH - INSET * 2);

  const el = (name, attrs, text) => {
    const node = document.createElementNS(svgNS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (text !== undefined) node.textContent = text;
    return node;
  };

  // Quadrant shading for the high-demand / low-coverage corner.
  svg.appendChild(el('rect', {
    x: PAD.left, y: PAD.top, width: plotW / 2, height: plotH / 2,
    fill: 'rgba(240,85,109,0.09)',
  }));

  svg.appendChild(el('line', {
    x1: PAD.left + plotW / 2, y1: PAD.top, x2: PAD.left + plotW / 2, y2: PAD.top + plotH,
    stroke: 'currentColor', 'stroke-opacity': '.18', 'stroke-dasharray': '3 3',
  }));
  svg.appendChild(el('line', {
    x1: PAD.left, y1: PAD.top + plotH / 2, x2: PAD.left + plotW, y2: PAD.top + plotH / 2,
    stroke: 'currentColor', 'stroke-opacity': '.18', 'stroke-dasharray': '3 3',
  }));

  svg.appendChild(el('text', {
    x: PAD.left + 5, y: PAD.top + 12, fill: 'currentColor', 'fill-opacity': '.55', 'font-size': '9',
  }, 'GAPS — fill these'));

  clusters.forEach((c, ci) => {
    const color = CLUSTER_COLORS[ci % CLUSTER_COLORS.length];
    c.members.slice(0, 30).forEach((m) => {
      const dot = el('circle', {
        cx: x(m.targetStrength),
        cy: y(m.demand),
        r: 3.2,
        fill: color,
        'fill-opacity': '.75',
      });
      const t = el('title', {});
      t.textContent = `${m.term} — you ${m.targetStrength.toFixed(2)}, category demand ${m.demand.toFixed(2)}`;
      dot.appendChild(t);
      svg.appendChild(dot);
    });
  });

  // Axes
  svg.appendChild(el('text', {
    x: PAD.left + plotW / 2, y: H - 6, fill: 'currentColor', 'fill-opacity': '.6',
    'font-size': '9', 'text-anchor': 'middle',
  }, 'Your page uses it  →'));

  const ylab = el('text', {
    x: 0, y: 0, fill: 'currentColor', 'fill-opacity': '.6', 'font-size': '9', 'text-anchor': 'middle',
    transform: `translate(11, ${PAD.top + plotH / 2}) rotate(-90)`,
  }, 'Category demand  →');
  svg.appendChild(ylab);

  host.appendChild(svg);

  const legend = document.createElement('div');
  legend.className = 'chips';
  legend.style.marginTop = '7px';
  clusters.forEach((c, ci) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.style.borderLeft = `3px solid ${CLUSTER_COLORS[ci % CLUSTER_COLORS.length]}`;
    chip.textContent = c.label;
    legend.appendChild(chip);
  });
  host.appendChild(legend);
}

// ------------------------------------------------------------------- misc --
function selectTab(name) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  ['issues', 'keywords', 'clusters', 'competitors'].forEach((t) => {
    $(`panel-${t}`).hidden = t !== name;
  });
}

function setStatus(html, isError = false) {
  const el = $('status');
  el.hidden = false;
  el.className = `status${isError ? ' error' : ''}`;
  el.textContent = '';
  // Only the spinner is markup; everything else is inserted as text.
  if (html.startsWith('<span class="spinner"></span>')) {
    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    el.append(spinner, document.createTextNode(html.replace('<span class="spinner"></span>', '')));
  } else {
    el.textContent = html;
  }
}

function displayUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname === '/' ? '' : u.pathname;
    return (u.hostname + path).replace(/^www\./, '');
  } catch {
    return url;
  }
}

function timeAgo(ts) {
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function exportJson() {
  const payload = {
    generatedAt: new Date().toISOString(),
    url: state.page?.url,
    audit: {
      score: state.audit?.score,
      grade: state.audit?.grade,
      counts: state.audit?.counts,
      findings: state.audit?.findings,
    },
    competitors: state.competitors.map((c) => ({ url: c.url, status: c.status, error: c.error })),
    keywords: (state.analysis?.keywords || []).slice(0, 150).map((k) => ({
      term: k.term,
      score: k.score,
      status: k.status,
      categoryCoverage: Number(k.coverage.toFixed(3)),
      yourStrength: Number(k.targetStrength.toFixed(3)),
      demand: Number(k.demand.toFixed(3)),
      gap: Number(k.gap.toFixed(3)),
      suggestedPlacements: k.placements,
    })),
    clusters: (state.analysis?.clusters || []).map((c) => ({
      label: c.label,
      theme: c.theme.label,
      advice: c.theme.advice,
      size: c.size,
      keywords: c.members.map((m) => m.term),
    })),
    benchmarks: state.analysis?.benchmarks,
    recommendations: state.analysis?.recommendations,
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const host = (() => { try { return new URL(state.page.url).hostname; } catch { return 'page'; } })();

  // Anchor download rather than chrome.downloads — avoids requesting the
  // "downloads" permission just for this.
  const a = document.createElement('a');
  a.href = url;
  a.download = `seo-lens-${host}-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
