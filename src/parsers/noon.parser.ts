import * as cheerio from 'cheerio';
import { ProductData } from './types';
import { extractNoonSku } from '../services/product-identity';

// Product-detail sections that render *other* products' images
const RECOMMENDATION_SCOPES = [
  '[class*="recommend" i]', '[class*="similar" i]', '[class*="carousel" i]', '[class*="sponsored" i]',
  '[data-qa*="recommend" i]', '[data-qa*="carousel" i]', '[data-qa*="similar" i]',
].join(', ');

function isNoonProductImage(src: string): boolean {
  return (src.includes('/p/pnsku/') || src.includes('/p/pzsku/') || src.includes('nooncdn.com/p/')) && !src.includes('placeholder');
}

/**
 * Gallery images of *this* product only. Noon CDN paths embed the SKU
 * (`/p/pnsku/<SKU>/...` or `/p/pzsku/<SKU>/...`), so when the page URL carries a SKU only
 * images with that SKU are kept. Otherwise only one image is trusted: og:image (the page's
 * declared main image), else the first image outside recommendation/carousel sections.
 */
export function extractNoonImages($: cheerio.CheerioAPI, url: string): string[] {
  const sku = extractNoonSku(url);
  const all: string[] = [];
  const outsideRecs: string[] = [];
  $('img').each((_, el) => {
    const src = $(el).attr('src') || '';
    if (!isNoonProductImage(src) || all.includes(src)) return;
    all.push(src);
    if ($(el).closest(RECOMMENDATION_SCOPES).length === 0) outsideRecs.push(src);
  });

  if (sku) {
    const own = all.filter(src => src.toUpperCase().includes(`/${sku}/`));
    if (own.length) return own;
  }
  const og = $('meta[property="og:image"]').attr('content');
  if (og && isNoonProductImage(og)) return [og];
  return outsideRecs.slice(0, 1);
}

/** true/false only with evidence; null when the page gives no stock signal. */
export function extractNoonAvailability($: cheerio.CheerioAPI): boolean | null {
  const cta = $('[data-qa="pdp-add-to-cart-revamp"], [data-qa="pdp-add-to-cart"], button[data-qa*="add-to-cart"]').first();
  const ctaText = cta.text().trim().toLowerCase();
  const productSection = $('[data-qa*="pdp"], [class*="productContainer"], main').first().text().toLowerCase();
  if (/out of stock|sold out|notify me/.test(ctaText) || /\bthis item is (currently )?out of stock\b|\bsold out\b/.test(productSection)) return false;
  if (cta.length && ctaText.includes('add to cart') && cta.attr('disabled') === undefined) return true;
  return null;
}

export function parseNoon(html: string, url: string): ProductData {
  const $ = cheerio.load(html);

  // Title
  const productName = $('h1').first().text().trim() || null;

  // Price — data-qa="div-price-now" contains clean current price e.g. "3899.00"
  const priceStr = $('[data-qa="div-price-now"]').first().text().trim() || null;
  const parsedPrice = priceStr ? parseFloat(priceStr.replace(/[^0-9.]/g, '')) : NaN;
  const price = Number.isFinite(parsedPrice) && parsedPrice > 0 ? parsedPrice : null;
  // Noon UAE always transacts in AED
  const currency = price !== null ? 'AED' : null;

  const imageUrls = extractNoonImages($, url);
  const imageUrl: string | null = imageUrls[0] || null;

  // Rating + review count — text like "4.62422 Ratings" (rating=4.6, count=2422)
  const ratingText = $('[class*="ratingCtr"]').first().text().trim();
  const ratingMatch = ratingText.match(/^(\d+\.\d)(\d+)\s*Rating/i);
  const ratings = ratingMatch ? parseFloat(ratingMatch[1]) : null;
  const reviewCount = ratingMatch ? parseInt(ratingMatch[2], 10) : null;

  const inStock = extractNoonAvailability($);

  // Description — highlights section
  let description: string | null = null;
  const highlights = $('[class*="highlightsCtr"]').first().text().trim();
  if (highlights) {
    description = highlights.replace(/^Highlights\s*/i, '').trim() || null;
  }

  return {
    productName,
    productUrl: url,
    imageUrl,
    imageUrls,
    price,
    currency,
    ratings,
    reviewCount,
    description,
    inStock,
    category: null,
  };
}
