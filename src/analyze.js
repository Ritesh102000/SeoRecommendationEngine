/**
 * Orchestration: turn one target page + N competitor pages into
 *   - a scored keyword table (demand / gap / opportunity)
 *   - k-means topic clusters over those keywords
 *   - category benchmarks
 *   - concrete "put this word here" recommendations
 */

import {
  keywordMapForPage, normalizeMap, tfidf, phraseness, segments, tokenizeSegment,
  STOPWORDS, BOILERPLATE,
} from './nlp.js';
import { autoCluster, l2Normalize } from './kmeans.js';

const MAX_VOCAB = 400;         // terms carried into scoring
const MAX_CLUSTERED = 180;     // terms carried into k-means (silhouette is O(n²))
const LEXICAL_DIMS = 160;      // unigram dimensions in the clustering vector
const MIN_PHRASENESS = 0.28;   // below this a multi-word phrase is word-order noise
const MIN_PHRASE_COUNT = 2;    // a phrase seen once in the whole corpus is not a keyword

/**
 * @param {object} target  page data for the scanned page
 * @param {Array}  competitors  page data for each competitor that fetched OK
 */
export function analyze(target, competitors = []) {
  const targetProfile = keywordMapForPage(target);
  const compProfiles = competitors.map(keywordMapForPage);

  const targetMap = targetProfile.weighted;
  const compMaps = compProfiles.map((p) => p.weighted);

  const targetNorm = normalizeMap(targetMap);
  const compNorms = compMaps.map(normalizeMap);
  const compCount = competitors.length;

  // Raw (unweighted) counts across every document, used for phrase quality.
  const corpusCounts = new Map();
  for (const profile of [targetProfile, ...compProfiles]) {
    for (const [term, c] of profile.counts) {
      corpusCounts.set(term, (corpusCounts.get(term) || 0) + c);
    }
  }

  // ------------------------------------------------------------- vocabulary -
  // Keep a term if the target uses it meaningfully, or if enough competitors do.
  const minCompDf = compCount >= 3 ? 2 : 1;
  const candidates = new Map(); // term -> { targetW, compDf, compSum }

  const touch = (term) => {
    let rec = candidates.get(term);
    if (!rec) { rec = { targetW: 0, compDf: 0, compSum: 0 }; candidates.set(term, rec); }
    return rec;
  };

  for (const [term, w] of targetNorm) touch(term).targetW = w;
  compNorms.forEach((m) => {
    for (const [term, w] of m) {
      if (w < 0.04) continue; // ignore a competitor's incidental mentions
      const rec = touch(term);
      rec.compDf += 1;
      rec.compSum += w;
    }
  });

  const vocab = new Set();
  for (const [term, rec] of candidates) {
    const isPhrase = term.includes(' ');
    if (isPhrase) {
      // Drop word pairs that only ever co-occurred by accident.
      if ((corpusCounts.get(term) || 0) < MIN_PHRASE_COUNT) continue;
      if (phraseness(term, corpusCounts) < MIN_PHRASENESS) continue;
    }
    const usefulToTarget = rec.targetW >= 0.06;
    const usefulToCategory = rec.compDf >= minCompDf;
    if (usefulToTarget || usefulToCategory) vocab.add(term);
  }

  // Trim to the most salient terms so the UI and the clustering stay meaningful.
  const salience = (term) => {
    const r = candidates.get(term);
    return r.targetW * 0.8 + (compCount ? (r.compSum / compCount) * 1.2 + (r.compDf / compCount) * 0.6 : 0);
  };
  let vocabList = Array.from(vocab).sort((a, b) => salience(b) - salience(a));
  if (vocabList.length > MAX_VOCAB) vocabList = vocabList.slice(0, MAX_VOCAB);
  const finalVocab = new Set(vocabList);

  // ----------------------------------------------------------------- TF-IDF -
  const corpus = [targetMap, ...compMaps];
  const { docs: tfidfDocs, idf, df } = tfidf(corpus, finalVocab);
  const targetTfidf = tfidfDocs[0];
  const compTfidf = tfidfDocs.slice(1);

  // ---------------------------------------------------------------- scoring -
  const keywords = vocabList.map((term) => {
    const rec = candidates.get(term);
    const words = term.split(' ').length;

    const coverage = compCount ? rec.compDf / compCount : 0;
    const compStrength = rec.compDf ? rec.compSum / rec.compDf : 0;
    const targetStrength = rec.targetW;

    // How much the category cares about this term.
    const demand = compCount ? 0.6 * coverage + 0.4 * compStrength : targetStrength;
    // How far behind the target is on it.
    const gap = Math.max(0, Math.min(1, demand - targetStrength));
    // Long-tail phrases convert better and are easier to win than head terms.
    const specificity = words === 1 ? 0.82 : words === 2 ? 1 : 0.94;

    const score = Math.round((0.55 * demand + 0.45 * gap) * specificity * 100);

    return {
      term,
      words,
      coverage,
      compDf: rec.compDf,
      compStrength,
      targetStrength,
      demand,
      gap,
      score,
      tfidf: targetTfidf.get(term) || 0,
      idf: idf.get(term) || 0,
      df: df.get(term) || 0,
      boilerplate: BOILERPLATE.has(term),
      status: statusFor({ targetStrength, compStrength, coverage, compCount }),
      placements: placementsFor(term, target),
      competitorTfidf: compTfidf.map((m) => m.get(term) || 0),
    };
  });

  keywords.sort((a, b) => b.score - a.score);

  // ------------------------------------------------------------- clustering -
  const clustered = keywords.slice(0, MAX_CLUSTERED);
  const clusters = clustered.length >= 6
    ? buildClusters(clustered, compCount, [target, ...competitors])
    : [];

  // ------------------------------------------------------------- benchmarks -
  const benchmarks = buildBenchmarks(target, competitors);

  // --------------------------------------------------------- recommendations
  const recommendations = buildRecommendations(keywords, target, compCount);

  return {
    keywords,
    clusters,
    benchmarks,
    recommendations,
    stats: {
      vocabSize: finalVocab.size,
      competitorCount: compCount,
      clusteredCount: clustered.length,
    },
  };
}

function statusFor({ targetStrength, compStrength, coverage, compCount }) {
  if (!compCount) return targetStrength > 0.35 ? 'primary' : 'secondary';
  if (targetStrength === 0 && coverage >= 0.5) return 'missing';
  if (targetStrength === 0 && coverage > 0) return 'absent';
  if (coverage === 0) return 'unique';
  if (targetStrength < compStrength * 0.55) return 'underused';
  if (targetStrength >= compStrength) return 'defend';
  return 'competitive';
}

export const STATUS_META = {
  missing: { label: 'Missing', hint: 'Most competitors cover this and you do not at all.', tone: 'critical' },
  absent: { label: 'Not used', hint: 'Some competitors cover this; you do not.', tone: 'warning' },
  underused: { label: 'Underused', hint: 'You mention it, but far more weakly than competitors.', tone: 'warning' },
  competitive: { label: 'Competitive', hint: 'You are roughly level with the category.', tone: 'ok' },
  defend: { label: 'Your strength', hint: 'You cover this more strongly than competitors — defend it.', tone: 'good' },
  unique: { label: 'Unique to you', hint: 'No competitor in the set uses this. Differentiator or off-topic.', tone: 'info' },
  primary: { label: 'Primary', hint: 'Dominant term on the page.', tone: 'good' },
  secondary: { label: 'Secondary', hint: 'Supporting term on the page.', tone: 'info' },
};

/** Where the term is missing on the target page. */
function placementsFor(term, page) {
  const has = (s) => (s || '').toLowerCase().includes(term);
  const out = [];
  if (!has(page.title)) out.push('title');
  if (!has(page.fields?.h1)) out.push('h1');
  if (!has(page.metaDescription)) out.push('meta description');
  if (!has(page.fields?.h2)) out.push('a subheading');
  return out;
}

/**
 * Cluster keywords with k-means.
 *
 * Each keyword becomes one vector built from three concatenated blocks:
 *
 *   1. Context block (dominant) — a PPMI-weighted profile of the words that
 *      appear in the same sentence as the phrase, across every document. This
 *      is what makes "pricing" land next to "free plan" and "per user" even
 *      though they share no words. Without it, one-hot token vectors leave
 *      unrelated terms mutually orthogonal, and k-means answers with one huge
 *      cluster plus a pile of singletons.
 *   2. Lexical block — indicators for the phrase's own tokens, so "gantt" and
 *      "gantt charts" stay together.
 *   3. Coverage block — tf-idf per document, which separates "everyone covers
 *      this" from "only you do".
 */
function buildClusters(keywords, compCount, pages) {
  const docDims = compCount + 1;

  // ---- lexical vocabulary: the tokens the selected phrases are made of -----
  const tokenFreq = new Map();
  for (const k of keywords) {
    for (const t of k.term.split(' ')) {
      if (STOPWORDS.has(t)) continue;
      tokenFreq.set(t, (tokenFreq.get(t) || 0) + 1);
    }
  }
  const lexTokens = Array.from(tokenFreq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, LEXICAL_DIMS)
    .map(([t]) => t);
  const lexIndex = new Map(lexTokens.map((t, i) => [t, i]));

  const context = buildContextVectors(keywords, pages);

  const CONTEXT_WEIGHT = 1.6;
  const LEXICAL_WEIGHT = 0.9;
  const COVERAGE_WEIGHT = 0.5;

  const ctxDims = context.dims;
  const vectors = keywords.map((k, ki) => {
    const v = new Float64Array(ctxDims + lexTokens.length + docDims);

    const ctx = context.vectors[ki];
    for (let i = 0; i < ctxDims; i++) v[i] = ctx[i] * CONTEXT_WEIGHT;

    for (const t of k.term.split(' ')) {
      const idx = lexIndex.get(t);
      if (idx !== undefined) v[ctxDims + idx] += LEXICAL_WEIGHT;
    }

    const base = ctxDims + lexTokens.length;
    v[base] = k.tfidf * COVERAGE_WEIGHT;
    for (let i = 0; i < compCount; i++) {
      v[base + 1 + i] = (k.competitorTfidf[i] || 0) * COVERAGE_WEIGHT;
    }

    return l2Normalize(v);
  });

  const { assignments, k, score } = autoCluster(vectors, {
    kMin: 2,
    kMax: 8,
    seed: 42,
    penalizeSingletons: true,
  });

  const groups = Array.from({ length: Math.max(k, 1) }, () => []);
  assignments.forEach((c, i) => groups[c]?.push(keywords[i]));

  return groups
    .filter((g) => g.length > 0)
    .map((members) => {
      members.sort((a, b) => b.score - a.score);
      const avg = (fn) => members.reduce((s, m) => s + fn(m), 0) / members.length;
      const avgCoverage = avg((m) => m.coverage);
      const avgTarget = avg((m) => m.targetStrength);
      const avgComp = avg((m) => m.compStrength);
      const avgScore = avg((m) => m.score);

      return {
        label: labelFor(members),
        members,
        size: members.length,
        avgCoverage,
        avgTarget,
        avgComp,
        avgScore: Math.round(avgScore),
        theme: themeFor({ avgCoverage, avgTarget, avgComp, compCount }),
      };
    })
    .sort((a, b) => b.avgScore - a.avgScore)
    .map((c, i) => ({ ...c, id: i, silhouette: score }));
}

/**
 * Distributional vectors: profile each keyword by the words it shares a
 * sentence with, then reweight with positive pointwise mutual information so
 * that generically common context words stop dominating the similarity.
 *
 * @returns {{vectors: Float64Array[], dims: number}}
 */
function buildContextVectors(keywords, pages) {
  // ---- context vocabulary --------------------------------------------------
  const freq = new Map();
  const docSegments = [];

  for (const page of pages) {
    const f = page.fields || {};
    const text = [f.title, f.description, f.h1, f.h2, f.h3, f.body].filter(Boolean).join('. ');
    const segs = [];
    for (const seg of segments(text)) {
      const toks = tokenizeSegment(seg).filter((t) => !STOPWORDS.has(t) && t.length >= 3);
      if (toks.length < 2) continue;
      segs.push(toks);
      for (const t of toks) freq.set(t, (freq.get(t) || 0) + 1);
    }
    docSegments.push(segs);
  }

  const ctxTokens = Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, LEXICAL_DIMS)
    .map(([t]) => t);
  const ctxIndex = new Map(ctxTokens.map((t, i) => [t, i]));
  const dims = ctxTokens.length;

  const vectors = keywords.map(() => new Float64Array(dims));
  if (dims === 0) return { vectors, dims: 0 };

  // ---- raw co-occurrence counts -------------------------------------------
  // Phrases and segments come from the same tokenizer, so a padded substring
  // test is an exact whole-token match.
  const needles = keywords.map((k) => ` ${k.term} `);

  for (const segs of docSegments) {
    for (const toks of segs) {
      const hay = ` ${toks.join(' ')} `;
      for (let ki = 0; ki < needles.length; ki++) {
        if (!hay.includes(needles[ki])) continue;
        const vec = vectors[ki];
        for (const t of toks) {
          const idx = ctxIndex.get(t);
          if (idx !== undefined) vec[idx] += 1;
        }
      }
    }
  }

  // ---- PPMI reweighting ----------------------------------------------------
  const colSums = new Float64Array(dims);
  const rowSums = new Float64Array(vectors.length);
  let total = 0;
  vectors.forEach((vec, i) => {
    for (let j = 0; j < dims; j++) {
      colSums[j] += vec[j];
      rowSums[i] += vec[j];
      total += vec[j];
    }
  });

  if (total > 0) {
    vectors.forEach((vec, i) => {
      if (rowSums[i] === 0) return;
      for (let j = 0; j < dims; j++) {
        if (vec[j] === 0) continue;
        const pmi = Math.log((vec[j] * total) / (rowSums[i] * colSums[j]));
        vec[j] = pmi > 0 ? pmi : 0;
      }
      l2Normalize(vec);
    });
  }

  return { vectors, dims };
}

/** Name a cluster after the tokens its highest-scoring members share. */
function labelFor(members) {
  const freq = new Map();
  members.slice(0, 25).forEach((m, rank) => {
    const weight = 1 / (1 + rank * 0.15);
    for (const t of m.term.split(' ')) {
      if (STOPWORDS.has(t) || t.length < 3) continue;
      freq.set(t, (freq.get(t) || 0) + weight);
    }
  });
  const top = Array.from(freq.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => t);
  if (top.length === 0) return members[0]?.term || 'Cluster';
  return top.join(' · ');
}

function themeFor({ avgCoverage, avgTarget, avgComp, compCount }) {
  if (!compCount) return { key: 'onpage', label: 'On-page topic', advice: 'Add competitors to see how this topic compares to the category.' };
  if (avgCoverage < 0.15) {
    return { key: 'unique', label: 'Only you', advice: 'No one else in the set covers this. Either a real differentiator or off-topic drift — decide which.' };
  }
  if (avgTarget < 0.1 && avgCoverage >= 0.4) {
    return { key: 'gap', label: 'Content gap', advice: 'The category covers this topic and this page does not. Highest-leverage place to add a section.' };
  }
  if (avgCoverage >= 0.6 && avgTarget < avgComp * 0.7) {
    return { key: 'weak', label: 'Table stakes, underweight', advice: 'Everyone covers this and you do so weakly. Strengthen it before chasing new topics.' };
  }
  if (avgTarget >= avgComp) {
    return { key: 'strength', label: 'Your strength', advice: 'You lead the set here. Keep this copy and build internal links around it.' };
  }
  return { key: 'contested', label: 'Contested', advice: 'You are level with the category. Depth and freshness decide this one.' };
}

function buildBenchmarks(target, competitors) {
  if (competitors.length === 0) return null;
  const nums = (fn) => competitors.map(fn).filter((n) => Number.isFinite(n));
  const median = (arr) => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
  };
  const pct = (fn) => Math.round((competitors.filter(fn).length / competitors.length) * 100);

  return [
    {
      metric: 'Word count',
      you: target.wordCount,
      category: median(nums((c) => c.wordCount)),
      format: 'number',
      higherIsBetter: true,
    },
    {
      metric: 'Title length',
      you: (target.title || '').length,
      category: median(nums((c) => (c.title || '').length)),
      format: 'chars',
      higherIsBetter: null,
    },
    {
      metric: 'Headings',
      you: (target.headings || []).length,
      category: median(nums((c) => (c.headings || []).length)),
      format: 'number',
      higherIsBetter: true,
    },
    {
      metric: 'Internal links',
      you: target.links?.internal || 0,
      category: median(nums((c) => c.links?.internal || 0)),
      format: 'number',
      higherIsBetter: true,
    },
    {
      metric: 'Images',
      you: target.images?.total || 0,
      category: median(nums((c) => c.images?.total || 0)),
      format: 'number',
      higherIsBetter: true,
    },
    {
      metric: 'Uses structured data',
      you: (target.schemaTypes || []).length > 0 ? 100 : 0,
      category: pct((c) => (c.schemaTypes || []).length > 0),
      format: 'percent',
      higherIsBetter: true,
    },
    {
      metric: 'Has meta description',
      you: target.metaDescription ? 100 : 0,
      category: pct((c) => Boolean(c.metaDescription)),
      format: 'percent',
      higherIsBetter: true,
    },
  ];
}

function buildRecommendations(keywords, target, compCount) {
  const out = [];
  const titleLc = (target.title || '').toLowerCase();
  const h1Lc = (target.fields?.h1 || '').toLowerCase();
  const descLc = (target.metaDescription || '').toLowerCase();

  const usable = keywords.filter((k) => !k.boilerplate);
  const gaps = usable.filter((k) => (k.status === 'missing' || k.status === 'absent') && k.words >= 2).slice(0, 6);
  const underused = usable.filter((k) => k.status === 'underused').slice(0, 5);
  const strengths = usable.filter((k) => k.status === 'defend' || k.status === 'primary').slice(0, 5);

  // The page's primary term is what it already talks about most — not what it is
  // missing, not site furniture, and a phrase beats a bare word as a target.
  // When there are competitors, require the category to use the term too:
  // a keyword nobody else in the niche mentions is not the one to build on.
  const rank = (k) => k.targetStrength * (k.words >= 2 ? 1.15 : 1);
  const owned = usable.filter((k) => k.targetStrength > 0).sort((a, b) => rank(b) - rank(a));
  const primary =
    (compCount ? owned.find((k) => k.coverage > 0) : owned[0])
    || owned[0]
    || usable[0]
    || keywords[0];

  if (primary && !titleLc.includes(primary.term)) {
    out.push({
      priority: 'high',
      title: `Put "${primary.term}" in the title tag`,
      detail: `It is the strongest topical term for this page but does not appear in the title — the highest-weight element you control.`,
      example: buildTitleSuggestion(target, primary.term),
    });
  }
  if (primary && !h1Lc.includes(primary.term)) {
    out.push({
      priority: 'high',
      title: `Work "${primary.term}" into the H1`,
      detail: 'The H1 and title should agree on the page topic. Right now they do not both contain the primary term.',
    });
  }
  if (primary && !descLc.includes(primary.term)) {
    out.push({
      priority: 'medium',
      title: `Mention "${primary.term}" in the meta description`,
      detail: 'Matched terms are bolded in the search snippet, which lifts click-through even when rank is unchanged.',
      example: buildDescriptionSuggestion(target, primary.term),
    });
  }

  if (gaps.length && compCount) {
    out.push({
      priority: 'high',
      title: `Cover ${gaps.length} topic${gaps.length === 1 ? '' : 's'} the category ranks for and you do not`,
      detail: `Competitors consistently cover: ${gaps.map((g) => `"${g.term}"`).join(', ')}. Each is a section this page is missing.`,
      terms: gaps.map((g) => g.term),
    });
  }

  if (underused.length && compCount) {
    out.push({
      priority: 'medium',
      title: 'Strengthen terms you only mention in passing',
      detail: `${underused.map((u) => `"${u.term}"`).join(', ')} appear on this page far more weakly than across the category. Promote them into headings rather than burying them in body copy.`,
      terms: underused.map((u) => u.term),
    });
  }

  if (strengths.length) {
    out.push({
      priority: 'low',
      title: 'Defend what you already lead on',
      detail: `You are strongest on ${strengths.map((s) => `"${s.term}"`).join(', ')}. Keep this copy intact and point internal links at this page using those phrases as anchor text.`,
      terms: strengths.map((s) => s.term),
    });
  }

  if (!compCount) {
    out.push({
      priority: 'medium',
      title: 'Add competitor URLs for the comparison',
      detail: 'Keyword scores right now reflect only this page. Add 3–5 sites in the same category to unlock gap analysis, clustering and benchmarks.',
    });
  }

  return out;
}

function buildTitleSuggestion(target, term) {
  const brand = (target.hostname || '').replace(/^www\./, '').split('.')[0];
  const brandNice = brand ? brand.charAt(0).toUpperCase() + brand.slice(1) : '';
  const nice = term.replace(/\b\w/g, (c) => c.toUpperCase());

  // Reuse the existing title as a qualifier only if it says something.
  const existing = (target.title || '').split(/[|\-–—]/)[0].trim();
  const isGeneric = !existing || existing.length < 12 || /^(home|welcome|index|untitled|page)$/i.test(existing);
  const base = isGeneric ? nice : `${nice} — ${existing}`;

  const suggestion = brandNice ? `${base} | ${brandNice}` : base;
  return suggestion.length > 60 ? `${suggestion.slice(0, 57)}…` : suggestion;
}

function buildDescriptionSuggestion(target, term) {
  const existing = (target.metaDescription || '').trim();
  if (!existing) return `Write ~150 characters covering "${term}" and the outcome a reader gets from this page.`;
  const merged = `${existing} Learn more about ${term}.`;
  return merged.length <= 160 ? merged : `Rework the existing description to lead with "${term}" (keep it under 160 characters).`;
}
