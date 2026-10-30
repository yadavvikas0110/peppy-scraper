/// <reference types="node" />
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAmazon } from '../../src/parsers/amazon.parser';
import { parseNoon } from '../../src/parsers/noon.parser';

const AMAZON_URL = 'https://www.amazon.ae/dp/B0DGHYDZR9';

function amazonPage(opts: { availability?: string; buyBox?: string; extra?: string; addToCart?: boolean }): string {
  return `<html><body>
    <span id="productTitle">Apple iPhone 16 (128 GB) - Black</span>
    <img id="landingImage" src="https://m.media-amazon.com/images/I/main.jpg"
      data-a-dynamic-image='{"https://m.media-amazon.com/images/I/a.jpg":[1,1],"https://m.media-amazon.com/images/I/b.jpg":[1,1]}'>
    ${opts.buyBox ?? ''}
    ${opts.availability !== undefined ? `<div id="availability"><span>${opts.availability}</span></div>` : ''}
    ${opts.addToCart ? '<input id="add-to-cart-button" type="submit">' : ''}
    ${opts.extra ?? ''}
  </body></html>`;
}

const BUY_BOX = `<div id="corePriceDisplay_desktop_feature_div">
  <span class="a-price a-text-price"><span class="a-offscreen">AED 3,799.00</span></span>
  <span class="a-price priceToPay"><span class="a-offscreen">AED 3,399.00</span></span></div>`;
// A recommendation carousel with its own price — must never be read as this product's price
const CAROUSEL = `<div id="similarities_feature_div"><span class="a-price"><span class="a-offscreen">AED 49.00</span></span>
  <span class="a-price"><span class="a-price-whole">49</span><span class="a-price-fraction">00</span></span></div>`;

describe('Amazon availability', () => {
  test('temporarily out of stock / currently unavailable are unavailable', () => {
    assert.equal(parseAmazon(amazonPage({ availability: 'Temporarily out of stock.', buyBox: BUY_BOX }), AMAZON_URL).inStock, false);
    assert.equal(parseAmazon(amazonPage({ availability: 'Currently unavailable. We don\'t know when or if this item will be back in stock.' }), AMAZON_URL).inStock, false);
  });

  test('long backorder lead times are not in stock', () => {
    assert.equal(parseAmazon(amazonPage({ availability: 'Usually ships within 1 to 2 months.', buyBox: BUY_BOX }), AMAZON_URL).inStock, false);
  });

  test('explicit in-stock text is available', () => {
    assert.equal(parseAmazon(amazonPage({ availability: 'In stock', buyBox: BUY_BOX }), AMAZON_URL).inStock, true);
    assert.equal(parseAmazon(amazonPage({ availability: 'Only 3 left in stock - order soon.', buyBox: BUY_BOX }), AMAZON_URL).inStock, true);
  });

  test('missing or empty availability stays unknown — never defaulted to in stock', () => {
    assert.equal(parseAmazon(amazonPage({ buyBox: BUY_BOX }), AMAZON_URL).inStock, null);
    assert.equal(parseAmazon(amazonPage({ availability: '   ', buyBox: BUY_BOX }), AMAZON_URL).inStock, null);
  });

  test('no availability text but a working Add to Cart is evidence of availability', () => {
    assert.equal(parseAmazon(amazonPage({ buyBox: BUY_BOX, addToCart: true }), AMAZON_URL).inStock, true);
  });
});

describe('Amazon price', () => {
  test('reads the buy-box price to pay, not the strike-through list price', () => {
    const p = parseAmazon(amazonPage({ availability: 'In stock', buyBox: BUY_BOX, extra: CAROUSEL }), AMAZON_URL);
    assert.equal(p.price, 3399);
    assert.equal(p.currency, 'AED');
  });

  test('without a buy box the price is unknown, never a carousel price', () => {
    const p = parseAmazon(amazonPage({ availability: 'Temporarily out of stock.', extra: CAROUSEL }), AMAZON_URL);
    assert.equal(p.price, null);
    assert.equal(p.currency, null);
    assert.equal(p.inStock, false);
  });

  test('reconstructs a split buy-box price inside the buy-box container only', () => {
    const split = `<div id="corePrice_feature_div"><span class="a-price"><span class="a-price-symbol">AED</span>
      <span class="a-price-whole">1,249.</span><span class="a-price-fraction">50</span></span></div>`;
    assert.equal(parseAmazon(amazonPage({ availability: 'In stock', buyBox: split, extra: CAROUSEL }), AMAZON_URL).price, 1249.5);
  });

  test('rejects zero and implausible prices', () => {
    const zero = `<div id="corePrice_feature_div"><span class="a-price"><span class="a-offscreen">AED 0.00</span></span></div>`;
    assert.equal(parseAmazon(amazonPage({ availability: 'In stock', buyBox: zero }), AMAZON_URL).price, null);
  });
});

describe('Noon gallery images', () => {
  const url = 'https://www.noon.com/uae-en/apple-iphone-16-128gb-black/N70104532V/p/';
  const own = (n: number) => `https://f.nooncdn.com/p/pnsku/N70104532V/45/_/17259/${n}.jpg`;
  const other = (sku: string) => `https://f.nooncdn.com/p/pnsku/${sku}/45/_/1/1.jpg`;
  const page = `<html><head><meta property="og:image" content="${own(1)}"></head><body>
    <h1>Apple iPhone 16 128GB Black</h1><div data-qa="div-price-now">3399.00</div>
    <div class="gallery">${[1, 2, 3].map(n => `<img src="${own(n)}">`).join('')}</div>
    <div class="RecommendedProducts">${['N1111111A', 'N2222222B', 'N3333333C', 'N4444444D'].map(s => `<img src="${other(s)}">`).join('')}</div>
    <div class="swiper-carousel"><img src="${other('N5555555E')}"></div>
  </body></html>`;

  test('keeps only images of this SKU, dropping recommendation carousels', () => {
    assert.deepEqual(parseNoon(page, url).imageUrls, [own(1), own(2), own(3)]);
  });

  test('without a SKU in the URL, trusts only the declared main image', () => {
    const p = parseNoon(page, 'https://www.noon.com/uae-en/some-product/');
    assert.deepEqual(p.imageUrls, [own(1)]);
  });

  test('stock without an Add to Cart or sold-out signal stays unknown', () => {
    assert.equal(parseNoon(page, url).inStock, null);
    const oos = page.replace('<h1>', '<button data-qa="pdp-add-to-cart-revamp">Notify me</button><h1>');
    assert.equal(parseNoon(oos, url).inStock, false);
    const buyable = page.replace('<h1>', '<button data-qa="pdp-add-to-cart-revamp">Add to cart</button><h1>');
    assert.equal(parseNoon(buyable, url).inStock, true);
  });
});

describe('Amazon UAE marketplace', () => {
  test('amazon.ae requests exit from the UAE; other hosts are untargeted', async () => {
    const { unlockerCountryFor } = await import('../../src/services/brightdata.service');
    assert.equal(unlockerCountryFor('https://www.amazon.ae/dp/B0DGHYDZR9', {}), 'ae');
    assert.equal(unlockerCountryFor('https://www.amazon.ae/s?k=iphone', { AMAZON_UNLOCKER_COUNTRY: 'AE' }), 'ae');
    assert.equal(unlockerCountryFor('https://www.amazon.com/dp/B0DGHYDZR9', {}), undefined);
    assert.equal(unlockerCountryFor('https://www.mumzworld.com/en/x', {}), undefined);
  });

  test('a price in another currency is never stored as AED', () => {
    const usd = `<div id="corePrice_feature_div"><span class="a-price priceToPay"><span class="a-offscreen">USD 899.00</span></span></div>`;
    const p = parseAmazon(amazonPage({ availability: 'In stock', buyBox: usd }), AMAZON_URL);
    assert.equal(p.price, null);
    assert.equal(p.currency, null);
    const aed = parseAmazon(amazonPage({ availability: 'In stock', buyBox: BUY_BOX }), AMAZON_URL);
    assert.equal(aed.currency, 'AED');
  });

  test('search links are normalised to www.amazon.ae/dp/ASIN only', async () => {
    const { parseAmazonSearch } = await import('../../src/parsers/search/amazon.search.parser');
    const html = '<a href="/Apple-iPhone/dp/B0DGHYDZR9/ref=sr_1_1">a</a><a href="https://aax-eu.amazon.ae/x/dp/B0AD000001">ad</a><a href="https://www.amazon.com/dp/B0US000001">us</a>';
    assert.deepEqual(parseAmazonSearch(html, 'https://www.amazon.ae/s?k=iphone'), ['https://www.amazon.ae/dp/B0DGHYDZR9']);
  });
});

describe('write-target guard', () => {
  test('product-writing CLIs refuse a production database without explicit confirmation', async () => {
    const { assertSafeWriteTarget } = await import('../../src/shared/db/mongo');
    assert.throws(() => assertSafeWriteTarget({ MONGODB_URI: 'mongodb://u:p@10.0.0.1:27017/prod' }), /Refusing to write to production database "prod"/);
    assert.throws(() => assertSafeWriteTarget({ MONGODB_URI: 'mongodb://h/x', MONGODB_DB: 'production' }), /production/);
    assert.equal(assertSafeWriteTarget({ MONGODB_URI: 'mongodb://u:p@10.0.0.1:27017/prod', CONFIRM_PRODUCTION_DB: 'yes' }).dbName, 'prod');
    assert.equal(assertSafeWriteTarget({ MONGODB_URI: 'mongodb://u:p@10.0.0.1:27017/dev' }).dbName, 'dev');
  });
});

describe('provider credential errors', () => {
  test('a rejected Bright Data key is recognised and never retried', async () => {
    const { isProviderAuthError } = await import('../../src/services/brightdata.service');
    assert.equal(isProviderAuthError('Unlocker API 401: Invalid token'), true);
    assert.equal(isProviderAuthError('BRIGHT_DATA_API_KEY is not set'), true);
    assert.equal(isProviderAuthError('Unlocker API 502: bad gateway'), false);
    assert.equal(isProviderAuthError('Timeout 60000ms exceeded'), false);
  });
});
