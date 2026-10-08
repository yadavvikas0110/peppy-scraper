import type { DiningLocale } from '../../dining.types';

// Deliveroo-only selectors, verified against the captured EN/AR fixtures (test/dining/fixtures).
// No hashed CSS class names are used: only ids, data-testid, role/aria and semantic elements.

export const DELIVEROO_SELECTORS = {
  // Primary data source: server-rendered Next.js state.
  nextData: 'script#__NEXT_DATA__',

  // Page language (<html lang="en" dir="ltr"> / <html lang="ar" dir="rtl">).
  htmlRoot: 'html',

  // Restaurant
  restaurantName: 'h1',
  restaurantUrl: 'link[rel="canonical"]',
  restaurantAlternateUrl: 'link[rel="alternate"][hreflang]',

  // Menu category sections: id="layout-<Deliveroo category ID>" (matches next-data category IDs).
  categorySection: '[id^="layout-"]',
  categoryName: 'h2',

  // Menu item: the full-card button overlay; its aria-label is "<name>[, <description>], <price>".
  menuItem: '[role="button"][aria-label]',
  // Leaf text nodes inside the card: name, optional description, price (in that order).
  itemText: 'p, span',
  itemImageContainer: '[data-testid="menu-item-image"]',
  // background-image is set inline only on items the browser has lazily rendered.
  itemImage: '[data-testid="menu-item-image"] [role="img"]',
  // Quantity stepper inside a card; excluded when reading item text.
  itemControls: 'button',
} as const;

export const DELIVEROO_CATEGORY_SECTION_ID = /^layout-(\d+)$/;

// Path to the menu payload inside __NEXT_DATA__.
export const DELIVEROO_NEXT_DATA_PATHS = {
  menuRoot: ['props', 'initialState', 'menuPage', 'menu', 'metas', 'root'],
  header: ['props', 'initialState', 'menuPage', 'menu', 'header'],
} as const;

// Header info spans carry no semantic ids, only localized text. Patterns observed in the fixtures:
//   en: "4.8 Excellent" "(500+)" "Closes at 23:00" "AED 20 minimum" "AED 4.95 delivery"
//   ar: "4.8 ممتاز"    "(500+)" "يغلق الساعة 23:00" "الحد الأدنى AED 20" "رسوم التوصيل AED 4.95"
export const DELIVEROO_HEADER_PATTERNS: Record<DiningLocale, {
  minimumOrder: RegExp;
  deliveryFee: RegExp;
  openingStatus: RegExp;
}> = {
  en: { minimumOrder: /\bminimum\b/i, deliveryFee: /\bdelivery\b/i, openingStatus: /\b(closes|opens) at\b/i },
  ar: { minimumOrder: /الحد الأدنى/, deliveryFee: /رسوم التوصيل/, openingStatus: /(يغلق|يفتح)/ },
};

export const DELIVEROO_HEADER_SEPARATOR = '·';
export const DELIVEROO_RATING_COUNT = /^\((\d[\d,]*)(\+)?\)$/;
export const DELIVEROO_RATING = /^(\d(?:[.,]\d+)?)(?:\s|$)/;
