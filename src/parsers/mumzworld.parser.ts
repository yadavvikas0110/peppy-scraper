import * as cheerio from 'cheerio';
import { ProductData } from './types';

// Mumzworld is Magento 2 — same pattern as Jumbo with different theme classes
export function parseMumzworld(html: string, url: string): ProductData {
  const $ = cheerio.load(html);

  // ── Name ──────────────────────────────────────────────────────────────────
  const productName =
    $('span[itemprop="name"]').first().text().trim() ||
    $('.page-title .base').first().text().trim() ||
    $('h1.product-name').first().text().trim() ||
    $('h1').first().text().trim() ||
    null;

  // ── Price ─────────────────────────────────────────────────────────────────
  let price: number | null = null;
  let currency: string | null = 'AED';

  const metaPrice = $('meta[itemprop="price"]').attr('content');
  if (metaPrice) {
    price = parseFloat(metaPrice);
  } else {
    const priceText =
      $('[data-price-type="finalPrice"] .price').first().text() ||
      $('.product-info-price .price').first().text() ||
      $('.price-box .price').first().text() ||
      $('[class*="product-price"]').first().text();

    const match = priceText.match(/([\d,]+\.?\d*)/);
    if (match) price = parseFloat(match[1].replace(/,/g, ''));
  }

  const metaCurrency = $('meta[itemprop="priceCurrency"]').attr('content');
  if (metaCurrency) currency = metaCurrency;

  // ── Images — collect all product gallery images ───────────────────────────
  const imageUrls: string[] = [];
  $('img').each((_, el) => {
    const src = $(el).attr('src') || '';
    if ((src.includes('mumzworld') || src.includes('media/catalog/product') || src.includes('s3-pwa-prod')) && !src.includes('placeholder') && !src.includes('logo')) {
      if (!imageUrls.includes(src)) imageUrls.push(src);
    }
  });
  const imageUrl: string | null = imageUrls[0] || null;

  // ── Rating ────────────────────────────────────────────────────────────────
  let ratings: number | null = null;
  let reviewCount: number | null = null;

  const ratingMeta = $('[itemprop="ratingValue"]').attr('content') || $('[itemprop="ratingValue"]').text();
  if (ratingMeta) ratings = parseFloat(ratingMeta);

  if (ratings === null) {
    const ratingTitle = $('.rating-result').attr('title') || '';
    const pctMatch = ratingTitle.match(/([\d.]+)%/);
    if (pctMatch) ratings = Math.round((parseFloat(pctMatch[1]) / 100) * 5 * 10) / 10;
  }

  const reviewMeta = $('[itemprop="reviewCount"]').attr('content') || $('[itemprop="reviewCount"]').text();
  const reviewMatch = reviewMeta.match(/\d+/);
  if (reviewMatch) reviewCount = parseInt(reviewMatch[0], 10);

  // ── Stock ─────────────────────────────────────────────────────────────────
  let inStock: boolean | null = null;
  const availEl = $('[itemprop="availability"]').attr('href') || $('[itemprop="availability"]').attr('content') || '';
  if (availEl) inStock = /InStock/i.test(availEl);
  if (inStock === null) {
    inStock = $('.stock.available').length > 0 ? true : ($('.stock.unavailable').length > 0 ? false : null);
  }
  // Current pages carry stock only in the JSON-LD Product offer
  if (inStock === null) {
    $('script[type="application/ld+json"]').each((_, el) => {
      if (inStock !== null) return;
      try {
        const nodes = [].concat(JSON.parse($(el).html() || '{}'));
        const product: any = nodes.find((n: any) => n?.['@type'] === 'Product');
        const offer = [].concat(product?.offers ?? [])[0] as any;
        if (typeof offer?.availability === 'string') inStock = /InStock/i.test(offer.availability);
      } catch {}
    });
  }

  // ── Description ───────────────────────────────────────────────────────────
  let description: string | null = null;
  const descEl =
    $('.product.attribute.description .value').text().trim() ||
    $('.product-info-description .value').text().trim() ||
    $('[itemprop="description"]').text().trim();
  if (descEl.length > 20) description = descEl.slice(0, 500);

  // ── JSON-LD fallback ──────────────────────────────────────────────────────
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const json = JSON.parse($(el).html() || '{}');
      const data = Array.isArray(json) ? json.find(j => j['@type'] === 'Product') : json;
      if (data?.['@type'] === 'Product') {
        if (price === null && data.offers?.price) price = parseFloat(String(data.offers.price));
        if (!description && data.description) description = String(data.description).slice(0, 500);
      }
    } catch {}
  });

  return {
    productName: productName || null,
    productUrl: url,
    imageUrl,
    imageUrls,
    price: price && !isNaN(price) ? price : null,
    currency,
    ratings,
    reviewCount,
    description,
    inStock,
    category: null,
  };
}
