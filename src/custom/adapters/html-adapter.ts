import type { ProductData } from '../../parsers/types';
import { extractJsonLdProduct } from '../core/jsonld';
import { mergeProducts } from '../core/normalize';
import type { CustomProduct } from '../core/types';

/**
 * Product page → product for HTML retailers: schema.org JSON-LD first, the existing
 * per-site parser (src/parsers/*.parser.ts) fills any field JSON-LD lacks.
 */
export function extractHtmlProduct(
  html: string,
  url: string,
  legacyParser: (html: string, url: string) => ProductData,
): CustomProduct {
  let legacy: Partial<CustomProduct> = {};
  try { legacy = legacyParser(html, url); } catch { /* the legacy parser is a fallback only */ }
  return mergeProducts(extractJsonLdProduct(html), legacy, url);
}

/** Absolute, query/fragment-free product URL on `origin`. */
export function absoluteUrl(href: string, origin: string): string {
  const u = new URL(href, origin);
  u.search = '';
  u.hash = '';
  return u.toString();
}
