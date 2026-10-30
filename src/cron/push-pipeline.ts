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
import axios from 'axios';
import { BundledProduct, RetailerOffer, StockStatus, toStockStatus } from '../parsers/types';
import { embedBatch, isEmbeddingAvailable } from '../services/embedding.service';
import { connectChroma, upsertProductsBatch, isChromaAvailable } from '../services/chroma.service';
import { getMongoConfig, redactMongoUri } from '../shared/db/mongo';
import { canonicalProductUrl, isAffiliateUrl, marketplaceIdFor, offerIdentityKey } from '../services/product-identity';
import { SCRAPER_API_KEY_HEADER } from '../utils/api-key';

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

function bundleKeys(b: BundledProduct): string[] {
  const keys = b.name ? [`name:${nameKey(b.name)}`] : [];
  for (const r of b.retailers) {
    const k = offerIdentityKey(r.retailerId, r.productUrl);
    if (k) keys.push(k);
  }
  return keys;
}

// The same product can come back from several queries in one run — by the same name or the
// same marketplace listing (ASIN/SKU). Merge those bundles before writing.
export function mergeDuplicateBundles(bundles: BundledProduct[]): BundledProduct[] {
  const merged: BundledProduct[] = [];
  const byKey = new Map<string, BundledProduct>();
  for (const b of bundles) {
    if (!b.name) continue;
    const keys = bundleKeys(b);
    const prev = keys.map(k => byKey.get(k)).find(Boolean);
    if (!prev) {
      const copy = { ...b, retailers: [...b.retailers], tags: [...b.tags], images: [...b.images] };
      merged.push(copy);
      keys.forEach(k => byKey.set(k, copy));
      continue;
    }
    for (const offer of b.retailers) {
      const i = prev.retailers.findIndex(r => r.retailerId === offer.retailerId);
      if (i < 0) prev.retailers.push(offer);
      // Keep the newer observation of the same retailer
      else if ((offer.observedAt ?? '') >= (prev.retailers[i].observedAt ?? '')) prev.retailers[i] = offer;
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
    const prices = prev.retailers
      .filter(r => toStockStatus(r.inStock) !== 'unavailable')
      .map(r => r.price).filter((p): p is number => p !== null && p > 0);
    prev.lowestPrice = prices.length ? Math.min(...prices) : null;
    prev.highestPrice = prices.length ? Math.max(...prices) : null;
    bundleKeys(b).forEach(k => byKey.set(k, prev));
  }
  return merged;
}

// ── Map BundledProduct → MongoDB schema ───────────────────────────────────────

export interface MongoRetailerOffer {
  retailerId: string;
  retailerName: string;
  /** Absent only for an unavailable offer whose page showed no price (updates stock, keeps old price) */
  price?: number;
  currency: string;
  /** null = unknown; never defaulted (the backend schema would otherwise read it as true) */
  inStock: boolean | null;
  stockStatus: StockStatus;
  productUrl?: string;
  imageUrl?: string;
  externalId?: string;
  canonicalUrl?: string;
  /** When the offer was observed on the retailer's site — never the time of the push */
  lastSeenAt?: Date;
  isStale?: boolean;
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

function toDate(iso: string | null | undefined): Date | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d : undefined;
}

export function toMongoOffer(r: RetailerOffer): MongoRetailerOffer | null {
  const stockStatus = r.stockStatus ?? toStockStatus(r.inStock);
  const hasPrice = r.price !== null && Number.isFinite(r.price) && r.price > 0;
  // A priceless offer only carries information when the page says the item is unavailable
  if (!hasPrice && stockStatus !== 'unavailable') return null;
  return dropUndefined({
    retailerId:   r.retailerId,
    retailerName: r.retailerName,
    price:        hasPrice ? r.price! : undefined,
    currency:     r.currency || 'AED',
    inStock:      stockStatus === 'unknown' ? null : stockStatus === 'available',
    stockStatus,
    productUrl:   r.productUrl ?? undefined,
    imageUrl:     r.imageUrl ?? undefined,
    externalId:   r.externalId ?? marketplaceIdFor(r.retailerId, r.productUrl) ?? undefined,
    canonicalUrl: r.canonicalUrl ?? canonicalProductUrl(r.productUrl) ?? undefined,
    lastSeenAt:   toDate(r.observedAt),
  });
}

export function toMongoProduct(bundle: BundledProduct): MongoProduct | null {
  if (!bundle.name) return null;
  const { broadCategory, subCategory } = taxonomyOf(bundle);

  const retailers = bundle.retailers.map(toMongoOffer).filter((o): o is MongoRetailerOffer => o !== null);
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

/** Only products with at least one priced offer may create a new document. */
export function isInsertable(p: MongoProduct): boolean {
  return p.retailers.some(r => r.price !== undefined);
}

// ── Derived pricing ───────────────────────────────────────────────────────────

export function stockStatusOf(offer: any): StockStatus {
  if (offer?.stockStatus === 'available' || offer?.stockStatus === 'unavailable' || offer?.stockStatus === 'unknown') return offer.stockStatus;
  return toStockStatus(offer?.inStock ?? null);
}

export interface DerivedPricing {
  /** Range over offers that may be bought: available or unknown stock, not stale. Null hides the product from listings. */
  lowestPrice: number | null;
  highestPrice: number | null;
  /** Best price among offers with evidence of availability only */
  bestConfirmedPrice: number | null;
  isTrending: boolean;
  isTopRated: boolean;
}

export function derivePricing(retailers: any[], rating?: number | null, reviewCount?: number | null): DerivedPricing {
  const priced = (retailers ?? []).filter(r => typeof r?.price === 'number' && r.price > 0 && r.isStale !== true);
  const comparable = priced.filter(r => stockStatusOf(r) !== 'unavailable');
  const confirmed = comparable.filter(r => stockStatusOf(r) === 'available');
  const prices = comparable.map(r => r.price as number);
  const confirmedPrices = confirmed.map(r => r.price as number);
  const comparableRetailers = new Set(comparable.map(r => r.retailerId)).size;
  return {
    lowestPrice: prices.length ? Math.min(...prices) : null,
    highestPrice: prices.length ? Math.max(...prices) : null,
    bestConfirmedPrice: confirmedPrices.length ? Math.min(...confirmedPrices) : null,
    // Same rule as the backend's migrate:trending — a real comparison plus social proof
    isTrending: comparableRetailers >= 2 && ((rating ?? 0) >= 4 || (reviewCount ?? 0) >= 50),
    isTopRated: (rating ?? 0) >= 4.5 && (reviewCount ?? 0) >= 100,
  };
}

// ── Merge into existing documents ─────────────────────────────────────────────

function sameListing(existing: any, incoming: MongoRetailerOffer): boolean {
  const existingKey = existing.externalId
    ? `${existing.retailerId}:id:${existing.externalId}`
    : offerIdentityKey(existing.retailerId, existing.productUrl);
  const incomingKey = incoming.externalId
    ? `${incoming.retailerId}:id:${incoming.externalId}`
    : offerIdentityKey(incoming.retailerId, incoming.productUrl);
  return !!existingKey && existingKey === incomingKey;
}

/**
 * Merges one observed offer onto the stored offer of the same retailer.
 *  - an observation older than the stored one never overwrites it
 *  - an unavailable offer without a price only updates stock (and needs an existing offer)
 *  - extra stored fields (variants, retailerLogo, originalPrice) survive
 *  - an affiliate URL stored for the same listing is kept as the redirect target
 */
export function mergeOffer(existing: any | undefined, incoming: MongoRetailerOffer): any | null {
  const existingSeen = existing?.lastSeenAt ? new Date(existing.lastSeenAt).getTime() : null;
  const incomingSeen = incoming.lastSeenAt ? incoming.lastSeenAt.getTime() : null;
  if (existing && existingSeen !== null && (incomingSeen === null || incomingSeen < existingSeen)) return existing;

  if (incoming.price === undefined) {
    if (!existing) return null;
    return { ...existing, inStock: false, stockStatus: 'unavailable', isStale: false, lastSeenAt: incoming.lastSeenAt ?? existing.lastSeenAt };
  }

  const keepAffiliateUrl = existing?.productUrl && isAffiliateUrl(existing.productUrl) && sameListing(existing, incoming);
  return dropUndefined({
    ...existing,
    ...incoming,
    productUrl: keepAffiliateUrl ? existing.productUrl : incoming.productUrl ?? existing?.productUrl,
    isStale: false,
    lastSeenAt: incoming.lastSeenAt ?? existing?.lastSeenAt,
  });
}

/**
 * Fields to $set on an existing document (or the full new document when `existing` is null).
 * Fills name/description/brand/category/images only when missing so admin edits survive, and
 * never writes backend-owned mapping fields — it only flags the product for re-mapping.
 */
export function mergeProduct(existing: any | null, p: MongoProduct, now: Date): Record<string, unknown> {
  const stored: any[] = existing?.retailers ?? [];
  const incomingIds = new Set(p.retailers.map(r => r.retailerId));
  const merged = p.retailers
    .map(offer => mergeOffer(stored.find(r => r.retailerId === offer.retailerId), offer))
    .filter(Boolean);
  const retailers = [...stored.filter(r => !incomingIds.has(r.retailerId)), ...merged];

  const rating = p.rating ?? existing?.rating;
  const reviewCount = p.reviewCount ?? existing?.reviewCount;
  const fill = <T>(field: string, value: T) => existing?.[field] ?? value;

  return dropUndefined({
    name:        fill('name', p.name),
    description: fill('description', p.description),
    brand:       fill('brand', p.brand),
    category:    fill('category', p.category),
    subcategory: fill('subcategory', p.subcategory),
    images:      existing?.images?.length ? existing.images : p.images,
    tags:        [...new Set([...(existing?.tags ?? []), ...p.tags])],
    // Ratings are fresh observations — overwrite when this run has them
    rating,
    reviewCount,
    retailers,
    ...derivePricing(retailers, rating, reviewCount),
    ingestMappingStatus: 'pending',
    ingestPendingAt: now,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
}

// ── Matching incoming products to stored documents ────────────────────────────

const ASIN_IN_URL = (asins: string[]) => new RegExp(`/(?:dp|gp/product)/(?:${asins.join('|')})(?:[/?#]|$)`, 'i');

/** One query that finds every stored document an incoming batch could belong to. */
export function buildCandidateQuery(products: MongoProduct[]): Record<string, unknown> {
  const names = new Set<string>();
  const ids = new Set<string>();
  const canonical = new Set<string>();
  const urls = new Set<string>();
  const asins = new Set<string>();
  for (const p of products) {
    names.add(p.name);
    for (const r of p.retailers) {
      if (r.externalId) ids.add(r.externalId);
      if (r.canonicalUrl) canonical.add(r.canonicalUrl);
      if (r.productUrl) urls.add(r.productUrl);
      if (r.retailerId === 'amazon' && r.externalId && /^[A-Z0-9]{10}$/.test(r.externalId)) asins.add(r.externalId);
    }
  }
  const or: Record<string, unknown>[] = [{ name: { $in: [...names] } }];
  if (ids.size) or.push({ 'retailers.externalId': { $in: [...ids] } });
  if (canonical.size) or.push({ 'retailers.canonicalUrl': { $in: [...canonical] } });
  if (urls.size) or.push({ 'retailers.productUrl': { $in: [...urls] } });
  // Rows seeded before identity fields existed store tagged URLs (…/dp/ASIN?tag=…)
  if (asins.size) or.push({ 'retailers.productUrl': { $regex: ASIN_IN_URL([...asins]).source, $options: 'i' } });
  return { $or: or };
}

function storedOfferKeys(doc: any): Set<string> {
  const keys = new Set<string>();
  for (const r of doc.retailers ?? []) {
    const id = r.externalId ?? marketplaceIdFor(r.retailerId, r.productUrl);
    if (id) keys.add(`${r.retailerId}:id:${String(id).toUpperCase()}`);
    const canonical = r.canonicalUrl ?? canonicalProductUrl(r.productUrl);
    if (canonical) keys.add(`${r.retailerId}:url:${canonical}`);
  }
  return keys;
}

/**
 * Stored document for an incoming product: a marketplace-identity match (ASIN/SKU, then canonical
 * URL) wins over a name match, so affiliate-tagged or re-titled rows are updated instead of duplicated.
 */
export function findExistingDocument(p: MongoProduct, docs: any[]): any | null {
  const incomingKeys = p.retailers.flatMap(r => [
    r.externalId ? `${r.retailerId}:id:${r.externalId.toUpperCase()}` : null,
    r.canonicalUrl ? `${r.retailerId}:url:${r.canonicalUrl}` : null,
  ]).filter((k): k is string => !!k);
  const byIdentity = docs.filter(d => {
    const keys = storedOfferKeys(d);
    return incomingKeys.some(k => keys.has(k));
  });
  if (byIdentity.length > 1) {
    console.warn(`[push] "${p.name}" matches ${byIdentity.length} stored products by marketplace ID — using the oldest; review duplicates.`);
    byIdentity.sort((a, b) => String(a._id).localeCompare(String(b._id)));
  }
  if (byIdentity.length) return byIdentity[0];
  const key = nameKey(p.name);
  return docs.find(d => typeof d.name === 'string' && nameKey(d.name) === key) ?? null;
}

// ── Mongo connection helper ───────────────────────────────────────────────────

/** The subset of a MongoDB collection the pipeline uses (a fake implements it in tests). */
export interface ProductsCollection {
  find(filter: object): { toArray(): Promise<any[]> };
  insertMany(docs: any[], options?: object): Promise<{ insertedCount: number }>;
  updateOne(filter: object, update: object): Promise<{ matchedCount: number; modifiedCount: number }>;
  createIndex?(spec: object, options?: object): Promise<unknown>;
}

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

// ── Write ─────────────────────────────────────────────────────────────────────

const MATCH_BATCH = 100;

export interface WriteResult {
  inserted: number;
  updated: number;
  /** incoming products that resolved to an existing document (by identity or name) */
  matched: number;
  conflicts: number;
  skipped: number;
}

/**
 * Upserts products with optimistic concurrency: an update only applies if the stored document's
 * updatedAt is unchanged since it was read, so a concurrent admin edit is never overwritten.
 * Conflicting products are re-read and retried once.
 */
export async function writeProducts(col: ProductsCollection, products: MongoProduct[], now: Date): Promise<WriteResult> {
  const result: WriteResult = { inserted: 0, updated: 0, matched: 0, conflicts: 0, skipped: 0 };
  let pending = products;

  for (let attempt = 0; attempt < 2 && pending.length > 0; attempt++) {
    const retry: MongoProduct[] = [];
    for (let i = 0; i < pending.length; i += MATCH_BATCH) {
      const batch = pending.slice(i, i + MATCH_BATCH);
      const docs = await col.find(buildCandidateQuery(batch)).toArray();
      // Several incoming products may land on the same stored document — merge them in order.
      // `fields` holds only what the pipeline owns, so nothing else is ever $set.
      const working = new Map<string, { base: any; fields: Record<string, unknown> }>();
      const inserts: any[] = [];
      const current = (d: any) => {
        const w = working.get(String(d._id));
        return w ? { ...w.base, ...w.fields } : d;
      };

      for (const p of batch) {
        const target = findExistingDocument(p, [...docs.map(current), ...inserts]);
        if (target && inserts.includes(target)) {
          Object.assign(target, mergeProduct(target, p, now));
        } else if (target) {
          if (attempt === 0) result.matched++;
          const id = String(target._id);
          const base = working.get(id)?.base ?? docs.find(d => String(d._id) === id);
          working.set(id, { base, fields: { ...working.get(id)?.fields, ...mergeProduct(target, p, now) } });
        } else if (isInsertable(p)) {
          inserts.push(mergeProduct(null, p, now));
        } else {
          result.skipped++;
        }
      }

      if (inserts.length) {
        const r = await col.insertMany(inserts, { ordered: false });
        result.inserted += r.insertedCount;
      }
      for (const { base, fields } of working.values()) {
        const r = await col.updateOne({ _id: base._id, updatedAt: base.updatedAt ?? null }, { $set: fields });
        if (r.matchedCount === 0) {
          result.conflicts++;
          retry.push(...batch.filter(p => findExistingDocument(p, [base])));
        } else if (r.modifiedCount > 0) {
          result.updated++;
        }
      }
    }
    pending = retry;
  }
  if (pending.length) console.warn(`[push] ${pending.length} product(s) not written — stored documents kept changing (concurrent edits).`);
  return result;
}

// ── Main callable function ────────────────────────────────────────────────────

export interface PushResult {
  mongoInserted: number;
  mongoUpdated: number;
  /** incoming products merged into existing documents */
  matchedExisting: number;
  /** bundles dropped before writing (no name/price/image) or with nothing insertable */
  skipped: number;
  chromaVectors: number;
  /** Outcome of asking the backend to map categories/roles/variants for the pushed products */
  mapping: MappingRequestResult;
  errors: string[];
}

export async function pushToDatabase(
  rawBundles: BundledProduct[],
  opts: { collection?: ProductsCollection; now?: Date; requestMapping?: () => Promise<MappingRequestResult> } = {},
): Promise<PushResult> {
  const errors: string[] = [];

  const bundles = mergeDuplicateBundles(rawBundles);
  const products = bundles.map(toMongoProduct).filter((p): p is MongoProduct => p !== null);
  console.log(`[push] ${rawBundles.length} bundles → ${bundles.length} after dedupe → ${products.length} valid products`);

  const offers = products.flatMap(p => p.retailers);
  const unknownStock = offers.filter(o => o.stockStatus === 'unknown').length;
  const unobserved = offers.filter(o => !o.lastSeenAt).length;
  if (unknownStock) console.log(`[push] ${unknownStock}/${offers.length} offers have unknown stock (kept, labelled unknown).`);
  if (unobserved) console.warn(`[push] ${unobserved} offers carry no observation time — their lastSeenAt is left as stored.`);

  const now = opts.now ?? new Date();
  const write = async (col: ProductsCollection) => {
    // Support the identity lookups; the backend's Mongoose schema owns the other indexes
    for (const field of ['retailers.productUrl', 'retailers.externalId', 'retailers.canonicalUrl', 'name', 'ingestMappingStatus']) {
      await col.createIndex?.({ [field]: 1 }, { background: true })
        .catch((e: any) => console.warn(`[push] Index ${field} not created: ${e.message}`));
    }
    return products.length ? writeProducts(col, products, now) : { inserted: 0, updated: 0, matched: 0, conflicts: 0, skipped: 0 };
  };

  let written: WriteResult;
  if (opts.collection) {
    written = await write(opts.collection);
  } else {
    console.log(`[push] Target: ${getMongoConfig().dbName}.products_clean`);
    written = await withProductsCollection(col => write(col as unknown as ProductsCollection));
  }
  console.log(`[push] ${written.inserted} new, ${written.updated} updated, ${written.skipped} skipped (no priced offer), ${written.conflicts} write conflict(s)`);
  if (written.conflicts) errors.push(`${written.conflicts} write conflict(s) with concurrent edits`);

  // Categories, roles and variant groups are owned by the backend — ask it to map pending products
  const mapping = await (opts.requestMapping ?? requestIngestMapping)();
  if (!mapping.ok) errors.push(`Backend mapping not applied: ${mapping.message} (products stay pending; run it again later)`);

  const pushed = {
    mongoInserted: written.inserted,
    mongoUpdated: written.updated,
    matchedExisting: written.matched,
    skipped: written.skipped + (bundles.length - products.length),
    mapping,
  };
  if (opts.collection) return { ...pushed, chromaVectors: 0, errors };

  let chromaVectors = 0;

  if (!isEmbeddingAvailable()) {
    console.warn('[push] OPENAI_API_KEY not set — skipping ChromaDB');
    return { ...pushed, chromaVectors, errors };
  }
  if (!isChromaAvailable()) {
    console.warn('[push] ChromaDB not configured — skipping');
    return { ...pushed, chromaVectors, errors };
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

  return { ...pushed, chromaVectors, errors };
}

// ── Backend mapping ───────────────────────────────────────────────────────────

export interface MappingRequestResult {
  ok: boolean;
  message: string;
  mapped?: number;
}

/**
 * Asks peppy-be to apply its category / product-role / variant-group mapping to every product
 * flagged ingestMappingStatus: 'pending'. Idempotent: a failed call leaves products pending and
 * the next call (or `npm run ingest:apply-mapping` in the backend) picks them up.
 */
export async function requestIngestMapping(env: NodeJS.ProcessEnv = process.env): Promise<MappingRequestResult> {
  const beUrl = env.PEPPY_BE_URL;
  const apiKey = env.SCRAPER_API_KEY;
  if (!beUrl) return { ok: false, message: 'PEPPY_BE_URL is not set' };
  if (!apiKey) return { ok: false, message: 'SCRAPER_API_KEY is not set (the mapping endpoint requires it)' };
  try {
    const res = await axios.post(`${beUrl}/api/v1/admin/scraper/ingest/apply-mapping`, {}, {
      timeout: 300000,
      headers: { [SCRAPER_API_KEY_HEADER]: apiKey },
      validateStatus: () => true,
    });
    if (res.status !== 200 || !res.data?.success) {
      return { ok: false, message: `HTTP ${res.status}: ${String(res.data?.error ?? '').slice(0, 200)}` };
    }
    const mapped = res.data.data?.mapped ?? 0;
    console.log(`[push] Backend mapping applied to ${mapped} product(s).`);
    return { ok: true, message: 'mapped', mapped };
  } catch (e: any) {
    return { ok: false, message: e.message };
  }
}

// ── Stale offers ──────────────────────────────────────────────────────────────

/**
 * Offers this pipeline wrote carry lastSeenAt. One not observed for `days` is stale: its price
 * is old and its stock is no longer evidenced, so it becomes isStale + unknown stock (absence of
 * data is not evidence of unavailability) and leaves the price range. Derived prices are
 * recomputed in the same write. Offers from other importers have no lastSeenAt and are untouched.
 */
export function markStaleInDocument(doc: any, cutoff: Date): Record<string, unknown> | null {
  let changed = false;
  const retailers = (doc.retailers ?? []).map((r: any) => {
    if (!r.lastSeenAt || r.isStale === true || new Date(r.lastSeenAt) >= cutoff) return r;
    changed = true;
    return { ...r, isStale: true, stockStatus: 'unknown', inStock: null };
  });
  if (!changed) return null;
  return { retailers, ...derivePricing(retailers, doc.rating, doc.reviewCount) };
}

export async function markStaleOffers(
  days = parseFloat(process.env.STALE_OFFER_DAYS || '3'),
  opts: { collection?: ProductsCollection; now?: Date } = {},
): Promise<number> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - days * 24 * 3600 * 1000);
  const run = async (col: ProductsCollection) => {
    const docs = await col.find({ retailers: { $elemMatch: { lastSeenAt: { $lt: cutoff }, isStale: { $ne: true } } } }).toArray();
    let staleOffers = 0;
    for (const doc of docs) {
      const update = markStaleInDocument(doc, cutoff);
      if (!update) continue;
      const r = await col.updateOne({ _id: doc._id, updatedAt: doc.updatedAt ?? null }, { $set: { ...update, updatedAt: now } });
      if (r.modifiedCount > 0) {
        staleOffers += (update.retailers as any[]).filter((o, i) => o.isStale && !doc.retailers[i].isStale).length;
      }
    }
    return staleOffers;
  };
  return opts.collection ? run(opts.collection) : withProductsCollection(col => run(col as unknown as ProductsCollection));
}

// ── Load bundles from JSON file ───────────────────────────────────────────────
export function loadBundlesFromJson(jsonPath: string): BundledProduct[] {
  const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  return raw.bundles ?? [];
}
