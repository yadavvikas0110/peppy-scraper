/// <reference types="node" />
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { variantsCompatible, variantSignature, bundleProducts, productRoleOf, identityConflict, MatchReview } from '../../src/services/bundler.service';
import { ProductData } from '../../src/parsers/types';

// Bundling must never call OpenAI from unit tests
delete process.env.OPENAI_API_KEY;

function product(name: string, price: number): ProductData {
  return {
    productName: name, productUrl: `https://example.test/${encodeURIComponent(name)}`, imageUrl: 'https://img.test/1.jpg',
    imageUrls: ['https://img.test/1.jpg'], price, currency: 'AED', ratings: null, reviewCount: null,
    description: null, inStock: true, category: null,
  };
}

describe('variant guards', () => {
  test('different model tiers never bundle', () => {
    assert.equal(variantsCompatible('Samsung Galaxy S24 256GB Black', 'Samsung Galaxy S24 Ultra 256GB Black'), false);
    assert.equal(variantsCompatible('Apple iPhone 15 128GB', 'Apple iPhone 15 Pro 128GB'), false);
    assert.equal(variantsCompatible('Apple iPhone 15 Pro 256GB', 'Apple iPhone 15 Pro Max 256GB'), false);
  });

  test('different generations never bundle', () => {
    assert.equal(variantsCompatible('Samsung Galaxy S24 Ultra 5G 256GB Titanium Black', 'Samsung Galaxy S25 Ultra 5G 256GB Titanium Black'), false);
    assert.equal(variantsCompatible('Apple iPhone 15 128GB Blue', 'Apple iPhone 16 128GB Blue'), false);
  });

  test('different storage or screen size never bundle', () => {
    assert.equal(variantsCompatible('Samsung Galaxy S24 128GB', 'Samsung Galaxy S24 256GB'), false);
    assert.equal(variantsCompatible('LG OLED evo C4 55 inch 4K TV', 'LG OLED evo C4 65 inch 4K TV'), false);
  });

  test('same product with different retailer wording still bundles', () => {
    assert.equal(variantsCompatible('Samsung Galaxy S24 128GB, Black, 8GB RAM, Android Smartphone', 'SAMSUNG Galaxy S24 5G (128 GB) Onyx Black'), true);
    assert.equal(variantsCompatible('Samsung Galaxy S24+ 512GB', 'Samsung Galaxy S24 Plus 512GB'), true);
    assert.equal(variantsCompatible('Samsung Galaxy S24 SM-S921B 256GB', 'Samsung Galaxy S24 256GB'), true);
  });

  test('RAM is not mistaken for storage', () => {
    assert.equal(variantSignature('Galaxy S24 8GB RAM 256GB').storageGb, 256);
    assert.equal(variantSignature('MacBook Pro 1TB 16GB').storageGb, 1024);
  });

  test('spec tokens are not model numbers', () => {
    const sig = variantSignature('Galaxy S24 5G 120Hz 5000mAh');
    assert.deepEqual([...sig.modelTokens], ['s24']);
  });
});

describe('bundleProducts', () => {
  test('merges the same phone across retailers but keeps the Ultra separate', async () => {
    const bundles = await bundleProducts([
      { site: 'amazon', data: product('Samsung Galaxy S24 256GB Onyx Black', 2499) },
      { site: 'noon', data: product('Samsung Galaxy S24 5G 256GB Onyx Black', 2399) },
      { site: 'carrefour', data: product('Samsung Galaxy S24 Ultra 5G 256GB Onyx Black', 3999) },
    ], 'samsung galaxy s24', 'Electronics', 'Smartphones');

    assert.equal(bundles.length, 2);
    const base = bundles.find(b => !/ultra/i.test(b.name ?? ''))!;
    assert.deepEqual(base.retailers.map(r => r.retailerId).sort(), ['amazon', 'noon']);
    assert.equal(base.lowestPrice, 2399);
    assert.ok(base.tags.includes('smartphone'));
  });
});

describe('cross-platform matching safety', () => {
  const at = (name: string, price: number | null, url: string, inStock: boolean | null = true): ProductData => ({
    ...product(name, price ?? 0), price, productUrl: url, inStock, scrapedAt: '2026-10-29T10:00:00.000Z',
  });

  test('an accessory never becomes the main product\'s offer', async () => {
    assert.equal(productRoleOf('Apple iPhone 16 Clear Case with MagSafe - Black'), 'accessory');
    assert.equal(productRoleOf('Apple AirPods Pro 2 with MagSafe Charging Case (USB-C)'), 'main_product');
    assert.equal(productRoleOf('Samsung Galaxy Watch6 44mm with Sport Band'), 'main_product');

    const reviews: MatchReview[] = [];
    const bundles = await bundleProducts([
      { site: 'noon', data: at('Apple iPhone 16 128GB Black 5G', 3399, 'https://www.noon.com/uae-en/x/N70104532V/p/') },
      { site: 'amazon', data: at('Apple iPhone 16 Clear Case Black', 49, 'https://www.amazon.ae/dp/B0CASE0001') },
    ], 'apple iphone 16', 'Electronics', 'Smartphones', reviews);
    assert.equal(bundles.length, 2);
    for (const b of bundles) assert.equal(b.retailers.length, 1);
  });

  test('different brands or product types never bundle', () => {
    assert.equal(identityConflict('Spigen Ultra Hybrid for Galaxy S24', 'Samsung Galaxy S24 256GB'), 'role_mismatch');
    assert.equal(identityConflict('Apple iPad Air 11 M2 128GB', 'Apple MacBook Air 13 M2 128GB'), 'type_mismatch');
    assert.equal(identityConflict('Sony WH-1000XM5 Wireless Headphones Black', 'Bose QuietComfort Wireless Headphones Black'), 'brand_mismatch');
    assert.equal(identityConflict('Samsung Galaxy S24 256GB Black', 'SAMSUNG Galaxy S24 5G (256 GB) Onyx Black'), null);
  });

  test('a price far outside the other offers is left unmatched for review', async () => {
    const reviews: MatchReview[] = [];
    const bundles = await bundleProducts([
      { site: 'noon', data: at('Samsung Galaxy S24 256GB Onyx Black', 2399, 'https://www.noon.com/uae-en/x/N1234567A/p/') },
      { site: 'amazon', data: at('Samsung Galaxy S24 5G 256GB Onyx Black', 899, 'https://www.amazon.ae/dp/B0S24REFRB') },
    ], 'samsung galaxy s24', 'Electronics', 'Smartphones', reviews);
    assert.equal(bundles.length, 2);
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].reason, 'price_ratio');
    assert.equal(reviews[0].incoming.site, 'amazon');
  });

  test('two links to the same ASIN produce one offer', async () => {
    const bundles = await bundleProducts([
      { site: 'amazon', data: at('Apple iPhone 16 128GB Black', 3399, 'https://www.amazon.ae/dp/B0DGHYDZR9') },
      { site: 'amazon', data: at('Apple iPhone 16 (128 GB) - Black', 3399, 'https://www.amazon.ae/gp/product/B0DGHYDZR9') },
    ], 'apple iphone 16', 'Electronics', 'Smartphones');
    assert.equal(bundles.length, 1);
    assert.equal(bundles[0].retailers.length, 1);
    assert.equal(bundles[0].retailers[0].externalId, 'B0DGHYDZR9');
  });

  test('unavailable offers do not set the price range; unknown-stock offers stay in it', async () => {
    const bundles = await bundleProducts([
      { site: 'amazon', data: at('Samsung Galaxy S24 256GB Black', 1999, 'https://www.amazon.ae/dp/B0S2400001', false) },
      { site: 'noon', data: at('Samsung Galaxy S24 5G 256GB Black', 2399, 'https://www.noon.com/uae-en/x/N1234567A/p/', null) },
      { site: 'carrefour', data: at('Samsung Galaxy S24 5G 256GB Black', 2499, 'https://www.carrefouruae.com/mafuae/en/p/8806095528922', true) },
    ], 'samsung galaxy s24', 'Electronics', 'Smartphones');
    assert.equal(bundles.length, 1);
    assert.equal(bundles[0].lowestPrice, 2399);
    assert.deepEqual(bundles[0].retailers.map(r => r.stockStatus), ['unavailable', 'unknown', 'available']);
    assert.equal(bundles[0].retailers[0].observedAt, '2026-10-29T10:00:00.000Z');
  });
});
