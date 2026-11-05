/**
 * Cross-platform product matching key for groceries.
 *
 * The same grocery item is listed on Talabat Mart, Deliveroo and Noon Minutes under
 * slightly different titles ("Almarai Fresh Milk Full Fat, 2L" vs "Almarai Full Fat
 * Milk 2L"), so exact-name matching never merges them and each becomes its own card.
 * This key folds those titles to the same value so the push pipeline can merge their
 * offers into ONE product document (→ per-platform price comparison on the card).
 *
 * Precision over recall: a key is only produced when the title carries a size / pack /
 * count token. Size-less titles ("Coriander Leaves") return null and are left to the
 * existing exact-name matching, so two genuinely different items are never merged just
 * because their words overlap. The size must also match, so "...1L" and "...2L" stay
 * separate products.
 *
 * Pure and deterministic — safe to call at write time and in a backfill.
 */

// Marketing / filler words that vary between retailers and must not affect identity.
const STOP = new Set([
  'the', 'and', 'of', 'with', 'for', 'in', 'a', 'an', 'to', 'plus',
  'pack', 'size', 'fresh', 'value', 'offer', 'new', 'original', 'premium',
  'assorted', 'each', 'approx', 'approximately', 'piece', 'pieces', 'pcs', 'pc',
]);

const MULTI_RE = /(\d+)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(ml|l|cl|g|kg|mg)\b/gi;
const SIZE_RE = /(\d+(?:\.\d+)?)\s*(ml|l|cl|g|kg|mg)\b/gi;
const COUNT_RE = /(\d+)\s*(pcs?|pieces?)\b/gi;

/**
 * Pull size/pack tokens out of a title and return them alongside the title with those
 * spans removed. Multipack spans ("4 x 1L") are consumed first so the inner "1L" is not
 * also counted as a standalone size.
 */
function sizesAndRemainder(name: string): { sizes: string[]; remainder: string } {
  const sizes = new Set<string>();
  const remainder = name
    .replace(MULTI_RE, (_f, a, b, u) => { sizes.add(`${a}x${b}${String(u).toLowerCase()}`); return ' '; })
    .replace(SIZE_RE, (_f, n, u) => { sizes.add(`${n}${String(u).toLowerCase()}`); return ' '; })
    .replace(COUNT_RE, (_f, n) => { sizes.add(`${n}pc`); return ' '; });
  return { sizes: [...sizes].sort(), remainder };
}

/** Normalized size/pack tokens found in a title, e.g. ["4x1l"], ["500g"], ["6pc"]. */
export function extractSizeTokens(name: string): string[] {
  return sizesAndRemainder(name).sizes;
}

/**
 * Build the cross-platform grocery match key for a product title, or null when the
 * title has no size/pack/count token (then the product is matched by exact name only).
 */
export function groceryMatchKey(name: string | null | undefined): string | null {
  if (!name) return null;
  const { sizes, remainder } = sizesAndRemainder(name);
  if (sizes.length === 0) return null; // precision: no size ⇒ no cross-platform merge

  // Tokenize the title with the size spans already removed.
  const stripped = remainder.toLowerCase().replace(/[^a-z0-9.\s]/g, ' ');

  const bag = [...new Set(
    stripped
      .split(/\s+/)
      .filter(t => t && t.length > 1 && !STOP.has(t) && !/^\d+$/.test(t)),
  )].sort();

  if (bag.length === 0) return null; // only noise words — not safe to merge
  return `${bag.join(' ')}#${sizes.join(',')}`;
}
