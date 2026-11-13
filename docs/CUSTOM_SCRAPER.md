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

On a server, these can also be set in the scraper service's own environment; the service's values take precedence.

```
CUSTOM_MONGODB_URI=mongodb://<user>:<password>@<host>:27017/dev?authSource=admin
CUSTOM_MONGODB_DB=dev
CUSTOM_DB_ALLOWLIST=dev
CUSTOM_SCRAPER_ENABLED=true        # false = the command (and the admin trigger) does nothing

# Images → our S3/CDN (required to save; --no-s3 overrides on the CLI only)
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
S3_BUCKET=
S3_REGION=
CDN_URL=                            # e.g. https://<distribution>.cloudfront.net

# Optional: ask OUR backend to map categories after a push (it must use the same database)
CUSTOM_BACKEND_URL=
CUSTOM_BACKEND_API_KEY=
```

## Control from the admin panel

The admin panel's **System → Scraper Control** page has a **Custom Scraper (Shopping & Luxury)** card. From it you can:
- pick sites and categories, and set products per category;
- **Scrape & Save** or **Test Run (no save)**, and **Stop** a run;
- see live progress in Live Logs, plus the last run's per-site results, saved counts and S3 counts.

How a request flows:
- Admin → backend `POST /admin/scraper/custom/trigger|stop`, which requires the `MANAGE_SCRAPER` permission.
- Backend → scraper service `POST /api/custom/trigger|stop` and `GET /api/custom/status`.
- The service starts the CLI above as a **child process**. The run therefore keeps its own lock and credential isolation, and can run alongside the Bright Data pipelines.

Saving is refused with a clear reason until S3 and the database are configured on the scraper server.

### Moving existing images to S3

```bash
npm run custom:images:s3:dry-run      # count (dev today: 1,249 documents, 5,445 images)
npm run custom:images:s3              # migrate; re-run to retry temporary failures
```

**When an image upload fails** (same policy as the dining pipeline: we never store a retailer image URL):
- **Scrape & save:** the image is dropped and the next run retries it. A product left with no image is not saved; it is listed as rejected ("no image could be uploaded to S3").
- **Stored documents (backfill and the post-push swap):** a retailer URL is removed only when it is dead (404/410, or the link does not return an image). Temporary failures (timeouts, 5xx, 403 blocks) keep the URL so the next run can retry; a removed image would not come back on a later scrape, because a merge keeps a document's stored images. A gallery is never emptied.

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

| Site | Discovery | Product data | Original price | Rating |
|---|---|---|---|---|
| Namshi | `/uae-en/<category>/` listing, HTTP | JSON-LD | `normalPrice` / `salePrice` in the app payload, anchored on the product URI | JSON-LD when present (~40%); the rest load client-side from an internal API, not scraped |
| Mumzworld | `/en/<category>` listing, HTTP (`/search/` is disallowed by robots.txt) | JSON-LD | Magento `regular_price` / `final_price` | JSON-LD |
| Jumbo | category page rendered in local Chromium; `advance-for-…` deposits skipped | JSON-LD over HTTP | Nuxt `regular_price` / `final_price` next to the product's `sku` | JSON-LD |
| Letstango | `/collections/<handle>/products.json` | Shopify JSON | variant `compare_at_price` | Loox widget `data-rating` / `data-raters` on the product page (1 extra request per product) |

An original price is stored only when its paired selling price equals the price already read for that
product, and it is above that price. A related product's prices on the same page are never used.
Letstango has no brand: Shopify's `vendor` is the marketplace seller.

**What reaches `products_clean`:**
- Product: `brand`, `sku` (filled when missing), `category`, `subcategory`, `rating`, `reviewCount`.
- Offer: `retailers[].originalPrice`, `price`, `stockStatus`, `lastSeenAt`.

These fields already exist in the backend schema, so no schema change was needed.

### Stored-image cleanup

Earlier page-wide `<img>` scraping stored Mumzworld CMS banners and badges, plus related-product
thumbnails, on product documents. The push keeps an existing document's images, so these need a one-off cleanup:

```bash
npm run custom:images:clean:dry-run   # report
npm run custom:images:clean           # apply (allowlisted DB only; never empties a gallery)
```

Rules live in `src/custom/custom-images-cleanup.ts` (`IMAGE_RULES`).

Pushing does **not** call ChromaDB or the backend (`PEPPY_BE_URL` is blanked). Backend mapping (app
`categories`, `discoveryCategories`, `productRole`, variant groups) is a separate step in `shikhar-peppy-backend`.
It maps **every** pending product in that database:

```bash
MONGODB_URI=<dev uri> npm run ingest:apply-mapping:dry-run
MONGODB_URI=<dev uri> npm run ingest:apply-mapping
```

## Adding a category or a site

- **Category:** add an entry to `config/custom-scraper.json`. `broadCategory` and `subCategory` must exist in `src/config/taxonomy.ts`.
- **Site:** add `src/custom/adapters/<site>.adapter.ts` implementing `PlatformAdapter` (`discover` + `extract`),
  then register it in `adapters/index.ts` and `CUSTOM_SITES`.
