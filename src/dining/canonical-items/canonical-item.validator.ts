import { ObjectId } from 'mongodb';
import { DINING_PLATFORMS } from '../dining.types';
import { validateLocalizedText, ValidationIssue, ValidationResult } from '../dining.validator';
import { MAX_SEARCH_KEYWORDS } from './canonical-item.text';
import { CANONICAL_ITEM_IDENTITY_STATUSES, CANONICAL_ITEM_STATUSES } from './canonical-item.types';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);
const isDate = (v: unknown) => v instanceof Date && !Number.isNaN(v.getTime());

// Platform-specific data stays on dining_menu_items.
const PLATFORM_FIELDS = ['price', 'originalPrice', 'currency', 'imageUrl', 'sourceUrl', 'url', 'platformItemId', 'sourceKey', 'isAvailable', 'availabilityStatus', 'isActive', 'modifiers', 'hasModifiers'];

export function canonicalIdentityKey(restaurantGroupId: ObjectId, seedMenuItemId: ObjectId): string {
  return `seed:${restaurantGroupId.toHexString()}:${seedMenuItemId.toHexString()}`;
}

export function validateCanonicalItem(doc: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const add = (path: string, message: string) => issues.push({ path, message });
  if (!isObj(doc)) return { valid: false, issues: [{ path: '$', message: 'must be an object' }] };

  for (const f of ['restaurantGroupId', 'seedMenuItemId', 'seedRestaurantId']) {
    if (!(doc[f] instanceof ObjectId)) add(f, 'must be an ObjectId');
  }
  if (doc.restaurantGroupId instanceof ObjectId && doc.seedMenuItemId instanceof ObjectId) {
    if (doc.identityKey !== canonicalIdentityKey(doc.restaurantGroupId, doc.seedMenuItemId)) add('identityKey', 'does not match restaurantGroupId + seedMenuItemId');
  }
  if (typeof doc.seedPlatform !== 'string' || !(DINING_PLATFORMS as readonly string[]).includes(doc.seedPlatform)) add('seedPlatform', 'must be a supported dining platform');

  for (const [field, required] of [['canonicalName', true], ['canonicalDescription', false], ['category', false]] as const) {
    for (const i of validateLocalizedText(doc[field], { required }).issues) add(i.path.replace(/^\$/, field), i.message);
  }

  for (const field of ['aliases', 'searchKeywords']) {
    const v = doc[field];
    if (!Array.isArray(v) || v.some(s => typeof s !== 'string' || !s.trim())) add(field, 'must be an array of non-empty strings');
  }
  if (Array.isArray(doc.searchKeywords) && doc.searchKeywords.length > MAX_SEARCH_KEYWORDS) add('searchKeywords', `must have at most ${MAX_SEARCH_KEYWORDS} entries`);

  if (doc.variant !== undefined) {
    const v = doc.variant;
    if (!isObj(v)) add('variant', 'must be an object');
    else {
      if (v.quantity !== undefined && !(typeof v.quantity === 'number' && Number.isFinite(v.quantity) && v.quantity > 0)) add('variant.quantity', 'must be a positive number');
      for (const f of ['size', 'unit']) if (v[f] !== undefined && (typeof v[f] !== 'string' || !(v[f] as string).trim())) add(`variant.${f}`, 'must be a non-empty string');
      if (v.label !== undefined) for (const i of validateLocalizedText(v.label).issues) add(i.path.replace(/^\$/, 'variant.label'), i.message);
    }
  }

  if (typeof doc.status !== 'string' || !(CANONICAL_ITEM_STATUSES as readonly string[]).includes(doc.status)) add('status', `must be one of: ${CANONICAL_ITEM_STATUSES.join(', ')}`);
  if (typeof doc.identityStatus !== 'string' || !(CANONICAL_ITEM_IDENTITY_STATUSES as readonly string[]).includes(doc.identityStatus)) {
    add('identityStatus', `must be one of: ${CANONICAL_ITEM_IDENTITY_STATUSES.join(', ')}`);
  }

  if (!isObj(doc.signals)) add('signals', 'must be an object');
  else for (const f of ['normalizedNames', 'normalizedDescriptions', 'normalizedCategories']) {
    const v = doc.signals[f];
    if (!Array.isArray(v) || v.some(s => typeof s !== 'string' || !s)) add(`signals.${f}`, 'must be an array of non-empty strings');
  }

  for (const f of PLATFORM_FIELDS) if (f in doc) add(f, 'platform-specific data does not belong on a canonical item');
  for (const f of ['createdAt', 'updatedAt']) if (!isDate(doc[f])) add(f, 'must be a valid Date');
  return { valid: issues.length === 0, issues };
}
