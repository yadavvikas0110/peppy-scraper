import { isPlainRecord } from '../../dining.object';

/*
 * A Talabat area listing page (e.g. https://www.talabat.com/uae/restaurants/1252/business-bay?page=2): script#__NEXT_DATA__
 * → props.pageProps.data.vendors, 15 vendors per page, with the platform branch id, coordinates and the menu path.
 *
 * The listing covers everything Talabat delivers to the area, not only restaurants (pharmacies, minimarts, supermarkets, ...),
 * and its order is not stable between requests, so a vendor may repeat or be missed across pages: callers de-duplicate by id.
 */

export interface TalabatListingVendor {
  // The id in the menu URL (/uae/restaurant/<branchId>/<slug>); this is the platform restaurant id of the menu page.
  branchId: string;
  restaurantId?: string;
  name: string;
  branchName?: string;
  branchSlug: string;
  // e.g. /uae/restaurant/714473/apotec-pharmacy-business-bay
  menuPath: string;
  cuisines: string[];
  rating?: number;
  ratingCount?: number;
  deliveryFee?: number;
  minimumOrder?: number;
  lat?: number;
  lng?: number;
  verticalType?: number;
  // A restaurant/food vendor: not a grocery, pharmacy, darkstore or other shop vertical.
  isRestaurant: boolean;
  promotionText?: string;
  discountText?: string;
}

export interface TalabatListingPage {
  page: number;
  size: number;
  totalVendors?: number;
  area?: { id: number; name: string; slug: string };
  vendors: TalabatListingVendor[];
}

function num(value: unknown): number | undefined {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function parseTalabatListing(html: string): TalabatListingPage | null {
  const match = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!match) return null;
  let data: unknown;
  try {
    data = (JSON.parse(match[1]) as { props?: { pageProps?: { data?: unknown } } }).props?.pageProps?.data;
  } catch {
    return null;
  }
  if (!isPlainRecord(data) || !Array.isArray(data.vendors)) return null;

  const vendors: TalabatListingVendor[] = [];
  const seen = new Set<string>();
  for (const raw of data.vendors) {
    if (!isPlainRecord(raw)) continue;
    const menuPath = str(raw.menuUrl);
    const name = str(raw.name);
    const idFromPath = menuPath ? /\/restaurant\/(\d+)\//.exec(menuPath)?.[1] : undefined;
    const branchId = idFromPath ?? (num(raw.branchId) !== undefined ? String(num(raw.branchId)) : undefined);
    if (!menuPath || !name || !branchId || seen.has(branchId)) continue;
    seen.add(branchId);
    const verticalType = num(raw.verticalType);
    vendors.push({
      branchId,
      restaurantId: num(raw.restaurantId) !== undefined ? String(num(raw.restaurantId)) : undefined,
      name,
      branchName: str(raw.branchName),
      branchSlug: str(raw.branchSlug) ?? menuPath.split('/').filter(Boolean).pop() ?? branchId,
      menuPath,
      cuisines: (str(raw.cuisineString) ?? '').split(',').map(c => c.trim()).filter(Boolean),
      rating: num(raw.rate) || undefined,
      ratingCount: num(raw.totalRatings) || undefined,
      deliveryFee: num(raw.deliveryFee),
      minimumOrder: num(raw.minimumOrderAmount),
      lat: num(raw.latitude),
      lng: num(raw.longitude),
      verticalType,
      isRestaurant: verticalType === 0 && raw.isGrocery !== true && raw.isDarkstore !== true,
      promotionText: str(raw.promotionText),
      discountText: str(raw.discountText),
    });
  }

  const area = isPlainRecord(data.area) && num(data.area.id) !== undefined
    ? { id: num(data.area.id) as number, name: str(data.area.name) ?? '', slug: str(data.area.slug) ?? '' }
    : undefined;
  return { page: num(data.page) ?? 1, size: num(data.size) ?? vendors.length, totalVendors: num(data.totalVendors), area, vendors };
}

// The EN menu URL the dining scraper takes (the `aid` is the delivery area the listing was for).
export function talabatMenuUrl(vendor: Pick<TalabatListingVendor, 'menuPath'>, areaId?: number): string {
  return `https://www.talabat.com${vendor.menuPath}${areaId !== undefined ? `?aid=${areaId}` : ''}`;
}
