import type {
  DiningLocale,
  DiningLocation,
  DiningPlatform,
  LocalizedText,
  MenuModifierGroup,
  SourceKeyKind,
} from '../dining.types';
import type { PlatformParseWarning } from './platform.types';

/*
 * Mapping contract: platform raw parse result → canonical Dining DTOs for ONE locale.
 *
 * Field names and types follow the Dining domain model (dining.types.ts). Localized fields carry only
 * the mapped locale (`{ en: … }` or `{ ar: … }`); the repositories merge them into the existing
 * document field-by-field, so an AR mapping never removes EN values and vice versa.
 *
 * DTOs carry no database fields (_id, ObjectId references, isActive, timestamps, run ids).
 * `undefined` means "not observed on the source" and leaves the stored value untouched;
 * `clear` lists optional fields the source shows as genuinely absent (e.g. a discount that ended).
 */

export interface DiningRestaurantDto {
  platform: DiningPlatform;
  sourceKey: string;
  sourceKeyKind: Exclude<SourceKeyKind, 'position'>;
  platformRestaurantId?: string;
  slug?: string;
  name: LocalizedText;
  url: LocalizedText;
  brandName?: LocalizedText;
  // Locale-neutral text (cuisine labels, address) is only provided by the platform's reference locale.
  cuisines?: string[];
  tags?: string[];
  location?: DiningLocation;
  rating?: number;
  ratingCount?: number;
  ratingCountText?: string;
  currency: string;
  deliveryFee?: number;
  minimumOrder?: number;
  deliveryTimeMin?: number;
  deliveryTimeMax?: number;
  isOpen?: boolean;
  imageUrl?: string;
}

export interface DiningMenuCategoryDto {
  sourceKey: string;
  sourceKeyKind: SourceKeyKind;
  platformCategoryId?: string;
  name: LocalizedText;
  sortOrder: number;
}

export type DiningMenuItemClearableField = 'description' | 'originalPrice' | 'imageUrl' | 'isPopular' | 'categoryId';

export interface DiningMenuItemDto {
  sourceKey: string;
  sourceKeyKind: SourceKeyKind;
  platformItemId?: string;
  // sourceKey of the parent category in the same mapping (resolved to categoryId by persistence).
  categorySourceKey?: string;
  categoryName?: LocalizedText;
  name: LocalizedText;
  description?: LocalizedText;
  price: number;
  originalPrice?: number;
  currency: string;
  imageUrl?: string;
  isAvailable?: boolean;
  isPopular?: boolean;
  dietaryTags?: string[];
  calories?: number;
  // Single-locale names; persistence merges them with the stored other-locale names.
  modifiers?: MenuModifierGroup[];
  sourceUrl: LocalizedText;
  clear: DiningMenuItemClearableField[];
}

// Whether this mapping may be used to mark unseen items inactive (see repositories).
export interface DiningMenuCompleteness {
  complete: boolean;
  reasons: string[];
  itemsSeen: number;
  itemsMapped: number;
  itemsRejected: number;
}

export interface DiningMappedMenu {
  platform: DiningPlatform;
  locale: DiningLocale;
  sourceUrl: string;
  restaurant: DiningRestaurantDto;
  categories: DiningMenuCategoryDto[];
  items: DiningMenuItemDto[];
  completeness: DiningMenuCompleteness;
  // Parser warnings plus mapping problems (unkeyable/duplicate items, dropped modifier groups).
  warnings: PlatformParseWarning[];
}

export class DiningMappingError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'DiningMappingError';
    this.code = code;
  }
}

export interface DiningPlatformMapper<TParseResult> {
  readonly platform: DiningPlatform;
  // Throws DiningMappingError only when the page as a whole is unusable (e.g. no restaurant identity).
  map(result: TParseResult): DiningMappedMenu;
}
