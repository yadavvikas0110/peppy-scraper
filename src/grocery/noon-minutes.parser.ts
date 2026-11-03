import * as cheerio from 'cheerio';
import type { TalabatGroceryItem, TalabatGroceryParseResult } from './talabat-grocery.types';

// noon Minutes renders each product as a card containing:
//   a[href*="/now-product/<SKU>/"]        → product link (SKU = stable externalId)
//   [class*="_title_"]       (h2)         → name  (e.g. "Nada Chocolate Low Fat Protein Milk")
//   [class*="_sizeInfo_"]    (span)       → pack size (e.g. "320ml - 30g Protein")
//   [class*="_productPrice_"](strong)     → selling price (AED major units, e.g. "6.15")
//   [class*="_oldPrice_"]    (span)       → was-price when discounted (e.g. "6.25")
//   img                                    → product image
// Classes are CSS-module hashed (_name_<hash>), so we match on the stable name part via [class*=].
// Verified live on minutes.noon.com/uae-en/search/?f[category]=... (Dubai store, en-ae locale).

const PRODUCT_LINK = 'a[href*="/now-product/"]';
const PRICE_SEL = '[class*="_productPrice_"]';
const TITLE_SEL = '[class*="_title_"]';
const SIZE_SEL = '[class*="_sizeInfo_"]';
const OLD_PRICE_SEL = '[class*="_oldPrice_"]';
const OOS_RE = /sold out|out of stock|notify me|unavailable/i;

/** "6.15", "AED 6.15", "6,150" → 6.15. Returns undefined when no number is present. */
function toPrice(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const m = raw.replace(/,/g, '').match(/\d+(\.\d+)?/);
  if (!m) return undefined;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : undefined;
}

function skuFromHref(href: string | undefined): string | undefined {
  if (!href) return undefined;
  const m = href.match(/\/now-product\/([^/?#]+)/);
  return m ? m[1] : undefined;
}

/**
 * Pure parser for a rendered noon Minutes category/search page: HTML in, products out. Never
 * fetches, never persists. Empty item list (with a warning) when no product cards are present
 * (e.g. the SPA didn't render, or a non-UAE exit resolved no store).
 */
export function parseNoonMinutes(html: string, sourceUrl: string): TalabatGroceryParseResult {
  const warnings: string[] = [];
  const result: TalabatGroceryParseResult = { store: { name: 'Noon Minutes' }, items: [], sourceUrl, currentPage: 1, pageCount: 1, warnings };

  const $ = cheerio.load(html);
  const priceEls = $(PRICE_SEL);
  if (priceEls.length === 0) {
    warnings.push('no product cards found (page may not have rendered or no UAE store resolved)');
    return result;
  }

  const seen = new Set<string>();
  priceEls.each((_i, el) => {
    // The card is the nearest ancestor that also holds a product link.
    const card = $(el).parents().filter((_j, p) => $(p).find(PRODUCT_LINK).length > 0).first();
    if (card.length === 0) return;

    const href = card.find(PRODUCT_LINK).first().attr('href');
    const sku = skuFromHref(href);
    if (!sku) return;
    if (seen.has(sku)) return; // one card per SKU

    const name = card.find(TITLE_SEL).first().text().replace(/\s+/g, ' ').trim();
    if (!name) {
      warnings.push(`card ${sku}: missing name — skipped`);
      return;
    }
    const price = toPrice($(el).text());
    if (price === undefined) {
      warnings.push(`card ${sku} ("${name}"): missing/invalid price — skipped`);
      return;
    }
    seen.add(sku);

    const size = card.find(SIZE_SEL).first().text().replace(/\s+/g, ' ').trim();
    const title = size && !name.toLowerCase().includes(size.toLowerCase()) ? `${name}, ${size}` : name;
    const oldPrice = toPrice(card.find(OLD_PRICE_SEL).first().text());
    const img = card.find('img').first();
    const imageUrl = (img.attr('src') || img.attr('data-src') || '').trim() || undefined;
    const images = imageUrl ? [imageUrl] : [];
    const cardText = card.text();
    const stockAmount = OOS_RE.test(cardText) ? 0 : null;

    const item: TalabatGroceryItem = {
      id: sku,
      sku,
      title,
      slug: sku,
      price,
      originalPrice: oldPrice && oldPrice > price ? oldPrice : undefined,
      image: imageUrl,
      images,
      stockAmount,
    };
    result.items.push(item);
  });

  if (result.items.length === 0) warnings.push('product cards present but none parsed cleanly');
  return result;
}
