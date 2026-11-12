import * as fs from 'fs';
import * as path from 'path';
import { bundleProducts } from '../services/bundler.service';
import { initVectorTagger } from '../services/vector-tagger.service';
import { pushToDatabase, PushResult } from '../cron/push-pipeline';
import type { BundledProduct } from '../parsers/types';
import { ADAPTERS } from './adapters';
import { LocalBrowser } from './core/browser';
import { HttpFetcher, RobotsDisallowedError, SiteBlockedError } from './core/http';
import type { CategoryTarget, CustomFetcher, CustomProduct, CustomSite, PlatformAdapter } from './core/types';
import { coverage, validateProduct } from './core/validate';
import type { CustomScraperConfig } from './custom.config';
import { CustomDbTarget, describeTarget, withCustomProductsCollection } from './custom.db';

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
}

export interface RunOptions {
  sites: CustomSite[];
  /** Only these category keys (any site) */
  categoryKeys?: string[];
  /** Overrides every category's limit */
  limit?: number;
  push?: CustomDbTarget;
  ai: boolean;
  outputDir: string;
  shouldStop: () => boolean;
}

export interface RunDeps {
  adapters: Record<CustomSite, PlatformAdapter>;
  fetcher?: CustomFetcher & { requests?: number; renders?: number; close?: () => Promise<void> };
  bundle: typeof bundleProducts;
  push: (bundles: BundledProduct[], target: CustomDbTarget) => Promise<PushResult>;
  now: () => Date;
}

const defaultPush = (bundles: BundledProduct[], target: CustomDbTarget) =>
  withCustomProductsCollection(target, collection => pushToDatabase(bundles, {
    collection,
    // Category/variant mapping is the backend's job; the custom scraper never calls an external service
    requestMapping: async () => ({ ok: true, message: 'not requested by the custom scraper' }),
  }));

export const defaultRunDeps: Omit<RunDeps, 'fetcher'> = {
  adapters: ADAPTERS,
  bundle: bundleProducts,
  push: defaultPush,
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

  if (opts.push && items.length) {
    if (opts.ai) {
      try { await initVectorTagger(); } catch (e: any) { console.warn(`[custom] AI tagging unavailable — base tags only: ${e.message}`); }
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
  }

  fs.writeFileSync(outputFile, JSON.stringify({ ...result, products: items, rejected }, null, 2));
  return result;
}
