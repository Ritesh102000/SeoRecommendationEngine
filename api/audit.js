import { extractFromHtml } from '../src/html-extract.js';
import { auditPage } from '../src/audit.js';

const MAX_HTML_BYTES = 2_000_000;

function isPrivateHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host === '::1') return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^169\.254\./.test(host)) return true;
  const match = host.match(/^172\.(\d+)\./);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
  if (/^192\.168\./.test(host) || /^0\./.test(host)) return true;
  return false;
}

function normalizeUrl(value) {
  const raw = String(value || '').trim();
  const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS URLs are supported.');
  if (url.username || url.password || isPrivateHost(url.hostname)) throw new Error('That URL cannot be scanned.');
  return url;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Use POST.' });
  }

  try {
    const url = normalizeUrl(req.body?.url);
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(12_000),
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; SEOLensBot/1.0; +https://vercel.app)',
        accept: 'text/html,application/xhtml+xml',
      },
    });

    if (!response.ok) throw new Error(`The website returned HTTP ${response.status}.`);
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
      throw new Error('That URL did not return an HTML webpage.');
    }

    const declaredSize = Number(response.headers.get('content-length') || 0);
    if (declaredSize > MAX_HTML_BYTES) throw new Error('That page is too large to scan.');

    const html = await response.text();
    if (Buffer.byteLength(html) > MAX_HTML_BYTES) throw new Error('That page is too large to scan.');

    const page = extractFromHtml(html, response.url);
    const audit = auditPage(page);
    return res.status(200).json({
      url: page.url,
      title: page.title,
      score: audit.score,
      grade: audit.grade,
      counts: audit.counts,
      findings: audit.findings,
      passed: audit.passed,
      summary: {
        wordCount: page.wordCount,
        headings: page.headings.length,
        images: page.images.total,
        internalLinks: page.links.internal,
      },
    });
  } catch (error) {
    const message = error?.name === 'TimeoutError'
      ? 'The website took too long to respond.'
      : error?.message || 'The page could not be scanned.';
    return res.status(400).json({ error: message });
  }
}
