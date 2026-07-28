import { extractFromHtml } from '../src/html-extract.js';
import { auditPage } from '../src/audit.js';
import { analyze } from '../src/analyze.js';

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

async function fetchPage(value) {
  const url = normalizeUrl(value);
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(12_000),
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; SEOLensBot/1.0)',
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
  return extractFromHtml(html, response.url);
}

function responseText(response) {
  if (response.output_text) return response.output_text;
  return (response.output || [])
    .flatMap((item) => item.content || [])
    .filter((item) => item.type === 'output_text')
    .map((item) => item.text)
    .join('\n');
}

async function getAiInsights(page, baselineKeywords, manualCompetitors, autoFind) {
  if (!process.env.OPENAI_API_KEY) {
    return { error: 'AI features need OPENAI_API_KEY in Vercel.' };
  }

  const prompt = `You are an SEO research assistant. Analyze the supplied webpage and return ONLY valid JSON.

Target URL: ${page.url}
Title: ${page.title}
Meta description: ${page.metaDescription}
H1: ${page.fields.h1}
H2s: ${page.fields.h2}
Page excerpt: ${page.fields.body.slice(0, 7000)}
Algorithmic keyword candidates: ${baselineKeywords.slice(0, 35).map((item) => item.term).join(', ')}
Manual competitor URLs: ${manualCompetitors.join(', ') || 'none'}

Return this exact shape:
{
  "keywords": [{"term":"string","intent":"informational|commercial|transactional|navigational","reason":"one concise sentence"}],
  "competitors": [{"name":"string","url":"https://...","reason":"one concise sentence"}],
  "summary":"two concise sentences"
}

Choose 10 high-value keywords grounded in the actual page. ${autoFind
    ? 'Use web search to identify up to 5 real organic competitors offering the same product, service, or content. Do not return directories, social networks, or the target domain.'
    : 'Do not discover new competitors. Return only the supplied manual competitor URLs.'}`;

  const request = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    signal: AbortSignal.timeout(35_000),
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-5.6',
      tools: autoFind ? [{ type: 'web_search' }] : undefined,
      input: prompt,
      store: false,
      max_output_tokens: 1800,
    }),
  });

  if (!request.ok) {
    const body = await request.json().catch(() => ({}));
    throw new Error(body.error?.message || `OpenAI returned HTTP ${request.status}.`);
  }

  const raw = responseText(await request.json());
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('OpenAI did not return usable SEO insights.');
  const parsed = JSON.parse(raw.slice(start, end + 1));
  const competitors = Array.isArray(parsed.competitors)
    ? parsed.competitors.slice(0, 5).flatMap((item) => {
      try {
        const url = normalizeUrl(item.url).toString();
        if (new URL(url).hostname === page.hostname) return [];
        return [{ name: String(item.name || new URL(url).hostname), url, reason: String(item.reason || '') }];
      } catch {
        return [];
      }
    })
    : [];
  return {
    keywords: Array.isArray(parsed.keywords) ? parsed.keywords.slice(0, 12) : [],
    competitors,
    summary: String(parsed.summary || ''),
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Use POST.' });
  }

  try {
    const page = await fetchPage(req.body?.url);
    const audit = auditPage(page);
    const manualCompetitors = Array.isArray(req.body?.competitors)
      ? req.body.competitors.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 5)
        .map((item) => normalizeUrl(item).toString())
      : [];
    const baseline = analyze(page);
    let ai = null;
    if (req.body?.useAI) {
      try {
        ai = await getAiInsights(page, baseline.keywords, manualCompetitors, req.body?.autoFind !== false);
      } catch (error) {
        ai = { error: error.message || 'AI analysis failed.' };
      }
    }

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
      keywords: baseline.keywords.slice(0, 12).map(({ term, score, status }) => ({ term, score, status })),
      ai,
      manualCompetitors,
    });
  } catch (error) {
    const message = error?.name === 'TimeoutError'
      ? 'The website took too long to respond.'
      : error?.message || 'The page could not be scanned.';
    return res.status(400).json({ error: message });
  }
}
