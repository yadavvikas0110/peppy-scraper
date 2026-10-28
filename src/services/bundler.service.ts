import { ProductData, RetailerOffer, BundledProduct } from '../parsers/types';
import { SiteKey } from '../config/sites';
import { tagBundleWithVectors, getBundleEmbedding } from './vector-tagger.service';

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

export async function bundleProducts(
  items: Array<{ site: SiteKey; data: ProductData }>,
  category: string,
  broadCategory: string,
  subCategory: string,
): Promise<BundledProduct[]> {
  const bundles: BundledProduct[] = [];

  for (const { site, data } of items) {
    if (!data.productName) continue;

    const offer: RetailerOffer = {
      retailerId: site,
      retailerName: RETAILER_DISPLAY_NAMES[site],
      price: data.price,
      currency: data.currency || 'AED',
      inStock: data.inStock,
      productUrl: data.productUrl,
      imageUrl: data.imageUrl,
      ratings: data.ratings,
      reviewCount: data.reviewCount,
    };

    let bestMatch: BundledProduct | null = null;
    let bestSim = 0;

    for (const bundle of bundles) {
      if (!bundle.name) continue;
      const sim = jaccardSimilarity(data.productName, bundle.name);
      if (sim >= SIMILARITY_THRESHOLD && sim > bestSim && variantsCompatible(data.productName, bundle.name)) {
        const alreadyHasRetailer = bundle.retailers.some(r => r.retailerId === site);
        if (!alreadyHasRetailer) {
          bestMatch = bundle;
          bestSim = sim;
        }
      }
    }

    const incomingImages = data.imageUrls?.length ? data.imageUrls : (data.imageUrl ? [data.imageUrl] : []);

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

  // Aggregate prices and ratings
  for (const bundle of bundles) {
    const prices = bundle.retailers
      .map(r => r.price)
      .filter((p): p is number => p !== null);

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
