import { createHash } from 'crypto';
import { ObjectId } from 'mongodb';
import type { DiningLocale, DiningPlatform } from '../dining.types';
import type { DiningCronCollections } from './dining-cron.collections';
import type {
  DiningCronChange,
  DiningCronChangeAction,
  DiningCronChangeEntity,
  DiningCronChangeSummary,
  DiningCronFieldChange,
} from './dining-cron.types';

/*
 * Field-level audit of one restaurant refresh: snapshot the restaurant, its categories and items
 * before the scrape, snapshot again after, and record what was created, updated, deactivated or
 * reactivated (e.g. `price: 17 → 18`, `imageUrl: … → …`). Read-only on the menu collections.
 */

const RESTAURANT_FIELDS = [
  'name.en', 'name.ar', 'description.en', 'description.ar', 'brandName.en', 'brandName.ar',
  'rating', 'ratingCount', 'ratingCountText', 'deliveryFee', 'minimumOrder', 'deliveryTimeMin', 'deliveryTimeMax',
  'isOpen', 'isActive', 'imageUrl', 'currency', 'cuisines', 'tags', 'offers',
  'location.address', 'location.area', 'location.city', 'location.lat', 'location.lng',
];

const CATEGORY_FIELDS = ['name.en', 'name.ar', 'sortOrder', 'isActive'];

const ITEM_FIELDS = [
  'name.en', 'name.ar', 'description.en', 'description.ar', 'categoryName.en', 'categoryName.ar', 'categoryId',
  'price', 'originalPrice', 'currency', 'imageUrl', 'availabilityStatus', 'isAvailable', 'isActive',
  'isPopular', 'hasModifiers', 'calories', 'dietaryTags', 'modifiers',
];

type Doc = Record<string, unknown> & { _id: ObjectId; sourceKey?: string; name?: { en?: string; ar?: string } };

export interface RestaurantSnapshot {
  restaurant: Doc | null;
  categories: Map<string, Doc>;
  items: Map<string, Doc>;
}

function read(doc: Doc, path: string): unknown {
  let value: unknown = doc;
  for (const key of path.split('.')) {
    if (value === null || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

// Key-order independent: per-locale writes rebuild nested objects ({en, ar} vs {ar, en}).
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object' && !(value instanceof Date) && !(value instanceof ObjectId)) {
    const entries = Object.keys(value as Record<string, unknown>)
      .filter(k => (value as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map(k => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function modifierDigest(value: unknown): { groups: number; options: number; hash: string } | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const options = value.reduce((n, g) => n + (Array.isArray(g?.options) ? g.options.length : 0), 0);
  return { groups: value.length, options, hash: createHash('sha1').update(stableStringify(value)).digest('hex').slice(0, 12) };
}

// Comparable, storable form: ObjectIds → hex, Dates → ISO, arrays kept, empty → undefined.
function normalize(path: string, value: unknown): unknown {
  if (path === 'modifiers') return modifierDigest(value);
  if (value === null || value === undefined || value === '') return undefined;
  if (value instanceof ObjectId) return value.toHexString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.length ? value : undefined;
  return value;
}

export function diffFields(before: Doc, after: Doc, fields: string[]): DiningCronFieldChange[] {
  const changes: DiningCronFieldChange[] = [];
  for (const field of fields) {
    const a = normalize(field, read(before, field));
    const b = normalize(field, read(after, field));
    if (stableStringify(a) !== stableStringify(b)) changes.push({ field, before: a ?? null, after: b ?? null });
  }
  return changes;
}

export async function snapshotRestaurant(collections: Pick<DiningCronCollections, 'restaurants' | 'menuCategories' | 'menuItems'>, restaurantId: ObjectId): Promise<RestaurantSnapshot> {
  const [restaurant, categories, items] = await Promise.all([
    collections.restaurants.findOne({ _id: restaurantId }),
    collections.menuCategories.find({ restaurantId }).toArray(),
    collections.menuItems.find({ restaurantId }).toArray(),
  ]);
  const byId = (docs: unknown[]) => new Map((docs as Doc[]).map(d => [d._id.toHexString(), d]));
  return { restaurant: restaurant as unknown as Doc | null, categories: byId(categories), items: byId(items) };
}

export interface ChangeContext {
  jobId: string;
  runId?: string;
  restaurantId: ObjectId;
  platform: DiningPlatform;
  locale: DiningLocale;
  now: Date;
}

function actionFor(before: Doc | undefined, after: Doc, changes: DiningCronFieldChange[]): DiningCronChangeAction | null {
  if (!before) return 'created';
  const wasActive = before.isActive !== false;
  const isActive = after.isActive !== false;
  if (wasActive && !isActive) return 'deactivated';
  if (!wasActive && isActive) return 'reactivated';
  return changes.length ? 'updated' : null;
}

function displayName(doc: Doc, locale: DiningLocale): string | undefined {
  return doc.name?.[locale] ?? doc.name?.en ?? doc.name?.ar;
}

function diffCollection(
  entity: DiningCronChangeEntity,
  before: Map<string, Doc>,
  after: Map<string, Doc>,
  fields: string[],
  ctx: ChangeContext
): DiningCronChange[] {
  const out: DiningCronChange[] = [];
  for (const [id, doc] of after) {
    const previous = before.get(id);
    const changes = previous ? diffFields(previous, doc, fields) : [];
    const action = actionFor(previous, doc, changes);
    if (!action) continue;
    out.push({
      jobId: ctx.jobId,
      runId: ctx.runId,
      restaurantId: ctx.restaurantId,
      platform: ctx.platform,
      locale: ctx.locale,
      entity,
      action,
      entityId: doc._id,
      sourceKey: String(doc.sourceKey ?? ''),
      name: displayName(doc, ctx.locale),
      changes,
      createdAt: ctx.now,
    });
  }
  return out;
}

export function diffSnapshots(before: RestaurantSnapshot, after: RestaurantSnapshot, ctx: ChangeContext): DiningCronChange[] {
  const restaurants = (s: RestaurantSnapshot) => new Map(s.restaurant ? [[s.restaurant._id.toHexString(), s.restaurant]] : []);
  return [
    ...diffCollection('restaurant', restaurants(before), restaurants(after), RESTAURANT_FIELDS, ctx),
    ...diffCollection('category', before.categories, after.categories, CATEGORY_FIELDS, ctx),
    ...diffCollection('item', before.items, after.items, ITEM_FIELDS, ctx),
  ];
}

export function summarizeChanges(changes: DiningCronChange[], stored: number): DiningCronChangeSummary {
  const byAction: DiningCronChangeSummary['byAction'] = {};
  for (const c of changes) byAction[c.action] = (byAction[c.action] ?? 0) + 1;
  return { recorded: stored, truncated: changes.length - stored, byAction };
}

// Items created by this refresh that are not linked to a canonical item yet (so not price-compared).
export async function countUnmappedItems(collections: Pick<DiningCronCollections, 'itemMappings'>, itemIds: ObjectId[]): Promise<number> {
  if (!itemIds.length) return 0;
  const mapped = await collections.itemMappings.distinct('menuItemId', { menuItemId: { $in: itemIds }, isActive: true });
  return itemIds.length - mapped.length;
}
