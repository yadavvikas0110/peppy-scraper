import type { DiningPlatform, DiningRestaurant, LocalizedText } from '../dining.types';
import type { RestaurantMatchSignals } from './identity.types';

// Signals of one source restaurant. Platform ID and slug identify the *listing* and are only
// ever compared within the same platform — never across platforms.
export interface SourceRestaurantSignals extends RestaurantMatchSignals {
  platform: DiningPlatform;
  platformRestaurantId?: string;
  slug?: string;
}

const ARABIC_FOLD: Record<string, string> = { 'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ٱ': 'ا', 'ة': 'ه', 'ى': 'ي', 'ـ': '' };

// Case/diacritic/punctuation-insensitive form used for comparisons only (never stored as display text).
export function normalizeIdentityText(value: string | undefined | null): string | undefined {
  if (typeof value !== 'string') return undefined;
  const out = value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[أإآٱةىـ]/g, ch => ARABIC_FOLD[ch])
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  return out || undefined;
}

function localizedKeys(text: LocalizedText | undefined): string[] {
  const keys = [text?.en, text?.ar].map(normalizeIdentityText).filter((k): k is string => !!k);
  return [...new Set(keys)];
}

function validCoordinates(lat: unknown, lng: unknown): { lat: number; lng: number } | undefined {
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) return undefined;
  return { lat, lng };
}

export function extractSourceSignals(restaurant: DiningRestaurant): SourceRestaurantSignals {
  const location = restaurant.location ?? {};
  const coords = validCoordinates(location.lat, location.lng);
  return {
    platform: restaurant.platform,
    platformRestaurantId: restaurant.platformRestaurantId,
    slug: restaurant.slug,
    names: localizedKeys(restaurant.name),
    brands: localizedKeys(restaurant.brandName),
    city: normalizeIdentityText(location.city),
    area: normalizeIdentityText(location.area),
    address: normalizeIdentityText(location.address),
    lat: coords?.lat,
    lng: coords?.lng,
  };
}

export function toGroupSignals(source: SourceRestaurantSignals): RestaurantMatchSignals {
  const { platform: _p, platformRestaurantId: _id, slug: _s, ...signals } = source;
  return signals;
}

// Without at least one of these a listing could be any branch of the brand.
export function hasBranchLocator(signals: RestaurantMatchSignals): boolean {
  return !!signals.address || !!signals.area || (signals.lat !== undefined && signals.lng !== undefined);
}

// Areas are compatible when equal or one contains the other as whole words
// ("dubai business bay" ⊇ "business bay").
export function areasCompatible(a: string, b: string): boolean {
  if (a === b) return true;
  const pa = ` ${a} `;
  const pb = ` ${b} `;
  return pa.includes(pb) || pb.includes(pa);
}

export function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
