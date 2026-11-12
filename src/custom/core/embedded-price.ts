/**
 * Regular (pre-discount) price from a page's embedded app state — Next.js RSC payloads,
 * Magento GraphQL caches, Nuxt state. JSON-LD only carries the selling price.
 *
 * Safety: a regular price is accepted only when it sits next to a selling price equal to the
 * price we already read for THIS product, optionally inside a window around the product's own
 * identifier — so a related product's prices on the same page are never picked up.
 */

const NUM = '([0-9]+(?:\\.[0-9]+)?)';

/** `key` followed by a number, in JSON ("key":1), escaped JSON (\"key\":1), JS (key:1) or Magento money ({"currency":"AED","value":1}). */
function valuesFor(text: string, key: string): Array<{ pos: number; value: number }> {
  const re = new RegExp(`${key}\\\\?"?\\s*:\\s*(?:\\{[^{}]{0,80}?value\\\\?"?\\s*:\\s*)?${NUM}`, 'g');
  return [...text.matchAll(re)].map(m => ({ pos: m.index ?? 0, value: parseFloat(m[1]) }));
}

const same = (a: number, b: number) => Math.abs(a - b) < 0.02;

export interface OriginalPriceRule {
  regularKey: string;
  finalKey: string;
  /** Text identifying this product in the payload (URI path, SKU); search is limited around it */
  anchor?: string | null;
  /** Max distance between the paired keys */
  maxGap?: number;
}

export function findOriginalPrice(text: string, price: number | null, rule: OriginalPriceRule): number | null {
  if (price === null || !text) return null;
  let window = text;
  if (rule.anchor) {
    const i = text.indexOf(rule.anchor);
    if (i < 0) return null; // the product's own record is not in the payload — do not guess
    window = text.slice(Math.max(0, i - 2000), i + 5000);
  }
  const gap = rule.maxGap ?? 1500;
  const regulars = valuesFor(window, rule.regularKey);
  for (const f of valuesFor(window, rule.finalKey)) {
    if (!same(f.value, price)) continue;
    const near = regulars
      .filter(r => Math.abs(r.pos - f.pos) <= gap)
      .sort((a, b) => Math.abs(a.pos - f.pos) - Math.abs(b.pos - f.pos))[0];
    if (!near) continue;
    return near.value > price + 0.009 ? Math.round(near.value * 100) / 100 : null;
  }
  return null;
}
