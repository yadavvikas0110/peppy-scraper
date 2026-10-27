/// <reference types="node" />
/*
 * DEVELOPER-ONLY one-off fixture capture. Never imported by the service or the test suite.
 * Each run makes ONE live Scrape.do request and consumes credits.
 *
 *   npx ts-node test/dining/tools/capture-deliveroo-fixture.ts <en|ar> [url] [--force]
 *
 * Writes test/dining/fixtures/deliveroo-<locale>.html and a .meta.json with non-secret fetch
 * metadata (status, request cost, …). Does not touch MongoDB.
 */
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { createScrapeDoClient } from '../../../src/shared/scrapedo/scrapedo.client';
import { maskSecrets } from '../../../src/shared/scrapedo/scrapedo.errors';
import {
  detectDeliverooLocale,
  getDeliverooFetchOptions,
  isDeliverooMenuUrl,
  toDeliverooLocaleUrl,
} from '../../../src/dining/platforms/deliveroo/deliveroo.adapter';

const DEFAULT_URL =
  'https://deliveroo.ae/en/menu/Dubai/dubai-business-bay/kamat-dt/?day=today&geohash=thrr3squys8d&time=ASAP';
const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures');

async function main(): Promise<void> {
  dotenv.config();
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const [locale, urlArg] = args.filter(a => a !== '--force');
  if (locale !== 'en' && locale !== 'ar') throw new Error('Usage: capture-deliveroo-fixture.ts <en|ar> [url] [--force]');

  const url = toDeliverooLocaleUrl(urlArg ?? DEFAULT_URL, locale);
  if (!isDeliverooMenuUrl(url) || detectDeliverooLocale(url) !== locale) throw new Error(`Not a ${locale} Deliveroo menu URL`);

  const htmlPath = path.join(FIXTURE_DIR, `deliveroo-${locale}.html`);
  const metaPath = path.join(FIXTURE_DIR, `deliveroo-${locale}.meta.json`);
  if (fs.existsSync(htmlPath) && !force) {
    throw new Error(`${path.relative(process.cwd(), htmlPath)} already exists — pass --force to spend credits re-capturing`);
  }

  const options = { ...getDeliverooFetchOptions(url, locale), client: { maxRetries: 0 } };
  console.log(`[capture] GET ${url}`);
  console.log(`[capture] options ${JSON.stringify({ ...options, client: undefined })}`);

  const res = await createScrapeDoClient().fetchHtml(url, options);

  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  fs.writeFileSync(htmlPath, res.html);
  const meta = {
    platform: 'deliveroo',
    locale,
    url,
    capturedAt: new Date().toISOString(),
    scrapeDoOptions: { ...options, client: undefined },
    statusCode: res.statusCode,
    initialStatusCode: res.initialStatusCode,
    finalUrl: res.finalUrl,
    requestCost: res.requestCost,
    remainingCredits: res.remainingCredits,
    attempts: res.attempts,
    durationMs: res.durationMs,
    bytes: Buffer.byteLength(res.html),
  };
  fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`[capture] saved ${path.relative(process.cwd(), htmlPath)} (${meta.bytes} bytes), cost=${res.requestCost ?? 'n/a'}, remaining=${res.remainingCredits ?? 'n/a'}`);
}

main().catch(err => {
  console.error(`[capture] failed: ${maskSecrets((err as Error).message, [process.env.SCRAPE_DO_TOKEN])}`);
  if ((err as { category?: string }).category) console.error(`[capture] category=${(err as { category?: string }).category}`);
  process.exitCode = 1;
});
