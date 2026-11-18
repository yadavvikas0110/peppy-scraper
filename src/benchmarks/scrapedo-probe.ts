/**
 * Scrape.do readiness probe — every Peppy platform, READ ONLY (no database, no S3).
 *
 * For each platform it fetches a real listing page and up to 2 real product pages through Scrape.do,
 * runs OUR existing parser on the result, and records: which Scrape.do option was the cheapest that
 * worked, credits (Scrape.do-Request-Cost), time, page size, and which product fields came through.
 *
 * Option ladder per page kind (cheapest first; the first that our parser can read is kept):
 *   plain → geo-ae → super+ae → render+ae → render+super+ae
 *
 *   node --env-file=.env.benchmark -r ts-node/register src/benchmarks/scrapedo-probe.ts [--only amazon,noon] [--budget 400]
 */
import * as fs from 'fs';
import * as path from 'path';
import { createScrapeDoClient } from '../shared/scrapedo/scrapedo.client';
import type { ScrapeDoRequestOptions } from '../shared/scrapedo/scrapedo.types';
import { fetchScrapeDoAccountInfo } from '../dining/bulk/bulk.credits';
import { parseAmazonSearch } from '../parsers/search/amazon.search.parser';
import { parseNoonSearch } from '../parsers/search/noon.search.parser';
import { parseCarrefourSearch } from '../parsers/search/carrefour.search.parser';
import { parseSharafDGSearch } from '../parsers/search/sharafdg.search.parser';
import { parseJumboSearch } from '../parsers/search/jumbo.search.parser';
import { parseNamshiSearch } from '../parsers/search/namshi.search.parser';
import { parseMumzworldSearch } from '../parsers/search/mumzworld.search.parser';
import { parseAmazon } from '../parsers/amazon.parser';
import { parseNoon } from '../parsers/noon.parser';
import { parseCarrefour } from '../parsers/carrefour.parser';
import { parseSharafDG } from '../parsers/sharafdg.parser';
import { parseJumbo } from '../parsers/jumbo.parser';
import { parseNamshi } from '../parsers/namshi.parser';
import { parseMumzworld } from '../parsers/mumzworld.parser';
import type { ProductData } from '../parsers/types';
import { parseTalabatGrocery } from '../grocery/talabat-grocery.parser';
import { parseDeliverooGrocery } from '../grocery/deliveroo-grocery.parser';
import { parseNoonMinutes } from '../grocery/noon-minutes.parser';
import { NOON_PRODUCT_READY_SELECTOR, noonCategoryUrl } from '../grocery/noon-minutes.config';
import { talabatAdapter } from '../dining/platforms/talabat/talabat.adapter';
import { deliverooAdapter } from '../dining/platforms/deliveroo/deliveroo.adapter';

interface Rung { label: string; options: ScrapeDoRequestOptions }
const LADDER: Rung[] = [
  { label: 'plain', options: {} },
  { label: 'geo-ae', options: { geoCode: 'ae' } },
  { label: 'super+ae', options: { super: true, geoCode: 'ae' } },
  { label: 'render+ae', options: { render: true, geoCode: 'ae', customWait: 2000 } },
  { label: 'render+super+ae', options: { render: true, super: true, geoCode: 'ae', customWait: 2000 } },
];

type Check = (html: string, url: string) => { ok: boolean; detail: string; links?: string[]; product?: ProductData };

interface Target {
  key: string; area: 'Shopping' | 'Grocery' | 'Dining'; name: string;
  listing: { url: string; check: Check; startAt?: number; extra?: ScrapeDoRequestOptions };
  product?: { check: Check; startAt?: number; extra?: ScrapeDoRequestOptions };
}

const listingCheck = (parse: (h: string, u: string) => string[]): Check => (html, url) => {
  const links = [...new Set(parse(html, url))];
  return { ok: links.length >= 3, detail: `${links.length} product links`, links };
};
const productCheck = (parse: (h: string, u: string) => ProductData): Check => (html, url) => {
  const p = parse(html, url);
  const ok = !!p.productName && typeof p.price === 'number' && p.price > 0;
  return { ok, detail: ok ? `${p.productName?.slice(0, 50)} · ${p.price} ${p.currency ?? ''}` : 'no name/price parsed', product: p };
};

const TARGETS: Target[] = [
  { key: 'amazon', area: 'Shopping', name: 'Amazon', listing: { url: 'https://www.amazon.ae/s?k=iphone+16&page=1', check: listingCheck(parseAmazonSearch) }, product: { check: productCheck(parseAmazon) } },
  { key: 'noon', area: 'Shopping', name: 'Noon', listing: { url: 'https://www.noon.com/uae-en/search/?q=iphone%2016&page=1', check: listingCheck(parseNoonSearch) }, product: { check: productCheck(parseNoon) } },
  { key: 'carrefour', area: 'Shopping', name: 'Carrefour', listing: { url: 'https://www.carrefouruae.com/mafuae/en/search?keyword=iphone%2016&page=1', check: listingCheck(parseCarrefourSearch) }, product: { check: productCheck(parseCarrefour) } },
  { key: 'sharafdg', area: 'Shopping', name: 'SharafDG', listing: { url: 'https://uae.sharafdg.com/c/mobiles_tablets/mobiles/', check: listingCheck(parseSharafDGSearch) }, product: { check: productCheck(parseSharafDG) } },
  { key: 'jumbo', area: 'Shopping', name: 'Jumbo', listing: { url: 'https://www.jumbo.ae/mobile-phones.html?pageNo=1', check: listingCheck(parseJumboSearch) }, product: { check: productCheck(parseJumbo) } },
  { key: 'namshi', area: 'Shopping', name: 'Namshi', listing: { url: 'https://www.namshi.com/uae-en/women-clothing/', check: listingCheck(parseNamshiSearch) }, product: { check: productCheck(parseNamshi) } },
  { key: 'mumzworld', area: 'Shopping', name: 'Mumzworld', listing: { url: 'https://www.mumzworld.com/en/feeding-and-nursing', check: listingCheck(parseMumzworldSearch) }, product: { check: productCheck(parseMumzworld) } },
  { key: 'letstango', area: 'Shopping', name: 'Letstango', listing: { url: 'https://www.letstango.com/collections/mobile-phones/products.json?limit=10', check: (html) => {
    let n = 0; let priced = 0;
    try { const j = JSON.parse(html); n = j.products?.length ?? 0; priced = (j.products ?? []).filter((p: any) => Number(p.variants?.[0]?.price) > 0).length; } catch { /* not JSON */ }
    return { ok: n > 0 && priced > 0, detail: `${n} products in feed, ${priced} with price` };
  } } },
  { key: 'grocery-talabat', area: 'Grocery', name: 'Talabat Mart', listing: { url: 'https://www.talabat.com/uae/grocery/797618/abu-hail/fruit-veg/fresh-fruit?aid=1169', check: (h, u) => { const r = parseTalabatGrocery(h, u); return { ok: r.items.length > 0, detail: `${r.items.length} grocery items` }; } } },
  { key: 'grocery-deliveroo', area: 'Grocery', name: 'Deliveroo HOP', listing: { url: 'https://deliveroo.ae/en/menu/Dubai/hopmc/deliveroo-hop-motor-city?day=today&geohash=thrq24sm92j2&time=ASAP', check: (h, u) => { const r = parseDeliverooGrocery(h, u); return { ok: r.items.length > 0, detail: `${r.items.length} grocery items` }; } } },
  { key: 'grocery-noon-minutes', area: 'Grocery', name: 'Noon Minutes', listing: { url: noonCategoryUrl('ice_cream'), startAt: 3, extra: { waitSelector: NOON_PRODUCT_READY_SELECTOR }, check: (h, u) => { const r = parseNoonMinutes(h, u); return { ok: r.items.length > 0, detail: `${r.items.length} grocery items` }; } } },
  { key: 'dining-talabat', area: 'Dining', name: 'Talabat restaurants', listing: { url: 'https://www.talabat.com/uae/restaurant/773429/kamat-vegetarian-the-palm-jumeirah?aid=1333', check: (h, u) => { const r: any = talabatAdapter.parse(h, { locale: 'en', sourceUrl: u } as any); return { ok: (r.items?.length ?? 0) > 0, detail: `${r.items?.length ?? 0} menu items, restaurant ${r.restaurant ? 'found' : 'missing'}` }; } } },
  { key: 'dining-deliveroo', area: 'Dining', name: 'Deliveroo restaurants', listing: { url: 'https://deliveroo.ae/en/menu/Dubai/dubai-business-bay/kamat-dt/', check: (h, u) => { const r: any = deliverooAdapter.parse(h, { locale: 'en', sourceUrl: u } as any); return { ok: (r.items?.length ?? 0) > 0, detail: `${r.items?.length ?? 0} menu items, restaurant ${r.restaurant ? 'found' : 'missing'}` }; } } },
];

interface Attempt { rung: string; ok: boolean; status?: number; credits: number; ms: number; kb: number; detail: string }
interface PageResult { kind: 'listing' | 'product'; url: string; ok: boolean; rung: string | null; credits: number; ms: number; attempts: Attempt[]; detail: string; fields?: Record<string, boolean> }

class OutOfBudget extends Error {}

async function main() {
  const arg = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
  const only = arg('--only')?.split(',');
  const budget = { limit: Number(arg('--budget') ?? 400), used: 0 };
  const perSiteLimit = Number(arg('--site-budget') ?? 90);
  const client = createScrapeDoClient({ logger: { log() {}, warn() {}, error() {} } as any });
  const remaining = async () => (await fetchScrapeDoAccountInfo())?.remainingMonthlyRequest ?? NaN;
  const start = await remaining();
  console.log(`[probe] Scrape.do credits remaining: ${start} · budget ${budget.limit} · read only (no database, no S3)`);

  const fetchWithLadder = async (url: string, kind: 'listing' | 'product', check: Check, from: number, extra: ScrapeDoRequestOptions | undefined, siteUsed: { n: number }) => {
    const attempts: Attempt[] = [];
    for (let i = from; i < LADDER.length; i++) {
      if (budget.used >= budget.limit) throw new OutOfBudget('total budget reached');
      if (siteUsed.n >= perSiteLimit) break;
      const rung = LADDER[i];
      const t0 = Date.now();
      try {
        const opts = { ...rung.options, ...(rung.options.render ? extra : {}), timeout: 60_000, client: { maxRetries: 0 } };
        const res = await client.fetchHtml(url, opts);
        const credits = res.requestCost ?? 0;
        budget.used += credits; siteUsed.n += credits;
        const c = check(res.html, res.finalUrl || url);
        attempts.push({ rung: rung.label, ok: c.ok, status: res.statusCode, credits, ms: Date.now() - t0, kb: Math.round(Buffer.byteLength(res.html) / 1024), detail: c.detail });
        console.log(`  ${c.ok ? 'OK ' : 'BAD'} ${kind.padEnd(7)} ${rung.label.padEnd(16)} ${String(credits).padStart(2)} cr ${String(Date.now() - t0).padStart(6)} ms  ${c.detail}`);
        if (c.ok) return { result: { kind, url, ok: true, rung: rung.label, credits: attempts.reduce((a, x) => a + x.credits, 0), ms: Date.now() - t0, attempts, detail: c.detail, fields: c.product ? fieldsOf(c.product) : undefined } as PageResult, level: i, links: c.links };
      } catch (e: any) {
        attempts.push({ rung: rung.label, ok: false, status: e?.statusCode, credits: 0, ms: Date.now() - t0, kb: 0, detail: String(e?.message ?? e).slice(0, 140) });
        console.log(`  ERR ${kind.padEnd(7)} ${rung.label.padEnd(16)}    ${String(Date.now() - t0).padStart(6)} ms  ${String(e?.message ?? e).slice(0, 110)}`);
      }
    }
    return { result: { kind, url, ok: false, rung: null, credits: attempts.reduce((a, x) => a + x.credits, 0), ms: 0, attempts, detail: attempts[attempts.length - 1]?.detail ?? 'not tried' } as PageResult, level: -1, links: undefined };
  };

  const report: any = { startedAt: new Date().toISOString(), creditsBefore: start, platforms: [] as any[] };
  for (const t of TARGETS) {
    if (only && !only.includes(t.key)) continue;
    console.log(`\n[probe] ${t.area} · ${t.name}`);
    const siteUsed = { n: 0 };
    const pages: PageResult[] = [];
    try {
      const l = await fetchWithLadder(t.listing.url, 'listing', t.listing.check, t.listing.startAt ?? 0, t.listing.extra, siteUsed);
      pages.push(l.result);
      if (t.product && l.links?.length) {
        let level = t.product.startAt ?? 0;
        for (const link of l.links.slice(0, 2)) {
          const p = await fetchWithLadder(link, 'product', t.product.check, level, t.product.extra, siteUsed);
          pages.push(p.result);
          if (p.level >= 0) level = p.level; // keep the cheapest working option for the next product
        }
      }
    } catch (e) { if (!(e instanceof OutOfBudget)) throw e; console.log('  budget reached — stopping'); report.platforms.push(summarise(t, pages)); break; }
    report.platforms.push(summarise(t, pages));
  }
  report.creditsAfter = await remaining();
  report.creditsUsed = report.creditsBefore - report.creditsAfter;
  report.finishedAt = new Date().toISOString();
  const dir = path.join(process.cwd(), 'output', 'benchmarks');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `scrapedo-probe_${report.startedAt.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));

  console.log('\n──────── Scrape.do readiness ────────');
  for (const p of report.platforms) {
    console.log(`${p.area.padEnd(9)} ${p.name.padEnd(22)} ${p.verdict.padEnd(9)} listing:${(p.listingOption ?? '-').padEnd(16)} product:${(p.productOption ?? '-').padEnd(16)} cr/page ${String(p.creditsPerPage ?? '-').padStart(3)}  ${p.note}`);
  }
  console.log(`credits used: ${report.creditsUsed} (remaining ${report.creditsAfter}) · report: ${file}`);
}

function fieldsOf(p: ProductData) {
  return { name: !!p.productName, price: (p.price ?? 0) > 0, currencyAED: p.currency === 'AED', images: (p.imageUrls?.length ?? 0) > 0, rating: p.ratings != null, reviews: p.reviewCount != null, stock: p.inStock != null, description: !!p.description };
}

function summarise(t: Target, pages: PageResult[]) {
  const listing = pages.find(p => p.kind === 'listing');
  const products = pages.filter(p => p.kind === 'product');
  const okProducts = products.filter(p => p.ok);
  const needsProduct = !!t.product;
  const verdict = !listing?.ok ? 'FAILED' : needsProduct && !okProducts.length ? 'PARTIAL' : 'WORKS';
  const winning = [listing, ...okProducts].filter(Boolean).filter(p => p!.ok) as PageResult[];
  const lastCredits = (p: PageResult) => p.attempts.filter(a => a.ok).slice(-1)[0]?.credits;
  const perPage = winning.length ? Math.max(...winning.map(p => lastCredits(p) ?? 0)) : null;
  const fields = okProducts[0]?.fields;
  return {
    key: t.key, area: t.area, name: t.name, verdict,
    listingOption: listing?.rung ?? null, productOption: okProducts[0]?.rung ?? null,
    creditsPerPage: perPage, creditsSpent: pages.reduce((a, p) => a + p.credits, 0),
    avgMs: winning.length ? Math.round(winning.reduce((a, p) => a + p.ms, 0) / winning.length) : null,
    fields: fields ?? null,
    note: !listing?.ok ? `listing: ${listing?.detail ?? 'not fetched'}` : needsProduct ? `${okProducts.length}/${products.length} products parsed · ${listing.detail}` : listing.detail,
    pages,
  };
}

main().catch(e => { console.error(`[probe] ${e?.message ?? e}`); process.exit(1); });
