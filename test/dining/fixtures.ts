/// <reference types="node" />
import { ObjectId } from 'mongodb';
import {
  buildCategorySourceKey,
  buildMenuItemSourceKey,
  buildRestaurantSourceKey,
} from '../../src/dining/dining.source-key';
import {
  DiningMenuCategory,
  DiningMenuItem,
  DiningRestaurant,
  DiningScrapeRun,
  emptyScrapeRunCounts,
  MenuModifierGroup,
} from '../../src/dining/dining.types';

export const NOW = new Date('2026-10-08T10:00:00.000Z');
export const RESTAURANT_ID = new ObjectId();
export const CATEGORY_ID = new ObjectId();
export const RESTAURANT_KEY = buildRestaurantSourceKey('deliveroo', { kind: 'id', value: '12345' });

export function makeRestaurant(overrides: Partial<DiningRestaurant> = {}): DiningRestaurant {
  return {
    platform: 'deliveroo',
    platformRestaurantId: '12345',
    sourceKey: RESTAURANT_KEY,
    sourceKeyKind: 'id',
    slug: 'dubai/jumeirah/shake-shack-jumeirah',
    name: { en: 'Shake Shack', ar: 'شيك شاك' },
    url: {
      en: 'https://deliveroo.ae/menu/dubai/jumeirah/shake-shack-jumeirah',
      ar: 'https://deliveroo.ae/ar/menu/dubai/jumeirah/shake-shack-jumeirah',
    },
    cuisines: ['Burgers'],
    tags: [],
    rating: 4.5,
    ratingCount: 500,
    currency: 'AED',
    deliveryFee: 7,
    deliveryTimeMin: 20,
    deliveryTimeMax: 35,
    isActive: true,
    offers: [],
    location: { city: 'Dubai', area: 'Jumeirah' },
    firstSeenAt: NOW,
    lastScrapedAtByLocale: { en: NOW },
    lastRunIdByLocale: { en: 'run_en_0001' },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function makeCategory(overrides: Partial<DiningMenuCategory> = {}): DiningMenuCategory {
  return {
    platform: 'deliveroo',
    restaurantId: RESTAURANT_ID,
    restaurantSourceKey: RESTAURANT_KEY,
    platformRestaurantId: '12345',
    platformCategoryId: 'cat-77',
    sourceKey: buildCategorySourceKey(RESTAURANT_KEY, { kind: 'id', value: 'cat-77' }),
    sourceKeyKind: 'id',
    name: { en: 'Burgers', ar: 'برجر' },
    sortOrder: 0,
    isActive: true,
    firstSeenAt: NOW,
    lastScrapedAtByLocale: { en: NOW, ar: NOW },
    lastRunIdByLocale: { en: 'run_en_0001', ar: 'run_ar_0001' },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function makeModifierGroup(overrides: Partial<MenuModifierGroup> = {}): MenuModifierGroup {
  return {
    groupId: 'grp-1',
    name: { en: 'Choose your size', ar: 'اختر الحجم' },
    required: true,
    minSelections: 1,
    maxSelections: 1,
    options: [
      { optionId: 'opt-s', name: { en: 'Single', ar: 'فردي' }, priceDelta: 0 },
      { optionId: 'opt-d', name: { en: 'Double', ar: 'مزدوج' }, priceDelta: 12, currency: 'AED' },
    ],
    ...overrides,
  };
}

export function makeMenuItem(overrides: Partial<DiningMenuItem> = {}): DiningMenuItem {
  return {
    platform: 'deliveroo',
    restaurantId: RESTAURANT_ID,
    restaurantSourceKey: RESTAURANT_KEY,
    platformRestaurantId: '12345',
    platformItemId: '987654',
    sourceKey: buildMenuItemSourceKey(RESTAURANT_KEY, { kind: 'id', value: '987654' }),
    sourceKeyKind: 'id',
    categoryId: CATEGORY_ID,
    categoryName: { en: 'Burgers', ar: 'برجر' },
    name: { en: 'ShackBurger', ar: 'شاك برجر' },
    description: { en: 'Cheeseburger with lettuce', ar: 'برجر بالجبن مع الخس' },
    price: 38,
    originalPrice: 42,
    currency: 'AED',
    isAvailable: true,
    isActive: true,
    dietaryTags: [],
    modifiers: [makeModifierGroup()],
    sourceUrl: {
      en: 'https://deliveroo.ae/menu/dubai/jumeirah/shake-shack-jumeirah',
      ar: 'https://deliveroo.ae/ar/menu/dubai/jumeirah/shake-shack-jumeirah',
    },
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    lastSeenAtByLocale: { en: NOW, ar: NOW },
    lastRunIdByLocale: { en: 'run_en_0001', ar: 'run_ar_0001' },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function makeScrapeRun(overrides: Partial<DiningScrapeRun> = {}): DiningScrapeRun {
  return {
    runId: 'run_en_0001',
    platform: 'deliveroo',
    locale: 'en',
    targetType: 'restaurant',
    targetUrl: 'https://deliveroo.ae/menu/dubai/jumeirah/shake-shack-jumeirah',
    trigger: 'manual',
    dryRun: false,
    status: 'succeeded',
    startedAt: NOW,
    finishedAt: new Date(NOW.getTime() + 4200),
    durationMs: 4200,
    counts: { ...emptyScrapeRunCounts(), restaurantsCreated: 1, categoriesCreated: 8, itemsSeen: 64, itemsCreated: 64 },
    errors: [],
    fetch: { statusCode: 200, requestCost: 25, remainingCredits: 9975, attempts: 1, durationMs: 3900 },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function paths(result: { issues: Array<{ path: string }> }): string[] {
  return result.issues.map(i => i.path);
}
