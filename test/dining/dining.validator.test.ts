/// <reference types="node" />
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { buildCategorySourceKey, buildRestaurantSourceKey } from '../../src/dining/dining.source-key';
import { LocalizedText } from '../../src/dining/dining.types';
import {
  assertValid,
  DiningValidationError,
  validateLocalizedText,
  validateMenuCategory,
  validateMenuItem,
  validateModifierGroup,
  validateRestaurant,
  validateScrapeRun,
} from '../../src/dining/dining.validator';
import {
  makeCategory,
  makeMenuItem,
  makeModifierGroup,
  makeRestaurant,
  makeScrapeRun,
  NOW,
  paths,
  RESTAURANT_KEY,
} from './fixtures';

describe('LocalizedText', () => {
  test('accepts en-only, ar-only and both', () => {
    const samples: LocalizedText[] = [{ en: 'Burger' }, { ar: 'برجر' }, { en: 'Burger', ar: 'برجر' }];
    for (const s of samples) assert.equal(validateLocalizedText(s, { required: true }).valid, true);
  });

  test('rejects plain strings, empty objects, unknown locales and blank values', () => {
    assert.equal(validateLocalizedText('Burger', { required: true }).valid, false);
    assert.equal(validateLocalizedText({}, { required: true }).valid, false);
    assert.deepEqual(paths(validateLocalizedText({ en: 'x', fr: 'y' })), ['$.fr']);
    assert.equal(validateLocalizedText({ en: '   ' }).valid, false);
    assert.equal(validateLocalizedText(undefined, { required: true }).valid, false);
    assert.equal(validateLocalizedText(undefined).valid, true);
  });

  test('does not trim: untrimmed text is reported, not mutated', () => {
    const value = { en: ' Burger ' };
    const result = validateLocalizedText(value);
    assert.equal(result.valid, false);
    assert.equal(value.en, ' Burger ');
  });

  test('url mode requires absolute http(s) platform URLs', () => {
    assert.equal(validateLocalizedText({ en: 'https://deliveroo.ae/menu/x' }, { url: true }).valid, true);
    assert.equal(validateLocalizedText({ en: '/menu/x' }, { url: true }).valid, false);
    assert.equal(validateLocalizedText({ en: 'https://api.scrape.do/?url=x' }, { url: true }).valid, false);
  });
});

describe('restaurant validation', () => {
  test('valid id-based restaurant passes', () => {
    assert.deepEqual(validateRestaurant(makeRestaurant()).issues, []);
  });

  test('valid slug-anchored restaurant without platformRestaurantId passes', () => {
    const slug = 'dubai/jumeirah/shake-shack-jumeirah';
    const doc = makeRestaurant({
      platformRestaurantId: undefined,
      sourceKeyKind: 'anchor',
      sourceKey: buildRestaurantSourceKey('deliveroo', { kind: 'anchor', value: slug }),
      slug,
    });
    assert.deepEqual(validateRestaurant(doc).issues, []);
  });

  test('reports invalid platform, currency, URLs, rating and sourceKey mismatch', () => {
    const doc = makeRestaurant({
      platform: 'ubereats' as never,
      currency: 'aed',
      url: { en: 'deliveroo.ae/menu' },
      rating: 7,
      sourceKey: 'deliveroo:restaurant:id:99999',
    });
    const p = paths(validateRestaurant(doc));
    for (const expected of ['platform', 'currency', 'url.en', 'rating']) assert.ok(p.includes(expected), expected);

    const mismatch = paths(validateRestaurant(makeRestaurant({ sourceKey: 'deliveroo:restaurant:id:99999' })));
    assert.ok(mismatch.includes('sourceKey'));
  });

  test('name must be LocalizedText, not a string', () => {
    const doc = { ...makeRestaurant(), name: 'Shake Shack' };
    assert.ok(paths(validateRestaurant(doc)).includes('name'));
  });

  test('delivery time range and location bounds are checked', () => {
    const doc = makeRestaurant({ deliveryTimeMin: 40, deliveryTimeMax: 20, location: { lat: 120 } });
    const p = paths(validateRestaurant(doc));
    assert.ok(p.includes('deliveryTimeMin'));
    assert.ok(p.includes('location.lat'));
  });

  test('assertValid throws DiningValidationError with all issues', () => {
    assert.throws(
      () => assertValid(validateRestaurant(makeRestaurant({ currency: 'X' })), 'restaurant'),
      (e: unknown) => e instanceof DiningValidationError && e.issues.some(i => i.path === 'currency')
    );
  });
});

describe('category validation', () => {
  test('valid id-based category passes', () => {
    assert.deepEqual(validateMenuCategory(makeCategory()).issues, []);
  });

  test('category without platformCategoryId uses a position key from sortOrder', () => {
    const doc = makeCategory({
      platformCategoryId: undefined,
      sourceKeyKind: 'position',
      sortOrder: 3,
      sourceKey: buildCategorySourceKey(RESTAURANT_KEY, { kind: 'position', value: 3 }),
    });
    assert.deepEqual(validateMenuCategory(doc).issues, []);

    const wrongPos = { ...doc, sortOrder: 4 };
    assert.ok(paths(validateMenuCategory(wrongPos)).includes('sourceKey'));
  });

  test('requires ObjectId restaurantId and a restaurantSourceKey from the same platform', () => {
    const doc = makeCategory({
      restaurantId: '652f1c' as never,
      restaurantSourceKey: buildRestaurantSourceKey('talabat', { kind: 'id', value: '12345' }),
    });
    const p = paths(validateMenuCategory(doc));
    assert.ok(p.includes('restaurantId'));
    assert.ok(p.includes('restaurantSourceKey'));
  });

  test('category name is required and localized', () => {
    assert.ok(paths(validateMenuCategory(makeCategory({ name: {} }))).includes('name'));
  });
});

describe('menu item validation', () => {
  test('valid item passes', () => {
    assert.deepEqual(validateMenuItem(makeMenuItem()).issues, []);
  });

  test('item without categoryId is valid (categories are optional)', () => {
    assert.deepEqual(validateMenuItem(makeMenuItem({ categoryId: undefined, categoryName: undefined })).issues, []);
  });

  test('rejects invalid price, originalPrice below price, currency and categoryId', () => {
    const p = paths(validateMenuItem(makeMenuItem({
      price: -1,
      currency: 'AEDX',
      categoryId: 'cat' as never,
    })));
    for (const expected of ['price', 'currency', 'categoryId']) assert.ok(p.includes(expected), expected);

    assert.ok(paths(validateMenuItem(makeMenuItem({ price: 50, originalPrice: 40 }))).includes('originalPrice'));
    assert.ok(paths(validateMenuItem(makeMenuItem({ price: Number.NaN }))).includes('price'));
    assert.ok(paths(validateMenuItem({ ...makeMenuItem(), price: '38' })).includes('price'));
  });

  test('allows a zero price (free add-ons) and requires source URL', () => {
    assert.deepEqual(validateMenuItem(makeMenuItem({ price: 0, originalPrice: undefined })).issues, []);
    assert.ok(paths(validateMenuItem({ ...makeMenuItem(), sourceUrl: undefined })).includes('sourceUrl'));
  });

  test('availability flags are required booleans', () => {
    const p = paths(validateMenuItem({ ...makeMenuItem(), isAvailable: 'yes', isActive: undefined }));
    assert.ok(p.includes('isAvailable'));
    assert.ok(p.includes('isActive'));
  });

  test('platformRestaurantId must match the restaurant key', () => {
    assert.ok(paths(validateMenuItem(makeMenuItem({ platformRestaurantId: '555' }))).includes('platformRestaurantId'));
  });
});

describe('modifier validation', () => {
  test('valid modifier group passes standalone and inside an item', () => {
    assert.deepEqual(validateModifierGroup(makeModifierGroup()).issues, []);
    assert.deepEqual(validateMenuItem(makeMenuItem({ modifiers: [makeModifierGroup()] })).issues, []);
  });

  test('reports selection-range and option problems with nested paths', () => {
    const group = makeModifierGroup({
      minSelections: 3,
      maxSelections: 1,
      options: [{ name: { en: 'Extra cheese' }, priceDelta: Number.POSITIVE_INFINITY, currency: 'usd' }],
    });
    const p = paths(validateModifierGroup(group));
    assert.ok(p.includes('$.minSelections'));
    assert.ok(p.includes('$.options[0].priceDelta'));
    assert.ok(p.includes('$.options[0].currency'));

    const inItem = paths(validateMenuItem(makeMenuItem({ modifiers: [group] })));
    assert.ok(inItem.includes('modifiers[0].options[0].currency'));
  });

  test('required group cannot have minSelections 0, and options must be non-empty', () => {
    assert.ok(paths(validateModifierGroup(makeModifierGroup({ minSelections: 0 }))).includes('$.minSelections'));
    assert.ok(paths(validateModifierGroup(makeModifierGroup({ options: [] }))).includes('$.options'));
  });

  test('modifier names must be localized', () => {
    const group = { ...makeModifierGroup(), name: 'Size' };
    assert.ok(paths(validateModifierGroup(group)).includes('$.name'));
  });
});

describe('scrape run validation', () => {
  test('valid succeeded and running runs pass', () => {
    assert.deepEqual(validateScrapeRun(makeScrapeRun()).issues, []);
    const running = makeScrapeRun({ status: 'running', finishedAt: undefined, durationMs: undefined, fetch: undefined });
    assert.deepEqual(validateScrapeRun(running).issues, []);
  });

  test('enforces status/finishedAt consistency', () => {
    assert.ok(paths(validateScrapeRun(makeScrapeRun({ status: 'running' }))).includes('finishedAt'));
    assert.ok(paths(validateScrapeRun(makeScrapeRun({ finishedAt: undefined }))).includes('finishedAt'));
    const early = makeScrapeRun({ finishedAt: new Date(NOW.getTime() - 1000) });
    assert.ok(paths(validateScrapeRun(early)).includes('finishedAt'));
  });

  test('failed run needs at least one error', () => {
    assert.ok(paths(validateScrapeRun(makeScrapeRun({ status: 'failed' }))).includes('errors'));
    const ok = makeScrapeRun({ status: 'failed', errors: [{ stage: 'fetch', code: 'timeout', message: 'Scrape.do request timed out' }] });
    assert.deepEqual(validateScrapeRun(ok).issues, []);
  });

  test('rejects invalid enums, counts and locale', () => {
    const run = {
      ...makeScrapeRun(),
      locale: 'fr',
      trigger: 'webhook',
      targetType: 'menu',
      counts: { ...makeScrapeRun().counts, itemsCreated: -1 },
    };
    const p = paths(validateScrapeRun(run));
    for (const expected of ['locale', 'trigger', 'targetType', 'counts.itemsCreated']) assert.ok(p.includes(expected), expected);
  });

  test('refuses Scrape.do request URLs and token-bearing messages', () => {
    const run = makeScrapeRun({
      status: 'failed',
      targetUrl: 'https://api.scrape.do/?token=abc&url=https%3A%2F%2Fdeliveroo.ae',
      errors: [{ stage: 'fetch', code: 'auth', message: 'GET https://api.scrape.do/?token=abc failed' }],
    });
    const p = paths(validateScrapeRun(run));
    assert.ok(p.includes('targetUrl'));
    assert.ok(p.includes('errors[0].message'));
  });

  test('_id, when present, must be an ObjectId', () => {
    assert.deepEqual(validateScrapeRun(makeScrapeRun({ _id: new ObjectId() })).issues, []);
    assert.ok(paths(validateScrapeRun({ ...makeScrapeRun(), _id: 'abc' })).includes('_id'));
  });
});
