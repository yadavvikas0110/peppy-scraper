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
} from './brightdata.service';
import { SITES, SiteKey } from '../config/sites';
import { bundleProducts } from './bundler.service';
import {
  buildJobId,
  loadCheckpoint,
  saveCheckpoint,
  deleteCheckpoint,
  CheckpointData,
} from './checkpoint.service';
import { initVectorTagger } from './vector-tagger.service';
import { connectChroma, isChromaAvailable } from './chroma.service';
import { collectShopifyProducts } from './shopify.service';
import { shouldStop } from '../utils/stop-signal';

export { closeBrowserPool as closeBrowser };

const STATIC_SEARCH_HOSTS = /amazon\.ae/;
const PRODUCT_LINK_SELECTORS = ['a[href*="/dp/"]', 'a[href*="/p/"]', 'a[data-pjax][href*="/product/"]'].join(', ');

// Errors that retrying cannot fix: routing failures, timeouts, Bright Data access refusals
const NO_RETRY_RE = /no_peer|probe_timeout|a2a_tun_open|a2a_exception|ERR_TUNNEL_CONNECTION_FAILED|Timeout \d+ms exceeded|Host blocked by Bright Data/i;

function isNonRetryable(message: string): boolean {
  return NO_RETRY_RE.test(message) || isAccessDeniedError(message);
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

async function fetchSearchHTML(url: string): Promise<string> {
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
async function scrapeProductWithRetry(url: string): Promise<ProductData> {
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

interface ScrapeOneSiteOptions {
  site: SiteKey;
  category: string;
  categoryKey?: string;
  broadCategory: string;
  subCategory: string;
  count: number;
  checkpoint: CheckpointData;
}

async function scrapeOneSite(opts: ScrapeOneSiteOptions): Promise<void> {
  const { site, category, categoryKey, broadCategory, subCategory, count, checkpoint } = opts;
  const siteConfig = SITES[site];

  // Use category browse URL if the site defines one for this categoryKey
  const categoryUrlBuilder = categoryKey && siteConfig.categories?.[categoryKey]
    ? siteConfig.categories[categoryKey]
    : null;

  // Shopify stores: fetch all product data via /products.json — no individual scraping
  if (siteConfig.shopify) {
    const alreadyDone = checkpoint.scraped.filter(s => s.site === site).length;
    if (alreadyDone > 0) {
      console.log(`[${site}] Shopify — resuming, ${alreadyDone} products already in checkpoint.`);
      return;
    }
    console.log(`[${site}] Shopify — fetching via /products.json...`);
    try {
      const products = await collectShopifyProducts(siteConfig.hostname, category, count);
      for (const data of products) {
        data.broadCategory = broadCategory;
        data.subCategory = subCategory;
        checkpoint.scraped.push({ site, url: data.productUrl || `${site}:unknown`, data });
      }
      saveCheckpoint(checkpoint);
      console.log(`[${site}] Shopify — ${products.length} products collected.`);
    } catch (e: any) {
      console.error(`[${site}] Shopify fetch failed: ${e.message}`);
    }
    return;
  }

  if (!checkpoint.links[site]) {
    let allLinks: string[];

    if (siteConfig.collectLinks) {
      console.log(`[${site}] Collecting links via custom collector...`);
      allLinks = await siteConfig.collectLinks(category, count);
    } else {
      const collectedLinks = new Set<string>();
      let pageNum = 1;

      while (collectedLinks.size < count) {
        const searchUrl = categoryUrlBuilder
          ? categoryUrlBuilder(pageNum)
          : siteConfig.buildSearchUrl(category, pageNum);
        console.log(`[${site}] Fetching page ${pageNum}: ${searchUrl}`);

        let pageHtml: string;
        try {
          pageHtml = await fetchSearchHTML(searchUrl);
        } catch (e: any) {
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
        for (const link of newLinks) {
          if (collectedLinks.size >= count) break;
          collectedLinks.add(link);
        }

        // All returned links were already collected — pagination exhausted
        if (collectedLinks.size === prevSize) {
          console.log(`[${site}] Page ${pageNum} returned only duplicates — stopping pagination.`);
          break;
        }

        pageNum++;
        await new Promise(r => setTimeout(r, 300 + Math.random() * 300));
      }

      allLinks = Array.from(collectedLinks).slice(0, count);
    }

    console.log(`[${site}] Collected ${allLinks.length}/${count} links.`);

    if (allLinks.length === 0) {
      console.warn(`[${site}] No links collected — skipping site for this query.`);
      return;
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
  const remaining = allLinks.filter(l => !alreadyDone.has(l) && !alreadyFailed.has(l));

  console.log(`[${site}] Scraping ${remaining.length} remaining (${alreadyDone.size} already done)...`);

  for (const link of remaining) {
    if (shouldStop()) {
      console.log(`[${site}] Stop signal — aborting.`);
      break;
    }
    try {
      const data = await scrapeProductWithRetry(link);
      // Stamp taxonomy on each product
      data.broadCategory = broadCategory;
      data.subCategory = subCategory;
      checkpoint.scraped.push({ site, url: link, data });
      saveCheckpoint(checkpoint);
      console.log(`[${site}] ✓ ${(data.productName || link).slice(0, 60)}`);
    } catch (e: any) {
      checkpoint.failed.push({ url: link, message: e.message });
      saveCheckpoint(checkpoint);
      console.error(`[${site}] ✗ ${link}: ${e.message}`);
    }
  }

  const ok = checkpoint.scraped.filter(s => s.site === site).length;
  const fail = checkpoint.failed.filter(f => allLinks.includes(f.url)).length;
  console.log(`[${site}] Done: ${ok} ok, ${fail} errors.`);
}

export interface BundledBulkResult {
  jobId: string;
  sites: string[];
  category: string;
  categoryKey?: string;
  broadCategory: string;
  subCategory: string;
  requestedCountPerSite: number;
  totalScraped: number;
  bundleCount: number;
  outputFile: string;
  bundles: BundledProduct[];
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
}): Promise<BundledBulkResult> {
  const {
    sites,
    category,
    categoryKey,
    broadCategory = 'Uncategorized',
    subCategory = 'General',
    count,
  } = options;

  // Init vector tagger + mongo once
  await ensureTagger();

  const jobId = buildJobId(sites, category, count, categoryKey);
  const existing = loadCheckpoint(jobId);
  const resumed = existing !== null;

  const checkpoint: CheckpointData = existing ?? {
    jobId,
    sites,
    category,
    categoryKey,
    broadCategory,
    subCategory,
    countPerSite: count,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    links: {},
    scraped: [],
    failed: [],
  };

  if (resumed) {
    console.log(`[resume] Job ${jobId} — ${checkpoint.scraped.length} products already done.`);
  } else {
    console.log(`[job] Starting ${jobId} — ${sites.join(', ')} × ${count} products [${broadCategory} > ${subCategory}].`);
  }

  await Promise.allSettled(
    sites.map(site =>
      scrapeOneSite({
        site,
        category,
        categoryKey: checkpoint.categoryKey,
        broadCategory: checkpoint.broadCategory,
        subCategory: checkpoint.subCategory,
        count,
        checkpoint,
      }).catch((e: any) => console.error(`[${site}] Site-level error — skipping: ${e.message}`))
    )
  );

  const allProducts = checkpoint.scraped.map(s => ({ site: s.site, data: s.data }));
  const bundles = await bundleProducts(allProducts, category, checkpoint.broadCategory, checkpoint.subCategory);
  console.log(`Bundled ${allProducts.length} products → ${bundles.length} bundles.`);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${sites.length === 1 ? sites[0] : sites.length + 'sites'}_${category.replace(/[^a-z0-9]/gi, '_')}_${timestamp}.json`;
  const outputDir = path.join(process.cwd(), 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, filename);

  const result: BundledBulkResult = {
    jobId,
    sites,
    category,
    categoryKey: checkpoint.categoryKey,
    broadCategory: checkpoint.broadCategory,
    subCategory: checkpoint.subCategory,
    requestedCountPerSite: count,
    totalScraped: allProducts.length,
    bundleCount: bundles.length,
    outputFile: outputPath,
    bundles,
    errors: checkpoint.failed,
    resumed,
  };

  fs.writeFileSync(outputPath, JSON.stringify({ ...result, bundles: withoutEmbeddings(result.bundles) }));
  console.log(`Saved to ${outputPath}`);

  deleteCheckpoint(jobId);
  return result;
}
