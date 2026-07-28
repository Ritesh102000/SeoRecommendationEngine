# SEO Lens

A Chrome extension that audits any page in one click, then ranks and clusters its
keywords against competitor sites in the same category.

The repository also includes a Vercel-ready web version. Visitors can submit a
URL, run the same audit, optionally enhance keyword extraction with OpenAI, and
either discover competitors automatically or enter competitor URLs manually.

## Deploy the web app on Vercel

Import the repository into Vercel with the **Other** framework preset. The
included `vercel.json` publishes `public/` and deploys `api/audit.js`.

For AI keyword enhancement and automatic competitor discovery, add this Vercel
environment variable and redeploy:

```text
OPENAI_API_KEY=your_server_side_key
```

The deterministic audit remains available when the key is not configured. You
can optionally set `OPENAI_MODEL`; otherwise the API uses `gpt-5.6`.

The Chrome extension still runs locally in the browser with no backend, account,
API key, or third-party service. Its core analysis is implemented from scratch in
plain JavaScript.

---

## What it does

**1. On-page audit (one click).** Injects a read-only collector into the active
tab and runs 28 checks across meta and indexing, structure, content, links,
media, social/schema and technical basics. Each finding states what is wrong, why
it matters, and the concrete fix. The score is a severity-weighted pass rate over
the same checks for every page, so it is comparable across scans.

**2. Keyword extraction.** Builds a weighted phrase profile for the page —
1–3 word n-grams, weighted by *where* they appear (title ×6, H1 ×5, meta
description ×3.5, H2 ×2.5, body ×1), since placement matters more than raw
frequency. Phrases containing stopwords are dropped, code samples and site
chrome are excluded, and word pairs that only co-occurred by accident are
filtered out by a conditional-probability test against their constituent words.

**3. Competitor comparison.** Fetches the competitor URLs you supply, parses them
in the service worker, and scores every term with TF-IDF across the whole set:

| Signal | Meaning |
| --- | --- |
| `coverage` | share of competitor pages using the term |
| `compStrength` | how heavily they use it |
| `targetStrength` | how heavily *your* page uses it |
| `demand` | `0.6 × coverage + 0.4 × compStrength` — how much the category cares |
| `gap` | `demand − targetStrength`, floored at 0 — how far behind you are |
| `score` | `(0.55 × demand + 0.45 × gap) × specificity`, 0–100 |

Every term is then labelled **Missing**, **Not used**, **Underused**,
**Competitive**, **Your strength** or **Unique to you**.

**4. k-means clustering.** Groups keywords into topic clusters so you get
sections to write, not a word list. Each keyword becomes one vector from three
blocks:

- **Context** (dominant) — a PPMI-weighted profile of the words it shares a
  sentence with, across every document. This is what puts *pricing* next to
  *free plan* despite them sharing no words.
- **Lexical** — indicators for the phrase's own tokens, keeping *gantt* with
  *gantt charts*.
- **Coverage** — per-document TF-IDF, separating "everyone covers this" from
  "only you do".

Clustering is cosine k-means with k-means++ seeding and a seeded PRNG, so
repeat scans give identical results. *k* is chosen automatically by sweeping
2–8 and taking the best mean silhouette score, discounted for partitions that
degenerate into singleton clusters.

Each cluster is labelled by its dominant tokens and typed as a **content gap**,
**table stakes but underweight**, **your strength**, **contested** or **only
you**, with advice attached.

**5. Benchmarks and export.** Median competitor word count, title length,
heading count, internal links, images, schema and meta-description adoption
versus yours — plus a full JSON export of everything.

---

## Install (development)

```bash
git clone <this repo> && cd ctaio
```

Then in Chrome:

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select this directory
4. Pin the extension and click it on any `http(s)` page

No build step is required — the extension ships as plain ES modules.

## Usage

1. Open the page you want to audit and click the icon.
2. Press **Scan page**. The Issues tab populates immediately.
3. Go to **Competitors**, add 3–5 URLs of pages in the same category (the tab
   also suggests domains the page already links to), and press **Re-run
   analysis**. Chrome will ask for permission to read those specific sites.
4. Read **Keywords** for individual terms and **Clusters** for the topics to
   write about. **Export JSON** dumps the whole report.

Competitor pages are cached for 6 hours; **Refetch (ignore cache)** forces a
fresh pull.

---

## Development

```bash
npm run lint     # parse every shipped file + validate the manifest
npm test         # 41 tests over extraction, audit, TF-IDF and k-means
npm run check    # both of the above
npm run icons    # regenerate the PNG icons from code
npm run build    # produce dist/seo-lens-v<version>.zip for the Web Store
```

Two extra tools help while iterating:

```bash
node tools/demo.mjs                                  # full report from fixtures
node tools/demo.mjs https://you.com https://rival.com # …or from live pages
```

`tools/preview.html` renders the real popup with stubbed `chrome.*` APIs so the
UI can be checked without reloading the extension. Serve the repo root and open
`/tools/preview.html`:

```bash
python3 -m http.server 8777
```

### Layout

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest |
| `popup.html/.css/.js` | UI and controller |
| `background.js` | Service worker: competitor fetching, caching, permissions |
| `src/extract-page.js` | Read-only DOM collector injected into the active tab |
| `src/html-extract.js` | Same shape, parsed from an HTML string (worker-safe) |
| `src/nlp.js` | Tokenising, n-grams, field weighting, TF-IDF, phraseness |
| `src/kmeans.js` | k-means++, cosine k-means, silhouette, auto-*k* |
| `src/audit.js` | The 28 on-page rules and scoring |
| `src/analyze.js` | Orchestration: scoring, clustering, benchmarks, advice |

`src/html-extract.js` is a deliberately tolerant regex scanner rather than a
real parser: MV3 service workers have no `DOMParser`. It only needs to recover
SEO signals, and it is written to survive malformed markup.

---

## Deploying to the Chrome Web Store

1. `npm run check && npm run build` → `dist/seo-lens-v1.0.0.zip`
2. Register as a developer at
   [chrome.google.com/webstore/devconsole](https://chrome.google.com/webstore/devconsole)
   (one-time $5 fee) and create a new item.
3. Upload the zip.
4. Fill in the listing: description, category (*Developer Tools* or
   *Productivity*), a 128×128 icon (`icons/icon128.png`), at least one 1280×800
   screenshot, and a link to a hosted copy of `PRIVACY.md`.
5. Justify the permissions when asked. The honest answers:
   - `activeTab` + `scripting` — read the current page's DOM when the user
     clicks Scan.
   - `storage` — remember the competitor list and cache fetched pages locally.
   - optional host permissions — fetch the specific competitor URLs the user
     adds. These are **optional** and requested at runtime, not granted up
     front, which is both better for the user and a smoother review.
6. Submit. Review typically takes a few days.

Bump `version` in `manifest.json` for every upload — the store rejects
duplicates.

### Notes for review

- No remote code: everything is bundled, and the CSP is `script-src 'self'`.
- No analytics, no network calls other than the competitor pages the user
  explicitly adds.
- No data leaves the browser.

---

## Limitations

Worth being straight about:

- **Keyword *demand* is measured against the competitor set you provide, not
  against real search volume.** There is no Google Ads or SERP API behind this.
  A term scoring 90 means "the pages you chose consistently cover this and you
  do not" — which is a genuinely useful signal, and not the same thing as
  monthly searches. Choose competitors that actually rank for what you want.
- **Client-rendered sites** return little server-side HTML. The scanned tab is
  fine (it reads the live DOM), but competitor pages built entirely in JS may
  come back near-empty; the extension flags those rather than scoring them.
- The audit covers on-page factors only — nothing about backlinks, domain
  authority, crawl budget or Core Web Vitals field data.
- English stopword and boilerplate lists; other languages will extract noisier
  phrases.

## License

MIT
