/**
 * PM2 process file for the shopping bulk pipeline (docs/SHOPPING_BULK.md). Template — review before use.
 *
 * 24/7 mode: one bulk run (every enabled category × every platform, in parallel), then a pause of
 * restart_delay (6 h), then the next run — forever. Each run refreshes prices/stock of what it finds and adds
 * new products; an interrupted run resumes from its checkpoints on the next start.
 *
 *   npm ci && npm run build
 *   pm2 start deploy/pm2.shopping-bulk.config.cjs        # start now
 *   pm2 save && pm2 startup systemd                      # survive reboots (run the printed command)
 *   pm2 logs peppy-shopping-bulk                         # live logs
 *   npm run shopping:stats -- --daily 7 --db             # day by day: scraped / failed / credits per platform, DB totals
 *   pm2 stop peppy-shopping-bulk                         # stop (finishes pages in flight, keeps checkpoints)
 *   pm2 restart peppy-shopping-bulk                      # start again after a stop
 *
 * Note: `npm run shopping:bulk:stop` only ends the CURRENT run — PM2 starts the next one after the delay.
 * Use `pm2 stop` to stop for good.
 */
module.exports = {
  apps: [
    {
      name: 'peppy-shopping-bulk',
      cwd: __dirname + '/..',
      script: 'dist/src/shopping/shopping-bulk.cli.js',
      // Narrow with --platforms / --categories / --count as needed
      args: '--category-concurrency 3 --product-concurrency 4',
      // Env file for this server: Scrape.do token + SCRAPE_DO_SITES, S3 + CDN_URL, MONGODB_URI, PEPPY_BE_URL, SCRAPER_API_KEY.
      // Ounass (via Scrape.do) sends response headers above Node's 16 KB default.
      node_args: '--max-http-header-size=131072 --env-file=.env',
      instances: 1,                // the bulk lock file also refuses a second run
      exec_mode: 'fork',
      autorestart: true,           // run again when a run ends…
      // …after 6 hours. One full run ≈ 2,450 product pages ≈ 10–15k Scrape.do credits and 45–90 min, so a 6 h
      // pause ≈ 3–4 runs/day ≈ 40–60k credits/day ≈ 1.2–1.8M/month. 30 min would be ~3–5M/month (the whole plan).
      restart_delay: 6 * 60 * 60 * 1000,
      max_restarts: 100000,
      min_uptime: 60000,
      kill_timeout: 120000,        // finish pages in flight and save checkpoints on stop
      max_memory_restart: '1500M',
      env: { NODE_ENV: 'production' },
      out_file: 'output/logs/pm2-shopping-bulk.out.log',
      error_file: 'output/logs/pm2-shopping-bulk.err.log',
      time: true,
    },
  ],
};
