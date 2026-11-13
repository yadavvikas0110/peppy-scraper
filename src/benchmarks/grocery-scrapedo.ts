/**
 * Scrape.do vs Bright Data — grocery benchmark (dev DB only).
 *
 * Runs the EXISTING grocery collectors/parsers with Scrape.do as the transport instead of Bright Data,
 * on a small sample, and measures every request: time, credits (Scrape.do-Request-Cost header),
 * success/block, bytes, products parsed. Bright Data's numbers come from its previous run already in
 * dev (`grocery_products`), compared offer-by-offer (externalId).
 *
 * Per platform it climbs an option ladder (cheapest first) and keeps the first option that returns a
 * usable page:  plain → geoCode=ae → super+ae → render+ae (Noon starts at render; it is a location-gated SPA).
 *
 * No duplicate products: Talabat is crawled for ONE store (stores share the catalogue) and the crawl
 * dedupes by SKU; Deliveroo/Noon collectors dedupe by SKU across pages.
 *
 *   node --env-file=.env.benchmark -r ts-node/register src/benchmarks/grocery-scrapedo.ts [--platform deliveroo,talabat,noon] [--budget 350] [--no-push]
 */
import * as fs from 'fs';
import * as path from 'path';
import { MongoClient } from 'mongodb';
import { createScrapeDoClient } from '../shared/scrapedo/scrapedo.client';
import type { ScrapeDoRequestOptions } from '../shared/scrapedo/scrapedo.types';
import { assertSafeWriteTarget, redactMongoUri } from '../shared/db/mongo';
import { collectDeliverooGrocery } from '../grocery/deliveroo-grocery.collector';
import { DELIVEROO_PILOT_STORES, DELIVEROO_RETAILER_ID } from '../grocery/deliveroo-grocery.config';
import { collectNoonMinutes } from '../grocery/noon-minutes.collector';
import { NOON_MINUTES_RETAILER_ID, NOON_PRODUCT_READY_SELECTOR } from '../grocery/noon-minutes.config';
import { crawlTalabatGrocery } from '../grocery/grocery-crawl';
import { resolveDubaiAreas } from '../grocery/talabat-grocery.config';
import { pushGroceryToDatabase } from '../grocery/db/grocery-push';
import { fetchScrapeDoAccountInfo } from '../dining/bulk/bulk.credits';

const remaining = async () => (await fetchScrapeDoAccountInfo())?.remainingMonthlyRequest ?? NaN;

type Platform = 'deliveroo' | 'talabat' | 'noon';
const RETAILER: Record<Platform, string> = { deliveroo: DELIVEROO_RETAILER_ID, talabat: 'talabat', noon: NOON_MINUTES_RETAILER_ID };

interface Rung { label: string; options: ScrapeDoRequestOptions }
const LADDER: Record<Platform, Rung[]> = {
  deliveroo: [
    { label: 'plain', options: {} },
    { label: 'geo-ae', options: { geoCode: 'ae' } },
    { label: 'super+ae', options: { super: true, geoCode: 'ae' } },
    { label: 'render+ae', options: { render: true, geoCode: 'ae' } },
  ],
  talabat: [
    { label: 'plain', options: {} },
    { label: 'geo-ae', options: { geoCode: 'ae' } },
    { label: 'super+ae', options: { super: true, geoCode: 'ae' } },
    { label: 'render+ae', options: { render: true, geoCode: 'ae' } },
  ],
  noon: [
    { label: 'render+ae', options: { render: true, geoCode: 'ae', waitSelector: NOON_PRODUCT_READY_SELECTOR, customWait: 3000 } },
    { label: 'render+super+ae', options: { render: true, super: true, geoCode: 'ae', waitSelector: NOON_PRODUCT_READY_SELECTOR, customWait: 3000 } },
  ],
};

/** A page is usable when it carries the data the parser reads (not a block / consent / empty shell). */
const USABLE: Record<Platform, (html: string) => boolean> = {
  deliveroo: h => h.includes('__NEXT_DATA__') && h.includes('menuPage'),
  talabat: h => h.includes('__NEXT_DATA__') && h.length > 20_000,
  noon: h => h.includes('/now-product/'),
};

interface RequestLog {
  platform: Platform; url: string; rung: string; ok: boolean; status?: number; credits: number;
  ms: number; bytes: number; error?: string;
}

class BudgetExceeded extends Error {}

function makeFetcher(platform: Platform, budget: { limit: number; used: number }, log: RequestLog[]) {
  const client = createScrapeDoClient({ logger: { log: () => {}, warn: () => {}, error: () => {} } as any });
  let level = 0; // learned rung — once a rung works it is kept for the rest of the platform
  return async (url: string): Promise<string> => {
    for (let i = level; i < LADDER[platform].length; i++) {
      const rung = LADDER[platform][i];
      if (budget.used >= budget.limit) throw new BudgetExceeded(`credit budget ${budget.limit} reached`);
      const t0 = Date.now();
      try {
        const res = await client.fetchHtml(url, { ...rung.options, timeout: 60_000, client: { maxRetries: 1 } });
        const credits = res.requestCost ?? 0;
        budget.used += credits;
        const ok = USABLE[platform](res.html);
        log.push({ platform, url, rung: rung.label, ok, status: res.statusCode, credits, ms: Date.now() - t0, bytes: Buffer.byteLength(res.html) });
        console.log(`[bench:${platform}] ${ok ? 'OK ' : 'BAD'} ${rung.label.padEnd(16)} ${String(credits).padStart(2)} cr ${String(Date.now() - t0).padStart(6)} ms  ${url.slice(0, 110)}`);
        if (ok) { level = i; return res.html; }
      } catch (e: any) {
        const credits = Number(e?.requestCost ?? 0) || 0;
        budget.used += credits;
        log.push({ platform, url, rung: rung.label, ok: false, status: e?.statusCode, credits, ms: Date.now() - t0, bytes: 0, error: String(e?.message ?? e).slice(0, 200) });
        console.log(`[bench:${platform}] ERR ${rung.label.padEnd(16)} ${String(Date.now() - t0).padStart(6)} ms  ${String(e?.message ?? e).slice(0, 120)}`);
      }
    }
    throw new Error(`no Scrape.do option returned a usable page: ${url}`);
  };
}

interface Snapshot { price: number; stock: string | null; name: string }
async function snapshotOffers(uri: string, dbName: string, retailerId: string): Promise<Map<string, Snapshot>> {
  const c = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
  await c.connect();
  try {
    const docs = await c.db(dbName).collection('grocery_products')
      .find({ 'retailers.retailerId': retailerId }).project({ name: 1, retailers: 1 }).toArray();
    const m = new Map<string, Snapshot>();
    for (const d of docs) for (const r of d.retailers ?? []) {
      if (r.retailerId === retailerId && r.externalId) m.set(String(r.externalId), { price: r.price, stock: r.stockStatus ?? null, name: d.name });
    }
    return m;
  } finally { await c.close(); }
}

async function touchedOffers(uri: string, dbName: string, retailerId: string, since: Date) {
  const c = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
  await c.connect();
  try {
    const docs = await c.db(dbName).collection('grocery_products')
      .find({ retailers: { $elemMatch: { retailerId, lastSeenAt: { $gte: since } } } }).project({ name: 1, images: 1, retailers: 1, category: 1, subcategory: 1 }).toArray();
    return docs.map(d => ({ d, r: (d.retailers ?? []).find((x: any) => x.retailerId === retailerId) }));
  } finally { await c.close(); }
}

async function main() {
  const arg = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
  const platforms = (arg('--platform') ?? 'deliveroo,talabat,noon').split(',') as Platform[];
  const budget = { limit: Number(arg('--budget') ?? 350), used: 0 };
  const push = !process.argv.includes('--no-push');
  if (process.env.BRIGHT_DATA_API_KEY || process.env.BRIGHT_DATA_BROWSER_AUTH) throw new Error('Bright Data variables must be empty for this benchmark');
  const { uri, dbName } = assertSafeWriteTarget(); // refuses prod-named databases
  if (dbName !== 'dev') throw new Error(`benchmark writes only to the dev database (got "${dbName}")`);

  const info = await remaining();
  console.log(`[bench] target ${dbName}.grocery_products · budget ${budget.limit} credits · push ${push} · remaining credits before: ${info}`);
  if (!(info > 0)) throw new Error('Scrape.do account has no remaining credits (or /info unreadable)');

  const log: RequestLog[] = [];
  const report: any = { startedAt: new Date().toISOString(), db: dbName, budget: budget.limit, platforms: {} };

  for (const p of platforms) {
    const retailerId = RETAILER[p];
    const before = await snapshotOffers(uri, dbName, retailerId);
    const fetchHtml = makeFetcher(p, budget, log);
    const creditsBefore = await remaining();
    const startedAt = new Date();
    const t0 = Date.now();
    let products = 0;
    let pushRes: any = null;
    let error: string | undefined;
    console.log(`\n[bench] ── ${p} ── (Bright Data previous run: ${before.size} offers in dev)`);
    try {
      if (p === 'deliveroo') {
        const r = await collectDeliverooGrocery(DELIVEROO_PILOT_STORES, { fetchHtml, max: 100_000 });
        products = r.bundles.length;
        if (push && r.bundles.length) pushRes = await pushGroceryToDatabase(r.bundles);
      } else if (p === 'noon') {
        const r = await collectNoonMinutes({ fetchHtml, max: Number(arg('--noon-pages') ?? 5) });
        products = r.bundles.length;
        if (push && r.bundles.length) pushRes = await pushGroceryToDatabase(r.bundles);
      } else {
        const pushedLines: string[] = [];
        const logger = { log: (m: string) => { if (/pushed batch/.test(m)) pushedLines.push(m); console.log(m); }, warn: console.warn, error: console.error };
        const prog = await crawlTalabatGrocery({ areas: resolveDubaiAreas().slice(0, 1), maxStores: 1, maxRequests: Number(arg('--talabat-requests') ?? 25), fetchHtml, dryRun: !push, logger: logger as any });
        products = prog.itemsSeen;
        const sum = (re: RegExp) => pushedLines.reduce((a, l) => a + Number(re.exec(l)?.[1] ?? 0), 0);
        pushRes = { mongoInserted: sum(/(\d+) new/), mongoUpdated: sum(/(\d+) updated/), crawl: prog };
      }
    } catch (e: any) { error = e?.message ?? String(e); console.error(`[bench:${p}] ${error}`); }
    const wallMs = Date.now() - t0;
    const creditsAfter = await remaining();

    // Compare with Bright Data's previous data (same parser → same externalId)
    const touched = push ? await touchedOffers(uri, dbName, retailerId, startedAt) : [];
    let overlap = 0, samePrice = 0, sameStock = 0;
    const priceDiffs: Array<{ name: string; bd: number; sd: number }> = [];
    for (const { d, r } of touched) {
      const prev = r?.externalId ? before.get(String(r.externalId)) : undefined;
      if (!prev) continue;
      overlap++;
      if (Math.abs(prev.price - r.price) < 0.005) samePrice++; else if (priceDiffs.length < 10) priceDiffs.push({ name: d.name, bd: prev.price, sd: r.price });
      if (prev.stock === (r.stockStatus ?? null)) sameStock++;
    }
    const cdn = (process.env.CDN_URL ?? '').replace(/\/+$/, '');
    const reqs = log.filter(l => l.platform === p);
    const okReqs = reqs.filter(l => l.ok);
    report.platforms[p] = {
      error,
      wallSeconds: Math.round(wallMs / 1000),
      requests: reqs.length, usableResponses: okReqs.length,
      credits: creditsBefore - creditsAfter, // authoritative: Scrape.do account counter (/info, free)
      creditsFromHeaders: reqs.reduce((a, l) => a + l.credits, 0),
      winningOption: okReqs[0]?.rung ?? null,
      avgMsPerUsableRequest: okReqs.length ? Math.round(okReqs.reduce((a, l) => a + l.ms, 0) / okReqs.length) : null,
      avgKbPerPage: okReqs.length ? Math.round(okReqs.reduce((a, l) => a + l.bytes, 0) / okReqs.length / 1024) : null,
      productsParsed: products,
      productsPerUsablePage: okReqs.length ? +(products / okReqs.length).toFixed(1) : null,
      push: pushRes ? { inserted: pushRes.mongoInserted, updated: pushRes.mongoUpdated, errors: pushRes.errors ?? [] } : null,
      coverage: touched.length ? {
        offers: touched.length,
        price: touched.filter(t => t.r?.price > 0).length,
        stockKnown: touched.filter(t => t.r?.stockStatus && t.r.stockStatus !== 'unknown').length,
        imagesOnS3: touched.filter(t => (t.d.images ?? []).length && t.d.images.every((u: string) => cdn && u.startsWith(cdn))).length,
        category: touched.filter(t => t.d.category).length,
      } : null,
      vsBrightData: { bdOffersInDev: before.size, overlapWithBd: overlap, samePrice, sameStock, priceDiffSample: priceDiffs },
    };
    console.log(`[bench] ${p}: ${JSON.stringify(report.platforms[p])}`);
    if (error && /budget/.test(error)) break;
  }

  report.creditsUsed = info - (await remaining());
  report.finishedAt = new Date().toISOString();
  report.requests = log;
  const dir = path.join(process.cwd(), 'output', 'benchmarks');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `grocery-scrapedo_${report.startedAt.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`\n[bench] credits used: ${report.creditsUsed} · report: ${file}`);
}

main().catch(e => { console.error(`[bench] ${redactMongoUri(String(e?.message ?? e), process.env.MONGODB_URI ?? '')}`); process.exit(1); });
