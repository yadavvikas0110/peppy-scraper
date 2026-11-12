import type { CustomProduct } from './types';

export interface Validation {
  ok: boolean;
  reasons: string[];
}

/** A product is stored only with a name, an AED price, an image and a URL. Stock may stay unknown. */
export function validateProduct(p: CustomProduct): Validation {
  const reasons: string[] = [];
  if (!p.productName) reasons.push('no name');
  if (p.price === null) reasons.push('no price');
  else if (p.currency !== 'AED') reasons.push(`currency ${p.currency ?? 'unknown'} (AED only)`);
  if (!p.imageUrls.length) reasons.push('no image');
  if (!p.productUrl) reasons.push('no URL');
  return { ok: reasons.length === 0, reasons };
}

const FIELDS: Array<[string, (p: CustomProduct) => boolean]> = [
  ['name', p => !!p.productName],
  ['price', p => p.price !== null],
  ['image', p => p.imageUrls.length > 0],
  ['multipleImages', p => p.imageUrls.length > 1],
  ['description', p => !!p.description],
  ['stockKnown', p => p.inStock !== null],
  ['brand', p => !!p.brand],
  ['sku', p => !!p.sku],
  ['rating', p => p.ratings !== null],
  ['originalPrice', p => p.originalPrice != null],
];

/** Share of products (0–100) that carry each field. */
export function coverage(products: CustomProduct[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, has] of FIELDS) {
    out[name] = products.length ? Math.round((products.filter(has).length / products.length) * 100) : 0;
  }
  return out;
}
