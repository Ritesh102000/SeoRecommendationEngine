#!/usr/bin/env node
/**
 * Smoke tests for the analysis pipeline.
 *
 * These run the real modules the extension ships — HTML extraction, the audit
 * rules, TF-IDF scoring and k-means — over synthetic pages in one category, and
 * assert the pipeline reaches the conclusions it is supposed to reach.
 */

import assert from 'node:assert/strict';
import { extractFromHtml } from '../src/html-extract.js';
import { auditPage } from '../src/audit.js';
import { analyze } from '../src/analyze.js';
import { extractPhrases, tokenize, normalizeMap } from '../src/nlp.js';
import { kmeans, autoCluster, l2Normalize, silhouette } from '../src/kmeans.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}\n      ${err.message}`);
  }
}

function section(name) {
  console.log(`\n${name}`);
}

// --------------------------------------------------------------- fixtures --
/** A well-built competitor page in the "project management software" category. */
const competitorHtml = (brand, extraSection) => `<!doctype html>
<html lang="en">
<head>
  <title>${brand} — Project Management Software for Remote Teams</title>
  <meta name="description" content="${brand} is project management software with task tracking, gantt charts and time tracking for remote teams.">
  <link rel="canonical" href="https://${brand.toLowerCase()}.com/">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta property="og:title" content="${brand} Project Management">
  <meta property="og:description" content="Project management software for remote teams.">
  <meta property="og:image" content="https://${brand.toLowerCase()}.com/og.png">
  <script type="application/ld+json">{"@type":"SoftwareApplication","name":"${brand}"}</script>
</head>
<body>
  <h1>Project Management Software Built for Remote Teams</h1>
  <p>${brand} gives your team task tracking, gantt charts, sprint planning and time tracking in one
     project management workspace. Remote teams use ${brand} to plan sprints, assign tasks and track
     project progress without endless status meetings.</p>
  <h2>Task Tracking and Sprint Planning</h2>
  <p>Task tracking keeps every task visible. Sprint planning tools let agile teams estimate story
     points, run sprint retrospectives and forecast delivery dates. Team collaboration happens in the
     task itself with comments, attachments and mentions.</p>
  <h2>Gantt Charts and Timelines</h2>
  <p>Gantt charts show project timelines, dependencies and milestones. Drag a task to reschedule the
     whole project timeline. Resource management shows who is overloaded across every project.</p>
  <h2>Time Tracking and Reporting</h2>
  <p>Built-in time tracking turns logged hours into project reports and client invoices. Reporting
     dashboards cover team workload, budget burn and sprint velocity.</p>
  ${extraSection}
  <h2>Pricing</h2>
  <p>Free plan for small teams. Paid pricing starts at $9 per user per month with annual billing.</p>
  <img src="/hero.png" alt="Project management dashboard" width="800" height="600" loading="lazy">
  <a href="/features">Features</a> <a href="/pricing">Pricing</a> <a href="/integrations">Integrations</a>
  <a href="/templates">Project templates</a> <a href="/security">Security</a>
</body>
</html>`;

const competitors = [
  extractFromHtml(
    competitorHtml('Acme', '<h2>Team Collaboration</h2><p>Team collaboration with shared docs, chat and file sharing keeps remote teams aligned.</p>'),
    'https://acme.com/',
  ),
  extractFromHtml(
    competitorHtml('Bolt', '<h2>Workflow Automation</h2><p>Workflow automation moves tasks between stages automatically and triggers notifications.</p>'),
    'https://bolt.com/',
  ),
  extractFromHtml(
    competitorHtml('Cirrus', '<h2>Agile Reporting</h2><p>Agile reporting covers sprint velocity, burndown charts and cycle time for every team.</p>'),
    'https://cirrus.com/',
  ),
];

/** The page under test: same category, but thin and missing key topics. */
const targetHtml = `<!doctype html>
<html>
<head>
  <title>Home</title>
</head>
<body>
  <h1>Welcome</h1>
  <h1>Our Product</h1>
  <p>We make a task tracking app for teams. Our task tracking app helps teams work together.
     Try our task tracking tool today and see how your team works.</p>
  <img src="/a.png">
  <img src="/b.png">
  <a href="https://acme.com/">Acme</a>
  <a href="https://twitter.com/us">Twitter</a>
  <a href="/about">About</a>
</body>
</html>`;

const target = extractFromHtml(targetHtml, 'https://mysite.com/');

// ----------------------------------------------------------------- tests ----
section('HTML extraction');

test('reads title, meta description and canonical', () => {
  const c = competitors[0];
  assert.equal(c.title, 'Acme — Project Management Software for Remote Teams');
  assert.match(c.metaDescription, /project management software/i);
  assert.equal(c.canonical, 'https://acme.com/');
});

test('collects headings with their levels', () => {
  const c = competitors[0];
  assert.equal(c.h1Count, 1);
  assert.ok(c.headings.filter((h) => h.level === 2).length >= 4, 'expected several H2s');
});

test('separates internal from external links', () => {
  assert.ok(target.links.external >= 2, 'target links out to acme + twitter');
  assert.ok(target.links.internal >= 1, 'target has an internal link');
  const hosts = target.links.externalHosts.map((h) => h.host);
  assert.ok(hosts.includes('acme.com'));
});

test('counts images missing alt', () => {
  assert.equal(target.images.total, 2);
  assert.equal(target.images.missingAlt, 2);
});

test('picks up JSON-LD schema types', () => {
  assert.ok(competitors[0].schemaTypes.includes('SoftwareApplication'));
  assert.equal(target.schemaTypes.length, 0);
});

test('decodes HTML entities in text', () => {
  const page = extractFromHtml('<html><head><title>Caf&eacute; &amp; Bar &#8212; Menu</title></head><body><p>x</p></body></html>', 'https://x.com/');
  assert.equal(page.title, 'Café & Bar — Menu');
});

test('excludes code samples from body text', () => {
  const page = extractFromHtml(
    '<html><body><p>Install the plugin.</p><pre>const bundler = require("zzzcode");</pre><p>Then run it.</p><code>npm install zzzinline</code></body></html>',
    'https://x.com/',
  );
  assert.ok(!page.fields.body.includes('zzzcode'), '<pre> contents leaked into keywords');
  assert.ok(!page.fields.body.includes('zzzinline'), '<code> contents leaked into keywords');
  assert.ok(page.fields.body.includes('Install the plugin'));
});

test('ignores script and style content in body text', () => {
  const page = extractFromHtml(
    '<html><body><script>var secretKeyword="zzzunique";</script><style>.a{color:red}</style><p>real copy here</p></body></html>',
    'https://x.com/',
  );
  assert.ok(!page.fields.body.includes('zzzunique'), 'script contents leaked into body text');
  assert.ok(page.fields.body.includes('real copy'));
});

section('Audit rules');

const targetAudit = auditPage(target);
const goodAudit = auditPage(competitors[0]);

test('flags the thin page and passes the good one', () => {
  assert.ok(targetAudit.score < goodAudit.score, `expected ${targetAudit.score} < ${goodAudit.score}`);
  assert.ok(goodAudit.score >= 80, `well-built page scored only ${goodAudit.score}`);
});

test('score stays within 0-100', () => {
  for (const a of [targetAudit, goodAudit]) {
    assert.ok(a.score >= 0 && a.score <= 100, `score out of range: ${a.score}`);
  }
});

test('detects multiple H1s', () => {
  assert.ok(targetAudit.findings.some((f) => f.id === 'h1-multiple'), 'missed duplicate H1');
});

test('detects the missing meta description and viewport', () => {
  const ids = targetAudit.findings.map((f) => f.id);
  assert.ok(ids.includes('description-missing'));
  assert.ok(ids.includes('viewport'));
  assert.ok(ids.includes('canonical-missing'));
});

test('detects images without alt text', () => {
  assert.ok(targetAudit.findings.some((f) => f.id === 'img-alt'));
});

test('flags noindex as critical', () => {
  const page = extractFromHtml('<html><head><title>T</title><meta name="robots" content="noindex, follow"></head><body><p>hi</p></body></html>', 'https://x.com/');
  const a = auditPage(page);
  const finding = a.findings.find((f) => f.id === 'noindex');
  assert.ok(finding, 'noindex not detected');
  assert.equal(finding.severity, 'critical');
});

test('every finding carries a fix', () => {
  for (const f of targetAudit.findings) {
    assert.ok(f.fix && f.fix.length > 10, `finding ${f.id} has no usable fix`);
    assert.ok(['critical', 'warning', 'notice'].includes(f.severity), `bad severity on ${f.id}`);
  }
});

section('Keyword extraction');

test('phrases never start or end with a stopword', () => {
  const map = extractPhrases('the best project management software for the remote team', 1);
  for (const phrase of map.keys()) {
    const parts = phrase.split(' ');
    assert.ok(parts[0] !== 'the' && parts[0] !== 'for', `phrase starts with a stopword: "${phrase}"`);
    assert.ok(parts.at(-1) !== 'the' && parts.at(-1) !== 'for', `phrase ends with a stopword: "${phrase}"`);
  }
});

test('n-grams do not cross punctuation boundaries', () => {
  const map = extractPhrases('gantt charts. sprint planning', 1);
  assert.ok(!map.has('charts sprint'), 'n-gram crossed a sentence boundary');
  assert.ok(map.has('gantt charts'));
  assert.ok(map.has('sprint planning'));
});

test('tokenizer drops bare numbers and one-character noise', () => {
  const toks = tokenize('we shipped 42 features in v2 — a big release');
  assert.ok(!toks.includes('42'));
  assert.ok(!toks.includes('a'));
  assert.ok(toks.includes('shipped'));
});

test('normalizeMap scales the strongest term to 1', () => {
  const m = normalizeMap(new Map([['a', 4], ['b', 2]]));
  assert.equal(m.get('a'), 1);
  assert.equal(m.get('b'), 0.5);
});

section('k-means');

test('separates two obviously distinct groups', () => {
  const vectors = [
    [1, 0, 0], [0.95, 0.05, 0], [0.9, 0.1, 0],
    [0, 1, 0], [0.05, 0.95, 0], [0, 0.9, 0.1],
  ].map((v) => l2Normalize(Float64Array.from(v)));

  const { assignments } = kmeans(vectors, 2, { seed: 7 });
  assert.equal(assignments[0], assignments[1], 'group A split apart');
  assert.equal(assignments[1], assignments[2], 'group A split apart');
  assert.equal(assignments[3], assignments[4], 'group B split apart');
  assert.notEqual(assignments[0], assignments[3], 'the two groups were merged');
});

test('is deterministic across runs', () => {
  const vectors = Array.from({ length: 40 }, (_, i) =>
    l2Normalize(Float64Array.from([Math.sin(i), Math.cos(i * 1.7), Math.sin(i * 0.3)])));
  const a = Array.from(kmeans(vectors, 3, { seed: 42 }).assignments);
  const b = Array.from(kmeans(vectors, 3, { seed: 42 }).assignments);
  assert.deepEqual(a, b);
});

test('silhouette rates a clean split above a forced one', () => {
  const vectors = [
    [1, 0], [0.99, 0.01], [0.98, 0.02], [0.97, 0.03],
    [0, 1], [0.01, 0.99], [0.02, 0.98], [0.03, 0.97],
  ].map((v) => l2Normalize(Float64Array.from(v)));
  const two = kmeans(vectors, 2, { seed: 3 });
  const four = kmeans(vectors, 4, { seed: 3 });
  assert.ok(
    silhouette(vectors, two.assignments, 2) > silhouette(vectors, four.assignments, 4),
    'over-clustering scored better than the natural k=2 split',
  );
});

test('autoCluster picks k=2 for two well-separated blobs', () => {
  const vectors = [];
  for (let i = 0; i < 15; i++) vectors.push(l2Normalize(Float64Array.from([1 + i * 0.001, 0.02, 0])));
  for (let i = 0; i < 15; i++) vectors.push(l2Normalize(Float64Array.from([0.02, 1 + i * 0.001, 0])));
  const { k } = autoCluster(vectors, { kMin: 2, kMax: 6 });
  assert.equal(k, 2, `chose k=${k}`);
});

test('never produces an empty cluster', () => {
  const vectors = Array.from({ length: 30 }, (_, i) =>
    l2Normalize(Float64Array.from([Math.sin(i), Math.cos(i), Math.sin(i / 2)])));
  const { assignments, k } = autoCluster(vectors, { kMin: 2, kMax: 5 });
  const seen = new Set(Array.from(assignments));
  assert.equal(seen.size, k, `k=${k} but only ${seen.size} clusters were used`);
});

section('End-to-end analysis');

const result = analyze(target, competitors);

test('produces keywords, clusters and benchmarks', () => {
  assert.ok(result.keywords.length > 20, `only ${result.keywords.length} keywords`);
  assert.ok(result.clusters.length >= 2, `only ${result.clusters.length} clusters`);
  assert.ok(result.benchmarks.length > 0);
  assert.equal(result.stats.competitorCount, 3);
});

test('surfaces category terms the target is missing', () => {
  const gaps = result.keywords
    .filter((k) => k.status === 'missing' || k.status === 'absent')
    .map((k) => k.term);
  assert.ok(gaps.some((t) => t.includes('gantt')), `no gantt gap found in: ${gaps.slice(0, 15).join(', ')}`);
  assert.ok(gaps.some((t) => t.includes('time tracking')), 'missed the time-tracking gap');
});

test('recognises what the target already covers', () => {
  const tracked = result.keywords.find((k) => k.term === 'task tracking');
  assert.ok(tracked, 'task tracking missing from the keyword table');
  assert.ok(tracked.targetStrength > 0, 'task tracking should register on the target page');
});

test('gap terms outrank terms the page already owns', () => {
  const gantt = result.keywords.find((k) => k.term.includes('gantt'));
  const owned = result.keywords.find((k) => k.term === 'task tracking');
  assert.ok(gantt.score > 0);
  assert.ok(gantt.gap > owned.gap, 'a missing term should have a larger gap than an owned one');
});

test('scores stay in range and sort descending', () => {
  for (const k of result.keywords) {
    assert.ok(k.score >= 0 && k.score <= 100, `${k.term} scored ${k.score}`);
    assert.ok(k.coverage >= 0 && k.coverage <= 1, `${k.term} coverage ${k.coverage}`);
  }
  for (let i = 1; i < result.keywords.length; i++) {
    assert.ok(result.keywords[i - 1].score >= result.keywords[i].score, 'keywords are not sorted by score');
  }
});

test('every clustered keyword belongs to exactly one cluster', () => {
  const seen = new Set();
  let total = 0;
  for (const c of result.clusters) {
    for (const m of c.members) {
      assert.ok(!seen.has(m.term), `"${m.term}" appears in two clusters`);
      seen.add(m.term);
      total++;
    }
  }
  assert.equal(total, result.stats.clusteredCount);
});

test('clusters carry a label and actionable advice', () => {
  for (const c of result.clusters) {
    assert.ok(c.label && c.label.length > 1, 'cluster has no label');
    assert.ok(c.theme.advice.length > 20, `cluster "${c.label}" has no advice`);
    assert.ok(c.size > 0);
  }
});

test('at least one cluster is identified as a content gap', () => {
  const themes = result.clusters.map((c) => c.theme.key);
  assert.ok(themes.includes('gap') || themes.includes('weak'), `themes were: ${themes.join(', ')}`);
});

test('never recommends site furniture as the primary keyword', () => {
  // The target's H1 is "Welcome", which carries a heavy field weight while
  // describing nothing — the primary term must be the real topic instead.
  const titleRec = result.recommendations.find((r) => r.title.includes('title tag'));
  assert.ok(titleRec, 'expected a title recommendation for a page titled "Home"');
  assert.ok(!/welcome/i.test(titleRec.title), `picked boilerplate as primary: ${titleRec.title}`);
  assert.ok(/task tracking/i.test(titleRec.title), `expected the real topic, got: ${titleRec.title}`);
});

test('boilerplate terms are flagged but still reported', () => {
  const welcome = result.keywords.find((k) => k.term === 'welcome');
  if (welcome) assert.equal(welcome.boilerplate, true, '"welcome" should be flagged as boilerplate');
  const real = result.keywords.find((k) => k.term === 'task tracking');
  assert.equal(real.boilerplate, false);
});

test('recommendations name concrete terms and placements', () => {
  assert.ok(result.recommendations.length > 0);
  const high = result.recommendations.filter((r) => r.priority === 'high');
  assert.ok(high.length > 0, 'no high-priority recommendation for a page this weak');
  for (const r of result.recommendations) {
    assert.ok(['high', 'medium', 'low'].includes(r.priority));
    assert.ok(r.title && r.detail);
  }
});

test('benchmarks compare against the competitor median', () => {
  const words = result.benchmarks.find((b) => b.metric === 'Word count');
  assert.ok(words.category > words.you, 'competitors should be wordier than the thin target');
  const schema = result.benchmarks.find((b) => b.metric === 'Uses structured data');
  assert.equal(schema.you, 0);
  assert.equal(schema.category, 100);
});

section('Degenerate inputs');

test('handles a page with no competitors', () => {
  const solo = analyze(target, []);
  assert.equal(solo.stats.competitorCount, 0);
  assert.ok(solo.keywords.length > 0);
  assert.equal(solo.benchmarks, null);
  assert.ok(solo.recommendations.length > 0);
});

test('handles an almost-empty page without throwing', () => {
  const blank = extractFromHtml('<html><body></body></html>', 'https://x.com/');
  const a = auditPage(blank);
  const r = analyze(blank, competitors);
  assert.ok(Number.isFinite(a.score));
  assert.ok(Array.isArray(r.keywords));
});

test('recovers the title from unclosed tags', () => {
  const messy = extractFromHtml('<html><head><title>Broken<body><h1>Hi<p>text<img src=x alt=y><a href=/z>link', 'https://x.com/');
  assert.equal(messy.title, 'Broken', 'should stop the title at the next tag, as browsers do');
  assert.ok(Number.isFinite(auditPage(messy).score), 'audit threw on malformed input');
});

test('parses unquoted attribute values', () => {
  const page = extractFromHtml('<html><body><img src=x.png alt=Dashboard width=10 height=10><a href=/next rel=nofollow>Next</a></body></html>', 'https://x.com/');
  assert.equal(page.images.missingAlt, 0);
  assert.equal(page.links.nofollow, 1);
});

test('handles a single competitor', () => {
  const one = analyze(target, [competitors[0]]);
  assert.equal(one.stats.competitorCount, 1);
  assert.ok(one.keywords.length > 0);
  for (const k of one.keywords) assert.ok(k.coverage === 0 || k.coverage === 1);
});

// ---------------------------------------------------------------- summary --
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
