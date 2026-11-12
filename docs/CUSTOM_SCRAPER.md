# Custom scraper (no third-party provider)

Scrapes **Shopping & Luxury** products from **Namshi, Mumzworld, Jumbo and Letstango** with our own
transport: plain HTTP plus a local headless Chromium. It does not use Bright Data or Scrape.do, and it
runs independently of the e-commerce cron, the shopping worker, and the grocery and dining pipelines.

## Run it

```bash
npm run custom:scrape                                # all sites → output/custom/*.json, no database write
npm run custom:scrape -- --site namshi --limit 5     # one site, 5 products per category
npm run custom:scrape -- --category perfumes,toys    # selected category keys
npm run custom:scrape:push                           # scrape + write to products_clean (allowlisted DB only)
npm run custom:scrape:push -- --ai                   # …with OpenAI tags/embeddings (off by default)
npm run custom:stop                                  # ask a running scrape to stop
npm run test:custom                                  # offline tests
```

Each run prints a summary per site and per category: valid and rejected products, plus field coverage %.
The full result (products, rejections and reasons) goes to `output/custom/custom_<time>.json`.

## Setup: `.env.custom` (gitignored)

```
CUSTOM_MONGODB_URI=mongodb://<user>:<password>@<host>:27017/dev?authSource=admin
CUSTOM_MONGODB_DB=dev
CUSTOM_DB_ALLOWLIST=dev
CUSTOM_SCRAPER_ENABLED=true        # false = the command exits without scraping
```

It **never** reads the shared `MONGODB_URI`. It writes only to a database named in `CUSTOM_DB_ALLOWLIST`.
The production pipeline's database name `peppy` is refused unless you explicitly allowlist it, and
production-style names (`prod`, `production`, `live`) are refused even when allowlisted.

## How it is kept separate

| | Custom scraper | Bright Data / Scrape.do pipelines |
|---|---|---|
| Code | `src/custom/**` | `services/brightdata.service`, `playwright.service`, `dining/`, `grocery/` |
| Entry | `custom:scrape` CLI only (no HTTP route, cron or worker) | cron, shopping worker, `/api/*` triggers |
| Config | `config/custom-scraper.json` | `scrape-master.ts`, `config/shopping-queries.json` |
| Lock / stop | `output/cron.custom.lock`, `output/stop.custom.signal` | `output/cron.lock`, … |
| Output | `output/custom/` | `output/` |
| Credentials | blanks every provider variable at startup | Bright Data, Scrape.do, Chroma, backend key |

`test/custom/custom.test.ts` loads every custom module and fails if Node ever loads Bright Data,
Scrape.do, their orchestrators, or `config/sites` (whose Carrefour collector imports Bright Data).

## Pipeline

```
discover   listing page (HTTP) │ listing page (local Chromium, Jumbo) │ Shopify collection JSON (Letstango)
fetch      robots.txt-checked, ≥2 s between requests per host, retry on 5xx/429, stop the site on an anti-bot page
extract    schema.org JSON-LD Product → existing src/parsers/*.parser.ts fills gaps
normalize  AED price · absolute https images (structured gallery only) · SEO title cleanup · stock true/false/unknown
validate   name + AED price + image + URL required; otherwise rejected with reasons
store      existing bundler → pushToDatabase(collection) → products_clean (ingestMappingStatus: pending)
```

| Site | Discovery | Product data | Notes |
|---|---|---|---|
| Namshi | `/uae-en/<category>/` listing, HTTP | JSON-LD | No struck-through price; ratings on ~40% |
| Mumzworld | `/en/<category>` listing, HTTP | JSON-LD | `/search/` is disallowed by robots.txt — never used |
| Jumbo | category page rendered in local Chromium | JSON-LD over HTTP | `advance-for-…` pre-order deposits are skipped |
| Letstango | `/collections/<handle>/products.json` | Shopify JSON | Shopify `vendor` is the seller, so no brand is taken; compare-at price → `originalPrice` |

Pushing does **not** call ChromaDB or the backend (`PEPPY_BE_URL` is blanked). Backend category, role and
variant mapping for the pushed products is a separate step in `shikhar-peppy-backend`:
`MONGODB_URI=<dev uri> npm run ingest:apply-mapping:dry-run`, then `npm run ingest:apply-mapping`.

## Adding a category or a site

- **Category:** add an entry to `config/custom-scraper.json`. `broadCategory` and `subCategory` must exist in `src/config/taxonomy.ts`.
- **Site:** add `src/custom/adapters/<site>.adapter.ts` implementing `PlatformAdapter` (`discover` + `extract`),
  then register it in `adapters/index.ts` and `CUSTOM_SITES`.
