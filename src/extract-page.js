/**
 * The function injected into the active tab by chrome.scripting.executeScript.
 *
 * IMPORTANT: this is serialised and evaluated in the page's world, so it must
 * be entirely self-contained — no imports, no references to module scope.
 * It only reads the DOM; it never writes to the page.
 */
export function collectPageData() {
  // Enough copy for a reliable keyword profile without bloating chrome.storage.
  const MAX_BODY_CHARS = 40000;

  const text = (el) => (el && el.textContent ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  const attr = (sel, name) => {
    const el = document.querySelector(sel);
    return el ? (el.getAttribute(name) || '').trim() : '';
  };
  const metaContent = (name) => {
    const el =
      document.querySelector(`meta[name="${name}" i]`) ||
      document.querySelector(`meta[property="${name}" i]`);
    return el ? (el.getAttribute('content') || '').trim() : '';
  };

  const loc = window.location;

  // --- Headings -------------------------------------------------------------
  const headings = [];
  document.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((h) => {
    const t = text(h);
    if (t) headings.push({ level: Number(h.tagName[1]), text: t.slice(0, 300) });
  });

  // --- Images ---------------------------------------------------------------
  const imgs = Array.from(document.images || []);
  let missingAlt = 0;
  let emptyAlt = 0;
  let noDimensions = 0;
  let noLazy = 0;
  const altText = [];
  imgs.forEach((img) => {
    if (!img.hasAttribute('alt')) missingAlt++;
    else if (!img.getAttribute('alt').trim()) emptyAlt++;
    else altText.push(img.getAttribute('alt').trim());
    if (!img.getAttribute('width') || !img.getAttribute('height')) noDimensions++;
    if (img.loading !== 'lazy') noLazy++;
  });

  // --- Links ----------------------------------------------------------------
  let internal = 0;
  let external = 0;
  let nofollow = 0;
  let emptyAnchor = 0;
  let genericAnchor = 0;
  const anchorText = [];
  const externalHosts = new Map();
  const GENERIC = new Set(['click here', 'read more', 'here', 'more', 'link', 'this', 'learn more']);

  document.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href') || '';
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
    let url;
    try {
      url = new URL(href, loc.href);
    } catch {
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

    const label = text(a);
    if (!label && !a.querySelector('img[alt]')) emptyAnchor++;
    else if (GENERIC.has(label.toLowerCase())) genericAnchor++;
    if (label) anchorText.push(label.slice(0, 120));

    const rel = (a.getAttribute('rel') || '').toLowerCase();
    if (rel.includes('nofollow')) nofollow++;

    if (url.hostname === loc.hostname) {
      internal++;
    } else {
      external++;
      externalHosts.set(url.hostname, (externalHosts.get(url.hostname) || 0) + 1);
    }
  });

  // --- Structured data ------------------------------------------------------
  const schemaTypes = new Set();
  let invalidJsonLd = 0;
  document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
    try {
      const parsed = JSON.parse(s.textContent);
      const walk = (node) => {
        if (!node) return;
        if (Array.isArray(node)) return node.forEach(walk);
        if (typeof node !== 'object') return;
        if (node['@type']) [].concat(node['@type']).forEach((t) => schemaTypes.add(String(t)));
        if (node['@graph']) walk(node['@graph']);
      };
      walk(parsed);
    } catch {
      invalidJsonLd++;
    }
  });
  document.querySelectorAll('[itemtype]').forEach((el) => {
    const t = el.getAttribute('itemtype') || '';
    const name = t.split('/').pop();
    if (name) schemaTypes.add(name);
  });

  // --- Body copy ------------------------------------------------------------
  const clone = document.body ? document.body.cloneNode(true) : null;
  if (clone) {
    // Code samples are not prose: without this, "const", "npm" and "bash" end
    // up recommended as keywords on any documentation page.
    clone.querySelectorAll(
      'script, style, noscript, template, svg, nav, footer, header, aside, form, pre, code, kbd, samp',
    ).forEach((n) => n.remove());
  }
  const bodyText = clone ? clone.textContent.replace(/\s+/g, ' ').trim().slice(0, MAX_BODY_CHARS) : '';
  const words = bodyText ? bodyText.split(/\s+/).filter((w) => /[a-zA-Z]/.test(w)) : [];

  // --- hreflang -------------------------------------------------------------
  const hreflang = Array.from(document.querySelectorAll('link[rel="alternate"][hreflang]')).map((l) => l.getAttribute('hreflang'));

  const headingsByLevel = (lvl) => headings.filter((h) => h.level === lvl).map((h) => h.text);

  return {
    ok: true,
    url: loc.href,
    origin: loc.origin,
    hostname: loc.hostname,
    pathname: loc.pathname,
    protocol: loc.protocol,
    fetchedAt: Date.now(),

    title: text(document.querySelector('title')),
    metaDescription: metaContent('description'),
    metaRobots: metaContent('robots'),
    canonical: attr('link[rel="canonical"]', 'href'),
    lang: document.documentElement.getAttribute('lang') || '',
    viewport: metaContent('viewport'),
    charset: document.characterSet || '',
    hreflang,

    og: {
      title: metaContent('og:title'),
      description: metaContent('og:description'),
      image: metaContent('og:image'),
      type: metaContent('og:type'),
      url: metaContent('og:url'),
    },
    twitter: {
      card: metaContent('twitter:card'),
      title: metaContent('twitter:title'),
      image: metaContent('twitter:image'),
    },

    headings,
    h1Count: headings.filter((h) => h.level === 1).length,

    images: {
      total: imgs.length,
      missingAlt,
      emptyAlt,
      noDimensions,
      noLazy,
    },
    links: {
      internal,
      external,
      nofollow,
      emptyAnchor,
      genericAnchor,
      externalHosts: Array.from(externalHosts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 40)
        .map(([host, count]) => ({ host, count })),
    },
    schemaTypes: Array.from(schemaTypes),
    invalidJsonLd,

    wordCount: words.length,
    domNodes: document.getElementsByTagName('*').length,
    htmlBytes: document.documentElement ? document.documentElement.outerHTML.length : 0,

    fields: {
      title: text(document.querySelector('title')),
      description: metaContent('description') + ' ' + metaContent('og:description'),
      h1: headingsByLevel(1).join('. '),
      h2: headingsByLevel(2).join('. '),
      h3: headingsByLevel(3).concat(headingsByLevel(4)).join('. '),
      anchor: anchorText.slice(0, 400).join('. '),
      alt: altText.slice(0, 200).join('. '),
      body: bodyText,
    },
  };
}
