import { ObjectId, UpdateFilter } from 'mongodb';
import { isPlainRecord, stripUndefined } from '../dining.object';
import type { DiningLocale, LocalizedText } from '../dining.types';

export { stripUndefined };

/*
 * Field-level update builder shared by the dining repositories.
 *
 * Every write is expressed as $set / $setOnInsert / $unset on individual paths ("name.en", never
 * "name"), so an AR scrape cannot remove EN values. `applyUpdate` replays the same update in
 * memory, which lets a repository validate the resulting document and detect real changes
 * before anything is written.
 */

export interface DocumentUpdate {
  set: Record<string, unknown>;
  setOnInsert: Record<string, unknown>;
  unset: string[];
}

type Obj = Record<string, unknown>;

export function createUpdate(): DocumentUpdate {
  return { set: {}, setOnInsert: {}, unset: [] };
}

const isPlainObject = isPlainRecord;

export function setField(update: DocumentUpdate, path: string, value: unknown): void {
  if (value !== undefined) update.set[path] = stripUndefined(value);
}

export function setOnInsertField(update: DocumentUpdate, path: string, value: unknown): void {
  if (value !== undefined && !(path in update.set)) update.setOnInsert[path] = stripUndefined(value);
}

export function setLocalized(update: DocumentUpdate, field: string, locale: DiningLocale, value: LocalizedText | undefined): void {
  const text = value?.[locale];
  if (text !== undefined) update.set[`${field}.${locale}`] = text;
}

// Removes one locale of a LocalizedText; removes the whole field when no other locale remains
// (an empty `{}` LocalizedText is invalid).
export function unsetLocalized(update: DocumentUpdate, existing: Obj | null, field: string, locale: DiningLocale): void {
  const current = existing?.[field];
  if (!isPlainObject(current) || current[locale] === undefined) return;
  const others = Object.keys(current).filter(k => k !== locale && current[k] !== undefined);
  update.unset.push(others.length ? `${field}.${locale}` : field);
}

export function unsetField(update: DocumentUpdate, existing: Obj | null, field: string): void {
  if (existing && existing[field] !== undefined) update.unset.push(field);
}

export function toMongoUpdate<T>(update: DocumentUpdate): UpdateFilter<T> {
  const out: Obj = { $set: update.set };
  if (Object.keys(update.setOnInsert).length) out.$setOnInsert = update.setOnInsert;
  if (update.unset.length) out.$unset = Object.fromEntries(update.unset.map(p => [p, '']));
  return out as UpdateFilter<T>;
}

// ─── In-memory replay ────────────────────────────────────────────────────────

function clone<T>(value: T): T {
  if (value instanceof Date) return new Date(value.getTime()) as unknown as T;
  if (Array.isArray(value)) return value.map(clone) as unknown as T;
  if (!isPlainObject(value)) return value;
  const out: Obj = {};
  for (const [k, v] of Object.entries(value)) out[k] = clone(v);
  return out as T;
}

function setPath(target: Obj, path: string, value: unknown): void {
  const parts = path.split('.');
  let node = target;
  for (const part of parts.slice(0, -1)) {
    if (!isPlainObject(node[part])) node[part] = {};
    node = node[part] as Obj;
  }
  node[parts[parts.length - 1]] = clone(value);
}

function unsetPath(target: Obj, path: string): void {
  const parts = path.split('.');
  let node: unknown = target;
  for (const part of parts.slice(0, -1)) {
    if (!isPlainObject(node)) return;
    node = node[part];
  }
  if (isPlainObject(node)) delete node[parts[parts.length - 1]];
}

// Mirrors MongoDB semantics for the operators used here; $setOnInsert applies only to new documents.
export function applyUpdate<T extends object>(existing: T | null, update: DocumentUpdate): T {
  const doc = (existing ? clone(existing) : {}) as Obj;
  for (const [path, value] of Object.entries(update.set)) setPath(doc, path, value);
  if (!existing) for (const [path, value] of Object.entries(update.setOnInsert)) setPath(doc, path, value);
  for (const path of update.unset) unsetPath(doc, path);
  return doc as T;
}

// ─── Change detection ────────────────────────────────────────────────────────

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a instanceof ObjectId || b instanceof ObjectId) {
    return a instanceof ObjectId && b instanceof ObjectId && a.equals(b);
  }
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) if (!deepEqual(a[k], b[k])) return false;
    return true;
  }
  return a === b;
}

// Metadata refreshed on every observation; not a content change.
export const OBSERVATION_FIELDS = [
  'updatedAt', 'lastSeenAt', 'lastSeenAtByLocale', 'lastScrapedAtByLocale', 'lastRunIdByLocale',
] as const;

export function sameContent(before: object, after: object): boolean {
  const strip = (doc: object) => {
    const copy = { ...(doc as Obj) };
    for (const f of OBSERVATION_FIELDS) delete copy[f];
    return copy;
  };
  return deepEqual(strip(before), strip(after));
}

export type UpsertStatus = 'created' | 'updated' | 'unchanged';

export function upsertStatus(existing: object | null, merged: object): UpsertStatus {
  if (!existing) return 'created';
  return sameContent(existing, merged) ? 'unchanged' : 'updated';
}

export function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000;
}
