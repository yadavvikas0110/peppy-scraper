import * as cheerio from 'cheerio';

// Single-segment category pages that look like product URLs (/mobile-phones.html)
const JUMBO_CATEGORY_SLUGS = new Set([
  'mobile-phones', 'television-home-theaters', 'headphones-speakers', 'cameras', 'wearables',
  'gaming', 'home-appliances', 'health-and-personal-care', 'personal-computers', 'accessories',
  'smart-home', 'deals', 'offers', 'brands', 'new-arrivals', 'clearance',
]);

// Product slugs are long descriptive titles (brand-model-variant-colour-storage);
// category slugs are one to three words
const MIN_PRODUCT_SLUG_WORDS = 4;

export function parseJumboSearch(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const links = new Set<string>();
  const base = 'https://www.jumbo.ae';

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const full = href.startsWith('http') ? href : `${base}${href.startsWith('/') ? href : '/' + href}`;

    const clean = full.split('?')[0].split('#')[0];
    if (!full.includes('jumbo.ae') || !clean.endsWith('.html')) return;
    // Product pages: exactly one path segment — /product-slug.html
    // Category pages: /personal-computers/laptops.html (multiple segments) — exclude
    const segments = new URL(clean).pathname.split('/').filter(Boolean);
    if (segments.length !== 1) return;

    const slug = segments[0].replace(/\.html$/, '');
    if (JUMBO_CATEGORY_SLUGS.has(slug)) return;
    if (slug.split('-').filter(Boolean).length < MIN_PRODUCT_SLUG_WORDS) return;
    links.add(clean);
  });

  return Array.from(links);
}
