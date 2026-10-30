import { ProductData, RetailerOffer, BundledProduct, toStockStatus } from '../parsers/types';
import { SiteKey } from '../config/sites';
import { tagBundleWithVectors, getBundleEmbedding } from './vector-tagger.service';
import { canonicalProductUrl, marketplaceIdFor } from './product-identity';

const RETAILER_DISPLAY_NAMES: Record<SiteKey, string> = {
  amazon:     'Amazon',
  noon:       'Noon',
  carrefour:  'Carrefour',
  sharafdg:   'Sharaf DG',
  jumbo:      'Jumbo',
  mumzworld:  'Mumzworld',
  namshi:     'Namshi',
  letstango:  'Letstango',
};

const SIMILARITY_THRESHOLD = 0.45;

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'in', 'of', 'to', 'at', 'by', 'with',
  'from', 'on', 'is', 'it', 'its', 'this', 'that', 'new', 'buy', 'online',
  'version', 'edition', 'series', 'model', 'international', 'middle', 'east',
]);

function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getTokens(name: string): Set<string> {
  return new Set(
    normalize(name)
      .split(' ')
      .filter(t => t.length > 1 && !STOPWORDS.has(t))
  );
}

function jaccardSimilarity(a: string, b: string): number {
  const ta = getTokens(a);
  const tb = getTokens(b);
  let intersection = 0;
  ta.forEach(t => { if (tb.has(t)) intersection++; });
  const union = new Set([...ta, ...tb]).size;
  return union === 0 ? 0 : intersection / union;
}

// ── Variant guards ────────────────────────────────────────────────────────────
// Token overlap alone merges different models ("Galaxy S24 Ultra 256GB" vs "Galaxy S25
// Ultra 256GB" scores 0.78). These attributes must agree before two names can bundle.

const QUALIFIERS = new Set(['pro', 'max', 'ultra', 'plus', 'mini', 'lite', 'fe', 'air', 'fold', 'flip']);
const STORAGE_RE = /(\d+(?:\.\d+)?)\s*(gb|tb)\b/g;
const SCREEN_RE = /(\d{2,3}(?:\.\d)?)\s*(?:"|''|-?\s*inch(?:es)?\b|in\b)/;
// Spec tokens that are not model identifiers (5g, 4k, 120hz, 5000mah, 1.7l, ...)
const UNIT_TOKEN_RE = /^\d+(?:\.\d+)?(?:g|k|hz|mah|w|mp|l|ml|kg|cm|mm|m|v|nm|th|nd|rd|st|x)$/;

export interface VariantSignature {
  qualifiers: string;      // sorted, space-joined
  storageGb: number | null;
  screenInch: number | null;
  modelTokens: Set<string>;
}

export function variantSignature(name: string): VariantSignature {
  let s = name.toLowerCase().replace(/\+/g, ' plus ');

  let storageGb: number | null = null;
  for (const m of s.matchAll(STORAGE_RE)) {
    const gb = parseFloat(m[1]) * (m[2] === 'tb' ? 1024 : 1);
    // Largest capacity is storage; smaller ones are usually RAM ("8GB RAM, 256GB")
    if (storageGb === null || gb > storageGb) storageGb = gb;
  }
  s = s.replace(STORAGE_RE, ' ');

  const screen = s.match(SCREEN_RE);
  const screenInch = screen ? parseFloat(screen[1]) : null;
  if (screen) s = s.replace(SCREEN_RE, ' ');

  const tokens = s.replace(/[^\w\s.]/g, ' ').split(/\s+/).map(t => t.replace(/^\.+|\.+$/g, '')).filter(Boolean);
  const qualifiers = [...new Set(tokens.filter(t => QUALIFIERS.has(t)))].sort().join(' ');
  const modelTokens = new Set(tokens.filter(t => /\d/.test(t) && !UNIT_TOKEN_RE.test(t) && t.length <= 12));

  return { qualifiers, storageGb, screenInch, modelTokens };
}

export function variantsCompatible(a: string, b: string): boolean {
  const sa = variantSignature(a);
  const sb = variantSignature(b);
  if (sa.qualifiers !== sb.qualifiers) return false;
  if (sa.storageGb !== null && sb.storageGb !== null && sa.storageGb !== sb.storageGb) return false;
  if (sa.screenInch !== null && sb.screenInch !== null && sa.screenInch !== sb.screenInch) return false;
  // Model numbers must overlap when both names have them (S24 vs S25, iPhone 15 vs 16).
  // Extra codes on one side (e.g. "SM-S921B") are fine as long as one token is shared.
  if (sa.modelTokens.size > 0 && sb.modelTokens.size > 0 && ![...sa.modelTokens].some(t => sb.modelTokens.has(t))) return false;
  return true;
}

// ── Role, type and brand guards ───────────────────────────────────────────────
// Search results mix main products with accessories ("iPhone 16 Clear Case" shares the
// model token "16" with "iPhone 16"). A case must never become the iPhone's offer.

const ACCESSORY_RE = /\b(cases?|covers?|screen protectors?|tempered glass|protectors?|chargers?|charging (?:cable|pad|stand|dock)|cables?|adapters?|stylus|sleeves?|pouch(?:es)?|skins?|holders?|mounts?|lens protectors?|replacement (?:bands?|straps?|tips|pads)|ear ?tips|ear ?pads|straps?|watch bands?|power banks?|refills?|cartridges?)\b/i;
// Text after these describes what ships with the main product ("AirPods Pro with Charging Case")
const INCLUDED_ITEMS_RE = /\b(?:with|including|includes|bundle|plus)\b|[+&]/i;

export type ProductRole = 'main_product' | 'accessory';

// "… for iPhone 16" / "compatible with Galaxy S24" — main products do not describe themselves this way
const FOR_DEVICE_RE = /\b(?:for|compatible with|designed for|fits)\s+(?:apple\s+|samsung\s+|google\s+)?(?:iphone|galaxy|ipad|macbook|airpods|pixel|apple watch|watch)\b/i;

export function productRoleOf(name: string): ProductRole {
  const head = name.split(INCLUDED_ITEMS_RE)[0];
  return ACCESSORY_RE.test(head) || FOR_DEVICE_RE.test(head) ? 'accessory' : 'main_product';
}

const TYPE_RULES: Array<[string, RegExp]> = [
  ['tablet', /\b(ipad|galaxy tab|tablet)\b/i],
  ['laptop', /\b(macbook|laptop|notebook|chromebook|thinkpad|vivobook|zenbook|ideapad)\b/i],
  ['watch', /\b(smart ?watch|apple watch|galaxy watch|watch)\b/i],
  ['earbuds', /\b(airpods|earbuds|earphones|in-ear|tws)\b/i],
  ['headphones', /\b(headphones?|headset|over-ear)\b/i],
  ['tv', /\b(tv|television)\b/i],
  ['speaker', /\b(speaker|soundbar)\b/i],
  ['phone', /\b(iphone|smartphone|mobile phone|galaxy [asz]\d+|pixel \d+|phone)\b/i],
];

export function productTypeOf(name: string): string | null {
  const head = name.split(INCLUDED_ITEMS_RE)[0];
  return TYPE_RULES.find(([, re]) => re.test(head))?.[0] ?? null;
}

const KNOWN_BRANDS = new Set(['apple', 'samsung', 'xiaomi', 'redmi', 'oneplus', 'huawei', 'honor', 'google', 'oppo', 'realme', 'vivo',
  'nokia', 'motorola', 'sony', 'lg', 'tcl', 'hisense', 'dell', 'hp', 'lenovo', 'asus', 'acer', 'msi', 'microsoft', 'jbl', 'bose',
  'anker', 'beats', 'philips', 'dyson', 'bosch', 'nespresso', 'spigen', 'otterbox', 'belkin', 'ugreen', 'baseus', 'esr', 'casetify']);

export function brandOf(name: string): string | null {
  return normalize(name).split(' ').slice(0, 4).find(t => KNOWN_BRANDS.has(t)) ?? null;
}

// Cross-retailer prices of one product rarely differ by more than this; a bigger gap
// usually means a wrong match (accessory, refurbished, multipack) and goes to review.
export const MAX_PRICE_RATIO = 2;
// Names this close but below SIMILARITY_THRESHOLD are reported for review, never merged
const REVIEW_SIMILARITY_FLOOR = 0.3;

export interface MatchReview {
  reason: string;
  similarity: number;
  incoming: { site: string; name: string; price: number | null; productUrl: string | null };
  candidate: { name: string; retailers: string[]; prices: number[] };
}

/** null when two titles may describe the same product, else the reason they cannot. */
export function identityConflict(a: string, b: string): string | null {
  if (productRoleOf(a) !== productRoleOf(b)) return 'role_mismatch';
  const ta = productTypeOf(a);
  const tb = productTypeOf(b);
  if (ta && tb && ta !== tb) return 'type_mismatch';
  const ba = brandOf(a);
  const bb = brandOf(b);
  if (ba && bb && ba !== bb) return 'brand_mismatch';
  if (!variantsCompatible(a, b)) return 'variant_mismatch';
  return null;
}

/** Prices that may set the product's range: priced offers not known to be unavailable. */
function comparablePrices(bundle: BundledProduct): number[] {
  return bundle.retailers
    .filter(r => toStockStatus(r.inStock) !== 'unavailable' && r.price !== null && r.price > 0)
    .map(r => r.price!);
}

export function priceRatioConflict(price: number | null, existing: number[]): boolean {
  if (price === null || price <= 0 || existing.length === 0) return false;
  const all = [...existing, price];
  return Math.max(...all) / Math.min(...all) > MAX_PRICE_RATIO;
}

export function buildOffer(site: SiteKey, data: ProductData): RetailerOffer {
  return {
    retailerId: site,
    retailerName: RETAILER_DISPLAY_NAMES[site],
    price: data.price,
    currency: data.currency || 'AED',
    inStock: data.inStock,
    stockStatus: toStockStatus(data.inStock),
    productUrl: data.productUrl,
    imageUrl: data.imageUrl,
    ratings: data.ratings,
    reviewCount: data.reviewCount,
    externalId: marketplaceIdFor(site, data.productUrl),
    canonicalUrl: canonicalProductUrl(data.productUrl),
    observedAt: data.scrapedAt ?? null,
  };
}

export async function bundleProducts(
  items: Array<{ site: SiteKey; data: ProductData }>,
  category: string,
  broadCategory: string,
  subCategory: string,
  reviews: MatchReview[] = [],
): Promise<BundledProduct[]> {
  const bundles: BundledProduct[] = [];

  for (const { site, data } of items) {
    if (!data.productName) continue;
    const offer = buildOffer(site, data);
    const incomingImages = data.imageUrls?.length ? data.imageUrls : (data.imageUrl ? [data.imageUrl] : []);

    // The same listing reached through two links (same ASIN/SKU) is one offer, not two products
    if (offer.externalId && bundles.some(b => b.retailers.some(r => r.retailerId === site && r.externalId === offer.externalId))) {
      continue;
    }

    let bestMatch: BundledProduct | null = null;
    let bestSim = 0;
    let bestReview: MatchReview | null = null;

    for (const bundle of bundles) {
      if (!bundle.name || bundle.retailers.some(r => r.retailerId === site)) continue;
      const sim = jaccardSimilarity(data.productName, bundle.name);
      if (sim < REVIEW_SIMILARITY_FLOOR) continue;

      const conflict = identityConflict(data.productName, bundle.name)
        ?? (priceRatioConflict(offer.price, comparablePrices(bundle)) ? 'price_ratio' : null)
        ?? (sim < SIMILARITY_THRESHOLD ? 'low_similarity' : null);

      if (!conflict) {
        if (sim > bestSim) { bestMatch = bundle; bestSim = sim; }
        continue;
      }
      // Only near-misses are worth a human look; role/type/brand conflicts are clear non-matches
      const reviewable = conflict === 'price_ratio' || conflict === 'low_similarity'
        || (conflict === 'variant_mismatch' && sim >= SIMILARITY_THRESHOLD);
      if (reviewable && (!bestReview || sim > bestReview.similarity)) {
        bestReview = {
          reason: conflict,
          similarity: Math.round(sim * 100) / 100,
          incoming: { site, name: data.productName, price: offer.price, productUrl: offer.productUrl },
          candidate: { name: bundle.name, retailers: bundle.retailers.map(r => r.retailerId), prices: comparablePrices(bundle) },
        };
      }
    }

    if (bestMatch) {
      bestMatch.retailers.push(offer);
      // Keep whichever retailer has the most images (more angles = better gallery)
      if (incomingImages.length > bestMatch.images.length) {
        bestMatch.images = incomingImages;
      }
      if (!bestMatch.description && data.description) {
        bestMatch.description = data.description;
      }
      if (data.productName.length > (bestMatch.name?.length ?? 0)) {
        bestMatch.name = data.productName;
      }
    } else {
      if (bestReview) reviews.push(bestReview);
      bundles.push({
        name: data.productName,
        description: data.description,
        category,
        broadCategory,
        subCategory,
        tags: [],
        images: incomingImages,
        lowestPrice: null,
        highestPrice: null,
        rating: null,
        reviewCount: null,
        retailerCount: 0,
        retailers: [offer],
      });
    }
  }

  // Aggregate prices and ratings. Unavailable offers never set the price range.
  for (const bundle of bundles) {
    const prices = comparablePrices(bundle);

    bundle.lowestPrice = prices.length > 0 ? Math.min(...prices) : null;
    bundle.highestPrice = prices.length > 0 ? Math.max(...prices) : null;
    bundle.retailerCount = bundle.retailers.length;

    let bestReviewCount = -1;
    for (const r of bundle.retailers) {
      if (r.reviewCount !== null && r.reviewCount > bestReviewCount) {
        bestReviewCount = r.reviewCount;
        bundle.rating = r.ratings;
        bundle.reviewCount = r.reviewCount;
      }
    }
    if (bundle.reviewCount === null) {
      for (const r of bundle.retailers) {
        if (r.ratings !== null) { bundle.rating = r.ratings; break; }
      }
    }
  }

  if (reviews.length) console.log(`[bundler] ${reviews.length} uncertain match(es) left unmatched for manual review.`);

  // Vector tagging — sequential to respect API rate limits
  console.log(`[bundler] Tagging ${bundles.length} bundles with vector tagger...`);
  for (const bundle of bundles) {
    bundle.tags = await tagBundleWithVectors(bundle, broadCategory, subCategory);
  }

  // Generate bundle embeddings. ChromaDB is written once, by pushToDatabase, after
  // cross-query dedupe — writing here too created a second vector per product.
  for (const bundle of bundles) {
    const embedding = await getBundleEmbedding(bundle);
    if (embedding) bundle.embedding = embedding;
  }

  // Sort: most retailers first, then lowest price
  bundles.sort((a, b) => {
    if (b.retailerCount !== a.retailerCount) return b.retailerCount - a.retailerCount;
    return (a.lowestPrice ?? Infinity) - (b.lowestPrice ?? Infinity);
  });

  return bundles;
}
