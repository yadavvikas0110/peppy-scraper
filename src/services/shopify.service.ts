import axios from 'axios';
import { ProductData } from '../parsers/types';

interface ShopifyVariant {
  id: number;
  title: string;
  price: string;
  available: boolean;
  sku: string;
}

interface ShopifyImage {
  src: string;
}

interface ShopifyProduct {
  id: number;
  title: string;
  handle: string;
  body_html: string;
  vendor: string;
  product_type: string;
  tags: string[];
  variants: ShopifyVariant[];
  images: ShopifyImage[];
}

interface ShopifyProductsResponse {
  products: ShopifyProduct[];
}

function htmlToText(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Every category word must appear as a whole word (plural allowed): "baby stroller" must not
// match "BaBylissPRO" or an adidas "Baby" jersey that has no stroller.
export function matchesCategory(product: ShopifyProduct, category: string): boolean {
  if (!category) return true;
  const tokens = category.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  const searchable = [
    product.title,
    product.product_type,
    product.vendor,
    ...(product.tags ?? []),
  ].join(' ').toLowerCase();
  return tokens.every(t => new RegExp(`\\b${escapeRegExp(t)}(?:s|es)?\\b`).test(searchable));
}

// Cheapest in-stock variant, falling back to the cheapest of all variants
function pickVariant(variants: ShopifyVariant[] | undefined): ShopifyVariant | undefined {
  const priced = (variants ?? []).filter(v => !isNaN(parseFloat(v.price)));
  const pool = priced.some(v => v.available) ? priced.filter(v => v.available) : priced;
  return pool.sort((a, b) => parseFloat(a.price) - parseFloat(b.price))[0];
}

export function mapShopifyProduct(product: ShopifyProduct, hostname: string): ProductData {
  const variant = pickVariant(product.variants);
  const price = variant ? parseFloat(variant.price) : null;
  const imageUrls = (product.images ?? []).map(i => i.src).filter(Boolean);
  const imageUrl = imageUrls[0] ?? null;
  const productUrl = `https://${hostname}/products/${product.handle}`;
  const description = product.body_html ? htmlToText(product.body_html).slice(0, 500) : null;

  return {
    productName: product.title || null,
    productUrl,
    imageUrl,
    imageUrls,
    price: price && !isNaN(price) ? price : null,
    currency: 'AED',
    ratings: null,
    reviewCount: null,
    description,
    inStock: variant?.available ?? null,
    category: product.product_type || null,
  };
}

export async function collectShopifyProducts(
  hostname: string,
  category: string,
  count: number,
): Promise<ProductData[]> {
  const results: ProductData[] = [];
  let page = 1;

  while (results.length < count) {
    const url = `https://${hostname}/products.json?limit=250&page=${page}`;
    let data: ShopifyProductsResponse;

    try {
      const res = await axios.get<ShopifyProductsResponse>(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
        timeout: 30000,
      });
      data = res.data;
    } catch (e: any) {
      console.error(`[shopify:${hostname}] Page ${page} failed: ${e.message}`);
      break;
    }

    if (!data.products?.length) break;

    const matched = category
      ? data.products.filter(p => matchesCategory(p, category))
      : data.products;

    for (const p of matched) {
      if (results.length >= count) break;
      const mapped = mapShopifyProduct(p, hostname);
      if (mapped.price !== null) results.push(mapped);
    }

    if (data.products.length < 250) break; // last page
    page++;
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`[shopify:${hostname}] Collected ${results.length} products for "${category}"`);
  return results.slice(0, count);
}
