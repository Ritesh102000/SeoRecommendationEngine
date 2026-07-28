/**
 * Rule-based on-page SEO audit.
 *
 * Every rule returns a finding with a severity, a plain statement of what's
 * wrong, and a concrete fix. Score is a weighted pass-rate, not a vibe.
 */

const SEVERITY_WEIGHT = { critical: 5, warning: 2, notice: 1 };

const CATEGORIES = {
  meta: 'Meta & indexing',
  content: 'Content',
  structure: 'Structure',
  links: 'Links',
  media: 'Media',
  social: 'Social & schema',
  technical: 'Technical',
};

/** @returns {{score:number, grade:string, findings:Array, passed:Array, counts:object}} */
export function auditPage(page) {
  const findings = [];
  const passed = [];

  let lostWeight = 0;
  let totalWeight = 0;

  const add = (cond, finding) => {
    // Every rule contributes its severity weight to the denominator whether it
    // passes or fails, so the score is a weighted pass-rate over the same set
    // of checks for every page.
    const weight = SEVERITY_WEIGHT[finding.severity] || 1;
    totalWeight += weight;
    if (cond) {
      lostWeight += weight;
      findings.push(finding);
    } else {
      passed.push({ id: finding.id, category: finding.category, label: finding.pass || finding.title });
    }
  };

  const title = (page.title || '').trim();
  const desc = (page.metaDescription || '').trim();
  const h1s = (page.headings || []).filter((h) => h.level === 1);

  // ---------------------------------------------------------------- meta ----
  add(!title, {
    id: 'title-missing', category: 'meta', severity: 'critical',
    title: 'No <title> tag',
    detail: 'The page has no title. This is the single strongest on-page signal and the clickable headline in search results.',
    fix: 'Add a <title> of 50–60 characters containing the primary keyword near the front.',
    pass: 'Title tag present',
  });

  if (title) {
    add(title.length < 30 || title.length > 60, {
      id: 'title-length', category: 'meta',
      severity: title.length < 20 || title.length > 70 ? 'warning' : 'notice',
      title: `Title is ${title.length} characters`,
      detail: title.length < 30
        ? 'Short titles waste the strongest ranking real estate you have.'
        : 'Google truncates around 60 characters (~580px); the tail will be cut off in results.',
      fix: 'Aim for 50–60 characters. Lead with the primary keyword, close with the brand.',
      value: title,
      pass: `Title length is good (${title.length} chars)`,
    });
  }

  add(!desc, {
    id: 'description-missing', category: 'meta', severity: 'warning',
    title: 'No meta description',
    detail: 'Without one, Google composes a snippet from arbitrary page text, which usually reads worse than a written one.',
    fix: 'Add a 140–160 character description that includes the primary keyword and a reason to click.',
    pass: 'Meta description present',
  });

  if (desc) {
    add(desc.length < 70 || desc.length > 165, {
      id: 'description-length', category: 'meta', severity: 'notice',
      title: `Meta description is ${desc.length} characters`,
      detail: desc.length < 70
        ? 'Too short to make a case for the click.'
        : 'Over ~160 characters the snippet gets truncated with an ellipsis.',
      fix: 'Target 140–160 characters.',
      value: desc,
      pass: `Meta description length is good (${desc.length} chars)`,
    });
  }

  const robots = (page.metaRobots || '').toLowerCase();
  add(robots.includes('noindex'), {
    id: 'noindex', category: 'meta', severity: 'critical',
    title: 'Page is set to noindex',
    detail: `The robots meta tag is "${page.metaRobots}", which tells search engines to drop this page from the index entirely.`,
    fix: 'Remove noindex if this page is meant to rank. If it is intentional (staging, thank-you pages), ignore this.',
    pass: 'Page is indexable',
  });

  add(robots.includes('nofollow'), {
    id: 'meta-nofollow', category: 'meta', severity: 'warning',
    title: 'Page-level nofollow is set',
    detail: 'No link equity flows from this page to anything it links to.',
    fix: 'Drop nofollow from the robots meta unless this is deliberate.',
    pass: 'Links on this page are followable',
  });

  add(!page.canonical, {
    id: 'canonical-missing', category: 'meta', severity: 'warning',
    title: 'No canonical URL',
    detail: 'Without a canonical, parameter and tracking variants of this URL can be treated as duplicate pages competing with each other.',
    fix: 'Add <link rel="canonical" href="..."> pointing at the preferred absolute URL.',
    pass: 'Canonical URL declared',
  });

  if (page.canonical && page.url) {
    let mismatch = false;
    try {
      const c = new URL(page.canonical, page.url);
      const u = new URL(page.url);
      mismatch = c.origin + c.pathname.replace(/\/$/, '') !== u.origin + u.pathname.replace(/\/$/, '');
    } catch { mismatch = false; }
    add(mismatch, {
      id: 'canonical-mismatch', category: 'meta', severity: 'notice',
      title: 'Canonical points at a different URL',
      detail: `This page declares ${page.canonical} as the canonical version, so it is asking not to be indexed under its own URL.`,
      fix: 'Confirm this is intentional (e.g. a paginated or filtered variant).',
      pass: 'Canonical is self-referencing',
    });
  }

  // ------------------------------------------------------------- structure --
  add(h1s.length === 0, {
    id: 'h1-missing', category: 'structure', severity: 'critical',
    title: 'No H1 heading',
    detail: 'The H1 tells both users and crawlers what the page is about. Missing it leaves the topic ambiguous.',
    fix: 'Add exactly one H1 containing the primary keyword.',
    pass: 'H1 present',
  });

  add(h1s.length > 1, {
    id: 'h1-multiple', category: 'structure', severity: 'warning',
    title: `${h1s.length} H1 headings on the page`,
    detail: 'Multiple H1s split the topical signal and usually mean headings are being used for styling.',
    fix: 'Keep one H1; demote the rest to H2.',
    value: h1s.map((h) => h.text).join(' | ').slice(0, 200),
    pass: 'Exactly one H1',
  });

  // Heading levels that jump more than one step (H2 -> H4).
  let skipped = null;
  const levels = (page.headings || []).map((h) => h.level);
  for (let i = 1; i < levels.length; i++) {
    if (levels[i] - levels[i - 1] > 1) { skipped = `H${levels[i - 1]} → H${levels[i]}`; break; }
  }
  add(Boolean(skipped), {
    id: 'heading-skip', category: 'structure', severity: 'notice',
    title: `Heading levels skip (${skipped})`,
    detail: 'Skipping levels breaks the document outline for screen readers and weakens the semantic hierarchy.',
    fix: 'Use headings in order without gaps.',
    pass: 'Heading hierarchy is sequential',
  });

  add((page.headings || []).length < 3 && page.wordCount > 400, {
    id: 'few-headings', category: 'structure', severity: 'notice',
    title: 'Very few subheadings for the amount of copy',
    detail: `${page.wordCount} words with only ${(page.headings || []).length} headings is a wall of text.`,
    fix: 'Break the content into scannable sections with descriptive H2s.',
    pass: 'Content is broken up with headings',
  });

  // --------------------------------------------------------------- content --
  add(page.wordCount < 300, {
    id: 'thin-content', category: 'content',
    severity: page.wordCount < 150 ? 'warning' : 'notice',
    title: `Thin content — ${page.wordCount} words`,
    detail: 'Pages under ~300 words rarely have enough substance to rank for competitive terms.',
    fix: 'Expand with genuinely useful detail: specifics, examples, answers to real questions.',
    pass: `Content depth is reasonable (${page.wordCount} words)`,
  });

  const keywordInTitle = topicOverlap(page.fields?.h1, title);
  add(title && page.fields?.h1 && !keywordInTitle, {
    id: 'title-h1-mismatch', category: 'content', severity: 'notice',
    title: 'Title and H1 share no significant words',
    detail: 'When the title and H1 describe different things, the page sends a mixed topical signal.',
    fix: 'Align them around the same primary keyword (they need not be identical).',
    pass: 'Title and H1 are topically aligned',
  });

  // ---------------------------------------------------------------- media ---
  const img = page.images || {};
  add(img.missingAlt > 0, {
    id: 'img-alt', category: 'media',
    severity: img.missingAlt > 5 ? 'warning' : 'notice',
    title: `${img.missingAlt} image${img.missingAlt === 1 ? '' : 's'} missing an alt attribute`,
    detail: 'Alt text is how image content is described to screen readers and to image search.',
    fix: 'Add descriptive alt text. Use alt="" only for purely decorative images.',
    pass: 'All images have alt attributes',
  });

  add(img.total > 3 && img.noDimensions > img.total * 0.5, {
    id: 'img-dimensions', category: 'media', severity: 'notice',
    title: `${img.noDimensions} of ${img.total} images have no width/height`,
    detail: 'Missing intrinsic dimensions cause layout shift, which hurts the CLS half of Core Web Vitals.',
    fix: 'Set width and height attributes (or a CSS aspect-ratio) on every image.',
    pass: 'Images declare dimensions',
  });

  add(img.total > 8 && img.noLazy > img.total * 0.7, {
    id: 'img-lazy', category: 'media', severity: 'notice',
    title: 'Images are not lazy-loaded',
    detail: `${img.total} images all load eagerly, delaying the largest contentful paint.`,
    fix: 'Add loading="lazy" to below-the-fold images (never to the hero image).',
    pass: 'Below-the-fold images are lazy-loaded',
  });

  // ---------------------------------------------------------------- links ---
  const links = page.links || {};
  add(links.internal < 3, {
    id: 'few-internal-links', category: 'links', severity: 'warning',
    title: `Only ${links.internal} internal links`,
    detail: 'Internal links distribute authority and help crawlers discover the rest of the site. Orphaned pages rank poorly.',
    fix: 'Link to related pages on the site with descriptive anchor text.',
    pass: `Internal linking is healthy (${links.internal} links)`,
  });

  add(links.genericAnchor > 3, {
    id: 'generic-anchors', category: 'links', severity: 'notice',
    title: `${links.genericAnchor} links use generic anchor text`,
    detail: 'Anchors like "click here" and "read more" tell search engines nothing about the destination.',
    fix: 'Replace with anchor text that describes the target page.',
    pass: 'Anchor text is descriptive',
  });

  add(links.emptyAnchor > 0, {
    id: 'empty-anchors', category: 'links', severity: 'notice',
    title: `${links.emptyAnchor} links have no text or alt`,
    detail: 'Empty links are invisible to screen readers and pass no context.',
    fix: 'Add link text, or an aria-label for icon-only links.',
    pass: 'No empty links',
  });

  // --------------------------------------------------------------- social ---
  add(!page.og?.title || !page.og?.description, {
    id: 'og-missing', category: 'social', severity: 'notice',
    title: 'Incomplete Open Graph tags',
    detail: 'Without og:title and og:description, shared links render as bare URLs on social platforms and in chat previews.',
    fix: 'Add og:title, og:description, og:image and og:url.',
    pass: 'Open Graph tags present',
  });

  add(!page.og?.image, {
    id: 'og-image', category: 'social', severity: 'notice',
    title: 'No og:image',
    detail: 'Shared links get no preview image, which measurably reduces click-through.',
    fix: 'Add an og:image at 1200×630.',
    pass: 'Share image defined',
  });

  add((page.schemaTypes || []).length === 0, {
    id: 'schema-missing', category: 'social', severity: 'warning',
    title: 'No structured data',
    detail: 'Schema.org markup is what makes rich results possible — ratings, FAQs, breadcrumbs, prices.',
    fix: 'Add JSON-LD for the page type (Article, Product, FAQPage, Organization…).',
    pass: `Structured data found: ${(page.schemaTypes || []).slice(0, 4).join(', ')}`,
  });

  add((page.invalidJsonLd || 0) > 0, {
    id: 'schema-invalid', category: 'social', severity: 'warning',
    title: `${page.invalidJsonLd} JSON-LD block(s) failed to parse`,
    detail: 'Malformed structured data is ignored entirely, so any rich-result eligibility is lost.',
    fix: 'Validate the markup with the Rich Results Test.',
    pass: 'Structured data parses cleanly',
  });

  // ------------------------------------------------------------- technical --
  add(page.protocol === 'http:', {
    id: 'no-https', category: 'technical', severity: 'critical',
    title: 'Page is served over HTTP',
    detail: 'HTTPS has been a ranking signal since 2014, and browsers mark HTTP pages as not secure.',
    fix: 'Serve the site over HTTPS and 301-redirect all HTTP traffic.',
    pass: 'Served over HTTPS',
  });

  add(!page.viewport, {
    id: 'viewport', category: 'technical', severity: 'critical',
    title: 'No viewport meta tag',
    detail: 'Without it the page will not adapt to mobile screens, and indexing is mobile-first.',
    fix: 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.',
    pass: 'Mobile viewport configured',
  });

  add(!page.lang, {
    id: 'lang', category: 'technical', severity: 'notice',
    title: 'No lang attribute on <html>',
    detail: 'Language is used for regional targeting and by screen readers to pick a voice.',
    fix: 'Add lang="en" (or the correct language code) to the <html> element.',
    pass: 'Page language declared',
  });

  const slug = (page.pathname || '').split('/').filter(Boolean).pop() || '';
  add(slug.length > 60 || /[_A-Z]/.test(slug) || /%[0-9a-f]{2}/i.test(slug), {
    id: 'url-slug', category: 'technical', severity: 'notice',
    title: 'URL slug is not clean',
    detail: `"${slug}" uses underscores, capitals, encoded characters, or is very long.`,
    fix: 'Use short, lowercase, hyphen-separated slugs.',
    pass: 'URL slug is clean',
  });

  add((page.domNodes || 0) > 2500, {
    id: 'dom-size', category: 'technical', severity: 'notice',
    title: `Large DOM — ${page.domNodes} elements`,
    detail: 'Over ~1,500 nodes Lighthouse flags DOM size; it slows rendering, style recalculation and interaction.',
    fix: 'Simplify the markup or virtualise long lists.',
    pass: 'DOM size is reasonable',
  });

  // ---------------------------------------------------------------- score ---
  const score = Math.max(0, Math.round(100 - (lostWeight / Math.max(totalWeight, 1)) * 100));

  const counts = {
    critical: findings.filter((f) => f.severity === 'critical').length,
    warning: findings.filter((f) => f.severity === 'warning').length,
    notice: findings.filter((f) => f.severity === 'notice').length,
    passed: passed.length,
  };

  const order = { critical: 0, warning: 1, notice: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);

  return { score, grade: gradeFor(score), findings, passed, counts, categories: CATEGORIES };
}

function gradeFor(score) {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 65) return 'C';
  if (score >= 50) return 'D';
  return 'F';
}

/** Do two strings share any word longer than 3 characters? */
function topicOverlap(a, b) {
  if (!a || !b) return true;
  const words = (s) => new Set(String(s).toLowerCase().match(/[a-z0-9]{4,}/g) || []);
  const A = words(a);
  for (const w of words(b)) if (A.has(w)) return true;
  return false;
}
