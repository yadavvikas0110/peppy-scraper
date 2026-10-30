/**
 * scrape-noon-affiliate.ts
 *
 * Scrapes 5 noon affiliate links using playwright-extra + stealth plugin.
 * Upserts into products_clean: inserts new, or updates price/rating/reviewCount if exists.
 * Affiliate link is stored as the retailer productUrl.
 *
 * Usage: npx ts-node scrape-noon-affiliate.ts
 */

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';
import { MongoClient, Collection } from 'mongodb';
import { getMongoConfig, redactMongoUri } from './src/shared/db/mongo';

// ─── Config ──────────────────────────────────────────────────────────────────

const AFFILIATE_LINKS: string[] = [
  'https://s.noon.com/duNm4YprxUg',
  'https://s.noon.com/WQ2u8RmA9b8',
  'https://s.noon.com/jvm9BIysRKM',
  'https://s.noon.com/u6qxQIOGLoE',
  'https://s.noon.com/BVN61juNRJE',
];

// Connection comes from MONGODB_URI / MONGODB_DB only — never hard-code credentials here.
const COLLECTION = 'products_clean';

chromium.use(StealthPlugin());

// ─── Scraper ─────────────────────────────────────────────────────────────────

interface ScrapedProduct {
  affiliateUrl: string;
  finalUrl: string;
  name: string | null;
  brand: string | null;
  price: number | null;
  originalPrice: number | null;
  currency: string;
  rating: number | null;
  reviewCount: number | null;
  images: string[];
  description: string | null;
  category: string | null;
  subcategory: string | null;
  sku: string | null;
  inStock: boolean;
  tags: string[];
}

async function scrapeNoonProduct(page: any, affiliateUrl: string): Promise<ScrapedProduct> {
  console.log(`\n[scrape] Navigating → ${affiliateUrl}`);
  await page.goto(affiliateUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Wait for main content to load
  try {
    await page.waitForSelector('h1', { timeout: 15000 });
  } catch {
    console.warn('  [warn] h1 not found within 15s, continuing anyway');
  }

  // Extra wait for dynamic content
  await page.waitForTimeout(3000);

  const finalUrl = page.url();
  console.log(`  [url] ${finalUrl}`);

  const html = await page.content();
  const $ = cheerio.load(html);

  // Name
  const name = $('h1').first().text().trim() || null;

  // Brand — noon shows brand in breadcrumb or dedicated brand element
  let brand: string | null = null;
  const brandEl = $('[data-qa="pdp-link-brand"], [class*="brandName"], [class*="brand-name"]').first().text().trim();
  if (brandEl) brand = brandEl;
  if (!brand) {
    // Try breadcrumb second-to-last item
    const breadcrumbs = $('[class*="breadcrumb"] a, nav a').map((_: any, el: any) => $(el).text().trim()).get();
    if (breadcrumbs.length >= 2) brand = breadcrumbs[breadcrumbs.length - 2] || null;
  }

  // Price
  const priceStr = $('[data-qa="div-price-now"]').first().text().trim();
  const price = priceStr ? parseFloat(priceStr.replace(/[^0-9.]/g, '')) : null;

  // Original/crossed-out price
  const origStr = $('[data-qa="div-price-was"], [class*="priceWas"], [class*="was-price"]').first().text().trim();
  const originalPrice = origStr ? parseFloat(origStr.replace(/[^0-9.]/g, '')) : null;

  // Images
  const imageUrls: string[] = [];
  $('img').each((_: any, el: any) => {
    const src = $(el).attr('src') || '';
    if ((src.includes('/p/pnsku/') || src.includes('nooncdn.com/p/')) && !src.includes('placeholder')) {
      if (!imageUrls.includes(src)) imageUrls.push(src);
    }
  });

  // Rating + reviewCount — "4.62422 Ratings"
  const ratingText = $('[class*="ratingCtr"]').first().text().trim();
  const ratingMatch = ratingText.match(/^(\d+\.\d)(\d+)\s*Rating/i);
  const rating = ratingMatch ? parseFloat(ratingMatch[1]) : null;
  const reviewCount = ratingMatch ? parseInt(ratingMatch[2], 10) : null;

  // InStock
  const addToCartText = $('[data-qa="pdp-add-to-cart-revamp"]').text().trim().toLowerCase();
  const inStock = addToCartText.includes('add to cart') || !html.toLowerCase().includes('out of stock');

  // Description
  let description: string | null = null;
  const highlights = $('[class*="highlightsCtr"]').first().text().trim();
  if (highlights) description = highlights.replace(/^Highlights\s*/i, '').trim() || null;
  if (!description) {
    description = $('[class*="description"], [data-qa*="description"]').first().text().trim() || null;
  }

  // Category from breadcrumbs
  const breadcrumbLinks = $('[class*="breadcrumb"] a, nav[aria-label*="read"] a').map((_: any, el: any) => $(el).text().trim()).get().filter(Boolean);
  const category = breadcrumbLinks[1] || null;   // e.g. "Electronics"
  const subcategory = breadcrumbLinks[2] || null; // e.g. "Mobile Phones"

  // SKU from URL — noon URLs contain pnsku/NXXXXXXX
  const skuMatch = finalUrl.match(/\/p\/([^/?#]+)/);
  const sku = skuMatch ? skuMatch[1] : null;

  // Tags from category breadcrumbs
  const tags = breadcrumbLinks.slice(1).filter(Boolean);

  return {
    affiliateUrl,
    finalUrl,
    name,
    brand,
    price,
    originalPrice,
    currency: 'AED',
    rating,
    reviewCount,
    images: imageUrls,
    description,
    category,
    subcategory,
    sku,
    inStock,
    tags,
  };
}

// ─── MongoDB upsert ───────────────────────────────────────────────────────────

async function upsertProduct(col: Collection, p: ScrapedProduct): Promise<'inserted' | 'updated' | 'skipped'> {
  if (!p.name) {
    console.warn('  [skip] No product name extracted');
    return 'skipped';
  }

  const retailer = {
    retailerId: 'noon',
    retailerName: 'Noon',
    retailerLogo: 'https://f.nooncdn.com/s/app/com/noon/images/noon_logo_1x.png',
    price: p.price ?? 0,
    originalPrice: p.originalPrice ?? undefined,
    currency: p.currency,
    inStock: p.inStock,
    productUrl: p.affiliateUrl, // store affiliate link here
  };

  // Try match by SKU first, then by name
  const filter = p.sku
    ? { $or: [{ sku: p.sku }, { name: p.name }] }
    : { name: p.name };

  const existing = await col.findOne(filter);

  if (existing) {
    // Update price/rating/reviewCount + retailer entry
    const retailers: any[] = existing.retailers || [];
    const rIdx = retailers.findIndex((r: any) => r.retailerId === 'noon');
    if (rIdx >= 0) {
      retailers[rIdx] = { ...retailers[rIdx], ...retailer };
    } else {
      retailers.push(retailer);
    }
    const prices = retailers.map((r: any) => r.price).filter(Boolean);
    await col.updateOne(
      { _id: existing._id },
      {
        $set: {
          rating: p.rating ?? existing.rating,
          reviewCount: p.reviewCount ?? existing.reviewCount,
          retailers,
          lowestPrice: prices.length ? Math.min(...prices) : existing.lowestPrice,
          highestPrice: prices.length ? Math.max(...prices) : existing.highestPrice,
          updatedAt: new Date(),
        },
      }
    );
    console.log(`  [updated] ${p.name}`);
    return 'updated';
  } else {
    // Insert new
    const doc = {
      name: p.name,
      description: p.description,
      brand: p.brand,
      category: p.category || 'Uncategorized',
      subcategory: p.subcategory,
      images: p.images,
      sku: p.sku,
      rating: p.rating,
      reviewCount: p.reviewCount,
      tags: p.tags,
      retailers: [retailer],
      lowestPrice: p.price,
      highestPrice: p.price,
      isTrending: false,
      isTopRated: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await col.insertOne(doc);
    console.log(`  [inserted] ${p.name}`);
    return 'inserted';
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // MongoDB
  // Throws before any network I/O if MONGODB_URI is missing or malformed.
  const { uri, dbName } = getMongoConfig();
  const client = new MongoClient(uri);
  try {
    await client.connect();
  } catch (err) {
    throw new Error(`MongoDB connection failed: ${redactMongoUri(String((err as Error)?.message), uri)}`);
  }
  const db = client.db(dbName);
  const col = db.collection(COLLECTION);
  console.log(`[mongo] Connected → ${dbName}/${COLLECTION}`);

  // Browser
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-AE',
    timezoneId: 'Asia/Dubai',
    extraHTTPHeaders: {
      'Accept-Language': 'en-AE,en;q=0.9',
    },
  });

  const results = { inserted: 0, updated: 0, skipped: 0, errors: 0 };

  for (const url of AFFILIATE_LINKS) {
    const page = await context.newPage();
    try {
      const product = await scrapeNoonProduct(page, url);
      console.log(`  name      : ${product.name}`);
      console.log(`  brand     : ${product.brand}`);
      console.log(`  price     : ${product.price} ${product.currency}`);
      console.log(`  origPrice : ${product.originalPrice}`);
      console.log(`  rating    : ${product.rating} (${product.reviewCount} reviews)`);
      console.log(`  images    : ${product.images.length}`);
      console.log(`  sku       : ${product.sku}`);
      console.log(`  category  : ${product.category} > ${product.subcategory}`);
      console.log(`  inStock   : ${product.inStock}`);

      const outcome = await upsertProduct(col, product);
      results[outcome]++;
    } catch (err: any) {
      console.error(`  [error] ${url}: ${err.message}`);
      results.errors++;
    } finally {
      await page.close();
    }
  }

  await browser.close();
  await client.close();

  console.log(`\n[done] inserted=${results.inserted} updated=${results.updated} skipped=${results.skipped} errors=${results.errors}`);
}

main().catch(err => {
  console.error('[fatal]', err.message);
  process.exit(1);
});
