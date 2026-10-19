import { DINING_PLATFORMS, DiningPlatform, SourceKeyKind } from './dining.types';

/*
 * Source identity strategy
 * ────────────────────────
 * A sourceKey is the deterministic, locale-independent identity of a dining document.
 * The EN and AR scrapes of the same restaurant/category/item must produce the same key,
 * so keys are built only from platform identifiers or locale-neutral source tokens —
 * never from display names (which differ per locale) or hashed CSS classes (which change per deploy).
 *
 * Precedence (resolveSourceIdentity):
 *   1. id       — platform-issued ID (restaurant ID, category ID, item ID). Preferred.
 *   2. anchor   — a locale-neutral stable token verified for the platform, e.g. the URL slug
 *                 shared by /en and /ar pages, or an item image asset path.
 *   3. position — 0-based order within the parent. Last resort, categories/items only.
 *                 Stable across EN/AR of the same menu, but a menu reorder re-keys entries
 *                 (old keys are then marked inactive, not duplicated as active).
 *
 * Formats (every value is encodeURIComponent-encoded, so ':' only ever separates segments):
 *   restaurant  <platform>:restaurant:<id|anchor>:<value>
 *   category    <restaurantKey>:category:<id|anchor|pos>:<value>
 *   item        <restaurantKey>:item:<id|anchor>:<value>          (survives moving between categories)
 *   item (pos)  <categoryKey>:item:pos:<index>                     (position is only meaningful in its category)
 *
 * A platform must use one strategy consistently: switching a restaurant from anchor to id
 * changes its key and therefore the keys of all its children.
 */

export type SourceIdentity =
  | { kind: 'id'; value: string }
  | { kind: 'anchor'; value: string }
  | { kind: 'position'; value: number };

export type StableSourceIdentity = Exclude<SourceIdentity, { kind: 'position' }>;

export class SourceKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceKeyError';
  }
}

const MAX_TOKEN_LENGTH = 256;
const MAX_POSITION = 100000;
const ARABIC_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
const WHITESPACE_RE = /\s/;

const KIND_SEGMENT: Record<SourceKeyKind, string> = { id: 'id', anchor: 'anchor', position: 'pos' };
const SEGMENT_KIND: Record<string, SourceKeyKind> = { id: 'id', anchor: 'anchor', pos: 'position' };

export function isDiningPlatform(value: unknown): value is DiningPlatform {
  return typeof value === 'string' && (DINING_PLATFORMS as readonly string[]).includes(value);
}

// Whitespace or Arabic script means a display name is being misused as an identity.
export function checkIdentityToken(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return 'must be a non-empty string';
  if (value.length > MAX_TOKEN_LENGTH) return `must be at most ${MAX_TOKEN_LENGTH} characters`;
  if (WHITESPACE_RE.test(value)) return 'must not contain whitespace (display names are not identities)';
  if (ARABIC_RE.test(value)) return 'must not contain Arabic text (translated names are not identities)';
  return null;
}

function assertIdentity(identity: SourceIdentity, label: string): void {
  if (identity.kind === 'position') {
    if (!Number.isInteger(identity.value) || identity.value < 0 || identity.value > MAX_POSITION) {
      throw new SourceKeyError(`${label} position must be an integer between 0 and ${MAX_POSITION}`);
    }
    return;
  }
  if (identity.kind !== 'id' && identity.kind !== 'anchor') {
    throw new SourceKeyError(`${label} identity kind must be id, anchor or position`);
  }
  const problem = checkIdentityToken(identity.value);
  if (problem) throw new SourceKeyError(`${label} ${identity.kind} ${problem}`);
}

function segment(identity: SourceIdentity): string {
  return `${KIND_SEGMENT[identity.kind]}:${encodeURIComponent(String(identity.value))}`;
}

export function resolveSourceIdentity(input: {
  id?: string;
  anchor?: string;
  position?: number;
}): SourceIdentity {
  if (input.id !== undefined) return { kind: 'id', value: input.id };
  if (input.anchor !== undefined) return { kind: 'anchor', value: input.anchor };
  if (input.position !== undefined) return { kind: 'position', value: input.position };
  throw new SourceKeyError('No source identity available: provide an id, anchor or position');
}

export function buildRestaurantSourceKey(platform: DiningPlatform, identity: StableSourceIdentity): string {
  if (!isDiningPlatform(platform)) throw new SourceKeyError(`Unknown dining platform: ${String(platform)}`);
  if ((identity as SourceIdentity).kind === 'position') {
    throw new SourceKeyError('Restaurant identity cannot be position-based');
  }
  assertIdentity(identity, 'restaurant');
  return `${platform}:restaurant:${segment(identity)}`;
}

export function buildCategorySourceKey(restaurantSourceKey: string, identity: SourceIdentity): string {
  assertRestaurantKey(restaurantSourceKey);
  assertIdentity(identity, 'category');
  return `${restaurantSourceKey}:category:${segment(identity)}`;
}

export function buildMenuItemSourceKey(
  restaurantSourceKey: string,
  identity: SourceIdentity,
  categorySourceKey?: string
): string {
  assertRestaurantKey(restaurantSourceKey);
  assertIdentity(identity, 'item');
  if (identity.kind !== 'position') {
    return `${restaurantSourceKey}:item:${segment(identity)}`;
  }
  if (!categorySourceKey || !categorySourceKey.startsWith(`${restaurantSourceKey}:category:`)) {
    throw new SourceKeyError('Position-based item identity requires the parent category sourceKey');
  }
  return `${categorySourceKey}:item:${segment(identity)}`;
}

// ─── Parsing (used by validation) ────────────────────────────────────────────

export interface ParsedSourceKey {
  platform: string;
  entity: 'restaurant' | 'category' | 'item';
  kind: SourceKeyKind;
  value: string;
}

export function parseSourceKey(key: string): ParsedSourceKey | null {
  if (typeof key !== 'string') return null;
  const parts = key.split(':');
  // platform:restaurant:kind:value[:entity:kind:value]*
  if (parts.length < 4 || (parts.length - 1) % 3 !== 0) return null;
  if (!isDiningPlatform(parts[0])) return null;

  for (let i = 1; i < parts.length; i += 3) {
    const [entitySeg, kindSeg, valueSeg] = [parts[i], parts[i + 1], parts[i + 2]];
    if (!SEGMENT_KIND[kindSeg] || valueSeg === '') return null;
    if (i === 1) {
      if (entitySeg !== 'restaurant' || kindSeg === 'pos') return null;
    } else if (entitySeg !== 'category' && entitySeg !== 'item') {
      return null;
    }
  }

  const entity = parts[parts.length - 3];
  if (entity !== 'restaurant' && entity !== 'category' && entity !== 'item') return null;
  let value: string;
  try {
    value = decodeURIComponent(parts[parts.length - 1]);
  } catch {
    return null;
  }
  return { platform: parts[0], entity, kind: SEGMENT_KIND[parts[parts.length - 2]], value };
}

function assertRestaurantKey(key: string): void {
  const parsed = parseSourceKey(key);
  if (!parsed || parsed.entity !== 'restaurant') {
    throw new SourceKeyError('restaurantSourceKey is not a valid restaurant sourceKey');
  }
}
