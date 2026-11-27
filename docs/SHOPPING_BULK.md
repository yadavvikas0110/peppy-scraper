# Shopping bulk pipeline (Scrape.do)

Scrapes many categories across the Priority-1 shopping platforms **in parallel**, merges the same
product across platforms, uploads every image to our S3/CDN, and writes `products_clean`, so the
storefront can show a price comparison.

| Platform | Key | Status |
|---|---|---|
| Amazon UAE | `amazon` | parser existed; Scrape.do profile measured 17 Nov 2026 |
| Noon | `noon` | parser existed; supported only through Scrape.do (Bright Data refuses it) |
| Carrefour UAE | `carrefour` | parser existed; Scrape.do profile measured |
| Jumbo | `jumbo` | parser existed; Scrape.do profile measured |
| Ounass | `ounass` | **new** (`src/parsers/ounass.parser.ts`), Scrape.do only |
| Centrepoint | `centrepoint` | **new** (`src/parsers/landmark.parser.ts`), Scrape.do only |
| Home Centre | `homecentre` | **new** (same Landmark parser), Scrape.do only |

Parsers for the new sites were written against live pages (Nov 2026); trimmed copies are the test
fixtures in `test/ecommerce/fixtures/`. Their Scrape.do option ladders are **not measured yet**
(see "Before the first run").

## How it works

```
config/shopping-catalog.json  (category → platforms, our taxonomy, count)
   │
   ├─ category jobs, N at a time (--category-concurrency, default 2)
   │     └─ scrapeBulk: one lane per platform, in parallel; --product-concurrency pages at once per lane
   │           category page when the platform has one for categoryKey (src/config/sites.ts), else search
   │           → bundler merges platforms in memory: same barcode, or guarded title match
   ├─ S3: every gallery + offer image re-hosted (content-hashed keys, products/images/); a failed
   │      upload drops that image — retailer URLs are never stored. No image → the offer can still join
   │      an existing product, but never creates one. CDNs that refuse direct downloads (Carrefour's
   │      cdn.mafrservices.com; SCRAPE_DO_IMAGE_HOSTS) are downloaded through Scrape.do (~1 credit/image)
   └─ one writer at a time: pushToDatabase merges into the stored document of
         1. the same listing (ASIN / SKU / product id / canonical URL)
         2. the same barcode (GTIN/EAN — Ounass, Centrepoint, Home Centre and JSON-LD pages state it)
         3. the same grocery key (groceries only)        4. the same name
         5. the same product on another platform: shared "brand|model" key AND similar title AND no
            role/type/brand/variant/colour conflict AND prices within 2× AND no offer from that retailer yet
      then asks the backend to map categories (ingestMappingStatus: pending → mapped)
```

Total parallelism is still capped by `SCRAPE_DO_CONCURRENCY` (shared limiter for the whole process):
set it to the plan's concurrent-request limit.

Wrong merges are worse than missed ones (a customer sent to a different product at the "best"
price), so products with no known brand or no model number (furniture, most fashion) merge across
platforms only by barcode or identical name.

## Before the first run

1. **Scrape.do token**: the token in `.env` was rejected on 25 Nov 2026 (401 inactive). Renew it; the CLI
   checks the account and refuses to start without credits.
2. **Switch the platforms to Scrape.do** in `.env`:
   `SCRAPE_DO_SITES=amazon,noon,carrefour,jumbo,ounass,centrepoint,homecentre,talabat,deliveroo,noon-minutes`
   `npm run shopping:bulk:list` shows each platform's transport; anything not on Scrape.do is flagged.
3. **Measure the new sites** (a few credits): `node --env-file=.env -r ts-node/register src/benchmarks/scrapedo-probe.ts --only ounass,centrepoint,homecentre`
   after adding them to its target list, then drop ladder rungs in `scrapedo.profiles.ts` that never win.
4. **Backfill match keys** on products stored before this change, so new platforms merge into them:
   `npm run build && npm run ecommerce:match-keys-backfill:dev` (dry run) then add `-- --execute`.
5. S3 (`S3_*`, `CDN_URL`) must be set; a write run refuses to start without it.

## Commands

```bash
npm run shopping:bulk:list                                    # plan: categories × platforms × transport
npm run shopping:bulk:dry-run -- --categories air-fryers --count 5          # scrape + bundle, no S3, no DB
npm run shopping:bulk -- --categories air-fryers --count 5                  # pilot: one category, 5 per platform
npm run shopping:bulk -- --platforms homecentre,amazon --categories air-fryers,coffee-machines
npm run shopping:bulk                                         # every enabled category
npm run shopping:bulk:stop                                    # graceful stop (or Ctrl+C / SIGTERM)
```

Options: `--categories`, `--platforms`, `--count`, `--category-concurrency`, `--product-concurrency`,
`--dry-run`, `--catalog <file>`, `--include-disabled`, `--list`.

The scripts use `.env`. Writes go to `MONGODB_DB` / the database in `MONGODB_URI`; a production-named
database is refused unless `CONFIRM_PRODUCTION_DB=yes`. Only one bulk run at a time (`output/shopping-bulk.lock`).

## 24/7 mode from the API

The scraper service (`npm run start:scraper`) runs the bulk pipeline continuously on request — every route needs
the `x-api-key` header (`SCRAPER_API_KEY`):

| Route | Effect |
|---|---|
| `POST /api/shopping/bulk/start` | full pass → wait `SHOPPING_BULK_INTERVAL_HOURS` → next pass … until stopped. Optional JSON body: `count`, `categories`, `platforms`, `categoryConcurrency`, `productConcurrency`, `maxPages`, `freshHours`, `intervalHours` (otherwise the `SHOPPING_BULK_*` env) |
| `POST /api/shopping/bulk/stop` | no further passes; the pass in progress finishes its pages, saves checkpoints and exits |
| `GET /api/shopping/bulk/status` | `phase` (idle / running / waiting / stopping), passes, current pass, next pass time, last outcome |

The on/off switch is kept in `output/shopping-bulk.auto.json`, so a deploy or restart of the service resumes 24/7 mode
until `stop` is called. Each pass is a child process with the same lock as the CLI, so do not also run
`deploy/pm2.shopping-bulk.config.cjs` — use one or the other.

## Outcomes and resume

Per category: `complete` (every page scraped and written), `partial` (some pages failed, a platform was
paused, or the backend mapping did not apply), `failed` (nothing scraped), `stopped`, `skipped` (no
platform has a data source), `error` (scrape or write threw; other categories continue).

* **Credits used up / token revoked** → that category stops; scraped pages stay in the checkpoint,
  unscraped links are left pending (never marked failed), nothing from it is written. Renew and rerun:
  it resumes where it stopped.
* **A platform blocks or is down** (5 failed pages in a row) → that platform pauses for this category,
  the other platforms continue and are written; its remaining links stay in the checkpoint for the next run.
* **Stop signal** → pages in flight finish, checkpoints are kept, interrupted categories write nothing.
* Checkpoints older than `CHECKPOINT_MAX_AGE_HOURS` (20) are discarded, so old prices are never published.

Each run writes `output/shopping-bulk_<time>.json` (per category: platforms, scraped / failed pages,
products, products compared on 2+ platforms, images uploaded / failed, inserted / updated / merged,
Scrape.do credits per platform) and one scrape output file per category (`output/<n>sites_<category>_<time>.json`).

## Adding a platform or a category

* Category: add an entry to `config/shopping-catalog.json` (validated on load: platforms, taxonomy,
  count, and that `categoryKey` exists on at least one platform). For a category page, add the key to
  that platform's `categories` in `src/config/sites.ts`.
* Platform: `SiteKey` + `SITES` entry (`src/config/sites.ts`), product + listing parser
  (`src/parsers/`), Scrape.do profile (`scrapedo.profiles.ts`), parser registration
  (`services/scrapedo-transport.ts`), display name (`bundler.service.ts`), marketplace id
  (`product-identity.ts`), a trimmed fixture and tests. Logo/label in `shikhar-peppy-user/src/lib/retailer-logos.ts`.

## Tests

`npm run test:ecommerce` (parsers on real-page fixtures, cross-platform merge guards, lanes, stop/pause/resume,
orchestrator, offline end-to-end) and `npm run test:scrapedo`. All offline; `test/db-guard.ts` blanks credentials
and blocks non-local databases.
