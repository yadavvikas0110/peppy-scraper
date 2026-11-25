/**
 * Cross-platform product matching against STORED documents.
 *
 * The bundler merges retailers inside one job. Jobs that run separately (another category, another
 * platform lane, yesterday's run) only met in the database by exact name before — so "Apple iPhone 16
 * 128GB Black" from Amazon and "iPhone 16 128GB Black" from Carrefour stayed two products and no price
 * comparison was shown. This module lets the push find that stored product, with the bundler's own guards:
 *
 *   1. Barcode (GTIN/EAN) equal on both sides → same product.
 *   2. Otherwise a candidate must share a match key (brand + model token, e.g. "apple|16"), and pass:
 *        • title similarity ≥ the bundler's threshold,
 *        • no role / type / brand / variant conflict (accessory vs device, 128 GB vs 256 GB, S24 vs S25),
 *        • prices within MAX_PRICE_RATIO of the stored comparable prices,
 *        • the stored product has no offer from the same retailer (that would be a different listing).
 *   Products with no known brand or no model token never fuzzy-match: a missed comparison is cheaper
 *   than a wrong one (a customer sent to the wrong product at the "best" price).
 */
import {
  brandOf, identityConflict, jaccardSimilarity, MAX_PRICE_RATIO, SIMILARITY_THRESHOLD, variantSignature,
} from './bundler.service';

const compact = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');

// Product lines that name their brand (titles like "iPhone 16 128GB – Black (Apple)" put the brand last)
const LINE_BRANDS: Array<[RegExp, string]> = [
  [/\b(iphone|ipad|macbook|airpods|imac|apple watch)\b/i, 'apple'],
  [/\bgalaxy\b/i, 'samsung'],
  [/\bpixel\s*\d/i, 'google'],
  [/\b(playstation|ps5|ps4)\b/i, 'sony'],
  [/\b(xbox|surface)\b/i, 'microsoft'],
  [/\bredmi\b/i, 'xiaomi'],
];
const KNOWN_ANYWHERE = /\b(apple|samsung|xiaomi|huawei|honor|oneplus|google|oppo|realme|vivo|nokia|motorola|sony|lg|tcl|hisense|dell|hp|lenovo|asus|acer|msi|microsoft|jbl|bose|anker|beats|philips|dyson|bosch|nespresso|tefal|braun|panasonic|sharp|toshiba|nikon|canon|garmin|fitbit|nintendo|delonghi|kenwood|ninja|cosori|instant pot)\b/i;

/**
 * Brand key for matching: a known brand at the start of the title (consistent across shops), else the
 * brand a product line implies, else the stated brand, else a known brand anywhere in the title.
 */
export function brandKey(name: string, brand?: string | null): string | null {
  const fromName = brandOf(name);
  if (fromName) return fromName;
  const line = LINE_BRANDS.find(([re]) => re.test(name))?.[1];
  if (line) return line;
  const stated = brand ? compact(brand) : '';
  if (stated.length >= 2) return stated;
  const anywhere = KNOWN_ANYWHERE.exec(name)?.[1];
  return anywhere ? compact(anywhere) : null;
}

/** "brand|model" keys stored on each product and used to find cross-platform candidates. */
export function crossMatchKeys(name: string | null | undefined, brand?: string | null): string[] {
  if (!name) return [];
  const b = brandKey(name, brand);
  if (!b) return [];
  const models = [...variantSignature(name).modelTokens]
    .map(t => t.replace(/[^a-z0-9]/g, ''))
    .filter(t => t.length >= 2 && t !== b && !/^(19|20)\d\d$/.test(t)); // years are not model numbers
  return [...new Set(models.map(m => `${b}|${m}`))];
}

export interface MatchCandidateProduct {
  name: string;
  brand?: string;
  gtins?: string[];
  matchKeys?: string[];
  retailers: Array<{ retailerId: string; price?: number; stockStatus?: string; isStale?: boolean }>;
}

function comparablePrices(retailers: any[]): number[] {
  return (retailers ?? [])
    .filter(r => typeof r?.price === 'number' && r.price > 0 && r.isStale !== true && r.stockStatus !== 'unavailable' && r.inStock !== false)
    .map(r => r.price as number);
}

export function sharesGtin(p: MatchCandidateProduct, doc: any): boolean {
  if (!p.gtins?.length) return false;
  const stored = new Set<string>([...(doc.gtins ?? []), ...(doc.retailers ?? []).map((r: any) => r?.gtin).filter(Boolean)]);
  return p.gtins.some(g => stored.has(g));
}

/** Why `doc` cannot be `p` on another platform, or null when it can. */
export function crossMatchConflict(p: MatchCandidateProduct, doc: any): string | null {
  if (typeof doc?.name !== 'string' || !doc.name) return 'no_name';
  const incomingRetailers = new Set(p.retailers.map(r => r.retailerId));
  if ((doc.retailers ?? []).some((r: any) => incomingRetailers.has(r?.retailerId))) return 'same_retailer';
  const keys = new Set<string>(doc.matchKeys ?? crossMatchKeys(doc.name, doc.brand));
  if (!(p.matchKeys ?? []).some(k => keys.has(k))) return 'no_shared_key';
  const ba = brandKey(p.name, p.brand);
  const bb = brandKey(doc.name, doc.brand);
  if (ba && bb && ba !== bb) return 'brand_mismatch';
  const conflict = identityConflict(p.name, doc.name);
  if (conflict) return conflict;
  if (jaccardSimilarity(p.name, doc.name) < SIMILARITY_THRESHOLD) return 'low_similarity';
  const stored = comparablePrices(doc.retailers);
  const incoming = comparablePrices(p.retailers);
  if (stored.length && incoming.length) {
    const all = [...stored, ...incoming];
    if (Math.max(...all) / Math.min(...all) > MAX_PRICE_RATIO) return 'price_ratio';
  }
  return null;
}

/** Best stored document for `p` from another platform: barcode first, then the guarded fuzzy match. */
export function findCrossRetailerMatch(p: MatchCandidateProduct, docs: any[]): any | null {
  const byGtin = docs.filter(d => sharesGtin(p, d));
  if (byGtin.length) return byGtin.sort((a, b) => String(a._id).localeCompare(String(b._id)))[0];
  if (!p.matchKeys?.length) return null;
  let best: any = null;
  let bestSim = 0;
  for (const d of docs) {
    if (crossMatchConflict(p, d)) continue;
    const sim = jaccardSimilarity(p.name, d.name);
    if (sim > bestSim || (sim === bestSim && best && String(d._id) < String(best._id))) { best = d; bestSim = sim; }
  }
  return best;
}
