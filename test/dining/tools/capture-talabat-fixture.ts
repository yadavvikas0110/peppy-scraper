/// <reference types="node" />
/*
 * DEVELOPER-ONLY one-off fixture capture. Never imported by the service or the test suite.
 *
 *   npx ts-node test/dining/tools/capture-talabat-fixture.ts <en|ar> [url] [--force]
 *     ONE live Scrape.do request (plain HTML, ~1 credit).
 *   npx ts-node test/dining/tools/capture-talabat-fixture.ts <en|ar> --from-file <raw.html> [--meta <raw.meta.json>] [--force]
 *     No request: sanitizes a page that was already captured.
 *
 * Writes test/dining/fixtures/talabat-<locale>.html (sanitized, see talabat-fixture.sanitize.ts)
 * and a .meta.json with non-secret fetch metadata. Does not touch MongoDB.
 */
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { createScrapeDoClient } from '../../../src/shared/scrapedo/scrapedo.client';
import { maskSecrets } from '../../../src/shared/scrapedo/scrapedo.errors';
import {
  detectTalabatLocale,
  getTalabatFetchOptions,
  isTalabatMenuUrl,
  toTalabatLocaleUrl,
} from '../../../src/dining/platforms/talabat/talabat.adapter';
import { sanitizeTalabatHtml, TALABAT_FIXTURE_DROPPED } from './talabat-fixture.sanitize';

const DEFAULT_URL = 'https://www.talabat.com/uae/restaurant/773429/kamat-vegetarian-the-palm-jumeirah?aid=1333';
const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures');

function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

async function main(): Promise<void> {
  dotenv.config();
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const fromFile = option(args, '--from-file');
  const metaFile = option(args, '--meta');
  const positional = args.filter((a, i) => !a.startsWith('--') && !['--from-file', '--meta'].includes(args[i - 1]));
  const [locale, urlArg] = positional;
  if (locale !== 'en' && locale !== 'ar') throw new Error('Usage: capture-talabat-fixture.ts <en|ar> [url] [--from-file <html>] [--meta <json>] [--force]');

  const url = toTalabatLocaleUrl(urlArg ?? DEFAULT_URL, locale);
  if (!isTalabatMenuUrl(url) || detectTalabatLocale(url) !== locale) throw new Error(`Not a ${locale} Talabat menu URL`);

  const htmlPath = path.join(FIXTURE_DIR, `talabat-${locale}.html`);
  const metaPath = path.join(FIXTURE_DIR, `talabat-${locale}.meta.json`);
  if (fs.existsSync(htmlPath) && !force) {
    throw new Error(`${path.relative(process.cwd(), htmlPath)} already exists — pass --force to overwrite`);
  }

  let rawHtml: string;
  let fetchMeta: Record<string, unknown>;
  if (fromFile) {
    rawHtml = fs.readFileSync(fromFile, 'utf8');
    const prior = metaFile ? (JSON.parse(fs.readFileSync(metaFile, 'utf8')) as Record<string, unknown>) : {};
    fetchMeta = {
      capturedAt: prior.capturedAt,
      scrapeDoOptions: prior.scrapeDoOptions,
      statusCode: prior.statusCode,
      initialStatusCode: prior.initialStatusCode,
      finalUrl: prior.finalUrl,
      requestCost: prior.requestCost,
      remainingCredits: prior.remainingCredits,
      attempts: prior.attempts,
      durationMs: prior.durationMs,
    };
  } else {
    const options = { ...getTalabatFetchOptions(url, locale), client: { maxRetries: 0 } };
    console.log(`[capture] GET ${url}`);
    console.log(`[capture] options ${JSON.stringify({ ...options, client: undefined })}`);
    const res = await createScrapeDoClient().fetchHtml(url, options);
    rawHtml = res.html;
    fetchMeta = {
      capturedAt: new Date().toISOString(),
      scrapeDoOptions: { ...options, client: undefined },
      statusCode: res.statusCode,
      initialStatusCode: res.initialStatusCode,
      finalUrl: res.finalUrl,
      requestCost: res.requestCost,
      remainingCredits: res.remainingCredits,
      attempts: res.attempts,
      durationMs: res.durationMs,
    };
  }

  const sanitized = sanitizeTalabatHtml(rawHtml);
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  fs.writeFileSync(htmlPath, sanitized);
  const meta = {
    platform: 'talabat',
    locale,
    url,
    ...fetchMeta,
    rawBytes: Buffer.byteLength(rawHtml),
    fixtureBytes: Buffer.byteLength(sanitized),
    sanitized: { dropped: TALABAT_FIXTURE_DROPPED },
  };
  fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`[capture] saved ${path.relative(process.cwd(), htmlPath)} (${meta.fixtureBytes} of ${meta.rawBytes} bytes kept)`);
}

main().catch(err => {
  console.error(`[capture] failed: ${maskSecrets((err as Error).message, [process.env.SCRAPE_DO_TOKEN])}`);
  if ((err as { category?: string }).category) console.error(`[capture] category=${(err as { category?: string }).category}`);
  process.exitCode = 1;
});
