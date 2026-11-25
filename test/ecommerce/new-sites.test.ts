/// <reference types="node" />
/**
 * Ounass, Centrepoint and Home Centre (Priority-1 shopping sites added for the Scrape.do bulk pipeline).
 * Fixtures are trimmed copies of live pages (Nov 2026): the page structure is real, only unused fields
 * and other products were removed — see test/ecommerce/fixtures/.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { parseLandmark, parseLandmarkSearch, landmarkState, landmarkPageCount } from '../../src/parsers/landmark.parser';
import { parseOunass, parseOunassSearch, ounassState } from '../../src/parsers/ounass.parser';
import { SITES, SITE_KEYS } from '../../src/config/sites';
import { marketplaceIdFor, offerIdentityKey } from '../../src/services/product-identity';
import { siteSupport } from '../../src/config/transport-policy';
import { profileForUrl, rungsFor } from '../../src/shared/scrapedo/scrapedo.profiles';
import { scrapeProductViaScrapeDo, fetchListingViaScrapeDo } from '../../src/services/scrapedo-transport';
import { createProfiledFetcher } from '../../src/shared/scrapedo/scrapedo.fetcher';
import { normalizeGtin } from '../../src/parsers/types';
import { buildOffer } from '../../src/services/bundler.service';
import { loadCatalog, parseCatalog } from '../../src/shopping/shopping-bulk';

const fx = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

const HC_URL = 'https://www.homecentre.com/ae/en/buy-lusso-office-chair/p/168661612';
const CP_URL = 'https://www.centrepointstores.com/ae/en/buy-trouble-maker-fact-check-palette/p/169238442';
const OUNASS_URL = 'https://www.ounass.ae/shop-skims-soft-smoothing-t-shirt-for-women-215328498_2755.html';

describe('Landmark parser (Home Centre product page)', () => {
  const p = parseLandmark(fx('homecentre-product.html'), HC_URL);

  test('reads the live sale price from the variant, not the base price in JSON-LD', () => {
    assert.equal(p.productName, 'Lusso Office Chair');
    assert.equal(p.price, 1399, 'variant priceInfo.price is what the customer pays');
    assert.equal(p.originalPrice, 1999, 'JSON-LD / defaultPrice is the struck-through price');
    assert.equal(p.currency, 'AED');
  });

  test('gallery of this variant only (no swatches), stock, brand, barcode, breadcrumbs', () => {
    assert.ok(p.imageUrls.length >= 10, `expected the full gallery, got ${p.imageUrls.length}`);
    assert.ok(p.imageUrls.every(u => /\/168661612-/.test(u) && !/swatch/.test(u)));
    assert.equal(p.imageUrl, p.imageUrls[0]);
    assert.equal(p.inStock, true);
    assert.equal(p.brand, 'Home Centre');
    assert.equal(p.gtin, '6292495613436');
    assert.equal(p.sku, '168661612');
    assert.match(p.category ?? '', /^Furniture > /);
  });
});

describe('Landmark parser (Centrepoint product page — same platform)', () => {
  const p = parseLandmark(fx('centrepoint-product.html'), CP_URL);

  test('picks the variant in the URL among four shades', () => {
    assert.equal(p.productName, 'Trouble Maker Fact Check Palette');
    assert.equal(p.price, 55);
    assert.equal(p.originalPrice, 79);
    assert.equal(p.gtin, '5061091862330', 'EAN of variant 169238442, not of a sibling shade');
    assert.ok(p.imageUrls.length >= 1 && p.imageUrls.every(u => /\/169238442-/.test(u)));
    assert.equal(p.brand, 'Trouble Maker');
  });

  test('a variant switched offline is unavailable; a page without state falls back to JSON-LD', () => {
    const html = fx('centrepoint-product.html');
    const state = landmarkState(html);
    const v = state.productPageReducerBL.data.variants.find((x: any) => x.sku === '169238442');
    v.online = false;
    const encoded = Buffer.from(JSON.stringify(state)).toString('base64');
    const offline = html.replace(/("initialState":\s*")[^"]+"/, `$1${encoded}"`);
    assert.equal(parseLandmark(offline, CP_URL).inStock, false);

    const ldOnly = html.replace(/<script id="__NEXT_DATA__"[\s\S]*?<\/script>/, '');
    const q = parseLandmark(ldOnly, CP_URL);
    assert.equal(q.productName, 'Trouble Maker Fact Check Palette');
    assert.equal(q.price, 79, 'without state only the JSON-LD (base) price is known');
    assert.equal(q.inStock, true);
  });
});

describe('Landmark listing parser', () => {
  test('Home Centre: absolute product URLs from the listing state; page count', () => {
    const html = fx('homecentre-listing.html');
    const links = parseLandmarkSearch(html, 'https://www.homecentre.com/ae/en/c/household-appliances-kitchenappliances-airfryers');
    assert.equal(links.length, 6);
    assert.ok(links.every(l => /^https:\/\/www\.homecentre\.com\/ae\/en\/buy-.+\/p\/\d+$/.test(l)), links[0]);
    assert.equal(landmarkPageCount(html), 1);
  });

  test('Centrepoint: same shape, 102 pages', () => {
    const html = fx('centrepoint-listing.html');
    const links = parseLandmarkSearch(html, 'https://www.centrepointstores.com/ae/en/c/beautyandpersonalcare?p=2');
    assert.ok(links.length > 0 && links.every(l => l.startsWith('https://www.centrepointstores.com/ae/en/buy-')));
    assert.equal(landmarkPageCount(html), 102);
  });

  test('falls back to plain anchors; a page without products gives no links', () => {
    const anchors = '<a href="/ae/en/buy-some-sofa/p/169023484">x</a><a href="/ae/en/c/furniture">cat</a>';
    assert.deepEqual(parseLandmarkSearch(anchors, 'https://www.homecentre.com/ae/en/c/furniture'), ['https://www.homecentre.com/ae/en/buy-some-sofa/p/169023484']);
    assert.deepEqual(parseLandmarkSearch('<html><title>x</title></html>', 'https://www.homecentre.com/ae/en/c/x'), []);
  });
});

describe('Ounass parser', () => {
  const p = parseOunass(fx('ounass-product.html'), OUNASS_URL);

  test('designer + name as the title, price and slashed price, full-size https images', () => {
    assert.equal(p.productName, 'SKIMS Soft Smoothing T-shirt');
    assert.equal(p.price, 165);
    assert.equal(p.originalPrice, 280);
    assert.equal(p.brand, 'SKIMS');
    assert.equal(p.imageUrls.length, 4);
    assert.ok(p.imageUrls.every(u => u.startsWith('https://ounass-ae.atgcdn.ae/')));
  });

  test('stock from outOfStock; barcode; breadcrumbs', () => {
    assert.equal(p.inStock, true);
    assert.equal(p.gtin, '0198310179742', 'UPC-A is stored as its EAN-13 form');
    assert.match(p.category ?? '', /^Women > Clothing/);
    const sold = fx('ounass-product.html').replace('"outOfStock": false', '"outOfStock": true');
    assert.equal(parseOunass(sold, OUNASS_URL).inStock, false);
  });

  test('state extraction survives braces inside strings', () => {
    assert.deepEqual(ounassState('<script>window.initialState = {"a":"x}{y","b":{"c":1}};</script>'), { a: 'x}{y', b: { c: 1 } });
    assert.equal(ounassState('<html>no state</html>'), null);
  });

  test('listing: product URLs and 24-per-page offsets', () => {
    const links = parseOunassSearch(fx('ounass-listing.html'), 'https://www.ounass.ae/women/clothing/dresses');
    assert.equal(links.length, 6);
    assert.ok(links.every(l => /^https:\/\/www\.ounass\.ae\/shop-.+_\d+\.html$/.test(l)));
    const dresses = SITES.ounass.categories!['women-dresses'];
    assert.equal(dresses(1), 'https://www.ounass.ae/women/clothing/dresses');
    assert.equal(dresses(3), 'https://www.ounass.ae/women/clothing/dresses?fh_start_index=48');
  });
});

describe('site registry, identity and transport', () => {
  test('Landmark pagination is ?p=N from page 2 (1-based)', () => {
    const c = SITES.homecentre.categories!['air-fryers'];
    assert.equal(c(1), 'https://www.homecentre.com/ae/en/c/household-appliances-kitchenappliances-airfryers');
    assert.equal(c(2), 'https://www.homecentre.com/ae/en/c/household-appliances-kitchenappliances-airfryers?p=2');
    assert.equal(SITES.centrepoint.categories!.fragrance(1), 'https://www.centrepointstores.com/ae/en/c/beautyandpersonalcare-fragrance');
  });

  test('every site key has a config', () => {
    for (const k of SITE_KEYS) assert.ok(SITES[k], k);
  });

  test('marketplace ids: Landmark SKU from /p/<sku>, Ounass styleColorId', () => {
    assert.equal(marketplaceIdFor('homecentre', HC_URL), '168661612');
    assert.equal(marketplaceIdFor('centrepoint', `${CP_URL}?utm=x`), '169238442');
    assert.equal(marketplaceIdFor('ounass', OUNASS_URL), '215328498_2755');
    assert.equal(offerIdentityKey('ounass', OUNASS_URL), 'ounass:id:215328498_2755');
    const o = buildOffer('homecentre', parseLandmark(fx('homecentre-product.html'), HC_URL));
    assert.equal(o.retailerName, 'Home Centre');
    assert.equal(o.externalId, '168661612');
    assert.equal(o.gtin, '6292495613436');
    assert.equal(o.originalPrice, 1999);
  });

  test('Scrape.do-only: unsupported without Scrape.do, supported when switched on', () => {
    for (const site of ['ounass', 'centrepoint', 'homecentre'] as const) {
      const off = siteSupport(site, {});
      assert.equal(off.supported, false);
      assert.match((off as any).reason, /Scrape\.do only/);
      assert.equal(siteSupport(site, { SCRAPE_DO_TOKEN: 't', SCRAPE_DO_SITES: site }).supported, true);
      assert.equal(siteSupport(site, { SCRAPE_DO_TOKEN: 't', SCRAPE_DO_SITES: 'all' }).supported, true);
    }
  });

  test('Scrape.do profiles exist for the new hosts', () => {
    assert.equal(profileForUrl(HC_URL)?.key, 'homecentre');
    assert.equal(profileForUrl(CP_URL)?.key, 'centrepoint');
    assert.equal(profileForUrl(OUNASS_URL)?.key, 'ounass');
    assert.ok(rungsFor(OUNASS_URL, 'product').rungs.length >= 2);
  });
});

describe('Scrape.do transport with the new parsers', () => {
  const ok = (html: string) => ({ html, statusCode: 200, finalUrl: '', targetUrl: '', requestCost: 1, attempts: 1, durationMs: 1 });
  const quiet = { log() {}, warn() {} };

  test('a Cloudflare challenge escalates; the real page is parsed', async () => {
    const pages = ['<html><head><title>Just a moment...</title></head><body>cf-chl-x</body></html>', fx('homecentre-product.html')];
    const calls: any[] = [];
    const client = { fetchHtml: async (_u: string, o: any) => { calls.push(o); return ok(pages[calls.length - 1]); } };
    const fetcher = createProfiledFetcher({ client: client as any, logger: quiet, sleep: async () => {} });
    const p = await scrapeProductViaScrapeDo(HC_URL, fetcher);
    assert.equal(p.price, 1399);
    assert.equal(calls.length, 2);
  });

  test('a listing is accepted when the state lists products', async () => {
    const client = { fetchHtml: async () => ok(fx('centrepoint-listing.html')) };
    const fetcher = createProfiledFetcher({ client: client as any, logger: quiet, sleep: async () => {} });
    const html = await fetchListingViaScrapeDo('https://www.centrepointstores.com/ae/en/c/toys', fetcher);
    assert.ok(parseLandmarkSearch(html, 'https://www.centrepointstores.com/ae/en/c/toys').length > 0);
  });
});

describe('barcode normalisation', () => {
  test('EAN-13 kept; UPC-A and GTIN-14 with leading zeros compare equal; junk rejected', () => {
    assert.equal(normalizeGtin('6292495613436'), '6292495613436');
    assert.equal(normalizeGtin('198310179742'), '0198310179742');
    assert.equal(normalizeGtin('00198310179742'), '0198310179742');
    assert.equal(normalizeGtin('12345670'), '12345670');
    for (const bad of ['', null, 'ABC123', '12345', '0000000000000', '123456789012345']) assert.equal(normalizeGtin(bad), null, String(bad));
  });
});

describe('shopping catalog', () => {
  test('the shipped catalog is valid and every category compares at least two Priority-1 platforms (except single-shop ones)', () => {
    const catalog = loadCatalog(path.join(__dirname, '..', '..', 'config', 'shopping-catalog.json'));
    assert.ok(catalog.length >= 20);
    const p1 = new Set(['amazon', 'noon', 'carrefour', 'ounass', 'centrepoint', 'homecentre', 'jumbo']);
    for (const c of catalog) {
      assert.ok(c.platforms.every(p => p1.has(p)), `${c.key} uses a non-Priority-1 platform`);
      if (c.key !== 'abayas') assert.ok(c.platforms.length >= 2, `${c.key} has nothing to compare against`);
    }
  });

  test('rejects unknown platforms, taxonomy, bad counts, duplicate keys and category keys no platform has', () => {
    const good = { key: 'x', label: 'X', category: 'x', broadCategory: 'Electronics', subCategory: 'Smartphones', count: 5, platforms: ['amazon'] };
    assert.equal(parseCatalog({ categories: [good] }).length, 1);
    assert.throws(() => parseCatalog({ categories: [{ ...good, platforms: ['ebay'] }] }), /unknown platform "ebay"/);
    assert.throws(() => parseCatalog({ categories: [{ ...good, subCategory: 'Nope' }] }), /unknown taxonomy/);
    assert.throws(() => parseCatalog({ categories: [{ ...good, count: 0 }] }), /count/);
    assert.throws(() => parseCatalog({ categories: [good, good] }), /duplicate key/);
    assert.throws(() => parseCatalog({ categories: [{ ...good, categoryKey: 'air-fryers' }] }), /exists on none of its platforms/);
    assert.throws(() => parseCatalog({ categories: [{ ...good, platforms: [] }] }), /at least one/);
  });
});

describe('fixes from the first live dry run (25 Nov 2026)', () => {
  test('Amazon: hidden price text with a savings phrase still gives the AED price', async () => {
    const { parsePrice, parseAmazon } = await import('../../src/parsers/amazon.parser');
    assert.deepEqual(parsePrice('AED 1,099.00 with 15 percent savings'), { price: 1099, currency: 'AED' });
    assert.deepEqual(parsePrice('AED1,099.00'), { price: 1099, currency: 'AED' });
    assert.equal(parsePrice('USD 30.00')?.currency, 'USD');
    const html = `<span id="productTitle">PHILIPS 55 INCH GOOGLE TV</span><div id="corePriceDisplay_desktop_feature_div"><span class="a-price priceToPay"><span class="a-offscreen">AED 1,099.00 with 15 percent savings</span><span class="a-price-symbol">AED</span><span class="a-price-whole">1,099.</span></span></div><input id="add-to-cart-button">`;
    const p = parseAmazon(html, 'https://www.amazon.ae/dp/B0FQCN522R');
    assert.equal(p.price, 1099);
    assert.equal(p.currency, 'AED');
  });

  test('brand is put in front of titles that lack it (Noon), never doubled', async () => {
    const { withBrand } = await import('../../src/services/bundler.service');
    assert.equal(withBrand('Dual Basket AirFryer XXL - 2 Basket Drawers', 'Philips'), 'Philips Dual Basket AirFryer XXL - 2 Basket Drawers');
    assert.equal(withBrand('Philips Airfryer 2000 series 6.2L', 'Philips'), 'Philips Airfryer 2000 series 6.2L');
    assert.equal(withBrand('Black & Decker Kettle', 'BLACK+DECKER'), 'Black & Decker Kettle');
    assert.equal(withBrand('4L Air Fryer', 'Generic'), '4L Air Fryer');
    assert.equal(withBrand('4L Air Fryer', null), '4L Air Fryer');
  });

  test('Carrefour on Scrape.do uses its search pages, not the stale sitemap', async () => {
    const os = await import('os');
    const { scrapeBulk } = await import('../../src/services/playwright.service');
    const { bundleProducts } = await import('../../src/services/bundler.service');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-'));
    process.env.SCRAPER_CHECKPOINT_DIR = path.join(tmp, 'cp');
    const fetched: string[] = [];
    try {
      const r = await scrapeBulk({ sites: ['carrefour'], category: 'air fryer', count: 1, broadCategory: 'Home & Kitchen', subCategory: 'Kitchen Appliances' }, {
        fetchSearchHtml: async url => { fetched.push(url); return '<a href="/mafuae/en/fryer/philips-airfryer-na350/p/2190332">x</a>'; },
        scrapeProduct: async url => ({ productName: 'Philips Airfryer NA350', productUrl: url, imageUrl: 'https://i/1.jpg', imageUrls: ['https://i/1.jpg'], price: 399, currency: 'AED', ratings: null, reviewCount: null, description: null, inStock: true, category: null }),
        collectShopify: async () => [], bundle: bundleProducts, shouldStop: () => false, ensureTagger: async () => {},
        now: () => new Date(), outputDir: path.join(tmp, 'out'), env: { SCRAPE_DO_TOKEN: 't', SCRAPE_DO_SITES: 'carrefour' },
      });
      assert.equal(r.status, 'complete');
      assert.match(fetched[0], /carrefouruae\.com\/mafuae\/en\/search\?keyword=air%20fryer&page=1$/);
    } finally {
      delete process.env.SCRAPER_CHECKPOINT_DIR;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
