/// <reference types="node" />
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowed, parseRobots } from '../../src/custom/core/robots';
import { HostRateLimiter, HttpFetcher, isBlockPage, RobotsDisallowedError, SiteBlockedError } from '../../src/custom/core/http';
import { cleanName, mergeProducts, normalizeImages, toPrice } from '../../src/custom/core/normalize';
import { extractJsonLdProduct } from '../../src/custom/core/jsonld';
import { coverage, validateProduct } from '../../src/custom/core/validate';

describe('robots.txt', () => {
  const rules = parseRobots([
    'User-agent: GPTBot', 'Disallow: /',
    '', 'User-agent: *', 'Disallow: /search/', 'Disallow: /*cart$', 'Disallow: *?post_type', 'Allow: /search/help',
  ].join('\n'));

  test('applies only the * group', () => {
    assert.equal(isAllowed(rules, '/en/strollers'), true);
    assert.equal(isAllowed(rules, '/search/?q=x'), false);
  });
  test('wildcards and $ anchor', () => {
    assert.equal(isAllowed(rules, '/en/cart'), false);
    assert.equal(isAllowed(rules, '/en/cart/items'), true);
    assert.equal(isAllowed(rules, '/?post_type=product'), false);
    assert.equal(isAllowed(rules, '/?q=a&post_type=product'), true); // literal "?post_type" only
  });
  test('longest match wins; Allow wins a tie', () => {
    assert.equal(isAllowed(rules, '/search/help'), true);
  });
  test('empty Disallow allows everything', () => {
    assert.equal(isAllowed(parseRobots('User-agent: *\nDisallow:'), '/anything'), true);
  });
});

describe('HTTP fetcher', () => {
  const opts = { userAgent: 'test', minIntervalMs: 0, timeoutMs: 5000, maxRetries: 1, respectRobots: true };
  const noSleep = async () => {};
  const res = (status: number, body: string) => ({ status, url: '', text: async () => body } as unknown as Response);

  test('rate limiter spaces calls to the same host', async () => {
    let clock = 0;
    const waits: number[] = [];
    const limiter = new HostRateLimiter(2000, () => clock, async ms => { waits.push(ms); });
    await limiter.wait('a.com');
    await limiter.wait('a.com');
    await limiter.wait('b.com');
    assert.deepEqual(waits, [2000]);
  });

  test('refuses URLs robots.txt disallows, without fetching them', async () => {
    const seen: string[] = [];
    const f = new HttpFetcher(opts, async (u: string) => { seen.push(u); return u.endsWith('/robots.txt') ? res(200, 'User-agent: *\nDisallow: /search/') : res(200, '<title>ok</title>'); }, noSleep);
    await assert.rejects(f.get('https://x.com/search/?q=1'), RobotsDisallowedError);
    assert.equal((await f.get('https://x.com/en/p')).status, 200);
    assert.deepEqual(seen, ['https://x.com/robots.txt', 'https://x.com/en/p']);
  });

  test('unreachable robots.txt means disallowed', async () => {
    const f = new HttpFetcher(opts, async (u: string) => { if (u.endsWith('/robots.txt')) throw new Error('timeout'); return res(200, 'x'); }, noSleep);
    await assert.rejects(f.get('https://x.com/a'), RobotsDisallowedError);
  });

  test('anti-bot page stops the site instead of retrying', async () => {
    let calls = 0;
    const f = new HttpFetcher(opts, async (u: string) => u.endsWith('/robots.txt') ? res(404, '') : (calls++, res(403, '<title>Just a moment...</title>')), noSleep);
    await assert.rejects(f.get('https://x.com/p'), SiteBlockedError);
    assert.equal(calls, 1);
  });

  test('retries 5xx, then succeeds', async () => {
    let calls = 0;
    const f = new HttpFetcher(opts, async (u: string) => u.endsWith('/robots.txt') ? res(404, '') : (++calls === 1 ? res(503, '') : res(200, 'ok')), noSleep);
    assert.equal((await f.get('https://x.com/p')).body, 'ok');
    assert.equal(calls, 2);
  });

  test('consecutive 403s stop the site; a 200 in between resets the streak', async () => {
    const statuses = [403, 200, 403, 403, 403];
    let i = 0;
    const f = new HttpFetcher(opts, async (u: string) => u.endsWith('/robots.txt') ? res(404, '') : res(statuses[i++], '<title>x</title>'), noSleep);
    assert.equal((await f.get('https://x.com/1')).status, 403);
    assert.equal((await f.get('https://x.com/2')).status, 200);
    assert.equal((await f.get('https://x.com/3')).status, 403);
    assert.equal((await f.get('https://x.com/4')).status, 403);
    await assert.rejects(f.get('https://x.com/5'), SiteBlockedError);
  });

  test('still 429 after retries stops the site', async () => {
    const f = new HttpFetcher(opts, async (u: string) => u.endsWith('/robots.txt') ? res(404, '') : res(429, ''), noSleep);
    await assert.rejects(f.get('https://x.com/p'), (e: any) => e instanceof SiteBlockedError && /429/.test(e.message));
  });

  test('a redirect onto a robots-disallowed path is refused', async () => {
    const f = new HttpFetcher(opts, async (u: string) => u.endsWith('/robots.txt')
      ? res(200, 'User-agent: *\nDisallow: /search/')
      : ({ status: 200, url: 'https://x.com/search/?q=a', text: async () => 'ok' } as unknown as Response), noSleep);
    await assert.rejects(f.get('https://x.com/old-product'), RobotsDisallowedError);
  });

  test('robots.txt answering 429 means disallowed', async () => {
    const f = new HttpFetcher(opts, async (u: string) => u.endsWith('/robots.txt') ? res(429, '') : res(200, 'x'), noSleep);
    await assert.rejects(f.get('https://x.com/a'), RobotsDisallowedError);
  });

  test('block page detection', () => {
    assert.equal(isBlockPage('<title>Just a moment...</title>'), true);
    assert.equal(isBlockPage('<title>Buy shoes | Namshi</title>'), false);
  });
});

describe('normalizers', () => {
  test('prices', () => {
    assert.equal(toPrice('1,299.00'), 1299);
    assert.equal(toPrice('AED 49.5'), 49.5);
    assert.equal(toPrice(0), null);
    assert.equal(toPrice('n/a'), null);
    assert.equal(toPrice(5_000_000), null);
  });
  test('images: absolute https, deduplicated', () => {
    assert.deepEqual(normalizeImages(['/a.jpg', 'http://cdn.x.com/b.jpg', 'https://cdn.x.com/b.jpg', 'data:x', null], 'https://www.x.com/p'),
      ['https://www.x.com/a.jpg', 'https://cdn.x.com/b.jpg']);
  });
  test('names lose SEO decoration', () => {
    assert.equal(cleanName('Asics Patriot 14 for Men | Best Price UAE'), 'Asics Patriot 14 for Men');
    assert.equal(cleanName('Buy Ella&#x27;s Kitchen Pie 130g in UAE | Mumzworld'), "Ella's Kitchen Pie 130g");
    assert.equal(cleanName('Apple iPhone 16 Pro Max | FREE DELIVERY | 1 Year Warranty'), 'Apple iPhone 16 Pro Max');
    assert.equal(cleanName('Apple iPhone 16 | FREE EXPRESS DELIVERY'), 'Apple iPhone 16');
  });
  test('variant segments after "|" are kept, so colours never merge', () => {
    assert.equal(cleanName('Apple iPhone 15 Pro Max 256GB | Natural Titanium'), 'Apple iPhone 15 Pro Max 256GB | Natural Titanium');
    assert.equal(cleanName('Ring in Uaebrand Edition'), 'Ring in Uaebrand Edition');
  });
  test('negative amounts are not prices', () => {
    assert.equal(toPrice('-5'), null);
    assert.equal(toPrice('AED -12.50'), null);
  });
});

const PRODUCT_LD = (extra: object = {}) => `<html><script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org', '@type': 'Product', name: 'Samsung Galaxy S25 Ultra 5G, 256 GB',
  sku: 'SM-S938', brand: { '@type': 'Brand', name: 'Samsung' }, description: 'Quad camera',
  image: ['https://mcprod.jumbo.ae/a.jpg', 'https://mcprod.jumbo.ae/b.jpg'],
  offers: { '@type': 'Offer', price: '3199', priceCurrency: 'AED', availability: 'https://schema.org/InStock' },
  aggregateRating: { ratingValue: '4.78', reviewCount: '25374' }, ...extra,
})}</script></html>`;

describe('JSON-LD extraction', () => {
  test('reads a schema.org Product', () => {
    assert.deepEqual(extractJsonLdProduct(PRODUCT_LD()), {
      productName: 'Samsung Galaxy S25 Ultra 5G, 256 GB',
      imageUrls: ['https://mcprod.jumbo.ae/a.jpg', 'https://mcprod.jumbo.ae/b.jpg'],
      price: 3199, currency: 'AED', inStock: true, description: 'Quad camera',
      ratings: 4.78, reviewCount: 25374, brand: 'Samsung', sku: 'SM-S938', category: null,
    });
  });
  test('brand as a string, out of stock, @graph', () => {
    const html = `<script type="application/ld+json">{"@graph":[{"@type":"WebSite"},{"@type":"Product","name":"Bag","brand":"Guess","offers":{"price":"450","priceCurrency":"AED","availability":"https://schema.org/OutOfStock"}}]}</script>`;
    const p = extractJsonLdProduct(html);
    assert.equal(p.brand, 'Guess');
    assert.equal(p.inStock, false);
    assert.equal(p.price, 450);
  });
  test('ratings are normalised to 0–5 (bestRating), unknown larger scales dropped', () => {
    assert.equal(extractJsonLdProduct(PRODUCT_LD({ aggregateRating: { ratingValue: '9', bestRating: '10', reviewCount: '4' } })).ratings, 4.5);
    assert.equal(extractJsonLdProduct(PRODUCT_LD({ aggregateRating: { ratingValue: '87', reviewCount: '4' } })).ratings, null);
  });
  test('no Product block → empty', () => {
    assert.deepEqual(extractJsonLdProduct('<script type="application/ld+json">{"@type":"Organization"}</script>'), {});
  });
  test('structured data wins; legacy parser fills gaps', () => {
    const merged = mergeProducts({ productName: 'A | Best Price', price: 10, currency: 'AED', imageUrls: ['https://x.com/1.jpg'] },
      { productName: 'ignored', description: 'from css', imageUrls: ['https://x.com/banner.jpg'], inStock: true }, 'https://x.com/p');
    assert.equal(merged.productName, 'A');
    assert.equal(merged.description, 'from css');
    assert.deepEqual(merged.imageUrls, ['https://x.com/1.jpg']); // page-wide <img> junk is not mixed in
    assert.equal(merged.inStock, true);
  });
  test('legacy images are used only when structured data has none', () => {
    const merged = mergeProducts({ productName: 'A' }, { imageUrls: ['https://x.com/2.jpg'] }, 'https://x.com/p');
    assert.deepEqual(merged.imageUrls, ['https://x.com/2.jpg']);
  });
});

describe('validation & coverage', () => {
  const ok = mergeProducts(extractJsonLdProduct(PRODUCT_LD()), {}, 'https://www.jumbo.ae/s25.html');
  test('valid product passes', () => assert.deepEqual(validateProduct(ok), { ok: true, reasons: [] }));
  test('missing price / non-AED / no image are rejected', () => {
    assert.deepEqual(validateProduct({ ...ok, price: null }).reasons, ['no price']);
    assert.deepEqual(validateProduct({ ...ok, currency: 'USD' }).reasons, ['currency USD (AED only)']);
    assert.deepEqual(validateProduct({ ...ok, imageUrls: [] }).reasons, ['no image']);
  });
  test('coverage percentages', () => {
    const c = coverage([ok, { ...ok, brand: null }]);
    assert.equal(c.price, 100);
    assert.equal(c.brand, 50);
  });
});
