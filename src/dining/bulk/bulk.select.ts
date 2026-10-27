import type { ImportQueueItem } from './bulk.types';

/*
 * Which discovered restaurants go into a batch. The two platforms list different slices of a very large catalogue, so
 * same-branch pairs cannot be found by crawling both lists blindly. Selection therefore works in three tiers:
 *
 *   1. PAIR     the same brand and the same area on both platforms: very likely the same branch (verified later by the
 *               identity matcher, which needs the same name and the same address or coordinates within 75 m)
 *   2. CONTROL  the same brand on both platforms but a different area: very likely different branches. Imported on purpose
 *               to check the mapping does NOT merge them.
 *   3. FILL     the rest of each platform's quota, most-reviewed first, at most a few per brand for variety.
 *
 * These are only hints for choosing what to scrape: nothing here links restaurants. Linking is the identity matcher's job.
 */

const STOP = new Set(['al', 'el', 'the', 'and', 'of', 'dubai', 'uae', 'restaurant', 'restaurants', 'cafe', 'caffe', 'branch', 'kitchen']);
// Words that name a kind of place, not which place: two "...Square" branches are not the same branch.
const GENERIC_PLACE = new Set(['square', 'mall', 'tower', 'towers', 'center', 'centre', 'street', 'st', 'road', 'rd', 'avenue', 'ave', 'plaza', 'park', 'boulevard', 'blvd', 'building', 'residence', 'residences']);

function tokens(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[`'’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// "McDonald's, Al Wasl" / "Hardee`s, ,Business Bay" / "Kababji Grill - كبابجي" → the first significant word of the brand part.
export function brandKey(name: string): string {
  const brandPart = name.split(/[,\-–(|]/)[0] ?? name;
  return tokens(brandPart).find(t => !STOP.has(t) && !/^\d+$/.test(t)) ?? '';
}

// Every word of the brand part of a name ("Pizza Hut", "Five Guys", "Black Sheep Coffee").
function brandTokens(name: string): Set<string> {
  return new Set(tokens(name.split(/[,\-–(|]/)[0] ?? name));
}

// Place words from the branch slug, minus the whole brand, filler and generic place words: "pizza-hut-al-diyafa" is "diyafa".
export function areaTokens(candidate: Pick<ImportQueueItem, 'slug' | 'name'>): Set<string> {
  const brand = brandTokens(candidate.name);
  const out = new Set<string>();
  for (const t of tokens(candidate.slug ?? candidate.name)) {
    if (brand.has(t) || STOP.has(t) || GENERIC_PLACE.has(t) || /^\d+$/.test(t)) continue;
    out.add(t);
  }
  return out;
}

export type SelectionTier = 'PAIR' | 'CONTROL' | 'FILL';

export interface Selection {
  platform: ImportQueueItem['platform'];
  platformRestaurantId: string;
  tier: SelectionTier;
  pairKey?: string;
  reason: string;
}

export interface SelectionOptions {
  // Restaurants wanted per platform.
  quota: Partial<Record<ImportQueueItem['platform'], number>>;
  // Same-brand/different-area control pairs to include.
  controls?: number;
  // At most this many restaurants of one brand per platform among the FILL picks.
  perBrandCap?: number;
}

type Candidate = Pick<ImportQueueItem, 'platform' | 'platformRestaurantId' | 'name' | 'slug' | 'rating' | 'ratingCount'>;

const popularity = (c: Candidate) => (c.ratingCount ?? 0) * 10 + (c.rating ?? 0);
const keyOf = (c: Candidate) => `${c.platform}:${c.platformRestaurantId}`;

export function selectForBatch(candidates: Candidate[], options: SelectionOptions): Selection[] {
  const quota = options.quota;
  const left = { ...quota } as Record<string, number>;
  const chosen = new Map<string, Selection>();
  const take = (c: Candidate, tier: SelectionTier, reason: string, pairKey?: string) => {
    if (chosen.has(keyOf(c)) || (left[c.platform] ?? 0) <= 0) return false;
    chosen.set(keyOf(c), { platform: c.platform, platformRestaurantId: c.platformRestaurantId, tier, reason, pairKey });
    left[c.platform]--;
    return true;
  };

  const byPlatform = (platform: string) => candidates.filter(c => c.platform === platform && brandKey(c.name));
  const deliveroo = byPlatform('deliveroo').sort((a, b) => popularity(b) - popularity(a));
  const talabat = byPlatform('talabat').sort((a, b) => popularity(b) - popularity(a));

  // 1. PAIR: same brand and a shared place word, most popular first.
  for (const d of deliveroo) {
    for (const t of talabat) {
      if (brandKey(d.name) !== brandKey(t.name)) continue;
      const shared = [...areaTokens(d)].filter(x => areaTokens(t).has(x));
      if (!shared.length) continue;
      const pairKey = `${brandKey(d.name)}:${shared.sort().join('+')}`;
      if ((left.deliveroo ?? 0) > 0 && (left.talabat ?? 0) > 0 && !chosen.has(keyOf(d)) && !chosen.has(keyOf(t))) {
        take(d, 'PAIR', `same brand "${brandKey(d.name)}" and area (${shared.join(', ')}) on both platforms`, pairKey);
        take(t, 'PAIR', `same brand "${brandKey(t.name)}" and area (${shared.join(', ')}) on both platforms`, pairKey);
      }
    }
  }

  // 2. CONTROL: same brand, no shared place word. One pair per brand.
  const controlBrands = new Set<string>();
  const pairedBrands = new Set([...chosen.values()].map(s => s.pairKey?.split(':')[0]));
  for (const d of deliveroo) {
    if (controlBrands.size >= (options.controls ?? 0)) break;
    const brand = brandKey(d.name);
    if (pairedBrands.has(brand) || controlBrands.has(brand) || chosen.has(keyOf(d))) continue;
    const t = talabat.find(x => brandKey(x.name) === brand && !chosen.has(keyOf(x)));
    if (!t) continue;
    if ((left.deliveroo ?? 0) > 0 && (left.talabat ?? 0) > 0) {
      take(d, 'CONTROL', `same brand "${brand}" as a Talabat branch but a different area: must not be merged`, `control:${brand}`);
      take(t, 'CONTROL', `same brand "${brand}" as a Deliveroo branch but a different area: must not be merged`, `control:${brand}`);
      controlBrands.add(brand);
    }
  }

  // 3. FILL: most popular first, a few per brand.
  const cap = options.perBrandCap ?? 2;
  for (const list of [deliveroo, talabat]) {
    const perBrand = new Map<string, number>();
    for (const s of chosen.values()) {
      const c = candidates.find(x => keyOf(x) === `${s.platform}:${s.platformRestaurantId}`);
      if (c && c.platform === list[0]?.platform) perBrand.set(brandKey(c.name), (perBrand.get(brandKey(c.name)) ?? 0) + 1);
    }
    for (const c of list) {
      const brand = brandKey(c.name);
      if ((perBrand.get(brand) ?? 0) >= cap) continue;
      if (take(c, 'FILL', 'most-reviewed restaurants of the listing')) perBrand.set(brand, (perBrand.get(brand) ?? 0) + 1);
    }
  }
  return [...chosen.values()];
}
