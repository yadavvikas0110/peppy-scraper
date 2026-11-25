/// <reference types="node" />
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ScrapeDoError } from '../../../src/shared/scrapedo/scrapedo.errors';
import { profileForUrl, rungsFor } from '../../../src/shared/scrapedo/scrapedo.profiles';
import { createProfiledFetcher, ScrapeDoAccountError, ScrapeDoCircuitOpenError, ScrapeDoNotFoundError, ScrapeDoUnreadablePageError } from '../../../src/shared/scrapedo/scrapedo.fetcher';
import { scrapeDoEnabledFor, scrapeDoPlatforms, scrapeProductViaScrapeDo } from '../../../src/services/scrapedo-transport';
import { siteSupport } from '../../../src/config/transport-policy';
import { parseNoon } from '../../../src/parsers/noon.parser';
import { fillFromJsonLd } from '../../../src/parsers/jsonld';
import { parseJumboSearch } from '../../../src/parsers/search/jumbo.search.parser';

const ok = (html: string, cost = 1) => ({ html, statusCode: 200, finalUrl: '', targetUrl: '', requestCost: cost, attempts: 1, durationMs: 1 });
const err = (category: any, statusCode?: number) => new ScrapeDoError({ category, message: `${category} ${statusCode ?? ''}`.trim(), statusCode });

function fakeClient(script: Array<(opts: any) => any>) {
  const calls: any[] = [];
  return {
    calls,
    client: { fetchHtml: async (_url: string, opts: any) => { calls.push(opts); const step = script[calls.length - 1]; if (!step) throw new Error('unexpected call'); return step(opts); } },
  };
}
const quiet = { log() {}, warn() {} };
const noSleep = async () => {};

describe('Scrape.do profiles', () => {
  test('hosts map to the measured profiles; minutes.noon.com is grocery, not noon.com shopping', () => {
    assert.equal(profileForUrl('https://www.noon.com/uae-en/x/p/')?.key, 'noon');
    assert.equal(profileForUrl('https://minutes.noon.com/uae-en/search/')?.key, 'noon-minutes');
    assert.equal(profileForUrl('https://uae.sharafdg.com/c/x/')?.key, 'sharafdg');
    assert.equal(profileForUrl('https://example.com/')?.key, undefined);
  });

  test('cheapest measured option first', () => {
    assert.equal(rungsFor('https://www.amazon.ae/s?k=x', 'listing').rungs[0].label, 'plain');
    assert.equal(rungsFor('https://www.carrefouruae.com/mafuae/en/p/1', 'product').rungs[0].label, 'residential-uae');
    assert.equal(rungsFor('https://uae.sharafdg.com/c/x/', 'listing').rungs[0].label, 'uae-ip');
    assert.equal(rungsFor('https://deliveroo.ae/en/menu/x', 'listing').rungs[0].label, 'uae-ip');
    const jumbo = rungsFor('https://www.jumbo.ae/mobile-phones.html', 'listing').rungs[0];
    assert.equal(jumbo.options.render, true);
    assert.equal(jumbo.options.customWait, 8000);
  });
});

describe('profiled fetch: retry rules', () => {
  test('timeouts and shop 502s escalate to the next option; credits count only successes', async () => {
    const f = fakeClient([() => { throw err('timeout'); }, () => ok('<html>products</html>', 1)]);
    const fetcher = createProfiledFetcher({ client: f.client as any, logger: quiet, sleep: noSleep });
    const r = await fetcher.fetch('https://www.amazon.ae/s?k=x', { kind: 'listing' });
    assert.equal(r.rung, 'uae-ip');
    assert.equal(r.credits, 1);
    assert.equal(f.calls[0].client.maxRetries, 0);       // our client never multiplies attempts
    assert.equal(typeof f.calls[0].timeout, 'number');   // per-rung Scrape.do timeout
    assert.equal(fetcher.usage().byPlatform.amazon.rungs['uae-ip'], 1);
  });

  test('a page without the expected data (or an anti-bot page) escalates', async () => {
    const f = fakeClient([
      () => ok('<title>Access Denied</title>'),
      () => ok('<html>no links</html>'),
      () => ok('<html>LINKS</html>', 10),
    ]);
    const fetcher = createProfiledFetcher({ client: f.client as any, logger: quiet, sleep: noSleep });
    const r = await fetcher.fetch('https://www.namshi.com/uae-en/women/', { kind: 'listing', isUsable: h => h.includes('LINKS') });
    assert.equal(r.rung, 'residential-uae');
    assert.equal(r.credits, 1 + 1 + 10);
  });

  test('two normal pages our parser cannot read → stop (parser problem), no third, pricier option', async () => {
    const f = fakeClient([() => ok('<html>a</html>', 1), () => ok('<html>b</html>', 1)]);
    const fetcher = createProfiledFetcher({ client: f.client as any, logger: quiet, sleep: noSleep });
    await assert.rejects(fetcher.fetch('https://www.amazon.ae/dp/X', { kind: 'product', isUsable: () => false }), ScrapeDoUnreadablePageError);
    assert.equal(f.calls.length, 2);
    assert.equal(fetcher.usage().credits, 2);
  });

  test('account problems stop immediately; 404 is not escalated', async () => {
    const a = createProfiledFetcher({ client: fakeClient([() => { throw err('quota'); }]).client as any, logger: quiet, sleep: noSleep });
    await assert.rejects(a.fetch('https://www.amazon.ae/dp/X', { kind: 'product' }), ScrapeDoAccountError);
    const nf = fakeClient([() => { throw err('target_4xx', 404); }]);
    const b = createProfiledFetcher({ client: nf.client as any, logger: quiet, sleep: noSleep });
    await assert.rejects(b.fetch('https://www.amazon.ae/dp/X', { kind: 'product' }), ScrapeDoNotFoundError);
    assert.equal(nf.calls.length, 1);
  });

  test('all options failed with a temporary error → one delayed retry of the cheapest such option', async () => {
    const f = fakeClient([() => { throw err('timeout'); }, () => { throw err('blocked'); }, () => { throw err('blocked'); }, () => ok('<html>x</html>')]);
    let slept = 0;
    const fetcher = createProfiledFetcher({ client: f.client as any, logger: quiet, sleep: async ms => { slept = ms; }, retryDelayMs: 1234 });
    const r = await fetcher.fetch('https://www.mumzworld.com/en/x', { kind: 'listing' });
    assert.equal(r.rung, 'plain');
    assert.equal(slept, 1234);
    assert.equal(f.calls.length, 4);
  });

  test('circuit breaker pauses a platform after N failed pages, other platforms unaffected', async () => {
    let t = 0;
    const always = { fetchHtml: async (url: string) => { if (url.includes('noon.com')) throw err('blocked'); return ok('<html>x</html>'); } };
    const fetcher = createProfiledFetcher({ client: always as any, logger: quiet, sleep: noSleep, breakerFailures: 2, breakerCooldownMs: 60_000, now: () => t });
    for (let i = 0; i < 2; i++) await assert.rejects(fetcher.fetch('https://www.noon.com/uae-en/a/p/', { kind: 'product' }));
    await assert.rejects(fetcher.fetch('https://www.noon.com/uae-en/b/p/', { kind: 'product' }), ScrapeDoCircuitOpenError);
    assert.ok(await fetcher.fetch('https://www.amazon.ae/dp/X', { kind: 'product' }));
    t = 61_000;
    await assert.rejects(fetcher.fetch('https://www.noon.com/uae-en/c/p/', { kind: 'product' }), e => !(e instanceof ScrapeDoCircuitOpenError));
  });
});

describe('switching platforms to Scrape.do', () => {
  test('SCRAPE_DO_SITES selects platforms; nothing without a token; unset = Bright Data unchanged', () => {
    assert.deepEqual([...scrapeDoPlatforms({ SCRAPE_DO_SITES: 'amazon, noon,unknown' })], ['amazon', 'noon']);
    assert.equal(scrapeDoPlatforms({ SCRAPE_DO_SITES: 'all' }).has('noon-minutes'), true);
    assert.equal(scrapeDoEnabledFor('amazon', { SCRAPE_DO_SITES: 'amazon' }), false);
    assert.equal(scrapeDoEnabledFor('amazon', { SCRAPE_DO_SITES: 'amazon', SCRAPE_DO_TOKEN: 't' }), true);
    assert.equal(scrapeDoEnabledFor('amazon', { SCRAPE_DO_TOKEN: 't' }), false);
  });

  test('Noon becomes supported when it runs on Scrape.do', () => {
    assert.equal(siteSupport('noon', {}).supported, false);
    assert.equal(siteSupport('noon', { SCRAPE_DO_SITES: 'noon', SCRAPE_DO_TOKEN: 't' }).supported, true);
  });

  test('product pages are validated with our parser: a shell without the product escalates', async () => {
    const f = fakeClient([() => ok('<html><body>loading…</body></html>'), () => ok('<html><h1>Phone X</h1><div data-qa="div-price-now">2,699.00</div></html>')]);
    const fetcher = createProfiledFetcher({ client: f.client as any, logger: quiet, sleep: noSleep });
    const p = await scrapeProductViaScrapeDo('https://www.noon.com/uae-en/phone-x/N1/p/', fetcher);
    assert.equal(p.price, 2699);
    assert.equal(f.calls.length, 2);
  });

  test('a product page without a price (no seller offer) is accepted, not escalated to pricier IPs', async () => {
    const f = fakeClient([() => ok('<html><h1>Phone X</h1></html>')]);
    const fetcher = createProfiledFetcher({ client: f.client as any, logger: quiet, sleep: noSleep });
    const p = await scrapeProductViaScrapeDo('https://www.noon.com/uae-en/phone-x/N1/p/', fetcher);
    assert.equal(p.productName, 'Phone X');
    assert.equal(p.price, null);
    assert.equal(f.calls.length, 1);
  });
});

describe('JSON-LD fills what the site parser missed', () => {
  const ld = `<script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: 'iPhone 16', image: ['https://f.nooncdn.com/a.jpg'], aggregateRating: { ratingValue: 4.6, reviewCount: 18112, bestRating: 5 }, offers: { price: '2699', priceCurrency: 'AED', availability: 'https://schema.org/InStock' } })}</script>`;

  test('Noon: rating, reviews and stock come from JSON-LD when the widgets are not in the HTML', () => {
    const p = parseNoon(`<html><h1>iPhone 16</h1><div data-qa="div-price-now">2699.00</div>${ld}</html>`, 'https://www.noon.com/uae-en/x/N1/p/');
    assert.equal(p.ratings, 4.6);
    assert.equal(p.reviewCount, 18112);
    assert.equal(p.inStock, true);
    assert.equal(p.price, 2699);
  });

  test('never overwrites a value the site parser found', () => {
    const base: any = { productName: 'From page', price: 10, currency: 'AED', ratings: 3.9, reviewCount: 5, inStock: false, imageUrls: ['x'], imageUrl: 'x', description: 'd', productUrl: 'u', category: null };
    assert.deepEqual(fillFromJsonLd(base, ld), base);
  });
});

describe('Jumbo listing parser', () => {
  test('skips deal hubs and advance-payment pages', () => {
    const html = ['deal-of-the-day', 'advance-for-iphone-17-pro-preorder', 'apple-iphone-17-pro-256gb-cosmic-orange']
      .map(s => `<a href="/${s}.html">x</a>`).join('');
    assert.deepEqual(parseJumboSearch(html, 'https://www.jumbo.ae/mobile-phones.html'), ['https://www.jumbo.ae/apple-iphone-17-pro-256gb-cosmic-orange.html']);
  });
});

describe('review fixes (Nov 2026)', () => {
  test('a parser that throws on a delivered page: credits are counted and it is treated as unreadable, not temporary', async () => {
    const f = fakeClient([() => ok('<html><title>a</title>page one</html>', 10), () => ok('<html><title>b</title>page two</html>', 25)]);
    let slept = 0;
    const fetcher = createProfiledFetcher({ client: f.client as any, logger: quiet, sleep: async () => { slept++; } });
    await assert.rejects(
      fetcher.fetch('https://www.amazon.ae/dp/B0DGHYDZR9', { kind: 'product', isUsable: () => { throw new Error('parser exploded'); } }),
      (e: unknown) => e instanceof ScrapeDoUnreadablePageError,
    );
    assert.equal(f.calls.length, 2, 'two options, no delayed "temporary" retry');
    assert.equal(slept, 0);
    assert.equal(fetcher.usage().credits, 35, 'charged pages are counted');
  });

  test('listing page 2+ may be empty: one fetch, no escalation; page 1 stays strict', async () => {
    const { fetchListingViaScrapeDo } = await import('../../../src/services/scrapedo-transport');
    const empty = '<!DOCTYPE html><html><head><title>Mobile Phones | Jumbo</title></head><body>' + 'x'.repeat(3000) + '<p>No products found</p></body></html>';
    const later = fakeClient([() => ok(empty)]);
    const html = await fetchListingViaScrapeDo('https://www.jumbo.ae/mobile-phones.html?pageNo=3', createProfiledFetcher({ client: later.client as any, logger: quiet, sleep: noSleep }), { allowEmpty: true });
    assert.equal(html, empty);
    assert.equal(later.calls.length, 1);

    const first = fakeClient([() => ok(empty), () => ok(empty)]);
    await assert.rejects(
      fetchListingViaScrapeDo('https://www.jumbo.ae/mobile-phones.html?pageNo=1', createProfiledFetcher({ client: first.client as any, logger: quiet, sleep: noSleep })),
      (e: unknown) => e instanceof ScrapeDoUnreadablePageError,
    );

    // A stub (no title, cut off) is never accepted as "empty"
    const stub = fakeClient([() => ok('<html><body>loading'), () => ok('<html><body>loading')]);
    await assert.rejects(fetchListingViaScrapeDo('https://www.jumbo.ae/mobile-phones.html?pageNo=2', createProfiledFetcher({ client: stub.client as any, logger: quiet, sleep: noSleep }), { allowEmpty: true }));
  });

  test('account and circuit errors are stop/pause errors for the scrape loop', async () => {
    const { isStopError, isPauseError } = await import('../../../src/services/playwright.service');
    assert.equal(isStopError(new ScrapeDoAccountError('x')), true);
    assert.equal(isPauseError(new ScrapeDoCircuitOpenError('x')), true);
    assert.equal(isStopError(new Error('Scrape.do could not fetch')), false);
    assert.equal(isPauseError(new Error('x')), false);
  });
});
