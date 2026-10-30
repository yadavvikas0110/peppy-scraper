# Shopping worker — Amazon UAE

A long-running scheduler that keeps Amazon UAE products and prices current in `products_clean`.
It reuses the existing pipeline (`scrapeBulk` → bundler → `pushToDatabase` → backend mapping) and
adds scheduling, a scheduler lock, a request budget, persistent job records and resume.

Only Amazon UAE is enabled. Noon stays disabled until Bright Data approves access
(`BRIGHT_DATA_APPROVED_SITES=noon`); the worker refuses to start if it is listed without approval.

## How it works

| Job | What it does | Default schedule |
|-----|--------------|------------------|
| `discovery:<query>` | Searches amazon.ae for one configured query, scrapes new product pages, bundles, pushes | every 24 h per query |
| `refresh:amazon` | Re-scrapes price & stock of existing Amazon offers older than `SHOPPING_FRESH_FOR_HOURS`, oldest first, in batches; then expires offers not observed for `STALE_OFFER_DAYS` | every 12 h |

* One job runs at a time. Interrupted jobs run first, then the most overdue.
* Discovery skips listings observed within the freshness window — refresh owns those.
* Every write goes through `pushToDatabase`: identity matching (ASIN), stock policy, derived prices,
  `lastSeenAt` = actual scrape time, then `POST /api/v1/admin/scraper/ingest/apply-mapping` on the backend
  (categories, discovery categories, product role, variant groups — fill-only, admin edits kept).
* Queries live in `config/shopping-queries.json` (`key` is permanent; `enabled: false` pauses a query).

### Outcomes

| Outcome | Meaning | Next run |
|---------|---------|----------|
| `complete` | every product succeeded, mapping applied | interval |
| `partial` | some products failed, a site was refused, or mapping was not applied | interval (blocked sources are not hammered) |
| `failed` | nothing usable | backoff 15 min × 2ⁿ (capped at the interval), after `SHOPPING_MAX_ATTEMPTS` the interval |
| `interrupted` | stop signal / restart; checkpoint kept, nothing published from discovery | immediately on next start |
| `budget_exhausted` | daily request budget used up; progress kept | 00:01 UTC next day |

Only `complete` sets `lastSuccessAt`.

### State (in the same database as the products)

* `shopping_worker_jobs` — schedule, status, last summary, refresh progress
* `shopping_worker_runs` — one record per run (summary counts, outcome, issues)
* `shopping_worker_locks` — scheduler lock (expires `SHOPPING_LOCK_TTL_MINUTES` after the holder dies)
* `shopping_worker_budget` — paid requests used per UTC day
* `output/checkpoints/*.json` — discovery checkpoints (expire after `CHECKPOINT_MAX_AGE_HOURS`, default 20)
* `output/shopping-worker-status.json` — snapshot written every tick
* `output/logs/shopping-worker-YYYY-MM-DD.jsonl` — structured log, one JSON object per line

## Commands (development — uses `.env.dev`)

```bash
npm run shopping:scrape:once -- --query iphone-16                 # one discovery run for a configured query
npm run shopping:scrape:once -- --search "apple iphone 16" --count 10 --broad Electronics --sub Smartphones
npm run shopping:refresh:once                                      # one refresh run
npm run shopping:worker:dev                                        # continuous worker (Ctrl+C = graceful stop)
npm run shopping:worker:status                                     # jobs, schedule, budget, backlog, failures (--json)
npm run shopping:worker:stop                                       # graceful stop of a running worker
npm run shopping:report -- output/<scrape-output>.json             # read-only quality report of an ingest
```

`run-once` takes the scheduler lock too, so it never overlaps a running worker, and caps its own paid
requests (`--max-requests`, default `count × 3 + 10`).

### Graceful stop and resume

`Ctrl+C`, `SIGTERM` (PM2/systemd stop) or `npm run shopping:worker:stop`: the worker finishes the current
product, saves its checkpoint, marks the job `interrupted`, releases the lock and exits. A second signal
forces exit. On the next start, jobs left `running` by a crash are recovered as `interrupted` and resume
first: discovery from its checkpoint, refresh from its saved progress (already-pushed ASINs are not
scraped again). Progress older than the resume window is discarded rather than published as fresh.

## Configuration

All `SHOPPING_*` settings are in `.env.example` with their defaults:

| Variable | Default | |
|----------|---------|---|
| `SHOPPING_WORKER_ENV` | `development` | development refuses a production database; production also needs `CONFIRM_PRODUCTION_DB=yes` |
| `SHOPPING_SITES` | `amazon` | only Amazon UAE is supported |
| `SHOPPING_DISCOVERY_INTERVAL_HOURS` | 24 | per query |
| `SHOPPING_REFRESH_INTERVAL_HOURS` | 12 | |
| `SHOPPING_FRESH_FOR_HOURS` | 12 | offers seen more recently are skipped |
| `SHOPPING_REFRESH_BATCH_SIZE` | 100 | offers per refresh run |
| `SHOPPING_DAILY_REQUEST_BUDGET` | 800 | paid Bright Data requests per UTC day, shared across processes |
| `SHOPPING_MIN_REQUEST_INTERVAL_MS` | 2000 | spacing between paid requests |
| `SHOPPING_MAX_CONCURRENCY` | 2 | concurrent Bright Data requests |
| `SHOPPING_RETRY_BASE_MINUTES` / `SHOPPING_MAX_ATTEMPTS` | 15 / 4 | job-level backoff |
| `AMAZON_UNLOCKER_COUNTRY` | `ae` | Unlocker exit country for amazon.ae |

Also required for mapping: `PEPPY_BE_URL` and `SCRAPER_API_KEY` (same key in the backend). Keep
`ENABLE_CRON=false` for the scraper server on the same machine — the worker refuses to start otherwise,
so the legacy nightly cron and the worker never scrape at the same time.

**Budget sizing:** a discovery query costs about 1–2 search pages + 1 request per new product (+ retries);
a refresh costs about 1 request per offer. 800/day covers e.g. 2 queries × 20 products twice a day
plus ~600 refreshes.

## Running 24/7 on Ubuntu

Build once per deploy: `npm ci && npm run build`.

### PM2

```bash
pm2 start deploy/pm2.shopping-worker.config.cjs
pm2 save
pm2 startup systemd        # run the command it prints → restarts after reboot
pm2 logs peppy-shopping-worker
pm2 stop peppy-shopping-worker    # graceful (kill_timeout gives it 120 s to checkpoint)
```

### systemd

```bash
sudo cp deploy/peppy-shopping-worker.service /etc/systemd/system/   # edit User/WorkingDirectory/env file first
sudo systemctl daemon-reload
sudo systemctl enable --now peppy-shopping-worker   # starts now and on every boot
journalctl -u peppy-shopping-worker -f
sudo systemctl stop peppy-shopping-worker
```

Both restart on crash with a 30 s delay (a crash loop cannot burn the request budget quickly) and give
the worker time to checkpoint on stop. The Mongo scheduler lock prevents two workers even if both
PM2 and systemd were configured by mistake.

## Promoting data to production

Do **not** use `shikhar-peppy-backend/scripts/migrate-products-dev-to-prod.mjs --execute`: it deletes every
production product before copying dev. Promote by re-pushing scrape output into production with the merge
pipeline (`add-to-mongodb.ts <file>` with production `MONGODB_URI` and `CONFIRM_PRODUCTION_DB=yes`), then run
the backend mapping against production — or run the worker itself in production mode.
