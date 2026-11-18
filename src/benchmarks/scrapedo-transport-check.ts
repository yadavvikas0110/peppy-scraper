/**
 * Live check of the Scrape.do transport through the REAL pipeline entry points (read only).
 * Run with SCRAPE_DO_SITES=all: shopping listing + product via the functions the cron and worker
 * call, grocery via the collectors' default fetcher (no fetchHtml injected). No database, no S3.
 *
 *   SCRAPE_DO_SITES=all SCRAPE_DO_CONCURRENCY=5 node --env-file=.env.benchmark -r ts-node/register src/benchmarks/scrapedo-transport-check.ts
 */
import { scrapeProductWithRetry } from '../services/playwright.service';
import { fetchListingViaScrapeDo, scrapeDoUsage, scrapeDoPlatforms } from '../services/scrapedo-transport';
import { SITES, SiteKey } from '../config/sites';
import { siteSupport } from '../config/transport-policy';
import { collectDeliverooGrocery } from '../grocery/deliveroo-grocery.collector';
import { DELIVEROO_PILOT_STORES } from '../grocery/deliveroo-grocery.config';
import { collectNoonMinutes } from '../grocery/noon-minutes.collector';
import { collectTalabatGrocery } from '../grocery/talabat-grocery.collector';

const LISTINGS: Partial<Record<SiteKey, string>> = {
  amazon: SITES.amazon.buildSearchUrl('air fryer', 1),
  noon: SITES.noon.buildSearchUrl('air fryer', 1),
  carrefour: SITES.carrefour.buildSearchUrl('air fryer', 1),
  sharafdg: 'https://uae.sharafdg.com/c/mobiles_tablets/mobiles/',
  jumbo: 'https://www.jumbo.ae/mobile-phones.html?pageNo=1',
  namshi: 'https://www.namshi.com/uae-en/men-shoes/',
  mumzworld: SITES.mumzworld.categories!['toys'](1),
};

async function main() {
  if (process.env.BRIGHT_DATA_API_KEY || process.env.BRIGHT_DATA_BROWSER_AUTH) throw new Error('Bright Data variables must be empty');
  console.log(`[check] Scrape.do platforms: ${[...scrapeDoPlatforms()].join(', ')}`);
  console.log(`[check] noon supported now: ${siteSupport('noon').supported}`);
  const rows: string[] = [];
  for (const [site, url] of Object.entries(LISTINGS) as Array<[SiteKey, string]>) {
    const t0 = Date.now();
    try {
      const html = await fetchListingViaScrapeDo(url);
      const links = SITES[site].parseSearchLinks(html, url);
      const p = await scrapeProductWithRetry(links[0]);
      rows.push(`${site.padEnd(10)} OK   ${String(links.length).padStart(3)} links · ${String(p.productName).slice(0, 45)} · ${p.price} ${p.currency} · rating ${p.ratings ?? '-'} · stock ${p.inStock ?? '-'} · ${p.imageUrls.length} img · ${Math.round((Date.now() - t0) / 1000)} s`);
    } catch (e: any) {
      rows.push(`${site.padEnd(10)} FAIL ${String(e?.message ?? e).slice(0, 160)}`);
    }
  }
  const g = async (name: string, fn: () => Promise<{ bundles: unknown[] }>) => {
    const t0 = Date.now();
    try { const r = await fn(); rows.push(`${name.padEnd(10)} OK   ${r.bundles.length} grocery products · ${Math.round((Date.now() - t0) / 1000)} s`); }
    catch (e: any) { rows.push(`${name.padEnd(10)} FAIL ${String(e?.message ?? e).slice(0, 160)}`); }
  };
  await g('deliveroo', () => collectDeliverooGrocery(DELIVEROO_PILOT_STORES.slice(0, 1), { max: 100_000 }) as any);
  await g('talabat', () => collectTalabatGrocery(undefined, { max: 40 }) as any);
  await g('noon-min', () => collectNoonMinutes({ max: 1 }) as any);

  console.log('\n──────── through the real pipeline functions ────────');
  rows.forEach(r => console.log(r));
  const u = scrapeDoUsage();
  console.log(`\npages ${u.pages} · failed ${u.failedPages} · credits ${u.credits}`);
  for (const [k, v] of Object.entries(u.byPlatform)) console.log(`  ${k.padEnd(13)} pages ${v.pages} failed ${v.failedPages} credits ${v.credits} options ${JSON.stringify(v.rungs)}`);
}

main().catch(e => { console.error(`[check] ${e?.message ?? e}`); process.exit(1); });
