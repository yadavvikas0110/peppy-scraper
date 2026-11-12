/**
 * Regular (pre-discount) price from a page's embedded app state — Next.js RSC payloads,
 * Magento GraphQL caches, Nuxt state. JSON-LD only carries the selling price.
 *
 * Safety: a regular price is accepted only when
 *   • it sits next to a selling price equal to the price we already read for THIS product,
 *   • inside a window around an occurrence of the product's own identifier (URI path, SKU), and
 *   • every such pair agrees — conflicting candidates (e.g. a related product with the same
 *     selling price) mean "unknown", never a guess.
 */

const NUM = '([0-9]+(?:\\.[0-9]+)?)';
const MAX_ANCHORS = 20;

/**
 * `key` followed by a number, in JSON ("key":1), escaped JSON (\"key\":1), JS (key:1) or Magento
 * money ({"currency":"AED","value":1}). The key must not be the tail of a longer identifier
 * (base_regular_price is not regular_price).
 */
function valuesFor(text: string, key: string): Array<{ pos: number; value: number }> {
  const re = new RegExp(`(?<![A-Za-z0-9_])${key}\\\\?"?\\s*:\\s*(?:\\{[^{}]{0,80}?value\\\\?"?\\s*:\\s*)?${NUM}`, 'g');
  return [...text.matchAll(re)].map(m => ({ pos: m.index ?? 0, value: parseFloat(m[1]) }));
}

const same = (a: number, b: number) => Math.abs(a - b) < 0.02;
const round2 = (n: number) => Math.round(n * 100) / 100;

export interface OriginalPriceRule {
  regularKey: string;
  finalKey: string;
  /** Text identifying this product in the payload (URI path, SKU); search is limited around its occurrences */
  anchor?: string | null;
  /** Max distance between the paired keys */
  maxGap?: number;
}

/** How far from an anchor occurrence the product's own price pair may sit (measured: ≤ ~1.6 KB). */
const ANCHOR_REACH = 2500;

function anchorPositions(text: string, anchor: string): number[] {
  const out: number[] = [];
  for (let i = text.indexOf(anchor); i >= 0 && out.length < MAX_ANCHORS; i = text.indexOf(anchor, i + anchor.length)) out.push(i);
  return out;
}

export function findOriginalPrice(text: string, price: number | null, rule: OriginalPriceRule): number | null {
  if (price === null || !text) return null;
  const gap = rule.maxGap ?? 1500;
  const regulars = valuesFor(text, rule.regularKey);
  const finals = valuesFor(text, rule.finalKey).filter(f => same(f.value, price));
  const regularNear = (pos: number) => regulars
    .filter(r => Math.abs(r.pos - pos) <= gap)
    .sort((a, b) => Math.abs(a.pos - pos) - Math.abs(b.pos - pos))[0];

  const candidates = new Set<number>();
  if (rule.anchor) {
    const anchors = anchorPositions(text, rule.anchor);
    if (!anchors.length) return null; // the product's own record is not in the payload — do not guess
    // Per occurrence of the product's id: only the matching pair NEAREST to it is this product's own
    for (const a of anchors) {
      const own = finals
        .filter(f => Math.abs(f.pos - a) <= ANCHOR_REACH)
        .sort((x, y) => Math.abs(x.pos - a) - Math.abs(y.pos - a))[0];
      const reg = own && regularNear(own.pos);
      if (reg) candidates.add(round2(reg.value));
    }
  } else {
    for (const f of finals) {
      const reg = regularNear(f.pos);
      if (reg) candidates.add(round2(reg.value));
    }
  }
  if (candidates.size !== 1) return null; // none, or occurrences disagree
  const regular = [...candidates][0];
  return regular > price + 0.009 ? regular : null;
}
