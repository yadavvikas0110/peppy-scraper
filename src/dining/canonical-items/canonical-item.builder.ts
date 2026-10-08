import { ObjectId, WithId } from 'mongodb';
import { stripUndefined } from '../dining.object';
import type { DiningLocale, DiningMenuItem, LocalizedText } from '../dining.types';
import { DINING_LOCALES } from '../dining.types';
import { deepEqual } from '../repositories/document-update';
import { buildItemSignals, buildSearchKeywords, extractVariant, normalizeItemText } from './canonical-item.text';
import type { DiningCanonicalItem } from './canonical-item.types';
import { canonicalIdentityKey } from './canonical-item.validator';

export const MAX_ALIASES = 20;

const clean = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

function cleanLocalized(text: LocalizedText | undefined): LocalizedText | undefined {
  if (!text || typeof text !== 'object') return undefined;
  const out: LocalizedText = {};
  for (const l of DINING_LOCALES) {
    const v = clean(text[l]);
    if (v) out[l] = v;
  }
  return out.en || out.ar ? out : undefined;
}

function derived(item: Pick<DiningCanonicalItem, 'canonicalName' | 'canonicalDescription' | 'category' | 'aliases'>) {
  const parts = { names: item.canonicalName, aliases: item.aliases, category: item.category, description: item.canonicalDescription };
  return { searchKeywords: buildSearchKeywords(parts), signals: buildItemSignals(parts) };
}

// One source item → one canonical item, copied from the source as-is (both locales when present).
export function buildCanonicalItem(restaurantGroupId: ObjectId, item: WithId<DiningMenuItem>, now: Date): DiningCanonicalItem {
  const canonicalName = cleanLocalized(item.name) ?? {};
  const base = {
    canonicalName,
    canonicalDescription: cleanLocalized(item.description),
    category: cleanLocalized(item.categoryName),
    aliases: [] as string[],
  };
  return stripUndefined({
    restaurantGroupId,
    identityKey: canonicalIdentityKey(restaurantGroupId, item._id),
    ...base,
    ...derived(base),
    variant: extractVariant(canonicalName),
    identityStatus: 'auto',
    status: 'active',
    seedMenuItemId: item._id,
    seedRestaurantId: item.restaurantId,
    seedPlatform: item.platform,
    createdAt: now,
    updatedAt: now,
  }) as DiningCanonicalItem;
}

export interface CanonicalItemEnrichment {
  set: Record<string, unknown>;
  merged: DiningCanonicalItem;
}

/*
 * Re-run on an existing canonical item: fills locales that are still missing (e.g. AR scraped
 * after the first backfill) and records a renamed seed name as an alias. Never overwrites an
 * existing value and never touches status/identityStatus — source availability is not
 * canonical status.
 */
export function planCanonicalItemEnrichment(existing: WithId<DiningCanonicalItem>, item: DiningMenuItem, now: Date): CanonicalItemEnrichment | null {
  const merged: DiningCanonicalItem = {
    ...existing,
    canonicalName: { ...existing.canonicalName },
    canonicalDescription: existing.canonicalDescription ? { ...existing.canonicalDescription } : undefined,
    category: existing.category ? { ...existing.category } : undefined,
    aliases: [...existing.aliases],
  };
  const set: Record<string, unknown> = {};

  const fill = (field: 'canonicalName' | 'canonicalDescription' | 'category', source: LocalizedText | undefined) => {
    const src = cleanLocalized(source);
    if (!src) return;
    for (const l of DINING_LOCALES) {
      const value = src[l];
      if (!value) continue;
      const current = merged[field]?.[l as DiningLocale];
      if (current === undefined) {
        merged[field] = { ...(merged[field] ?? {}), [l]: value };
        set[`${field}.${l}`] = value;
      } else if (field === 'canonicalName' && normalizeItemText(current) !== normalizeItemText(value)) {
        const known = new Set([...merged.aliases, ...Object.values(merged.canonicalName)].map(normalizeItemText));
        if (!known.has(normalizeItemText(value)) && merged.aliases.length < MAX_ALIASES) merged.aliases.push(value);
      }
    }
  };
  fill('canonicalName', item.name);
  fill('canonicalDescription', item.description);
  fill('category', item.categoryName);

  const next = derived(merged);
  if (!deepEqual(merged.aliases, existing.aliases)) set.aliases = merged.aliases;
  if (!deepEqual(next.searchKeywords, existing.searchKeywords)) set.searchKeywords = next.searchKeywords;
  if (!deepEqual(next.signals, existing.signals)) set.signals = next.signals;
  if (existing.identityStatus === 'auto') {
    const variant = extractVariant(merged.canonicalName);
    if (variant && !deepEqual(variant, existing.variant)) set.variant = variant;
  }
  if (Object.keys(set).length === 0) return null;

  set.updatedAt = now;
  return { set, merged: stripUndefined({ ...merged, ...next, variant: (set.variant as DiningCanonicalItem['variant']) ?? existing.variant, updatedAt: now }) };
}
