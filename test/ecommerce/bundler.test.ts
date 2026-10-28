/// <reference types="node" />
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { variantsCompatible, variantSignature, bundleProducts } from '../../src/services/bundler.service';
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
