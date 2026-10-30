import * as cheerio from 'cheerio';
import { ProductData } from './types';

// Only containers that hold the buy-box price of *this* product. A page-wide `.a-price`
// also matches carousels, "other sellers" and accessory suggestions, so it is never used.
const BUY_BOX_PRICE_CONTAINERS = [
  '#corePriceDisplay_desktop_feature_div',
  '#corePrice_feature_div',
  '#corePrice_desktop',
  '#apex_desktop',
  '#price_inside_buybox',
  '#newBuyBoxPrice',
  '#tp_price_block_total_price_ww',
];
const LEGACY_PRICE_IDS = ['#priceblock_ourprice', '#priceblock_dealprice', '#priceblock_saleprice'];

const MAX_PLAUSIBLE_PRICE = 1_000_000;

function parsePrice(text: string): { price: number; currency: string | null } | null {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  const numeric = cleaned.replace(/[^0-9.,]/g, '').replace(/,/g, '');
  const price = parseFloat(numeric);
  if (!Number.isFinite(price) || price <= 0 || price > MAX_PLAUSIBLE_PRICE) return null;
  return { price, currency: cleaned.replace(/[\d.,\s ]/g, '').trim() || null };
}

export function extractAmazonBuyBoxPrice($: cheerio.CheerioAPI): { price: number; currency: string | null } | null {
  for (const container of BUY_BOX_PRICE_CONTAINERS) {
    const scope = $(container).first();
    if (!scope.length) continue;
    // Strike-through list prices (.a-text-price) are not what the customer pays
    const offscreen = scope.find('.priceToPay .aok-offscreen, .priceToPay .a-offscreen, .apexPriceToPay .a-offscreen, .aok-offscreen, .a-price:not(.a-text-price) .a-offscreen')
      .map((_, el) => $(el).text().trim()).get().find(t => /\d/.test(t));
    const fromOffscreen = offscreen ? parsePrice(offscreen) : null;
    if (fromOffscreen) return fromOffscreen;

    const whole = scope.find('.a-price:not(.a-text-price) .a-price-whole').first().text().replace(/[^0-9]/g, '');
    if (whole) {
      const frac = scope.find('.a-price:not(.a-text-price) .a-price-fraction').first().text().replace(/[^0-9]/g, '');
      const sym = scope.find('.a-price:not(.a-text-price) .a-price-symbol').first().text().trim();
      const reconstructed = parsePrice(`${sym}${whole}.${frac || '00'}`);
      if (reconstructed) return reconstructed;
    }
  }
  for (const id of LEGACY_PRICE_IDS) {
    const parsed = parsePrice($(id).first().text());
    if (parsed) return parsed;
  }
  return null;
}

const UNAVAILABLE_RE = /currently unavailable|temporarily out of stock|out of stock|not available|unavailable|we don't know when or if this item will be back/i;
// Long lead times mean the item is backordered, not on hand
const BACKORDER_RE = /usually (?:ships|dispatched) (?:with)?in \d+\s*(?:to|-)\s*\d+\s*(?:weeks|months)|(?:weeks|months) to dispatch/i;
const AVAILABLE_RE = /\bin stock\b|only \d+ left in stock|left in stock|usually (?:ships|dispatched) within \d+\s*(?:to|-)?\s*\d*\s*(?:hours|days|business days)|available to ship/i;

/**
 * Stock state from evidence on the page only:
 *   false — the availability block says the item is unavailable / out of stock / backordered
 *   true  — it says in stock, or there is no availability text but a working Add to Cart / Buy Now
 *   null  — no signal either way (never defaulted to in stock)
 */
export function extractAmazonAvailability($: cheerio.CheerioAPI): boolean | null {
  const text = $('#availability').text().replace(/\s+/g, ' ').trim();
  if (text) {
    if (UNAVAILABLE_RE.test(text) || BACKORDER_RE.test(text)) return false;
    if (AVAILABLE_RE.test(text)) return true;
  }
  if ($('#outOfStock, #outOfStockBuyBox_feature_div').length) return false;
  const buyButton = $('#add-to-cart-button, #buy-now-button').filter((_, el) => $(el).attr('disabled') === undefined);
  if (!text && buyButton.length) return true;
  return null;
}

/** amazon.ae prices are in AED; anything else (geo-shifted page, wrong marketplace) is not usable */
export function normalizeAmazonAeCurrency(raw: string | null): 'AED' | null {
  if (!raw) return 'AED'; // amazon.ae omits the symbol in some split-price layouts
  return /^(aed|د\.?إ\.?)$/i.test(raw.trim()) ? 'AED' : null;
}

export function parseAmazon(html: string, url: string): ProductData {
  const $ = cheerio.load(html);

  const productName = $('#productTitle').text().trim() || null;

  const buyBox = extractAmazonBuyBoxPrice($);
  const currency = buyBox ? normalizeAmazonAeCurrency(buyBox.currency) : null;
  // A price in another currency is never stored as an AED price
  const price = currency ? buyBox?.price ?? null : null;

  const landingImg = $('#landingImage');
  const imageUrl = landingImg.attr('src') || null;
  // data-a-dynamic-image is a JSON obj mapping URL → [w, h] for all zoom images
  const dynImageData = landingImg.attr('data-a-dynamic-image') || '';
  let imageUrls: string[] = [];
  try {
    const parsed = JSON.parse(dynImageData);
    imageUrls = Object.keys(parsed).filter(u => u.startsWith('http'));
  } catch {}
  if (imageUrls.length === 0 && imageUrl) imageUrls = [imageUrl];
  const ratingsStr = $('#acrPopover').attr('title') || null;
  const ratings = ratingsStr ? parseFloat(ratingsStr.split(' ')[0]) : null;
  const reviewCountStr = $('#acrCustomerReviewText').first().text().trim() || null;
  const reviewCount = reviewCountStr ? parseInt(reviewCountStr.replace(/[^0-9,]/g, '').replace(/,/g, ''), 10) : null;
  const inStock = extractAmazonAvailability($);
  const description = $('#feature-bullets li:not(.aplus-module)')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter(t => t.length > 0)
    .join(' | ') || null;

  return {
    productName,
    productUrl: url,
    imageUrl,
    imageUrls,
    price,
    currency,
    ratings: Number.isFinite(ratings) ? ratings : null,
    reviewCount: Number.isFinite(reviewCount) ? reviewCount : null,
    description,
    inStock,
    category: null
  };
}
