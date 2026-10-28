// Must stay the first import: several modules read process.env when they are loaded
import 'dotenv/config';
import express from 'express';
import * as http from 'http';
import cron from 'node-cron';
import * as fs from 'fs';
import * as path from 'path';
import { scrapeProduct, scrapeCategory } from './services/scrape.do.service';
import { scrapeBulk, closeBrowser, withoutEmbeddings } from './services/playwright.service';
import { SiteKey } from './config/sites';
import { runFullPipeline } from './cron/cron-runner';
import { runDemoPipeline } from './cron/demo-runner';
import { attachLogServer, interceptConsole, getLogs } from './logger';
import { LOCK_FILE, STOP_FILE, readLock } from './utils/stop-signal';
import { requireScraperApiKey, isApiKeyEnforced } from './utils/api-key';

interceptConsole();

const app = express();
const PORT = process.env.PORT || 4000;

app.use(express.json());
app.get('/', async (req, res) => {

    res.json({status:"peppy cron is running"});

});

// Everything below `/` spends scraping credits or exposes logs
app.use(requireScraperApiKey);
if (!isApiKeyEnforced()) {
  console.warn('[auth] SCRAPER_API_KEY is not set — scraper endpoints are open to anyone who can reach this port.');
}

app.get('/scrape', async (req, res) => {
  const { url } = req.query;

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Please provide a valid url as a query parameter (e.g. /scrape?url=https://amazon.ae/...)' });
  }

  try {
    const productData = await scrapeProduct(url);
    res.json(productData);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/scrape-category', async (req, res) => {
  const urlParamIndex = req.originalUrl.indexOf('url=');
  if (urlParamIndex === -1) {
    return res.status(400).json({ error: 'Please provide a valid url as a query parameter' });
  }

  let rawUrlStr = req.originalUrl.substring(urlParamIndex + 4);
  let targetUrl = rawUrlStr;
  let limitNum = 5;

  if (req.query.limit) {
    limitNum = parseInt(req.query.limit as string, 10);
    const limitMatch = targetUrl.match(/&limit=\d+/);
    if (limitMatch) {
      targetUrl = targetUrl.replace(limitMatch[0], '');
    }
  }

  targetUrl = decodeURIComponent(targetUrl);

  try {
    const productsData = await scrapeCategory(targetUrl, limitNum);
    res.json({ count: productsData.length, products: productsData });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

const VALID_SITES: SiteKey[] = ['amazon', 'noon', 'carrefour', 'sharafdg', 'jumbo', 'mumzworld', 'namshi', 'letstango'];

app.post('/scrape-bulk', async (req, res) => {
  const { site, sites: sitesParam, category, categoryKey, broadCategory, subCategory, count } = req.body;

  // Accept `sites` (array) or `site` (single string, backward compat)
  let requestedSites: string[] = [];
  if (sitesParam) {
    requestedSites = Array.isArray(sitesParam) ? sitesParam : [sitesParam];
  } else if (site) {
    requestedSites = [site];
  }

  if (requestedSites.length === 0) {
    return res.status(400).json({
      error: `Provide "sites" (array) or "site" (string). Valid values: ${VALID_SITES.join(', ')}`,
    });
  }

  const invalidSites = requestedSites.filter(s => !VALID_SITES.includes(s as SiteKey));
  if (invalidSites.length > 0) {
    return res.status(400).json({
      error: `Invalid site(s): ${invalidSites.join(', ')}. Must be one of: ${VALID_SITES.join(', ')}`,
    });
  }

  if (!category || typeof category !== 'string' || category.trim() === '') {
    return res.status(400).json({ error: 'category must be a non-empty string' });
  }
  if (!count || typeof count !== 'number' || count < 1 || count > 500) {
    return res.status(400).json({ error: 'count must be a number between 1 and 500' });
  }

  try {
    const result = await scrapeBulk({
      sites: requestedSites as SiteKey[],
      category: category.trim(),
      categoryKey: typeof categoryKey === 'string' && categoryKey.trim() ? categoryKey.trim() : undefined,
      broadCategory: typeof broadCategory === 'string' ? broadCategory.trim() : undefined,
      subCategory: typeof subCategory === 'string' ? subCategory.trim() : undefined,
      count,
    });
    res.json({
      success: true,
      jobId: result.jobId,
      resumed: result.resumed,
      sites: result.sites,
      category: result.category,
      broadCategory: result.broadCategory,
      subCategory: result.subCategory,
      requestedCountPerSite: result.requestedCountPerSite,
      totalScraped: result.totalScraped,
      bundleCount: result.bundleCount,
      errorCount: result.errors.length,
      outputFile: result.outputFile,
      bundles: withoutEmbeddings(result.bundles),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Manual trigger + status ──────────────────────────────────────────────────

app.get('/api/status', (_req, res) => {
  const lock = readLock();
  if (lock) {
    return res.json({ running: true, startedAt: lock.startedAt, pid: lock.pid, mode: lock.mode || 'full' });
  }
  res.json({ running: false });
});

app.post('/api/trigger', (_req, res) => {
  const lock = readLock();
  if (lock) {
    return res.json({ triggered: false, reason: 'Pipeline already running', startedAt: lock.startedAt, mode: lock.mode || 'full' });
  }
  res.json({ triggered: true });
  runFullPipeline().catch(e => console.error('[trigger] Pipeline failed:', e.message));
});

app.post('/api/demo', (_req, res) => {
  const lock = readLock();
  if (lock) {
    return res.json({ triggered: false, reason: 'Pipeline already running', startedAt: lock.startedAt, mode: lock.mode || 'full' });
  }
  res.json({ triggered: true });
  runDemoPipeline().catch(e => console.error('[demo] Pipeline failed:', e.message));
});

app.get('/api/logs', (_req, res) => {
  res.json({ logs: getLogs() });
});

app.post('/api/stop', (_req, res) => {
  if (!fs.existsSync(LOCK_FILE)) {
    return res.json({ stopped: false, reason: 'Pipeline not running' });
  }
  try {
    fs.mkdirSync(path.dirname(STOP_FILE), { recursive: true });
    fs.writeFileSync(STOP_FILE, JSON.stringify({ requestedAt: new Date().toISOString() }));
    console.log('[stop] Stop signal written — pipeline will abort at next checkpoint.');
    res.json({ stopped: true });
  } catch (e: any) {
    res.status(500).json({ stopped: false, reason: e.message });
  }
});

// ─── Cron schedule ────────────────────────────────────────────────────────────
if (process.env.ENABLE_CRON === 'true') {
  const schedule = process.env.SCRAPE_CRON || '0 2 * * *';
  if (!cron.validate(schedule)) {
    console.error(`[cron] Invalid SCRAPE_CRON expression: "${schedule}". Cron not started.`);
  } else {
    cron.schedule(schedule, async () => {
      console.log('[cron] Trigger — starting scheduled pipeline...');
      await runFullPipeline().catch(e => console.error('[cron] Pipeline failed:', e.message));
    });
    console.log(`[cron] Scheduled: "${schedule}" (set ENABLE_CRON=false to disable)`);
  }
}

const server = http.createServer(app);
attachLogServer(server);

server.listen(PORT, () => {
  console.log(`Scraper service running on http://localhost:${PORT}`);
  console.log(`WebSocket logs:     WS   ws://localhost:${PORT}/ws/logs`);
  console.log(`Product endpoint:   GET  http://localhost:${PORT}/scrape?url=<product_url>`);
  console.log(`Category endpoint:  GET  http://localhost:${PORT}/scrape-category?url=<category_url>&limit=3`);
  console.log(`Bulk endpoint:      POST http://localhost:${PORT}/scrape-bulk`);
  console.log(`                         Body: { "sites": ["amazon","noon","carrefour","sharafdg"], "category": "...", "count": N }`);
  console.log(`                         (or "site": "amazon" for single-site backward compat)`);
});

async function shutdown() {
  console.log('\nShutting down...');
  await closeBrowser();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
