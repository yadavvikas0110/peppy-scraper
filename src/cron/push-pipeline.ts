/**
 * push-pipeline.ts
 *
 * Callable version of push-to-mongodb logic.
 * Used by both cron-runner and the standalone push-to-mongodb.ts script.
 */

import dotenv from 'dotenv';
dotenv.config();

import * as fs from 'fs';
import * as crypto from 'crypto';
import { Collection, MongoClient } from 'mongodb';
import { BundledProduct } from '../parsers/types';
import { embedBatch, isEmbeddingAvailable } from '../services/embedding.service';
import { connectChroma, upsertProductsBatch, isChromaAvailable } from '../services/chroma.service';
import { getMongoConfig, redactMongoUri } from '../shared/db/mongo';

// ── Category inference ────────────────────────────────────────────────────────
const QUERY_TO_TAXONOMY: Array<{ pattern: RegExp; broadCategory: string; subCategory: string }> = [
  { pattern: /iphone|apple.*phone/i,                          broadCategory: 'Electronics', subCategory: 'Smartphones' },
  { pattern: /galaxy\s*s\d|galaxy\s*a\d|galaxy\s*z|samsung.*phone/i, broadCategory: 'Electronics', subCategory: 'Smartphones' },
  { pattern: /xiaomi|oneplus|huawei.*phone|google.*pixel|oppo|realme/i, broadCategory: 'Electronics', subCategory: 'Smartphones' },
  { pattern: /smartphone|mobile phone/i,                      broadCategory: 'Electronics', subCategory: 'Smartphones' },
  { pattern: /macbook|laptop|notebook|thinkpad|inspiron|pavilion|surface laptop|gaming laptop/i, broadCategory: 'Electronics', subCategory: 'Laptops' },
  { pattern: /ipad|galaxy tab|tablet/i,                      broadCategory: 'Electronics', subCategory: 'Tablets' },
  { pattern: /airpods|headphones|earbuds|speaker|soundbar|earphones/i, broadCategory: 'Electronics', subCategory: 'Audio & Headphones' },
  { pattern: /\b(oled|qled|neo qled|bravia|smart tv|television|tcl tv)\b/i, broadCategory: 'Electronics', subCategory: 'Televisions' },
  { pattern: /monitor|curved monitor/i,                       broadCategory: 'Electronics', subCategory: 'Monitors' },
  { pattern: /apple watch|galaxy watch|fitbit|garmin.*watch|smartwatch/i, broadCategory: 'Electronics', subCategory: 'Wearables' },
  { pattern: /ps5|playstation|xbox|gaming controller|gaming headset/i, broadCategory: 'Electronics', subCategory: 'Gaming' },
  { pattern: /mirrorless camera|dslr|gopro|action camera/i,   broadCategory: 'Electronics', subCategory: 'Cameras' },
  { pattern: /security camera|doorbell|smart plug|alexa|echo|smart speaker/i, broadCategory: 'Electronics', subCategory: 'Smart Home' },
  { pattern: /coffee machine|air fryer|pressure cooker|stand mixer|blender|microwave|kettle|toaster/i, broadCategory: 'Home & Kitchen', subCategory: 'Kitchen Appliances' },
  { pattern: /washing machine|washer|refrigerator|fridge|dishwasher|clothes dryer/i, broadCategory: 'Home & Kitchen', subCategory: 'Large Appliances' },
  { pattern: /vacuum cleaner|robot vacuum/i,                  broadCategory: 'Home & Kitchen', subCategory: 'Cleaning Appliances' },
  { pattern: /air conditioner|air purifier|humidifier/i,      broadCategory: 'Home & Kitchen', subCategory: 'Air Treatment' },
  { pattern: /hair dryer|hair straightener|shaver|epilator|toothbrush/i, broadCategory: 'Personal Care', subCategory: 'Grooming' },
  { pattern: /treadmill|exercise bike|yoga mat|protein|whey/i, broadCategory: 'Fitness & Sports', subCategory: 'Cardio Equipment' },
  { pattern: /sofa|office chair|mattress|bedding|curtains|led strip/i, broadCategory: 'Home & Kitchen', subCategory: 'Furniture & Bedding' },
  { pattern: /printer|ssd|usb.*hub|webcam/i,                  broadCategory: 'Office', subCategory: 'Peripherals' },
  { pattern: /baby stroller|pram|baby monitor|diaper|baby food|baby formula/i, broadCategory: 'Baby & Kids', subCategory: 'Baby Essentials' },
  { pattern: /baby carrier|baby seat|crib|bassinet|baby bath/i, broadCategory: 'Baby & Kids', subCategory: 'Baby Gear' },
  { pattern: /toy|lego|board game|puzzle/i,                   broadCategory: 'Baby & Kids', subCategory: 'Toys & Games' },
  { pattern: /dress|abaya|hijab|women.*fashion|men.*fashion|shirt|jeans|sneaker/i, broadCategory: 'Fashion', subCategory: 'Clothing' },
  { pattern: /perfume|fragrance|deodorant/i,                  broadCategory: 'Personal Care', subCategory: 'Fragrance' },
  { pattern: /skincare|moisturizer|serum|sunscreen|face wash/i, broadCategory: 'Personal Care', subCategory: 'Skincare' },
  { pattern: /makeup|lipstick|foundation|mascara|eyeshadow/i, broadCategory: 'Personal Care', subCategory: 'Makeup' },
];

export function inferTaxonomy(category: string): { broadCategory: string; subCategory: string } {
  for (const rule of QUERY_TO_TAXONOMY) {
    if (rule.pattern.test(category)) {
      return { broadCategory: rule.broadCategory, subCategory: rule.subCategory };
    }
  }
  return { broadCategory: 'Electronics', subCategory: 'General' };
}

// ── Brand extraction ──────────────────────────────────────────────────────────
const BRAND_TAG_MAP: Record<string, string> = {
  'brand-apple': 'Apple', 'brand-samsung': 'Samsung', 'brand-lg': 'LG',
  'brand-sony': 'Sony', 'brand-dyson': 'Dyson', 'brand-philips': 'Philips',
  'brand-xiaomi': 'Xiaomi', 'brand-huawei': 'Huawei', 'brand-dell': 'Dell',
  'brand-hp': 'HP', 'brand-lenovo': 'Lenovo', 'brand-nespresso': 'Nespresso',
  'brand-bosch': 'Bosch', 'brand-anker': 'Anker', 'brand-google': 'Google',
  'brand-jbl': 'JBL', 'brand-bose': 'Bose',
};

function extractBrand(tags: string[]): string | undefined {
  for (const tag of tags) {
    if (BRAND_TAG_MAP[tag]) return BRAND_TAG_MAP[tag];
  }
  return undefined;
}

function taxonomyOf(bundle: BundledProduct): { broadCategory: string; subCategory: string } {
  return bundle.broadCategory
    ? { broadCategory: bundle.broadCategory, subCategory: bundle.subCategory }
    : inferTaxonomy(bundle.category);
}

// ── Cross-query dedupe ────────────────────────────────────────────────────────

function nameKey(name: string): string {
  return name.toLowerCase().replace(/\s+/g, ' ').trim();
}

// The same product can come back from several queries in one run. Merge those bundles
// before writing, otherwise concurrent upserts in one bulkWrite race on the same name.
export function mergeDuplicateBundles(bundles: BundledProduct[]): BundledProduct[] {
  const byName = new Map<string, BundledProduct>();
  for (const b of bundles) {
    if (!b.name) continue;
    const key = nameKey(b.name);
    const prev = byName.get(key);
    if (!prev) {
      byName.set(key, { ...b, retailers: [...b.retailers], tags: [...b.tags], images: [...b.images] });
      continue;
    }
    for (const offer of b.retailers) {
      const i = prev.retailers.findIndex(r => r.retailerId === offer.retailerId);
      if (i >= 0) prev.retailers[i] = offer; else prev.retailers.push(offer);
    }
    prev.tags = [...new Set([...prev.tags, ...b.tags])];
    if (b.images.length > prev.images.length) prev.images = [...b.images];
    prev.description ??= b.description;
    if ((b.reviewCount ?? -1) > (prev.reviewCount ?? -1)) {
      prev.rating = b.rating;
      prev.reviewCount = b.reviewCount;
    }
    prev.embedding ??= b.embedding;
    prev.retailerCount = prev.retailers.length;
    const prices = prev.retailers.map(r => r.price).filter((p): p is number => p !== null && p > 0);
    prev.lowestPrice = prices.length ? Math.min(...prices) : null;
    prev.highestPrice = prices.length ? Math.max(...prices) : null;
  }
  return [...byName.values()];
}

// ── Map BundledProduct → MongoDB schema ───────────────────────────────────────

export interface MongoRetailerOffer {
  retailerId: string;
  retailerName: string;
  price: number;
  currency: string;
  inStock: boolean;
  productUrl?: string;
  imageUrl?: string;
}

export interface MongoProduct {
  name: string;
  description?: string;
  brand?: string;
  category: string;
  subcategory: string;
  images: string[];
  rating?: number;
  reviewCount?: number;
  tags: string[];
  retailers: MongoRetailerOffer[];
}

function dropUndefined<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

export function toMongoProduct(bundle: BundledProduct): MongoProduct | null {
  if (!bundle.name) return null;
  const { broadCategory, subCategory } = taxonomyOf(bundle);

  const retailers = bundle.retailers
    .filter(r => r.price !== null && r.price > 0)
    .map(r => dropUndefined({
      retailerId:   r.retailerId,
      retailerName: r.retailerName,
      price:        r.price!,
      currency:     r.currency || 'AED',
      inStock:      r.inStock ?? true,
      productUrl:   r.productUrl ?? undefined,
      imageUrl:     r.imageUrl ?? undefined,
    }));

  if (retailers.length === 0) return null;
  const images = bundle.images.filter(Boolean);
  if (images.length === 0) return null; // reject no-image products

  return dropUndefined({
    name:         bundle.name,
    description:  bundle.description ?? undefined,
    brand:        extractBrand(bundle.tags),
    category:     broadCategory,
    subcategory:  subCategory,
    images,
    rating:       bundle.rating ?? undefined,
    reviewCount:  bundle.reviewCount ?? undefined,
    tags:         bundle.tags,
    retailers,
  });
}

// ── Upsert that merges into existing documents ────────────────────────────────

// Wrap literals so strings starting with "$" are never read as field paths
const lit = (v: unknown) => ({ $literal: v });

// Matches an existing product by name, or by any retailer URL (names drift between runs
// because the bundler keeps the longest retailer title)
export function productFilter(p: MongoProduct): Record<string, unknown> {
  const urls = p.retailers.map(r => r.productUrl).filter((u): u is string => !!u);
  return urls.length > 0
    ? { $or: [{ name: p.name }, { 'retailers.productUrl': { $in: urls } }] }
    : { name: p.name };
}

/**
 * Aggregation-pipeline update for one product. On an existing document it:
 *  - replaces only this run's retailers' offers (matched by retailerId), keeping every
 *    other retailer and any extra offer fields (variants, retailerLogo, originalPrice)
 *  - fills name/description/brand/category/images only when missing, so admin edits
 *    and S3-migrated images are never overwritten
 *  - leaves fields it does not own (productRole, variant grouping, ...) untouched
 */
export function buildProductUpdate(p: MongoProduct, now: Date): object[] {
  const existingRetailers = { $ifNull: ['$retailers', []] };
  const incomingIds = p.retailers.map(r => r.retailerId);

  const mergedRetailers = {
    $concatArrays: [
      { $filter: { input: existingRetailers, as: 'r', cond: { $not: [{ $in: ['$$r.retailerId', lit(incomingIds)] }] } } },
      p.retailers.map(offer => ({
        $mergeObjects: [
          { $ifNull: [{ $arrayElemAt: [{ $filter: { input: existingRetailers, as: 'e', cond: { $eq: ['$$e.retailerId', lit(offer.retailerId)] } } }, 0] }, {}] },
          lit({ ...offer, lastSeenAt: now }),
        ],
      })),
    ],
  };

  const keepOrFill = (field: string, value: unknown) => ({ $ifNull: [`$${field}`, lit(value)] });

  const fields: Record<string, unknown> = {
    name:        keepOrFill('name', p.name),
    category:    keepOrFill('category', p.category),
    subcategory: keepOrFill('subcategory', p.subcategory),
    images: {
      $cond: [{ $gt: [{ $size: { $ifNull: ['$images', []] } }, 0] }, '$images', lit(p.images)],
    },
    tags:      { $setUnion: [{ $ifNull: ['$tags', []] }, lit(p.tags)] },
    retailers: mergedRetailers,
    createdAt: { $ifNull: ['$createdAt', lit(now)] },
    updatedAt: lit(now),
  };
  if (p.description !== undefined) fields.description = keepOrFill('description', p.description);
  if (p.brand !== undefined) fields.brand = keepOrFill('brand', p.brand);
  // Ratings are fresh observations — overwrite when this run has them
  if (p.rating !== undefined) fields.rating = lit(p.rating);
  if (p.reviewCount !== undefined) fields.reviewCount = lit(p.reviewCount);

  const positivePrices = { $filter: { input: '$retailers.price', as: 'p', cond: { $gt: ['$$p', 0] } } };

  return [
    { $set: fields },
    {
      $set: {
        lowestPrice:  { $min: positivePrices },
        highestPrice: { $max: positivePrices },
        isTrending:   { $gte: [{ $size: '$retailers' }, 2] },
        isTopRated:   { $and: [{ $gte: [{ $ifNull: ['$rating', 0] }, 4.5] }, { $gte: [{ $ifNull: ['$reviewCount', 0] }, 100] }] },
      },
    },
  ];
}

// ── Mongo connection helper ───────────────────────────────────────────────────

async function withProductsCollection<T>(fn: (col: Collection) => Promise<T>): Promise<T> {
  const { uri, dbName } = getMongoConfig();
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
  try {
    await client.connect();
    return await fn(client.db(dbName).collection('products_clean'));
  } catch (e: any) {
    throw new Error(redactMongoUri(String(e?.message ?? e), uri));
  } finally {
    await client.close().catch(() => {});
  }
}

// ── Main callable function ────────────────────────────────────────────────────

export interface PushResult {
  mongoInserted: number;
  mongoUpdated: number;
  chromaVectors: number;
  errors: string[];
}

export async function pushToDatabase(
  rawBundles: BundledProduct[],
): Promise<PushResult> {
  const errors: string[] = [];

  const bundles = mergeDuplicateBundles(rawBundles);
  const products = bundles.map(toMongoProduct).filter((p): p is MongoProduct => p !== null);
  console.log(`[push] ${rawBundles.length} bundles → ${bundles.length} after dedupe → ${products.length} valid products`);

  const { dbName } = getMongoConfig();
  console.log(`[push] Target: ${dbName}.products_clean`);

  const now = new Date();
  const { mongoInserted, mongoUpdated } = await withProductsCollection(async col => {
    // Supports the productUrl match below; the backend's Mongoose schema owns the other indexes
    await col.createIndex({ 'retailers.productUrl': 1 }, { background: true })
      .catch((e: any) => console.warn(`[push] Index retailers.productUrl not created: ${e.message}`));
    await col.createIndex({ name: 1 }, { background: true })
      .catch((e: any) => console.warn(`[push] Index name not created: ${e.message}`));

    if (products.length === 0) return { mongoInserted: 0, mongoUpdated: 0 };

    const ops = products.map(p => ({
      updateOne: { filter: productFilter(p), update: buildProductUpdate(p, now), upsert: true },
    }));
    const bulkResult = await col.bulkWrite(ops as any[], { ordered: false });
    console.log(`[push] Upserted: ${bulkResult.upsertedCount} new, ${bulkResult.modifiedCount} updated`);
    return { mongoInserted: bulkResult.upsertedCount, mongoUpdated: bulkResult.modifiedCount };
  });

  let chromaVectors = 0;

  if (!isEmbeddingAvailable()) {
    console.warn('[push] OPENAI_API_KEY not set — skipping ChromaDB');
    return { mongoInserted, mongoUpdated, chromaVectors, errors };
  }
  if (!isChromaAvailable()) {
    console.warn('[push] ChromaDB not configured — skipping');
    return { mongoInserted, mongoUpdated, chromaVectors, errors };
  }

  try {
    // Reuse embeddings computed by the bundler; only embed bundles that lack one (e.g. after a resume)
    const missing = bundles.filter(b => !b.embedding?.length);
    if (missing.length > 0) {
      console.log(`[push] Generating ${missing.length} missing embeddings...`);
      const texts = missing.map(b =>
        [b.name, b.description?.slice(0, 200), ...(b.tags ?? []).slice(0, 15)]
          .filter(Boolean).join(' ').slice(0, 800)
      );
      const embeddings = await embedBatch(texts);
      missing.forEach((b, i) => { b.embedding = embeddings[i]; });
    }

    const chromaDocs = bundles.map(bundle => {
      const taxonomy = taxonomyOf(bundle);
      return {
        id:            crypto.createHash('sha256').update((bundle.name ?? '').toLowerCase().trim()).digest('hex').slice(0, 24),
        name:          bundle.name ?? 'Unknown',
        embedding:     bundle.embedding!,
        broadCategory: taxonomy.broadCategory,
        subCategory:   taxonomy.subCategory,
        tags:          bundle.tags ?? [],
        lowestPrice:   bundle.lowestPrice,
        highestPrice:  bundle.highestPrice,
        retailerCount: bundle.retailerCount,
      };
    });

    await connectChroma();
    await upsertProductsBatch(chromaDocs);
    chromaVectors = chromaDocs.length;
    console.log(`[push] ChromaDB: ${chromaVectors} vectors upserted`);
  } catch (e: any) {
    const msg = `ChromaDB push failed: ${e.message}`;
    console.error(`[push] ${msg}`);
    errors.push(msg);
  }

  return { mongoInserted, mongoUpdated, chromaVectors, errors };
}

// ── Stale offers ──────────────────────────────────────────────────────────────

/**
 * Marks offers this pipeline wrote (they carry lastSeenAt) as out of stock when no run has
 * seen them for STALE_OFFER_DAYS (default 3). Offers from other importers have no
 * lastSeenAt and are never touched. A later run that sees the offer again restores it.
 */
export async function markStaleOffers(days = parseFloat(process.env.STALE_OFFER_DAYS || '3')): Promise<number> {
  const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000);
  return withProductsCollection(async col => {
    const result = await col.updateMany(
      { retailers: { $elemMatch: { lastSeenAt: { $lt: cutoff }, inStock: { $ne: false } } } },
      { $set: { 'retailers.$[r].inStock': false, updatedAt: new Date() } },
      { arrayFilters: [{ 'r.lastSeenAt': { $lt: cutoff }, 'r.inStock': { $ne: false } }] },
    );
    return result.modifiedCount;
  });
}

// ── Load bundles from JSON file ───────────────────────────────────────────────
export function loadBundlesFromJson(jsonPath: string): BundledProduct[] {
  const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  return raw.bundles ?? [];
}
