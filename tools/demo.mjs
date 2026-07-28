#!/usr/bin/env node
/**
 * Print a full analysis report to the terminal.
 *
 *   node tools/demo.mjs                       # synthetic fixtures
 *   node tools/demo.mjs <url> <competitor>…   # live pages
 *
 * Useful for tuning the scoring without reloading the extension.
 */

import { extractFromHtml } from '../src/html-extract.js';
import { auditPage } from '../src/audit.js';
import { analyze } from '../src/analyze.js';

const args = process.argv.slice(2);

const competitorHtml = (brand, extra) => `<html lang="en"><head>
<title>${brand} — Project Management Software for Remote Teams</title>
<meta name="description" content="${brand} is project management software with task tracking, gantt charts and time tracking for remote teams.">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="canonical" href="https://${brand.toLowerCase()}.com/">
<meta property="og:title" content="${brand}"><meta property="og:description" content="Project management software."><meta property="og:image" content="/og.png">
<script type="application/ld+json">{"@type":"SoftwareApplication","name":"${brand}"}</script>
</head><body>
<h1>Project Management Software for Remote Teams</h1>
<p>${brand} gives teams task tracking, gantt charts, sprint planning and time tracking in one project management workspace. Remote teams plan sprints, assign tasks and track project progress with project management software built for distributed work.</p>
<h2>Task Tracking and Sprint Planning</h2>
<p>Task tracking keeps every task visible. Sprint planning lets agile teams estimate story points and run sprint retrospectives. Team collaboration happens inside the task.</p>
<h2>Gantt Charts and Timelines</h2>
<p>Gantt charts show project timelines, dependencies and milestones. Resource management shows who is overloaded. Gantt charts update when you reschedule a task.</p>
<h2>Time Tracking and Reporting</h2>
<p>Time tracking turns logged hours into project reports and client invoices. Reporting dashboards cover team workload and sprint velocity. Time tracking runs in the background.</p>
${extra}
<h2>Pricing</h2><p>Free plan for small teams. Pricing starts at nine dollars per user per month.</p>
<img src="/hero.png" alt="Project management dashboard" width="800" height="600" loading="lazy">
<a href="/features">Features</a><a href="/pricing">Pricing</a><a href="/templates">Project templates</a>
</body></html>`;

const targetHtml = `<html><head><title>Home</title></head><body>
<h1>Welcome</h1><h1>Our Product</h1>
<p>We make a task tracking app for teams. Our task tracking app helps teams work together. Try our task tracking tool today.</p>
<img src="/a.png"><a href="https://acme.com/">Acme</a><a href="/about">About</a>
</body></html>`;

async function load(url) {
  const res = await fetch(url, { redirect: 'follow', headers: { Accept: 'text/html' } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return extractFromHtml(await res.text(), res.url || url);
}

let target;
let competitors;

if (args.length >= 1) {
  target = await load(args[0]);
  competitors = [];
  for (const url of args.slice(1)) {
    try {
      competitors.push(await load(url));
    } catch (err) {
      console.error(`  ! skipped ${url}: ${err.message}`);
    }
  }
} else {
  target = extractFromHtml(targetHtml, 'https://mysite.com/');
  competitors = [
    extractFromHtml(competitorHtml('Acme', '<h2>Team Collaboration</h2><p>Team collaboration with shared docs and chat keeps remote teams aligned. Team collaboration is built in.</p>'), 'https://acme.com/'),
    extractFromHtml(competitorHtml('Bolt', '<h2>Workflow Automation</h2><p>Workflow automation moves tasks between stages and triggers notifications. Workflow automation needs no code.</p>'), 'https://bolt.com/'),
    extractFromHtml(competitorHtml('Cirrus', '<h2>Agile Reporting</h2><p>Agile reporting covers sprint velocity, burndown charts and cycle time. Agile reporting is exportable.</p>'), 'https://cirrus.com/'),
  ];
}

const audit = auditPage(target);
const result = analyze(target, competitors);

const pad = (s, n) => String(s).padEnd(n);
const rule = (label) => console.log(`\n\x1b[1m${label}\x1b[0m\n${'─'.repeat(64)}`);

console.log(`\n\x1b[1mSEO Lens — ${target.url}\x1b[0m`);
console.log(`Score ${audit.score}/100 (grade ${audit.grade})  ·  ${audit.counts.critical} critical, ${audit.counts.warning} warnings, ${audit.counts.notice} notices, ${audit.counts.passed} passed`);

rule('Top issues');
for (const f of audit.findings.slice(0, 8)) {
  console.log(`  [${pad(f.severity, 8)}] ${f.title}\n              → ${f.fix}`);
}

rule(`Keywords (${result.stats.competitorCount} competitors, ${result.keywords.length} terms)`);
console.log(`  ${pad('score', 6)}${pad('term', 32)}${pad('cat', 6)}${pad('you', 6)}status`);
for (const k of result.keywords.slice(0, 20)) {
  console.log(`  ${pad(k.score, 6)}${pad(k.term, 32)}${pad(`${Math.round(k.coverage * 100)}%`, 6)}${pad(k.targetStrength.toFixed(2), 6)}${k.status}`);
}

rule(`Clusters (k=${result.clusters.length})`);
for (const c of result.clusters) {
  console.log(`  \x1b[1m${c.label}\x1b[0m  [${c.theme.label}]  ${c.size} keywords`);
  console.log(`    ${c.members.slice(0, 8).map((m) => m.term).join(', ')}`);
  console.log(`    → ${c.theme.advice}`);
}

if (result.benchmarks) {
  rule('Benchmarks');
  for (const b of result.benchmarks) {
    console.log(`  ${pad(b.metric, 26)} you ${pad(b.you, 8)} category ${b.category}`);
  }
}

rule('Recommendations');
for (const r of result.recommendations) {
  console.log(`  (${r.priority}) ${r.title}`);
  console.log(`      ${r.detail}`);
  if (r.example) console.log(`      e.g. ${r.example}`);
}
console.log();
