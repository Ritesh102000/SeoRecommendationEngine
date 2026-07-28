/**
 * Tokenisation, n-gram extraction and TF-IDF.
 * No dependencies — this runs in the popup page and the service worker.
 */

export const STOPWORDS = new Set(`a about above after again against all am an and any are aren't as at be
because been before being below between both but by can cannot could couldn't did didn't do does doesn't
doing don't down during each few for from further had hadn't has hasn't have haven't having he he'd he'll
he's her here here's hers herself him himself his how how's i i'd i'll i'm i've if in into is isn't it it's
its itself let's me more most mustn't my myself no nor not of off on once only or other ought our ours
ourselves out over own same shan't she she'd she'll she's should shouldn't so some such than that that's the
their theirs them themselves then there there's these they they'd they'll they're they've this those through
to too under until up very was wasn't we we'd we'll we're we've were weren't what what's when when's where
where's which while who who's whom why why's with won't would wouldn't you you'd you'll you're you've your
yours yourself yourselves also just get got make made use used using new one two three via etc via per within
across upon many much may might must shall will since however therefore thus able need needs want wants
like likes back even still yet ever never always often sometimes really quite rather every another anything
something nothing everything someone anyone everyone else than then now today yesterday tomorrow here there
click read more learn find see view go home page site website www com http https html`.split(/\s+/).filter(Boolean));

/** Junk tokens that survive tokenisation but carry no topical signal. */
const JUNK = new Set(['px', 'em', 'rem', 'div', 'span', 'href', 'src', 'utm', 'nbsp', 'amp', 'lorem', 'ipsum']);

/**
 * Site furniture. These are real words that often sit in an H1 or nav ("Welcome",
 * "Home"), so they pick up heavy field weights while describing nothing. They
 * stay in the keyword table — it should report what is actually on the page —
 * but are never recommended as a keyword to target.
 */
export const BOILERPLATE = new Set([
  'welcome', 'home', 'homepage', 'about', 'about us', 'contact', 'contact us', 'menu',
  'navigation', 'nav', 'toggle', 'skip', 'search', 'login', 'log in', 'logout', 'sign in',
  'sign up', 'signup', 'register', 'subscribe', 'newsletter', 'copyright', 'rights reserved',
  'all rights', 'privacy', 'privacy policy', 'terms', 'terms of service', 'cookie', 'cookies',
  'cookie policy', 'sitemap', 'back to top', 'read more', 'learn more', 'click here',
  'main content', 'skip to content', 'follow us', 'share', 'print', 'email us', 'faq',
  'page', 'website', 'site', 'welcome to',
]);

const SEGMENT_SPLIT = /[.!?;:,()\[\]{}"“”„«»|/\\<>•·—–\n\r\t~^*+=@#$%&]+/;
const TOKEN_SPLIT = /[^a-z0-9'’-]+/;

/** Split text into segments (n-grams never cross a segment boundary). */
export function segments(text) {
  if (!text) return [];
  return String(text).toLowerCase().split(SEGMENT_SPLIT);
}

function cleanToken(raw) {
  const t = raw.replace(/^['’-]+|['’-]+$/g, '');
  if (t.length < 2 || t.length > 28) return null;
  if (JUNK.has(t)) return null;
  if (/^\d+$/.test(t)) return null;          // bare numbers
  if (!/[a-z]/.test(t)) return null;         // must contain a letter
  return t;
}

/** Tokenise one segment into clean tokens. */
export function tokenizeSegment(segment) {
  const out = [];
  for (const raw of segment.split(TOKEN_SPLIT)) {
    if (!raw) continue;
    const t = cleanToken(raw);
    if (t) out.push(t);
  }
  return out;
}

/** Flat token list for the whole text (used for word counts / density). */
export function tokenize(text) {
  const out = [];
  for (const seg of segments(text)) out.push(...tokenizeSegment(seg));
  return out;
}

/**
 * Extract weighted n-gram phrases (1..maxN words) from a text blob.
 *
 * Phrases may not contain a stopword in any position: leading or trailing
 * stopwords produce fragments, and interior ones ("software for remote") span
 * two unrelated phrases rather than naming one thing.
 *
 * @param sink   phrase -> field-weighted score
 * @param counts phrase -> raw occurrence count, used later to judge whether a
 *               phrase is a real collocation or an accident of word order
 */
export function extractPhrases(text, weight = 1, maxN = 3, sink = new Map(), counts = null) {
  for (const seg of segments(text)) {
    const toks = tokenizeSegment(seg);
    for (let n = 1; n <= maxN; n++) {
      for (let i = 0; i + n <= toks.length; i++) {
        const gram = toks.slice(i, i + n);
        let hasStop = false;
        for (const t of gram) if (STOPWORDS.has(t)) { hasStop = true; break; }
        if (hasStop) continue;
        if (n === 1 && gram[0].length < 3) continue;
        const phrase = gram.join(' ');
        sink.set(phrase, (sink.get(phrase) || 0) + weight);
        if (counts) counts.set(phrase, (counts.get(phrase) || 0) + 1);
      }
    }
  }
  return sink;
}

/** Field importance — where a term appears matters more than how often. */
export const FIELD_WEIGHTS = {
  title: 6,
  h1: 5,
  description: 3.5,
  h2: 2.5,
  h3: 1.8,
  anchor: 1.4,
  alt: 1.2,
  body: 1,
};

/**
 * Build the phrase profile for one page from its extracted fields.
 * @returns {{weighted: Map<string, number>, counts: Map<string, number>}}
 */
export function keywordMapForPage(page) {
  const weighted = new Map();
  const counts = new Map();
  const f = page.fields || {};
  for (const [field, weight] of Object.entries(FIELD_WEIGHTS)) {
    extractPhrases(f[field], weight, 3, weighted, counts);
  }
  return { weighted, counts };
}

/**
 * Is this multi-word phrase a real collocation, or two words that happened to
 * sit next to each other? Compares the phrase's frequency against its rarest
 * constituent word: "gantt charts" always appears together (ratio ≈ 1), while
 * "gives teams" is one accident among many uses of "teams" (ratio ≈ 0.07).
 */
export function phraseness(phrase, corpusCounts) {
  const tokens = phrase.split(' ');
  if (tokens.length === 1) return 1;
  const phraseCount = corpusCounts.get(phrase) || 0;
  let minToken = Infinity;
  for (const t of tokens) {
    const c = corpusCounts.get(t);
    if (c !== undefined && c < minToken) minToken = c;
  }
  if (!isFinite(minToken) || minToken === 0) return 1;
  return phraseCount / minToken;
}

/**
 * Classic TF-IDF over a corpus of weighted phrase maps.
 * tf is length-normalised by the document's max weight so long pages don't win
 * by volume alone.
 */
export function tfidf(docMaps, vocab) {
  const N = docMaps.length;
  const df = new Map();
  for (const m of docMaps) {
    for (const term of m.keys()) {
      if (vocab && !vocab.has(term)) continue;
      df.set(term, (df.get(term) || 0) + 1);
    }
  }
  const idf = new Map();
  for (const [term, d] of df) idf.set(term, Math.log((N + 1) / (d + 1)) + 1);

  const docs = docMaps.map((m) => {
    let max = 0;
    for (const [term, w] of m) {
      if (vocab && !vocab.has(term)) continue;
      if (w > max) max = w;
    }
    const out = new Map();
    if (max === 0) return out;
    for (const [term, w] of m) {
      if (vocab && !vocab.has(term)) continue;
      out.set(term, (w / max) * (idf.get(term) || 1));
    }
    return out;
  });

  return { docs, idf, df };
}

/**
 * Rescale a phrase map so its strongest term is 1.0. Lets us compare a
 * 400-word landing page against a 4,000-word guide without the guide winning
 * on raw volume.
 */
export function normalizeMap(map) {
  let max = 0;
  for (const w of map.values()) if (w > max) max = w;
  const out = new Map();
  if (max === 0) return out;
  for (const [term, w] of map) out.set(term, w / max);
  return out;
}
