/**
 * Extract the same shape as extract-page.js, but from a raw HTML string.
 *
 * This runs in the MV3 service worker, where DOMParser does not exist, so it is
 * a deliberately tolerant regex/scanner-based parser. It only needs to be good
 * enough for SEO signals (meta, headings, visible copy) — not a spec-compliant
 * HTML parser.
 */

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', copy: '©', reg: '®',
  trade: '™', eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', uuml: 'ü', ouml: 'ö',
  auml: 'ä', szlig: 'ß', middot: '·', bull: '•', laquo: '«', raquo: '»', deg: '°', euro: '€',
  pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶', dagger: '†', permil: '‰', prime: '′',
};

export function decodeEntities(str) {
  if (!str || str.indexOf('&') === -1) return str || '';
  return str.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try { return String.fromCodePoint(code); } catch { return match; }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

/** Parse the attribute soup inside a single tag into a lowercase-keyed object. */
export function parseAttrs(tagBody) {
  const out = {};
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(tagBody))) {
    const value = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] || '';
    out[m[1].toLowerCase()] = decodeEntities(value).trim();
  }
  return out;
}

const collapse = (s) => (s || '').replace(/\s+/g, ' ').trim();
const stripTags = (html) => collapse(decodeEntities(html.replace(/<[^>]*>/g, ' ')));

/** Remove elements whose content is never user-visible copy. */
function stripNonContent(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript\s*>/gi, ' ')
    .replace(/<svg\b[\s\S]*?<\/svg\s*>/gi, ' ')
    .replace(/<template\b[\s\S]*?<\/template\s*>/gi, ' ');
}

/**
 * Boilerplate regions and code samples that would otherwise pollute the
 * keyword profile — without stripping <pre>/<code>, any documentation page
 * ends up "ranking" for const, npm and bash.
 */
function stripChrome(html) {
  return html
    .replace(/<nav\b[\s\S]*?<\/nav\s*>/gi, ' ')
    .replace(/<footer\b[\s\S]*?<\/footer\s*>/gi, ' ')
    .replace(/<header\b[\s\S]*?<\/header\s*>/gi, ' ')
    .replace(/<aside\b[\s\S]*?<\/aside\s*>/gi, ' ')
    .replace(/<form\b[\s\S]*?<\/form\s*>/gi, ' ')
    .replace(/<pre\b[\s\S]*?<\/pre\s*>/gi, ' ')
    .replace(/<code\b[\s\S]*?<\/code\s*>/gi, ' ')
    .replace(/<kbd\b[\s\S]*?<\/kbd\s*>/gi, ' ')
    .replace(/<samp\b[\s\S]*?<\/samp\s*>/gi, ' ');
}

/**
 * @param {string} html raw response body
 * @param {string} finalUrl the URL after redirects
 */
export function extractFromHtml(html, finalUrl) {
  const MAX_BODY_CHARS = 40000;
  const raw = String(html || '');
  const clean = stripNonContent(raw);

  let loc;
  try {
    loc = new URL(finalUrl);
  } catch {
    loc = { href: finalUrl, origin: '', hostname: '', pathname: '', protocol: '' };
  }

  // --- head-ish signals -----------------------------------------------------
  // Browsers recover from an unclosed <title> by ending it at the next tag;
  // without the fallback we would wrongly report "no title tag" on such pages.
  const titleMatch =
    clean.match(/<title[^>]*>([\s\S]*?)<\/title\s*>/i) ||
    clean.match(/<title[^>]*>([^<]*)/i);
  const title = titleMatch ? stripTags(titleMatch[1]) : '';

  const metas = [];
  const metaRe = /<meta\b([^>]*)>/gi;
  let mm;
  while ((mm = metaRe.exec(clean))) metas.push(parseAttrs(mm[1]));

  const meta = (key) => {
    const k = key.toLowerCase();
    const hit = metas.find(
      (a) => (a.name && a.name.toLowerCase() === k) || (a.property && a.property.toLowerCase() === k),
    );
    return hit ? hit.content || '' : '';
  };

  const links = [];
  const linkRe = /<link\b([^>]*)>/gi;
  let lm;
  while ((lm = linkRe.exec(clean))) links.push(parseAttrs(lm[1]));
  const linkRel = (rel) => {
    const hit = links.find((a) => (a.rel || '').toLowerCase().split(/\s+/).includes(rel));
    return hit ? hit.href || '' : '';
  };

  const htmlTag = clean.match(/<html\b([^>]*)>/i);
  const lang = htmlTag ? parseAttrs(htmlTag[1]).lang || '' : '';

  // --- headings -------------------------------------------------------------
  const headings = [];
  const headingRe = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi;
  let hm;
  while ((hm = headingRe.exec(clean))) {
    const t = stripTags(hm[2]);
    if (t) headings.push({ level: Number(hm[1]), text: t.slice(0, 300) });
    if (headings.length > 400) break;
  }
  const byLevel = (lvl) => headings.filter((h) => h.level === lvl).map((h) => h.text);

  // --- images ---------------------------------------------------------------
  const imgRe = /<img\b([^>]*)>/gi;
  let im;
  let total = 0;
  let missingAlt = 0;
  let emptyAlt = 0;
  let noDimensions = 0;
  let noLazy = 0;
  const altText = [];
  while ((im = imgRe.exec(clean))) {
    const a = parseAttrs(im[1]);
    total++;
    if (!('alt' in a)) missingAlt++;
    else if (!a.alt) emptyAlt++;
    else altText.push(a.alt);
    if (!a.width || !a.height) noDimensions++;
    if ((a.loading || '').toLowerCase() !== 'lazy') noLazy++;
  }

  // --- links ----------------------------------------------------------------
  let internal = 0;
  let external = 0;
  let nofollow = 0;
  const anchorText = [];
  const externalHosts = new Map();
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  let am;
  while ((am = anchorRe.exec(clean))) {
    const a = parseAttrs(am[1]);
    const href = a.href || '';
    if (!href || href.startsWith('#') || /^(javascript|mailto|tel):/i.test(href)) continue;
    let url;
    try {
      url = new URL(href, loc.href);
    } catch {
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    const label = stripTags(am[2]);
    if (label) anchorText.push(label.slice(0, 120));
    if ((a.rel || '').toLowerCase().includes('nofollow')) nofollow++;
    if (url.hostname === loc.hostname) internal++;
    else {
      external++;
      externalHosts.set(url.hostname, (externalHosts.get(url.hostname) || 0) + 1);
    }
    if (anchorText.length > 600) break;
  }

  // --- structured data ------------------------------------------------------
  const schemaTypes = new Set();
  const ldRe = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi;
  let ld;
  while ((ld = ldRe.exec(raw))) {
    try {
      const parsed = JSON.parse(ld[1].trim());
      const walk = (node) => {
        if (!node) return;
        if (Array.isArray(node)) return node.forEach(walk);
        if (typeof node !== 'object') return;
        if (node['@type']) [].concat(node['@type']).forEach((t) => schemaTypes.add(String(t)));
        if (node['@graph']) walk(node['@graph']);
      };
      walk(parsed);
    } catch {
      /* malformed JSON-LD on a competitor page is their problem, not ours */
    }
  }

  // --- body copy ------------------------------------------------------------
  const bodyMatch = clean.match(/<body\b[^>]*>([\s\S]*)<\/body\s*>/i);
  const bodyHtml = bodyMatch ? bodyMatch[1] : clean;
  const bodyText = stripTags(stripChrome(bodyHtml)).slice(0, MAX_BODY_CHARS);
  const words = bodyText ? bodyText.split(/\s+/).filter((w) => /[a-zA-Z]/.test(w)) : [];

  return {
    ok: true,
    url: loc.href,
    origin: loc.origin,
    hostname: loc.hostname,
    pathname: loc.pathname,
    protocol: loc.protocol,
    fetchedAt: Date.now(),

    title,
    metaDescription: meta('description'),
    metaRobots: meta('robots'),
    canonical: linkRel('canonical'),
    lang,
    viewport: meta('viewport'),
    charset: '',
    hreflang: links.filter((l) => l.hreflang).map((l) => l.hreflang),

    og: {
      title: meta('og:title'),
      description: meta('og:description'),
      image: meta('og:image'),
      type: meta('og:type'),
      url: meta('og:url'),
    },
    twitter: {
      card: meta('twitter:card'),
      title: meta('twitter:title'),
      image: meta('twitter:image'),
    },

    headings,
    h1Count: headings.filter((h) => h.level === 1).length,

    images: { total, missingAlt, emptyAlt, noDimensions, noLazy },
    links: {
      internal,
      external,
      nofollow,
      emptyAnchor: 0,
      genericAnchor: 0,
      externalHosts: Array.from(externalHosts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 40)
        .map(([host, count]) => ({ host, count })),
    },
    schemaTypes: Array.from(schemaTypes),
    invalidJsonLd: 0,

    wordCount: words.length,
    domNodes: 0,
    htmlBytes: raw.length,

    fields: {
      title,
      description: `${meta('description')} ${meta('og:description')}`,
      h1: byLevel(1).join('. '),
      h2: byLevel(2).join('. '),
      h3: byLevel(3).concat(byLevel(4)).join('. '),
      anchor: anchorText.slice(0, 400).join('. '),
      alt: altText.slice(0, 200).join('. '),
      body: bodyText,
    },
  };
}
