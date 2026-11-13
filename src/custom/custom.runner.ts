import * as fs from 'fs';
import * as path from 'path';
import { bundleProducts } from '../services/bundler.service';
import { initVectorTagger } from '../services/vector-tagger.service';
import { pushToDatabase, PushResult, requestIngestMapping } from '../cron/push-pipeline';
import type { BundledProduct } from '../parsers/types';
import { ADAPTERS } from './adapters';
import { LocalBrowser } from './core/browser';
import { HttpFetcher, RobotsDisallowedError, samePage, SiteBlockedError } from './core/http';
import type { CategoryTarget, CustomFetcher, CustomProduct, CustomSite, PlatformAdapter } from './core/types';
import { coverage, validateProduct } from './core/validate';
import type { CustomScraperConfig } from './custom.config';
import { CustomDbTarget, describeTarget, withCustomProductsCollection } from './custom.db';
import { ImageRehoster, RehostStats, replaceStoredImageUrls } from './core/images-s3';

export interface ScrapedItem {
  site: CustomSite;
  category: string;
  broadCategory: string;
  subCategory: string;
  product: CustomProduct;
}

export interface Rejected { site: CustomSite; category: string; url: string; reasons: string[] }

export interface CategoryReport { key: string; wanted: number; candidates: number; valid: number; rejected: number; error?: string }

export type SiteStatus = 'complete' | 'partial' | 'failed' | 'blocked' | 'stopped';

export interface SiteReport {
  site: CustomSite;
  transport: PlatformAdapter['transport'];
  status: SiteStatus;
  valid: number;
  rejected: number;
  categories: CategoryReport[];
  coverage: Record<string, number>;
  reason?: string;
}

export interface CustomRunResult {
  startedAt: string;
  finishedAt: string;
  sites: SiteReport[];
  requests: { http: number; browserRenders: number };
  outputFile: string;
  push?: PushResult & { target: string; bundles: number };
  /** Image re-hosting on our S3/CDN (only with push + S3) */
  s3?: RehostStats & { storedDocumentsUpdated: number; storedImagesReplaced: number; storedImagesDropped: number };
}

export interface RunOptions {
  sites: CustomSite[];
  /** Only these category keys (any site) */
  categoryKeys?: string[];
  /** Overrides every category's limit */
  limit?: number;
  push?: CustomDbTarget;
  /** Re-host images on S3 before pushing (required for push unless explicitly skipped) */
  s3?: ImageRehoster;
  ai: boolean;
  outputDir: string;
  shouldStop: () => boolean;
}

export interface RunDeps {
  adapters: Record<CustomSite, PlatformAdapter>;
  fetcher?: CustomFetcher & { requests?: number; renders?: number; close?: () => Promise<void> };
  bundle: typeof bundleProducts;
  push: (bundles: BundledProduct[], target: CustomDbTarget) => Promise<PushResult>;
  replaceStoredImages: (mapping: Map<string, string>, target: CustomDbTarget, drop?: Set<string>) => Promise<{ documents: number; images: number; conflicts: number; dropped: number; keptLastImage: number }>;
  now: () => Date;
}

/**
 * Category / role / variant mapping is the backend's job. It is requested only when
 * CUSTOM_BACKEND_URL (+ CUSTOM_BACKEND_API_KEY) point at OUR backend — which must use the same
 * database the custom scraper writes to. Otherwise products stay pending for `ingest:apply-mapping`.
 */
export async function requestCustomMapping(env: NodeJS.ProcessEnv = process.env): Promise<{ ok: boolean; message: string; mapped?: number }> {
  const url = env.CUSTOM_BACKEND_URL?.trim();
  if (!url) return { ok: true, message: 'not requested (CUSTOM_BACKEND_URL not set) — run the backend ingest:apply-mapping' };
  return requestIngestMapping({ PEPPY_BE_URL: url.replace(/\/+$/, ''), SCRAPER_API_KEY: env.CUSTOM_BACKEND_API_KEY ?? '' });
}

const defaultPush = (bundles: BundledProduct[], target: CustomDbTarget) =>
  withCustomProductsCollection(target, collection => pushToDatabase(bundles, { collection, requestMapping: () => requestCustomMapping() }));

export const defaultRunDeps: Omit<RunDeps, 'fetcher'> = {
  adapters: ADAPTERS,
  bundle: bundleProducts,
  push: defaultPush,
  replaceStoredImages: (mapping, target, drop) => withCustomProductsCollection(target, col => replaceStoredImageUrls(col, mapping, new Date(), drop)),
  now: () => new Date(),
};

function makeFetcher(config: CustomScraperConfig) {
  const http = new HttpFetcher(config.http);
  const browser = new LocalBrowser(http, config.http.userAgent);
  return {
    get: (url: string, accept?: string) => http.get(url, accept),
    render: (url: string, waitMs?: number) => browser.render(url, waitMs ?? config.browserWaitMs),
    get requests() { return http.requests; },
    get renders() { return browser.renders; },
    close: () => browser.close(),
  };
}

async function scrapeCategory(
  adapter: PlatformAdapter, target: CategoryTarget, fetcher: CustomFetcher,
  seen: Set<string>, items: ScrapedItem[], rejected: Rejected[], opts: RunOptions, now: () => Date,
): Promise<CategoryReport> {
  const site = adapter.site;
  const report: CategoryReport = { key: target.key, wanted: target.limit, candidates: 0, valid: 0, rejected: 0 };
  const accept = (product: CustomProduct, url: string): void => {
    const id = product.sku ? `sku:${product.sku}` : `url:${product.productUrl ?? url}`;
    if (seen.has(id)) return; // already collected from another category this run
    const v = validateProduct(product);
    if (!v.ok) { report.rejected++; rejected.push({ site, category: target.key, url, reasons: v.reasons }); return; }
    seen.add(id);
    product.broadCategory = target.broadCategory;
    product.subCategory = target.subCategory;
    product.scrapedAt = now().toISOString();
    items.push({ site, category: target.key, broadCategory: target.broadCategory, subCategory: target.subCategory, product });
    report.valid++;
    console.log(`[custom:${site}] ✓ ${target.key}: ${(product.productName ?? url).slice(0, 60)} — AED ${product.price}`);
  };

  // Ask for spare candidates: some will be rejected or duplicates
  const discovery = await adapter.discover(target, target.limit * 2, fetcher);

  if (discovery.products) {
    report.candidates = discovery.products.length;
    for (let p of discovery.products) {
      if (report.valid >= target.limit || opts.shouldStop()) break;
      if (adapter.enrich && validateProduct(p).ok) {
        try { p = await adapter.enrich(p, fetcher); } catch (e: any) {
          if (e instanceof SiteBlockedError) throw e;
          console.warn(`[custom:${site}] enrich failed for ${p.productUrl}: ${e.message} — kept without it`);
        }
      }
      accept(p, p.productUrl ?? `${site}:unknown`);
    }
    return report;
  }

  const urls = discovery.urls ?? [];
  report.candidates = urls.length;
  for (const url of urls) {
    if (report.valid >= target.limit || opts.shouldStop()) break;
    try {
      const page = await fetcher.get(url);
      if (page.status !== 200) {
        report.rejected++;
        rejected.push({ site, category: target.key, url, reasons: [`HTTP ${page.status}`] });
        continue;
      }
      // A discontinued product often redirects to another product or a category page: its data
      // must not be stored under this URL
      if (!samePage(page.url, url)) {
        report.rejected++;
        rejected.push({ site, category: target.key, url, reasons: [`redirected to ${page.url}`] });
        continue;
      }
      accept(adapter.extract(page.body, url), url);
    } catch (e: any) {
      if (e instanceof SiteBlockedError) throw e;
      report.rejected++;
      rejected.push({ site, category: target.key, url, reasons: [e instanceof RobotsDisallowedError ? 'robots.txt disallows' : e.message] });
    }
  }
  return report;
}

export async function runCustomScrape(config: CustomScraperConfig, opts: RunOptions, deps: Partial<RunDeps> = {}): Promise<CustomRunResult> {
  const d: RunDeps = { ...defaultRunDeps, ...deps };
  const fetcher = d.fetcher ?? makeFetcher(config);
  const startedAt = d.now().toISOString();
  const items: ScrapedItem[] = [];
  const rejected: Rejected[] = [];
  const reports: SiteReport[] = [];

  try {
    for (const site of opts.sites) {
      const adapter = d.adapters[site];
      const targets = config.sites[site]
        .filter(t => !opts.categoryKeys?.length || opts.categoryKeys.includes(t.key))
        .map(t => (opts.limit ? { ...t, limit: opts.limit } : t));
      const report: SiteReport = { site, transport: adapter.transport, status: 'complete', valid: 0, rejected: 0, categories: [], coverage: {} };
      reports.push(report);
      if (!targets.length) { report.status = 'failed'; report.reason = 'no categories configured/selected'; continue; }

      console.log(`\n[custom:${site}] ${targets.length} categor${targets.length === 1 ? 'y' : 'ies'} via ${adapter.transport}`);
      const seen = new Set<string>();
      for (const target of targets) {
        if (opts.shouldStop()) { report.status = 'stopped'; report.reason = 'stop signal'; break; }
        try {
          report.categories.push(await scrapeCategory(adapter, target, fetcher, seen, items, rejected, opts, d.now));
        } catch (e: any) {
          if (e instanceof SiteBlockedError) { report.status = 'blocked'; report.reason = e.message; console.warn(`[custom:${site}] ${e.message} — skipping the rest of ${site}`); break; }
          report.categories.push({ key: target.key, wanted: target.limit, candidates: 0, valid: 0, rejected: 0, error: e.message });
          console.error(`[custom:${site}] ${target.key} failed: ${e.message}`);
        }
      }
      const siteItems = items.filter(i => i.site === site);
      report.valid = siteItems.length;
      report.rejected = rejected.filter(r => r.site === site).length;
      report.coverage = coverage(siteItems.map(i => i.product));
      // A stop noticed inside a category also ends the site as stopped, not as partial/complete
      if (report.status === 'complete' && opts.shouldStop()) { report.status = 'stopped'; report.reason = 'stop signal'; }
      if (report.status === 'complete') {
        const short = report.categories.some(c => c.valid < c.wanted);
        report.status = report.valid === 0 ? 'failed' : short ? 'partial' : 'complete';
      }
    }
  } finally {
    await fetcher.close?.();
  }

  const finishedAt = d.now().toISOString();
  fs.mkdirSync(opts.outputDir, { recursive: true });
  const outputFile = path.join(opts.outputDir, `custom_${startedAt.replace(/[:.]/g, '-')}.json`);
  const result: CustomRunResult = {
    startedAt, finishedAt, sites: reports,
    requests: { http: fetcher.requests ?? 0, browserRenders: fetcher.renders ?? 0 },
    outputFile,
  };
  const save = () => fs.writeFileSync(outputFile, JSON.stringify({ ...result, products: items, rejected }, null, 2));
  // Saved before any database work, so a failed push never loses what was scraped
  save();

  if (opts.push && items.length) {
    if (opts.ai) {
      try { await initVectorTagger(); } catch (e: any) { console.warn(`[custom] AI tagging unavailable — base tags only: ${e.message}`); }
    }
    if (opts.s3) {
      console.log(`\n[custom:s3] Re-hosting images of ${items.length} products on S3...`);
      for (const it of items) {
        it.product.imageUrls = await opts.s3.rehostAll(it.product.imageUrls);
        it.product.imageUrl = it.product.imageUrls[0] ?? null;
      }
      // Like dining: failed images are dropped. A product left without any image is not saved.
      const noImage = items.filter(it => !it.product.imageUrls.length);
      for (const it of noImage) {
        rejected.push({ site: it.site, category: it.category, url: it.product.productUrl ?? "", reasons: ["no image could be uploaded to S3 (retried next run)"] });
        const s = result.sites.find(x => x.site === it.site);
        if (s) { s.valid--; s.rejected++; }
      }
      for (let i = items.length - 1; i >= 0; i--) if (!items[i].product.imageUrls.length) items.splice(i, 1);
      console.log(`[custom:s3] ${opts.s3.stats.uploaded} uploaded, ${opts.s3.stats.alreadyOwn} already on S3, ${opts.s3.stats.failed} failed (dropped)${noImage.length ? `; ${noImage.length} product(s) skipped — no image left` : ''}`);
    }
    if (!items.length) {
      console.log('[custom:s3] Nothing to push — no product kept an image.');
      result.s3 = { ...opts.s3!.stats, storedDocumentsUpdated: 0, storedImagesReplaced: 0, storedImagesDropped: 0 };
      save();
      return result;
    }
    // Bundle per taxonomy slot so the bundler's category tags apply; cross-retailer matches merge here
    const groups = new Map<string, ScrapedItem[]>();
    for (const it of items) {
      const k = `${it.broadCategory}|${it.subCategory}`;
      groups.set(k, [...(groups.get(k) ?? []), it]);
    }
    const bundles: BundledProduct[] = [];
    for (const group of groups.values()) {
      const { broadCategory, subCategory } = group[0];
      bundles.push(...await d.bundle(group.map(g => ({ site: g.site, data: g.product })), subCategory, broadCategory, subCategory));
    }
    const target = describeTarget(opts.push);
    console.log(`\n[custom] Pushing ${items.length} products as ${bundles.length} bundles → ${target}`);
    const pushed = await d.push(bundles, opts.push);
    result.push = { ...pushed, target, bundles: bundles.length };
    if (opts.s3) {
      // Existing documents keep their stored images on merge — swap the retailer URLs re-hosted this run
      const none = { documents: 0, images: 0, conflicts: 0, dropped: 0, keptLastImage: 0 };
      const swapped = opts.s3.mapping.size || opts.s3.permanentFailures.size
        ? await d.replaceStoredImages(opts.s3.mapping, opts.push, opts.s3.permanentFailures) : none;
      if (swapped.documents) console.log(`[custom:s3] ${swapped.images} stored image URL(s) switched to S3, ${swapped.dropped} dead one(s) removed, on ${swapped.documents} existing document(s)`);
      result.s3 = { ...opts.s3.stats, storedDocumentsUpdated: swapped.documents, storedImagesReplaced: swapped.images, storedImagesDropped: swapped.dropped };
    }
  }

  save();
  return result;
}
