# Peppy Scraper Service — Handoff Document
**Last updated:** 2026-05-13  
**Repo:** https://github.com/applore-shikhar/peppy-scraper.git

---

## What Was Built

### 8-Site Scraper
Full scraping pipeline across 8 UAE e-commerce sites:

| Site | Method | Parser |
|------|--------|--------|
| Amazon | Bright Data Unlocker (HTTP) | `amazon.parser.ts` |
| Noon | Bright Data Browser (CDP) | `noon.parser.ts` |
| Carrefour | Bright Data Browser + Sitemap | `carrefour.parser.ts` |
| SharafDG | Bright Data Browser (CDP) | `sharafdg.parser.ts` |
| Jumbo | Bright Data Browser (CDP) | `jumbo.parser.ts` |
| Mumzworld | Bright Data Unlocker (HTTP) | `mumzworld.parser.ts` |
| Namshi | Bright Data Browser (CDP) | `namshi.parser.ts` |
| Letstango | Shopify `/products.json` (axios) | `shopify.service.ts` |

### Category-Level Scraping (Option 1)
Sites scrape actual category browse pages — not product-specific search terms.

- **Jumbo** — `/mobile-phones.html`, `/personal-computers/laptops.html`, `/television-home-theaters.html`, etc. Pagination: `?pageNo=N`
- **SharafDG** — Algolia `/c/{taxonomy}/` URLs: `/c/mobiles_tablets/mobiles/`, `/c/computing/laptops/`, `/c/tv_video_audio/tvs/`, etc. Pagination: `?page=N`
- **Mumzworld** — `/en/baby-gear/strollers`, `/en/toys-games`, etc. Pagination: `?p=N`
- **Namshi** — `/uae-en/women/`, `/uae-en/men/`, `/uae-en/women/abayas/`, etc. Pagination: `?page=N`
- **Amazon/Noon/Carrefour** — search-based (already broad enough)
- **Letstango** — Shopify category filter via `collectShopifyProducts`

### Data Pipeline
```
Category page (categoryKey) or search → link collection → per-product scrape
→ bundler (Jaccard ≥ 0.45 AND matching variant attributes: Pro/Max/Ultra/Plus…, storage, screen size, model number)
→ vector tagger (OpenAI text-embedding-3-small; optional — scraping continues with base tags if OpenAI fails)
→ cross-query dedupe → MongoDB products_clean MERGE (no flush) → ChromaDB upsert
→ stale offers (not seen for STALE_OFFER_DAYS) marked inStock:false
```

### Key Design Decisions
- **Merge, never flush**: products match by marketplace identity first (`retailers.externalId` = Amazon ASIN / Noon SKU / Carrefour ID, then `retailers.canonicalUrl`, then legacy tagged `/dp/ASIN` URLs), then by `name`. Only this run's retailers' offers are replaced; other retailers' offers and extra offer fields (`variants`, `retailerLogo`, `originalPrice`) are kept, and an affiliate `productUrl` (`?tag=`, `s.noon.com`) of the same listing is never replaced by a bare URL. An older observation never overwrites a newer one. `name`/`category`/`images`/`brand` are only filled when missing. Writes are conditional on `updatedAt`, so a concurrent admin edit is re-read, never overwritten. Backend-owned fields (`productRole`, `categories`, variant grouping) are never written — products are flagged `ingestMappingStatus: 'pending'` and the scraper asks peppy-be (`POST /api/v1/admin/scraper/ingest/apply-mapping`) to map them; `npm run ingest:apply-mapping` in peppy-be retries anything left pending.
- **Target database**: `MONGODB_DB` → database in `MONGODB_URI` path → `peppy` (same rule as the dining module).
- **Stock & prices**: each offer has `stockStatus` `available` / `unavailable` / `unknown` from page evidence only (`inStock: null` when unknown — never defaulted). `lowestPrice`/`highestPrice` cover available + unknown offers (unknown stays visible, labelled); `bestConfirmedPrice` covers available only; unavailable and stale offers never set a price. `lastSeenAt` is the scrape time of the page, never the push time. Offers unseen for `STALE_OFFER_DAYS` (default 3) become `isStale` + unknown and leave the price range, recomputed in the same write.
- **Multi-image**: each parser collects all image angles; bundler picks retailer with MOST images (no cross-retailer merging)
- **No-image rejection**: pages that load without a name/price or image are re-fetched up to 3×, then moved to `checkpoint.failed` — never pushed to DB. Network errors are retried once inside `scrapeProductBD` (no stacked retries).
- **Browser sessions / blocked sites**: one Bright Data Scraping Browser session per hostname (a shared session hits `navigate_domains_limit`). `src/config/transport-policy.ts` lists sites without an authorized data source — currently **Noon** (Bright Data refuses it: robots.txt/KYC). `/scrape-bulk` refuses such sites with 422 unless `allowPartial: true`; the cron runs the other sites and reports the run as partial (never success). Set `BRIGHT_DATA_APPROVED_SITES=noon` only once Bright Data approves access. A host refused mid-run is reported `unsupported`. Anti-bot block pages are retried on a fresh session.
- **Checkpoint system / job status**: each job reports per-site `complete | failed | unsupported | stopped` and a job status (`complete` only if every requested site completed). Jobs resume from `output/checkpoints/{jobId}.json`; checkpoints and cron state older than `CHECKPOINT_MAX_AGE_HOURS` / `CRON_STATE_MAX_AGE_HOURS` (default 20) are discarded. A stop signal keeps the checkpoint and cron state, publishes nothing, skips stale expiry and reports the run as not successful. Uncertain cross-retailer matches (price ratio > 2×, near-miss titles) stay unmatched and are listed in the job output's `matchReviews`.
- **Taxonomy**: `broadCategory` + `subCategory` stamped on each product at scrape time; `inferTaxonomy()` as fallback regex. Every pair used in `QUERIES` must exist in `src/config/taxonomy.ts` (enforced by `test/ecommerce/config.test.ts`).
- **Auth**: set `SCRAPER_API_KEY` (same value in peppy-be) to require `x-api-key` on every route except `/`, and `?key=` on `/ws/logs`. Unset = open (a startup warning is logged).

### Shopping worker (Amazon UAE, 24/7)
Scheduled discovery (24 h per query) + price/stock refresh (12 h) with a Mongo scheduler lock, daily Bright Data budget, persistent job records and resume. See `docs/SHOPPING_WORKER.md` (commands: `npm run shopping:*`; PM2/systemd templates in `deploy/`). Do not run it alongside `ENABLE_CRON=true`.

### Cron Job
- File: `src/cron/cron-runner.ts`
- Registered in `src/index.ts` on startup when `ENABLE_CRON=true`
- Loops all `QUERIES` from `scrape-master.ts` sequentially with 15s cooldown between queries
- After all queries: calls `pushToDatabase()` → merges into `products_clean` (see Key Design Decisions), then `markStaleOffers()`
- Posts status to `PEPPY_BE_URL/api/admin/scraper/status` on completion
- Lock file: `output/cron.lock` prevents overlapping runs

### Environment Variables (production server)
```env
ENABLE_CRON=true
SCRAPE_CRON=30 17 * * *    # 11pm IST = 17:30 UTC
MONGODB_URI=...
OPENAI_API_KEY=...
BRIGHTDATA_...=...
PEPPY_BE_URL=https://api.peppy.ae
CHROMA_API_KEY / CHROMA_TENANT / CHROMA_DATABASE=...   # optional
SCRAPER_API_KEY=...        # shared with peppy-be; enables endpoint auth
MONGODB_DB=...             # optional; defaults to the database in MONGODB_URI
```

### Tests
`npm run test:ecommerce` — bundler variant guards, push merge pipeline, query plan/taxonomy consistency, parsers, API key.

### Scripts
| Script | Purpose |
|--------|---------|
| `pnpm start` | Start HTTP server + register cron |
| `npx ts-node scrape-master.ts` | Manual full scrape (all queries) |
| `npx ts-node scrape-category-test.ts` | Test category scraping across all 8 sites (10 products each) |
| `npx ts-node scrape-test.ts` | Smoke test all sites (10 products each) |
| `npx ts-node push-to-mongodb.ts [file.json]` | Merge a master JSON into MongoDB (defaults to latest `master_*.json`) |
| `npx ts-node add-to-mongodb.ts <file.json>` | Merge any output JSON into MongoDB (same merge as cron) |

### Deployment
- **Repo:** https://github.com/applore-shikhar/peppy-scraper.git
- **NOT for Netlify** (no persistent process)
- **Recommended:** DigitalOcean $6/mo droplet (1GB RAM), Railway $5/mo, or Render paid ($7/mo background worker)
- **Render free tier**: cron unreliable (spins down after 15min inactivity), 512MB RAM (OOM risk on full run)

---

## Admin Panel Integration — Next Task

**Goal:** Add a "Scraper Control" section to the admin panel that lets admins manually trigger the cron pipeline and view its status — without SSH access to the server.

### Admin Panel Tech Stack
- React + Vite + shadcn/ui
- Services in `src/services/` call peppy-be API via `src/services/api.js`
- Existing relevant pages:
  - `src/pages/system/SystemStatus.jsx` — shows scraper health from `/admin/scraper/health`
  - `src/pages/system/ErrorLogs.jsx` — shows scraper logs from `/admin/system/logs`
  - `src/services/system.service.js` — calls `/admin/scraper/health`, `/admin/scraper/success-rates`

### What Needs to Be Built

#### 1. Admin Panel — New Page: `ScraperControl.jsx`
Located at `src/pages/system/ScraperControl.jsx`. Should show:
- **Cron status**: last run time, next scheduled run, success/failure, product count inserted
- **Manual trigger button**: "Run Now" → POST to scraper service trigger endpoint
- **Live log stream** (optional): poll for status every 10s while running
- **Query list**: show which categories are configured (read from backend or hardcoded)

#### 2. peppy-be — New Endpoints Needed
The scraper service already POSTs status to peppy-be on completion. peppy-be needs:
```
GET  /api/admin/scraper/status        → last run status, productCount, errorCount, duration
GET  /api/admin/scraper/health        → already exists (used by SystemStatus.jsx)
POST /api/admin/scraper/trigger       → forward trigger to scraper service HTTP endpoint
```

#### 3. Scraper Service — Trigger Endpoint
`src/index.ts` needs a POST route that manually kicks off `runFullPipeline()`:
```
POST /api/trigger   → calls runFullPipeline() (checks lock file, skips if already running)
```
This already partially exists — confirm in `src/index.ts`.

### Assessment Tasks for Next Session
1. Read `src/index.ts` in scraper service — confirm what HTTP routes exist
2. Read peppy-be scraper controller — find what `/admin/scraper/*` endpoints are implemented
3. Read `SystemStatus.jsx` fully — understand existing UI patterns to match style
4. Decide: does peppy-be proxy the trigger to scraper service, or does admin panel call scraper service directly?
5. Build `ScraperControl.jsx` + wire to backend

---

## File Map (key files only)

```
New Scraper Service/
├── src/
│   ├── config/
│   │   └── sites.ts              ← SiteKey enum, category browse URLs per site
│   ├── cron/
│   │   ├── cron-runner.ts        ← runFullPipeline(), lock file, status POST
│   │   └── push-pipeline.ts      ← pushToDatabase(), loadBundlesFromJson()
│   ├── parsers/
│   │   ├── *.parser.ts           ← one per site
│   │   └── search/*.search.parser.ts  ← extract product links from listing pages
│   ├── services/
│   │   ├── playwright.service.ts ← scrapeBulk(), scrapeOneSite(), categoryKey routing
│   │   ├── brightdata.service.ts ← fetchHTMLViaUnlocker, fetchHTMLViaBrowser, scrapeProductBD
│   │   ├── bundler.service.ts    ← Jaccard dedup, image strategy, vector tagging
│   │   ├── shopify.service.ts    ← Letstango /products.json
│   │   ├── checkpoint.service.ts ← resumable job state
│   │   ├── vector-tagger.service.ts ← OpenAI embeddings + ChromaDB
│   │   └── chroma.service.ts     ← ChromaDB client
│   └── index.ts                  ← Express server + cron registration
├── scrape-master.ts              ← QUERIES array (all 80+ category queries)
├── scrape-category-test.ts       ← 6-query category browse test
└── scrape-test.ts                ← 3-query smoke test

Admin Panel/
├── src/
│   ├── pages/system/
│   │   ├── SystemStatus.jsx      ← existing scraper health UI (extend this or add new page)
│   │   └── ErrorLogs.jsx
│   ├── services/
│   │   ├── system.service.js     ← calls /admin/scraper/health, /admin/system/logs
│   │   └── api.js                ← axios base instance
│   └── App.jsx                   ← add route for ScraperControl
```
