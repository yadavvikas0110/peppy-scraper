/// <reference types="node" />
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCategorySourceKey,
  buildMenuItemSourceKey,
  buildRestaurantSourceKey,
  parseSourceKey,
  resolveSourceIdentity,
  SourceKeyError,
} from '../../src/dining/dining.source-key';
import { validateMenuItem } from '../../src/dining/dining.validator';
import { makeMenuItem, RESTAURANT_KEY } from './fixtures';

describe('sourceKey generation', () => {
  test('restaurant, category and item keys are deterministic and hierarchical', () => {
    const r = buildRestaurantSourceKey('deliveroo', { kind: 'id', value: '12345' });
    assert.equal(r, 'deliveroo:restaurant:id:12345');
    assert.equal(r, buildRestaurantSourceKey('deliveroo', { kind: 'id', value: '12345' }));

    const c = buildCategorySourceKey(r, { kind: 'id', value: 'cat-77' });
    assert.equal(c, 'deliveroo:restaurant:id:12345:category:id:cat-77');

    const i = buildMenuItemSourceKey(r, { kind: 'id', value: '987654' });
    assert.equal(i, 'deliveroo:restaurant:id:12345:item:id:987654');
  });

  test('values are encoded so ":" and "/" cannot break the key structure', () => {
    const r = buildRestaurantSourceKey('talabat', { kind: 'anchor', value: 'dubai/marina:west' });
    assert.equal(r, 'talabat:restaurant:anchor:dubai%2Fmarina%3Awest');
    const parsed = parseSourceKey(r);
    assert.deepEqual(parsed, { platform: 'talabat', entity: 'restaurant', kind: 'anchor', value: 'dubai/marina:west' });
  });

  test('rejects display names, Arabic text and unknown platforms as identity', () => {
    assert.throws(() => buildRestaurantSourceKey('deliveroo', { kind: 'anchor', value: 'Shake Shack' }), SourceKeyError);
    assert.throws(() => buildRestaurantSourceKey('deliveroo', { kind: 'anchor', value: 'شيك-شاك' }), SourceKeyError);
    assert.throws(() => buildMenuItemSourceKey(RESTAURANT_KEY, { kind: 'id', value: '' }), SourceKeyError);
    assert.throws(() => buildRestaurantSourceKey('ubereats' as never, { kind: 'id', value: '1' }), SourceKeyError);
    assert.throws(
      () => buildRestaurantSourceKey('deliveroo', { kind: 'position', value: 1 } as never),
      SourceKeyError
    );
  });

  test('child keys require a valid restaurant key', () => {
    assert.throws(() => buildCategorySourceKey('not-a-key', { kind: 'id', value: '1' }), SourceKeyError);
    const itemKey = buildMenuItemSourceKey(RESTAURANT_KEY, { kind: 'id', value: '1' });
    assert.throws(() => buildCategorySourceKey(itemKey, { kind: 'id', value: '1' }), SourceKeyError);
  });

  test('resolveSourceIdentity prefers id, then anchor, then position', () => {
    assert.deepEqual(resolveSourceIdentity({ id: '9', anchor: 'a', position: 2 }), { kind: 'id', value: '9' });
    assert.deepEqual(resolveSourceIdentity({ anchor: 'a', position: 2 }), { kind: 'anchor', value: 'a' });
    assert.deepEqual(resolveSourceIdentity({ position: 2 }), { kind: 'position', value: 2 });
    assert.throws(() => resolveSourceIdentity({}), SourceKeyError);
  });

  test('parseSourceKey rejects malformed keys', () => {
    for (const bad of ['', 'deliveroo', 'deliveroo:restaurant:id', 'ubereats:restaurant:id:1',
      'deliveroo:restaurant:pos:1', 'deliveroo:restaurant:id:1:menu:id:2', 'deliveroo:restaurant:id:']) {
      assert.equal(parseSourceKey(bad), null, bad);
    }
  });
});

describe('EN and AR resolve to the same identity', () => {
  // What a parser sees on the /en and /ar versions of the same Deliveroo page.
  const en = {
    url: 'https://deliveroo.ae/menu/dubai/jumeirah/shake-shack-jumeirah',
    restaurantId: '12345',
    slug: 'dubai/jumeirah/shake-shack-jumeirah',
    item: { id: '987654', name: 'ShackBurger', position: 0 },
    category: { name: 'Burgers', position: 0 },
  };
  const ar = {
    url: 'https://deliveroo.ae/ar/menu/dubai/jumeirah/shake-shack-jumeirah',
    restaurantId: '12345',
    slug: 'dubai/jumeirah/shake-shack-jumeirah',
    item: { id: '987654', name: 'شاك برجر', position: 0 },
    category: { name: 'برجر', position: 0 },
  };

  test('platform IDs give identical restaurant, category and item keys', () => {
    const keys = [en, ar].map(p => {
      const r = buildRestaurantSourceKey('deliveroo', { kind: 'id', value: p.restaurantId });
      return {
        restaurant: r,
        item: buildMenuItemSourceKey(r, resolveSourceIdentity({ id: p.item.id })),
      };
    });
    assert.deepEqual(keys[0], keys[1]);
    assert.notEqual(en.url, ar.url, 'URLs differ per locale but do not affect identity');
  });

  test('slug anchor and category position fallbacks are also locale-independent', () => {
    const keys = [en, ar].map(p => {
      const r = buildRestaurantSourceKey('deliveroo', { kind: 'anchor', value: p.slug });
      const c = buildCategorySourceKey(r, resolveSourceIdentity({ position: p.category.position }));
      const i = buildMenuItemSourceKey(r, resolveSourceIdentity({ position: p.item.position }), c);
      return { r, c, i };
    });
    assert.deepEqual(keys[0], keys[1]);
    assert.equal(keys[0].i, 'deliveroo:restaurant:anchor:dubai%2Fjumeirah%2Fshake-shack-jumeirah:category:pos:0:item:pos:0');
  });
});

describe('optional platformItemId', () => {
  test('item with platformItemId must use the id-based key', () => {
    const anchorKey = buildMenuItemSourceKey(RESTAURANT_KEY, { kind: 'anchor', value: 'img/abc123.jpg' });
    const result = validateMenuItem(makeMenuItem({ sourceKey: anchorKey, sourceKeyKind: 'anchor' }));
    assert.equal(result.valid, false);
    assert.ok(result.issues.some(i => i.path === 'sourceKeyKind'));
  });

  test('item without platformItemId is valid with an anchor key', () => {
    const doc = makeMenuItem({
      platformItemId: undefined,
      sourceKeyKind: 'anchor',
      sourceKey: buildMenuItemSourceKey(RESTAURANT_KEY, { kind: 'anchor', value: 'img/abc123.jpg' }),
    });
    assert.deepEqual(validateMenuItem(doc).issues, []);
  });

  test('item without platformItemId is valid with a category-scoped position key', () => {
    const categoryKey = buildCategorySourceKey(RESTAURANT_KEY, { kind: 'position', value: 2 });
    const doc = makeMenuItem({
      platformItemId: undefined,
      sourceKeyKind: 'position',
      sourceKey: buildMenuItemSourceKey(RESTAURANT_KEY, { kind: 'position', value: 5 }, categoryKey),
    });
    assert.deepEqual(validateMenuItem(doc).issues, []);
  });

  test('position key without a category key is rejected', () => {
    assert.throws(
      () => buildMenuItemSourceKey(RESTAURANT_KEY, { kind: 'position', value: 5 }),
      SourceKeyError
    );
  });

  test('id kind without platformItemId is rejected', () => {
    const result = validateMenuItem(makeMenuItem({ platformItemId: undefined }));
    assert.ok(result.issues.some(i => i.path === 'platformItemId'));
  });
});
