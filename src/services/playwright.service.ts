import * as fs from 'fs';
import * as path from 'path';
import { ProductData, BundledProduct } from '../parsers/types';
import {
  scrapeProductBD,
  fetchHTMLViaUnlocker,
  fetchHTMLViaBrowser,
  closeBrowserPool,
  resetBrowser,
  isAccessDeniedError,
  isProviderAuthError,
} from './brightdata.service';
import { SITES, SiteKey } from '../config/sites';
import { bundleProducts, MatchReview } from './bundler.service';
import {
  buildJobId,
  loadCheckpoint,
  saveCheckpoint,
  deleteCheckpoint,
  CheckpointData,
} from './checkpoint.service';
import { partitionSites, UnsupportedSitesError } from '../config/transport-policy';
import { initVectorTagger } from './vector-tagger.service';
import { connectChroma, isChromaAvailable } from './chroma.service';
import { collectShopifyProducts } from './shopify.service';
import { shouldStop } from '../utils/stop-signal';
import { fetchListingViaScrapeDo, scrapeDoEnabledFor, scrapeDoEnabledForUrl, scrapeProductViaScrapeDo } from './scrapedo-transport';

export { closeBrowserPool as closeBrowser };

const STATIC_SEARCH_HOSTS = /amazon\.ae/;
const PRODUCT_LINK_SELECTORS = ['a[href*="/dp/"]', 'a[href*="/p/"]', 'a[data-pjax][href*="/product/"]'].join(', ');

// Errors that retrying cannot fix: routing failures, timeouts, Bright Data access refusals
const NO_RETRY_RE = /no_peer|probe_timeout|a2a_tun_open|a2a_exception|ERR_TUNNEL_CONNECTION_FAILED|Timeout \d+ms exceeded|Host blocked by Bright Data/i;

function isNonRetryable(message: string): boolean {
  return NO_RETRY_RE.test(message) || isAccessDeniedError(message) || isProviderAuthError(message) || /Scrape\.do account problem/.test(message);
}

// Anti-bot interstitials (Akamai, Cloudflare, captchas) — the site refused this session,
// which is not the same as an empty listing page
const BLOCK_PAGE_TITLE_RE = /^\s*(access denied|attention required|just a moment|are you a robot|pardon our interruption|request blocked|captcha)/i;

export function isBlockPage(html: string): boolean {
  const title = html.match(/<title[^>]*>([^<]*)/i)?.[1] ?? '';
  return BLOCK_PAGE_TITLE_RE.test(title) || (html.length < 3000 && /errors\.edgesuite\.net|cf-chl-|captcha-delivery/i.test(html));
}

// Shared by concurrent queries so the tagger and Chroma are initialised only once
let taggerInit: Promise<void> | null = null;

function ensureTagger(): Promise<void> {
  return taggerInit ??= (async () => {
    // Tagging is optional: an OpenAI failure (e.g. no credits) must not stop scraping
    try {
      await initVectorTagger();
    } catch (e: any) {
      console.warn(`[vector-tagger] Init failed — continuing with base tags only: ${e.message}`);
    }
    if (isChromaAvailable()) {
      try {
        await connectChroma();
      } catch (e: any) {
        console.warn(`[chroma] Connection failed — vector store disabled: ${e.message}`);
      }
    }
  })();
}

// Embeddings are 1536 floats per bundle — keep them out of files written to disk
export function withoutEmbeddings(bundles: BundledProduct[]): BundledProduct[] {
  return bundles.map(({ embedding, ...rest }) => rest);
}

export interface SearchFetchContext {
  /** 1-based listing page number */
  page?: number;
}

async function fetchSearchHTML(url: string, ctx: SearchFetchContext = {}): Promise<string> {
  // Platforms switched to Scrape.do (SCRAPE_DO_SITES) use its profiles and retry rules instead
  if (scrapeDoEnabledForUrl(url)) return fetchListingViaScrapeDo(url, undefined, { allowEmpty: (ctx.page ?? 1) > 1 });
  const hostname = new URL(url).hostname;
  const isAmazon = STATIC_SEARCH_HOSTS.test(hostname);

  let lastErr: Error = new Error('unknown');
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const html = isAmazon
        ? await fetchHTMLViaUnlocker(url)
        : await fetchHTMLViaBrowser(url, PRODUCT_LINK_SELECTORS, 10000);

      if (isAmazon) {
        const hasTitle = /<title[^>]*>[^<]+/i.test(html);
        const hasProducts = html.includes('/dp/');
        if (!hasTitle || (!hasProducts && html.length < 5000)) {
          const delay = 8000 * Math.pow(2, attempt);
          console.warn(`[amazon-search] Blocked/empty response (attempt ${attempt + 1}) — waiting ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
      }

      // A fresh session usually gets a different exit IP, so retrying a block page can succeed
      if (isBlockPage(html)) {
        resetBrowser(url);
        throw new Error(`Blocked by site anti-bot page ("${html.match(/<title[^>]*>([^<]*)/i)?.[1]?.trim()}")`);
      }

      return html;
    } catch (e: any) {
      lastErr = e;
      if (isNonRetryable(e.message)) break;
      if (/domain limit/i.test(e.message)) resetBrowser(url);
      if (attempt < 3) {
        const delay = 3000 * Math.pow(2, attempt);
        console.warn(`[search] Attempt ${attempt + 1} failed (${e.message.split('\n')[0]}) — retrying in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

class IncompletePageError extends Error {}

// scrapeProductBD already retries network/browser errors internally. This loop only
// re-fetches pages that loaded but rendered incompletely, so paid attempts don't multiply.
export async function scrapeProductWithRetry(url: string): Promise<ProductData> {
  // Scrape.do path validates the page with our parser and escalates options itself — no re-fetch loop
  if (scrapeDoEnabledForUrl(url)) return scrapeProductViaScrapeDo(url);
  let lastErr: Error = new Error('unknown');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const data = await scrapeProductBD(url);
      if (data.productName == null && data.price == null) {
        throw new IncompletePageError('blank data — page may not have rendered correctly');
      }
      const hasImage = !!data.imageUrl || (data.imageUrls?.length ?? 0) > 0;
      if (!hasImage) {
        throw new IncompletePageError('no image — will retry');
      }
      return data;
    } catch (e: any) {
      lastErr = e;
      if (!(e instanceof IncompletePageError)) break;
      if (attempt < 2) {
        const delay = 3000 * Math.pow(2, attempt);
        console.warn(`[retry ${attempt + 1}] ${url}: ${e.message} (waiting ${delay}ms)`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// ─── Per-site outcome ─────────────────────────────────────────────────────────

/**
 * complete    — links were collected and at least one product was scraped
 * failed      — the site produced no products (search failed, empty listing, every page failed)
 * unsupported — no authorized data source (transport policy, or Bright Data refused the host)
 * stopped     — a stop signal interrupted the site; its checkpoint is kept for resume
 */
export type SiteStatus = 'complete' | 'failed' | 'unsupported' | 'stopped';
export type JobStatus = 'complete' | 'partial' | 'failed' | 'stopped';

export interface SiteOutcome {
  site: SiteKey;
  status: SiteStatus;
  scraped: number;
  failed: number;
  /** Links not scraped because the product was observed recently (deps.shouldSkipUrl) */
  skipped?: number;
  /** Product links collected for this run */
  links?: number;
  /** Links left unscraped because the platform was paused (kept in the checkpoint for the next run) */
  pending?: number;
  reason?: string;
}

/**
 * Errors that mean "stop now, resume later" rather than "this product failed": the daily budget,
 * or a Scrape.do account problem (credits used up, token revoked) — every further page would fail
 * the same way, so the rest of the links stay unscraped for a resume instead of being marked failed.
 */
export function isStopError(e: any): boolean {
  return e?.name === 'BudgetExhaustedError' || e?.name === 'ScrapeDoAccountError';
}

/**
 * The platform's circuit breaker is open (too many failed pages in a row): stop this site only.
 * Its remaining links are left pending — not failed — and other sites keep going.
 */
export function isPauseError(e: any): boolean {
  return e?.name === 'ScrapeDoCircuitOpenError';
}

export function isAccessRefusal(message: string): boolean {
  return /Host blocked by Bright Data/i.test(message) || isAccessDeniedError(message);
}

/** Network-facing operations, injectable so job status logic can be tested offline. */
export interface BulkScrapeDeps {
  scrapeProduct(url: string): Promise<ProductData>;
  fetchSearchHtml(url: string, ctx?: SearchFetchContext): Promise<string>;
  collectShopify(hostname: string, category: string, count: number): Promise<ProductData[]>;
  bundle: typeof bundleProducts;
  shouldStop(): boolean;
  ensureTagger(): Promise<void>;
  now(): Date;
  outputDir: string;
  env: NodeJS.ProcessEnv;
  /** Optional: skip links whose product is still fresh (counted as skipped, not scraped) */
  shouldSkipUrl?: (site: SiteKey, url: string) => boolean;
  /** Product pages fetched at once per site (default 1). The transport's own limiter still applies. */
  productConcurrency?: number;
  /**
   * With shouldSkipUrl: fresh links do not count toward `count` while collecting — pagination continues
   * (up to maxListingPages) until `count` links that need scraping are found. Repeat runs then discover
   * new products instead of paying again for the same first page of products.
   */
  discoverPastFresh?: boolean;
  /** Listing pages per site per job when discoverPastFresh is on (default 15) */
  maxListingPages?: number;
}

export const defaultBulkScrapeDeps: BulkScrapeDeps = {
  scrapeProduct: scrapeProductWithRetry,
  fetchSearchHtml: fetchSearchHTML,
  collectShopify: collectShopifyProducts,
  bundle: bundleProducts,
  shouldStop,
  ensureTagger,
  now: () => new Date(),
  get outputDir() { return process.env.SCRAPER_OUTPUT_DIR || path.join(process.cwd(), 'output'); },
  get env() { return process.env; },
  get productConcurrency() { return Math.max(1, Math.floor(Number(process.env.SCRAPE_PRODUCT_CONCURRENCY) || 1)); },
};

interface ScrapeOneSiteOptions {
  site: SiteKey;
  category: string;
  categoryKey?: string;
  broadCategory: string;
  subCategory: string;
  count: number;
  checkpoint: CheckpointData;
}

async function scrapeOneSite(opts: ScrapeOneSiteOptions, deps: BulkScrapeDeps): Promise<SiteOutcome> {
  const { site, category, categoryKey, broadCategory, subCategory, count, checkpoint } = opts;
  const siteConfig = SITES[site];
  const scrapedCount = () => checkpoint.scraped.filter(s => s.site === site).length;
  const stamp = (data: ProductData) => {
    data.broadCategory = broadCategory;
    data.subCategory = subCategory;
    data.scrapedAt = deps.now().toISOString();
  };

  // Use category browse URL if the site defines one for this categoryKey
  const categoryUrlBuilder = categoryKey && siteConfig.categories?.[categoryKey]
    ? siteConfig.categories[categoryKey]
    : null;

  // Shopify stores: fetch all product data via /products.json — no individual scraping
  if (siteConfig.shopify) {
    const alreadyDone = scrapedCount();
    if (alreadyDone > 0) {
      console.log(`[${site}] Shopify — resuming, ${alreadyDone} products already in checkpoint.`);
      return { site, status: 'complete', scraped: alreadyDone, failed: 0 };
    }
    console.log(`[${site}] Shopify — fetching via /products.json...`);
    try {
      const products = await deps.collectShopify(siteConfig.hostname, category, count);
      for (const data of products) {
        stamp(data);
        checkpoint.scraped.push({ site, url: data.productUrl || `${site}:unknown`, data });
      }
      saveCheckpoint(checkpoint);
      console.log(`[${site}] Shopify — ${products.length} products collected.`);
      return products.length > 0
        ? { site, status: 'complete', scraped: products.length, failed: 0 }
        : { site, status: 'failed', scraped: 0, failed: 0, reason: 'Shopify returned no products' };
    } catch (e: any) {
      console.error(`[${site}] Shopify fetch failed: ${e.message}`);
      return { site, status: 'failed', scraped: 0, failed: 0, reason: `Shopify fetch failed: ${e.message}` };
    }
  }

  // Links passed over while collecting because their product is still fresh (discoverPastFresh)
  const skippedFresh = new Set<string>();
  if (!checkpoint.links[site]) {
    let allLinks: string[];
    let searchError: string | undefined;
    const deeper = !!deps.shouldSkipUrl && !!deps.discoverPastFresh;
    const maxPages = deeper ? Math.max(1, deps.maxListingPages ?? 15) : Infinity;

    const useCollector = !!siteConfig.collectLinks && !(siteConfig.listingPagesOnScrapeDo && scrapeDoEnabledFor(site, deps.env));
    if (useCollector && siteConfig.collectLinks) {
      console.log(`[${site}] Collecting links via custom collector...`);
      allLinks = await siteConfig.collectLinks(category, count);
    } else {
      const collectedLinks = new Set<string>();
      let pageNum = 1;

      while (collectedLinks.size < count) {
        if (pageNum > maxPages) {
          console.log(`[${site}] Reached ${maxPages} listing pages — ${collectedLinks.size} new, ${skippedFresh.size} still fresh.`);
          break;
        }
        if (deps.shouldStop()) {
          return { site, status: 'stopped', scraped: 0, failed: 0, reason: 'stop signal during link collection' };
        }
        const searchUrl = categoryUrlBuilder
          ? categoryUrlBuilder(pageNum)
          : siteConfig.buildSearchUrl(category, pageNum);
        console.log(`[${site}] Fetching page ${pageNum}: ${searchUrl}`);

        let pageHtml: string;
        try {
          pageHtml = await deps.fetchSearchHtml(searchUrl, { page: pageNum });
        } catch (e: any) {
          if (isStopError(e)) {
            return { site, status: 'stopped', scraped: 0, failed: 0, reason: e.message };
          }
          searchError = e.message;
          console.error(`[${site}] Search page ${pageNum} failed: ${e.message}`);
          break;
        }

        const newLinks = siteConfig.parseSearchLinks(pageHtml, searchUrl);
        console.log(`[${site}] Page ${pageNum} → ${newLinks.length} links`);

        if (newLinks.length === 0) {
          const title = pageHtml.match(/<title[^>]*>([^<]*)/i)?.[1] ?? 'unknown';
          console.log(`[${site}] Empty page — title: "${title}". Stopping pagination.`);
          break;
        }

        const prevSize = collectedLinks.size;
        const prevFresh = skippedFresh.size;
        for (const link of newLinks) {
          if (collectedLinks.size >= count) break;
          if (deeper && !collectedLinks.has(link) && deps.shouldSkipUrl!(site, link)) { skippedFresh.add(link); continue; }
          collectedLinks.add(link);
        }

        // All returned links were already seen — pagination exhausted
        if (collectedLinks.size === prevSize && skippedFresh.size === prevFresh) {
          console.log(`[${site}] Page ${pageNum} returned only duplicates — stopping pagination.`);
          break;
        }

        pageNum++;
        await new Promise(r => setTimeout(r, 300 + Math.random() * 300));
      }

      allLinks = Array.from(collectedLinks).slice(0, count);
    }

    console.log(`[${site}] Collected ${allLinks.length}/${count} links.`);

    if (allLinks.length === 0 && skippedFresh.size > 0) {
      console.log(`[${site}] Every product found (${skippedFresh.size}) was scraped recently — nothing to pay for.`);
      return { site, status: 'complete', scraped: 0, failed: 0, skipped: skippedFresh.size, links: 0, reason: 'all products still fresh' };
    }
    if (allLinks.length === 0) {
      const reason = searchError ? `search failed: ${searchError}` : 'no product links found';
      console.warn(`[${site}] No links collected — ${reason}.`);
      return { site, status: searchError && isAccessRefusal(searchError) ? 'unsupported' : 'failed', scraped: 0, failed: 0, reason };
    }

    checkpoint.links[site] = allLinks;
    saveCheckpoint(checkpoint);
  } else {
    console.log(`[${site}] Resuming — ${checkpoint.links[site]!.length} links from checkpoint.`);
  }

  const allLinks = checkpoint.links[site]!;
  const alreadyDone = new Set(
    checkpoint.scraped.filter(s => s.site === site).map(s => s.url)
  );
  const alreadyFailed = new Set(checkpoint.failed.map(f => f.url));
  const notDone = allLinks.filter(l => !alreadyDone.has(l) && !alreadyFailed.has(l));
  const remaining = deps.shouldSkipUrl ? notDone.filter(l => !deps.shouldSkipUrl!(site, l)) : notDone;
  const skipped = notDone.length - remaining.length + skippedFresh.size;

  console.log(`[${site}] Scraping ${remaining.length} remaining (${alreadyDone.size} already done, ${skipped} still fresh — skipped)...`);

  const concurrency = Math.max(1, Math.floor(deps.productConcurrency ?? 1));
  const run = { halt: null as null | 'stop' | 'pause', reason: 'stop signal' };
  let refusal: string | undefined;
  let next = 0;

  // A small worker pool: each worker takes the next link until the list is done or the site halts.
  // Results are recorded as they arrive, so a crash loses at most the pages in flight.
  const worker = async () => {
    while (!run.halt) {
      if (deps.shouldStop()) {
        if (!run.halt) console.log(`[${site}] Stop signal — aborting; progress kept in checkpoint.`);
        run.halt ??= 'stop';
        return;
      }
      const link = remaining[next++];
      if (link === undefined) return;
      try {
        const data = await deps.scrapeProduct(link);
        stamp(data);
        checkpoint.scraped.push({ site, url: link, data });
        saveCheckpoint(checkpoint);
        console.log(`[${site}] ✓ ${(data.productName || link).slice(0, 60)}`);
      } catch (e: any) {
        if (isStopError(e) || isPauseError(e)) {
          // Not this product's fault — leave it unscraped so a resume picks it up
          if (!run.halt) {
            run.halt = isStopError(e) ? 'stop' : 'pause';
            run.reason = e.message;
            console.warn(`[${site}] ${e.message} — ${run.halt === 'stop' ? 'stopping' : 'pausing this site'}; progress kept in checkpoint.`);
          }
          return;
        }
        checkpoint.failed.push({ url: link, message: e.message });
        saveCheckpoint(checkpoint);
        console.error(`[${site}] ✗ ${link}: ${e.message}`);
        if (isAccessRefusal(e.message)) refusal ??= e.message;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, remaining.length) }, worker));

  const ok = scrapedCount();
  const fail = checkpoint.failed.filter(f => allLinks.includes(f.url)).length;
  const handled = new Set([...checkpoint.scraped.filter(s => s.site === site).map(s => s.url), ...checkpoint.failed.map(f => f.url)]);
  const pending = remaining.filter(l => !handled.has(l)).length;
  console.log(`[${site}] Done: ${ok} ok, ${fail} errors${pending ? `, ${pending} pending` : ''}.`);
  const counts = { scraped: ok, failed: fail, skipped, links: allLinks.length };
  if (run.halt === 'stop') return { site, status: 'stopped', ...counts, pending, reason: run.reason };
  if (run.halt === 'pause') {
    const reason = `paused: ${run.reason} (${pending} link(s) left for the next run)`;
    return ok > 0 ? { site, status: 'complete', ...counts, pending, reason } : { site, status: 'failed', ...counts, pending, reason };
  }
  // Every link still fresh is a successful no-op, not a failure
  if (ok > 0 || (skipped > 0 && fail === 0)) return { site, status: 'complete', ...counts };
  if (refusal) return { site, status: 'unsupported', ...counts, reason: refusal };
  return { site, status: 'failed', ...counts, reason: `all ${fail} product page(s) failed` };
}

export function jobStatusOf(outcomes: SiteOutcome[]): JobStatus {
  if (outcomes.some(o => o.status === 'stopped')) return 'stopped';
  // A site paused with links left (circuit breaker) is not complete, even though it published data
  if (outcomes.length > 0 && outcomes.every(o => o.status === 'complete' && !o.pending)) return 'complete';
  if (outcomes.some(o => o.status === 'complete')) return 'partial';
  return 'failed';
}

export interface BundledBulkResult {
  jobId: string;
  /** complete only when every requested site completed; see SiteStatus */
  status: JobStatus;
  siteResults: SiteOutcome[];
  sites: string[];
  category: string;
  categoryKey?: string;
  broadCategory: string;
  subCategory: string;
  requestedCountPerSite: number;
  totalScraped: number;
  bundleCount: number;
  outputFile: string | null;
  bundles: BundledProduct[];
  matchReviews: MatchReview[];
  errors: Array<{ url: string; message: string }>;
  resumed: boolean;
}

export async function scrapeBulk(options: {
  sites: SiteKey[];
  category: string;
  categoryKey?: string;
  broadCategory?: string;
  subCategory?: string;
  count: number;
  /** Run the supported sites and report the rest as unsupported, instead of refusing the job */
  allowUnsupported?: boolean;
}, deps: BulkScrapeDeps = defaultBulkScrapeDeps): Promise<BundledBulkResult> {
  const {
    sites,
    category,
    categoryKey,
    broadCategory = 'Uncategorized',
    subCategory = 'General',
    count,
  } = options;

  // Refuse before spending anything when a requested site has no authorized data source
  const { supported, unsupported } = partitionSites(sites, deps.env);
  if (unsupported.length > 0 && !options.allowUnsupported) {
    throw new UnsupportedSitesError(unsupported);
  }

  // Init vector tagger + mongo once
  await deps.ensureTagger();

  const jobId = buildJobId(sites, category, count, categoryKey);
  // Expired checkpoints are discarded here, so old prices are never resumed
  const existing = loadCheckpoint(jobId, { now: deps.now() });
  const resumed = existing !== null;

  const checkpoint: CheckpointData = existing ?? {
    jobId,
    sites,
    category,
    categoryKey,
    broadCategory,
    subCategory,
    countPerSite: count,
    startedAt: deps.now().toISOString(),
    updatedAt: deps.now().toISOString(),
    links: {},
    scraped: [],
    failed: [],
  };

  if (resumed) {
    console.log(`[resume] Job ${jobId} — ${checkpoint.scraped.length} products already done.`);
  } else {
    console.log(`[job] Starting ${jobId} — ${supported.join(', ')} × ${count} products [${broadCategory} > ${subCategory}].`);
  }
  for (const u of unsupported) console.warn(`[${u.site}] Unsupported — ${u.reason}. Reported, not scraped.`);

  const settled = await Promise.allSettled(
    supported.map(site =>
      scrapeOneSite({
        site,
        category,
        categoryKey: checkpoint.categoryKey,
        broadCategory: checkpoint.broadCategory,
        subCategory: checkpoint.subCategory,
        count,
        checkpoint,
      }, deps)
    )
  );
  const siteResults: SiteOutcome[] = [
    ...settled.map((s, i): SiteOutcome => s.status === 'fulfilled'
      ? s.value
      : { site: supported[i], status: 'failed', scraped: 0, failed: 0, reason: `site-level error: ${s.reason?.message ?? s.reason}` }),
    ...unsupported.map((u): SiteOutcome => ({ site: u.site, status: 'unsupported', scraped: 0, failed: 0, reason: u.reason })),
  ];
  for (const r of siteResults) {
    if (r.status !== 'complete') console.warn(`[${r.site}] ${r.status.toUpperCase()}${r.reason ? ` — ${r.reason}` : ''}`);
  }

  const status = jobStatusOf(siteResults);
  const base = {
    jobId,
    status,
    siteResults,
    sites,
    category,
    categoryKey: checkpoint.categoryKey,
    broadCategory: checkpoint.broadCategory,
    subCategory: checkpoint.subCategory,
    requestedCountPerSite: count,
    totalScraped: checkpoint.scraped.length,
    errors: checkpoint.failed,
    resumed,
  };

  // An interrupted job is not a result: keep the checkpoint for resume and publish nothing
  if (status === 'stopped') {
    saveCheckpoint(checkpoint);
    console.log(`[job] ${jobId} stopped — ${checkpoint.scraped.length} products kept in checkpoint for resume.`);
    return { ...base, bundleCount: 0, outputFile: null, bundles: [], matchReviews: [] };
  }

  // Data scraped before a resume carries its own scrape time; very old checkpoints without one
  // fall back to the job start, so an offer is never stamped fresher than it is
  const allProducts = checkpoint.scraped.map(s => ({
    site: s.site,
    data: { ...s.data, scrapedAt: s.data.scrapedAt ?? checkpoint.startedAt },
  }));
  const matchReviews: MatchReview[] = [];
  const bundles = await deps.bundle(allProducts, category, checkpoint.broadCategory, checkpoint.subCategory, matchReviews);
  console.log(`Bundled ${allProducts.length} products → ${bundles.length} bundles [${status}].`);

  const timestamp = deps.now().toISOString().replace(/[:.]/g, '-');
  const filename = `${sites.length === 1 ? sites[0] : sites.length + 'sites'}_${category.replace(/[^a-z0-9]/gi, '_')}_${timestamp}.json`;
  fs.mkdirSync(deps.outputDir, { recursive: true });
  const outputPath = path.join(deps.outputDir, filename);

  const result: BundledBulkResult = { ...base, bundleCount: bundles.length, outputFile: outputPath, bundles, matchReviews };
  fs.writeFileSync(outputPath, JSON.stringify({ ...result, bundles: withoutEmbeddings(result.bundles) }));
  console.log(`Saved to ${outputPath}`);

  // Keep the checkpoint while a site that was attempted failed, so a rerun inside the resume
  // window retries just that site. Unsupported sites cannot be fixed by rerunning.
  // A paused site (pending links) also keeps it, so the next run scrapes only what is left.
  const attemptedAllComplete = siteResults.every(r => (r.status === 'complete' && !r.pending) || r.status === 'unsupported');
  if (attemptedAllComplete) deleteCheckpoint(jobId);
  return result;
}
