import * as cheerio from 'cheerio';
import { ProductData } from './types';

function positive(value: unknown): number | null {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function jsonLdPrice(offers: any): number | null {
  const offer = Array.isArray(offers) ? offers[0] : offers;
  return positive(offer?.price ?? offer?.lowPrice);
}

// Product ID is the last path segment: /mafuae/en/.../p/8806095528922
function ownFinalPrice(html: string, url: string): number | null {
  const id = url.match(/\/p\/([A-Za-z0-9]+)/)?.[1];
  if (!id) return null;
  // Flight data is JSON with optional escaping (\\"); look only in the record that follows the ID
  const re = new RegExp(`${id}[\\s\\S]{0,1500}?finalPrice\\\\*":\\\\*"([\\d.]+)`);
  return positive(html.match(re)?.[1]);
}

export function parseCarrefour(html: string, url: string): ProductData {
  const $ = cheerio.load(html);
  const safeHtml = typeof html === 'string' ? html : '';

  // --- JSON-LD Product — name, image, inStock and (current pages) the selling price ---
  let jsonLd: any = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (jsonLd) return;
    try {
      const parsed = JSON.parse($(el).html() || '{}');
      if (parsed['@type'] === 'Product') jsonLd = parsed;
    } catch {}
  });

  const offers = jsonLd?.offers;
  const currency = offers?.priceCurrency || 'AED';
  const inStock = offers?.availability
    ? offers.availability.includes('InStock')
    : !safeHtml.toLowerCase().includes('out of stock');

  const imageRaw = jsonLd?.image;
  const imageUrls: string[] = Array.isArray(imageRaw) ? imageRaw.filter(Boolean) : (imageRaw ? [imageRaw] : []);
  const imageUrl: string | null = imageUrls[0] || null;
  const productName = jsonLd?.name || $('h1').first().text().trim() || null;

  // --- Price ---
  // The page embeds finalPrice for every product it shows (recommendations, accessories), so the
  // first finalPrice on the page is usually someone else's (e.g. 208 AED on an S24 Ultra page).
  // 1. JSON-LD offer price  2. finalPrice that follows this product's own ID  3. unknown
  const price = jsonLdPrice(offers) ?? ownFinalPrice(safeHtml, url);

  // --- Ratings & review count from pdpResponse ---
  const ratingMatch = safeHtml.match(/averageRating\\*":\\*"([\d.]+)/);
  const ratings = ratingMatch ? parseFloat(ratingMatch[1]) : null;

  const reviewTextMatch = safeHtml.match(/totalReviewsText\\*":\\*"[^"\\]*\(+__?(\d+)[^"\\]*/);
  const reviewCount = reviewTextMatch ? parseInt(reviewTextMatch[1], 10) : null;

  // --- Description — collect product <p> elements, skip cookie/legal boilerplate ---
  const descParagraphs: string[] = [];
  $('p').each((_, el) => {
    const text = $(el).text().trim();
    if (
      text.length > 80 &&
      !text.toLowerCase().includes('cookie') &&
      !text.toLowerCase().includes('privacy policy') &&
      !text.toLowerCase().includes('by clicking')
    ) {
      descParagraphs.push(text);
    }
  });
  const description = descParagraphs.length > 0
    ? descParagraphs.slice(0, 3).join(' | ')
    : null;

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
