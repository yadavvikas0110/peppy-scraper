// Talabat page anchors, verified on the EN and AR captures of restaurant 773429 (2026-10-09).
// Menu data comes only from the Next.js payload; CSS selectors are used for page metadata only.

export const TALABAT_SELECTORS = {
  htmlRoot: 'html',
  nextData: 'script#__NEXT_DATA__',
  canonicalUrl: 'link[rel="canonical"]',
  // The page writes `hrefLang`; HTML attribute names are case-insensitive.
  alternateUrl: 'link[rel="alternate"][hreflang]',
  jsonLd: 'script[type="application/ld+json"]',
} as const;

export const TALABAT_NEXT_DATA_PATHS = {
  menuState: ['props', 'pageProps', 'initialMenuState'],
  query: ['query'],
} as const;

// Sections Talabat injects into the menu that are not real menu categories. "Picks for you"
// (id -1) is personalised and repeats items that also appear in their real section.
export function isSyntheticTalabatCategoryId(id: string): boolean {
  return /^-\d+$/.test(id) || id === '0';
}
