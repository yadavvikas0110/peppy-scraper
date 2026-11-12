/// <reference types="node" />
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { findOriginalPrice } from '../../src/custom/core/embedded-price';
import { parseLooxRating } from '../../src/custom/adapters/letstango.adapter';
import { namshiAdapter, namshiUri } from '../../src/custom/adapters/namshi.adapter';
import { cleanImages } from '../../src/custom/custom-images-cleanup';
import { buildOffer } from '../../src/services/bundler.service';
import { mergeOffer, mergeProduct, toMongoProduct } from '../../src/cron/push-pipeline';
import { mumzworldAdapter } from '../../src/custom/adapters/mumzworld.adapter';
import type { BundledProduct } from '../../src/parsers/types';

describe('original price from embedded app state', () => {
  test('escaped JSON (Namshi RSC payload), anchored on the product URI', () => {
    const html = 'x\\"uri\\":\\"/buy-a/SKU1/p/\\",\\"title\\":\\"A\\",\\"normalPrice\\":310,\\"salePrice\\":186,y'
      + '\\"uri\\":\\"/buy-b/SKU2/p/\\",\\"normalPrice\\":999,\\"salePrice\\":186';
    assert.equal(findOriginalPrice(html, 186, { regularKey: 'normalPrice', finalKey: 'salePrice', anchor: 'uri\\":\\"/buy-a/SKU1/p/' }), 310);
  });
  test('Magento money objects (Mumzworld)', () => {
    const html = '"regular_price":{"currency":"AED","value":120},"final_price":{"currency":"AED","value":115}';
    assert.equal(findOriginalPrice(html, 115, { regularKey: 'regular_price', finalKey: 'final_price', maxGap: 200 }), 120);
  });
  test('JS object (Jumbo Nuxt state), equal prices → no discount', () => {
    const html = 'sku:"SM-1",price:3199,regular_price:3199,final_price:3199';
    assert.equal(findOriginalPrice(html, 3199, { regularKey: 'regular_price', finalKey: 'final_price', anchor: 'sku:"SM-1"' }), null);
  });
  test('a related product with another selling price is never used', () => {
    const html = '"regular_price":{"value":500},"final_price":{"value":400}';
    assert.equal(findOriginalPrice(html, 115, { regularKey: 'regular_price', finalKey: 'final_price' }), null);
  });
  test('Mumzworld: a related product listed first with the same selling price is not used', () => {
    const ld = `<script type="application/ld+json">{"@type":"Product","name":"Own","sku":"OWN-1","image":["https://www.mumzworld.com/media/catalog/product/own.jpg"],"offers":{"price":"100","priceCurrency":"AED"}}</script>`;
    const related = '"price_range":{"minimum_price":{"regular_price":{"currency":"AED","value":150},"final_price":{"currency":"AED","value":100}}},"sku":"REL-9"';
    const own = '"price_range":{"minimum_price":{"regular_price":{"currency":"AED","value":100},"final_price":{"currency":"AED","value":100}}},"sku":"OWN-1"';
    const pad = 'x'.repeat(9000);
    // Page layout as measured: JSON-LD in <head>, product payloads far below it
    assert.equal(mumzworldAdapter.extract(ld + pad + related + pad + own, 'https://www.mumzworld.com/en/own').originalPrice, null);
    const ownDiscount = own.replace('"value":100},"final', '"value":120},"final');
    assert.equal(mumzworldAdapter.extract(ld + pad + related + pad + ownDiscount, 'https://www.mumzworld.com/en/own').originalPrice, 120);
    // related block right next to the own one: still the own pair (nearest to the sku)
    assert.equal(mumzworldAdapter.extract(ld + pad + related + ownDiscount, 'https://www.mumzworld.com/en/own').originalPrice, 120);
  });
  test('occurrences of the product id that disagree → unknown', () => {
    const html = 'sku:"A" regular_price:150,final_price:100' + 'x'.repeat(6000) + 'sku:"A" regular_price:130,final_price:100';
    assert.equal(findOriginalPrice(html, 100, { regularKey: 'regular_price', finalKey: 'final_price', anchor: 'sku:"A"', maxGap: 40 }), null);
  });
  test('unanchored: conflicting pairs → unknown', () => {
    const html = '"regular_price":{"value":150},"final_price":{"value":100}' + ' '.repeat(200) + '"regular_price":{"value":130},"final_price":{"value":100}';
    assert.equal(findOriginalPrice(html, 100, { regularKey: 'regular_price', finalKey: 'final_price', maxGap: 40 }), null);
  });
  test('a longer key ending in the same name is not matched', () => {
    assert.equal(findOriginalPrice('base_regular_price:999,final_price:100', 100, { regularKey: 'regular_price', finalKey: 'final_price' }), null);
  });
  test('anchor not on the page → no guess', () => {
    assert.equal(findOriginalPrice('"normalPrice":310,"salePrice":186', 186, { regularKey: 'normalPrice', finalKey: 'salePrice', anchor: 'nope' }), null);
  });
  test('Namshi adapter wires it up', () => {
    const url = 'https://www.namshi.com/uae-en/buy-a/SKU1/p/';
    assert.equal(namshiUri(url), '/buy-a/SKU1/p/');
    const html = `<script type="application/ld+json">{"@type":"Product","name":"A","image":["https://f.nooncdn.com/a.jpg"],"offers":{"price":"186","priceCurrency":"AED"}}</script>`
      + '<script>self.__next_f.push([1,"\\"uri\\":\\"/buy-a/SKU1/p/\\",\\"normalPrice\\":310,\\"salePrice\\":186"])</script>';
    assert.equal(namshiAdapter.extract(html, url).originalPrice, 310);
  });
});

describe('Letstango ratings (Loox widget)', () => {
  test('reads rating and raters', () => {
    assert.deepEqual(parseLooxRating('<div class="loox-rating" style="x" data-id="1" data-rating="4.4" data-raters="65">'), { ratings: 4.4, reviewCount: 65 });
  });
  test('no reviews → null, not 0', () => {
    assert.deepEqual(parseLooxRating('<div class="loox-rating" data-rating="" data-raters="">'), { ratings: null, reviewCount: null });
    assert.deepEqual(parseLooxRating('<html></html>'), { ratings: null, reviewCount: null });
  });
});

describe('stored-image cleanup rules', () => {
  const own = 'https://www.mumzworld.com/media/catalog/product/19468963-FRP0134-1.jpg';
  const banner = 'https://www.mumzworld.com/media/wysiwyg/30-AWARDS-1-EN.jpg';
  const related = 'https://www.mumzworld.com/media/catalog/product/cache/8bf0/TC-FRP0046-1.jpg';
  test('drops banners and related-product thumbnails when own images exist', () => {
    assert.deepEqual(cleanImages([own, banner, related], ['mumzworld']), [own]);
  });
  test('keeps cache images when they are the only product images', () => {
    assert.deepEqual(cleanImages([related, banner], ['mumzworld']), [related]);
  });
  test('never empties a gallery, never touches other retailers', () => {
    assert.equal(cleanImages([banner], ['mumzworld']), null);
    assert.equal(cleanImages([banner, own], ['jumbo']), null);
    assert.equal(cleanImages([own], ['mumzworld']), null);
  });
});

describe('brand, sku, originalPrice reach products_clean', () => {
  const data = {
    productName: 'Asics Patriot 14', productUrl: 'https://www.namshi.com/uae-en/buy-a/Z44FAA5C6E8DA259D931FZ/p/',
    imageUrl: 'https://f.nooncdn.com/a.jpg', imageUrls: ['https://f.nooncdn.com/a.jpg'], price: 186, currency: 'AED',
    ratings: null, reviewCount: null, description: null, inStock: true, category: null, scrapedAt: '2026-11-12T00:00:00Z',
    brand: 'Asics', sku: 'Z44F-7', originalPrice: 310,
  };
  const bundle = (offer = buildOffer('namshi', data)): BundledProduct => ({
    name: data.productName, description: null, category: 'Footwear', broadCategory: 'Fashion', subCategory: 'Footwear',
    tags: [], images: data.imageUrls, lowestPrice: 186, highestPrice: 186, rating: null, reviewCount: null,
    retailerCount: 1, retailers: [offer], brand: 'Asics', sku: 'Z44F-7',
  });

  test('offer and product carry them', () => {
    const p = toMongoProduct(bundle())!;
    assert.equal(p.brand, 'Asics');
    assert.equal(p.sku, 'Z44F-7');
    assert.equal(p.retailers[0].originalPrice, 310);
  });
  test('an "original" price not above the selling price means "no discount" (null, clears a stored one)', () => {
    const offer = buildOffer('namshi', { ...data, originalPrice: 150 });
    assert.equal(offer.originalPrice, null);
    assert.equal(toMongoProduct(bundle({ ...offer, originalPrice: 186 }))!.retailers[0].originalPrice, null);
  });
  test('stale original price: cleared by a "no discount" observation, kept for parsers that never report it, dropped when not above price', () => {
    const stored = { retailerId: 'namshi', price: 80, originalPrice: 100, lastSeenAt: new Date('2026-11-01') };
    const seen = new Date('2026-11-12');
    const incoming = (extra: object) => ({ retailerId: 'namshi', retailerName: 'Namshi', currency: 'AED', inStock: true, stockStatus: 'available' as const, lastSeenAt: seen, ...extra });
    assert.equal(mergeOffer(stored, incoming({ price: 120, originalPrice: null })).originalPrice, null);
    assert.equal('originalPrice' in mergeOffer(stored, incoming({ price: 120 })), false); // 100 <= 120: no longer a discount
    assert.equal(mergeOffer(stored, incoming({ price: 90 })).originalPrice, 100);          // Bright Data style: untouched
  });
  test('parsers that do not set the fields produce the same offer shape as before', () => {
    const { brand, sku, originalPrice, ...legacy } = data;
    assert.equal('originalPrice' in buildOffer('namshi', legacy), false);
  });
  test('existing documents get sku/brand filled only when missing', () => {
    const p = toMongoProduct(bundle())!;
    assert.equal(mergeProduct({ name: 'x', brand: 'Kept', retailers: [] }, p, new Date()).brand, 'Kept');
    assert.equal(mergeProduct({ name: 'x', retailers: [] }, p, new Date()).sku, 'Z44F-7');
  });
});
