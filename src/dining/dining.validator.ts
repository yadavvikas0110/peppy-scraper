import { ObjectId } from 'mongodb';
import {
  DINING_LOCALES,
  SCRAPE_RUN_COUNT_FIELDS,
  SCRAPE_RUN_STATUSES,
  SCRAPE_RUN_TARGET_TYPES,
  SCRAPE_RUN_TRIGGERS,
} from './dining.types';
import {
  buildCategorySourceKey,
  buildMenuItemSourceKey,
  buildRestaurantSourceKey,
  checkIdentityToken,
  isDiningPlatform,
  parseSourceKey,
  SourceIdentity,
} from './dining.source-key';

// Validators report problems; they never coerce, trim or fill in values.

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

export class DiningValidationError extends Error {
  readonly issues: ValidationIssue[];

  constructor(label: string, issues: ValidationIssue[]) {
    super(`${label} failed validation: ${issues.map(i => `${i.path} ${i.message}`).join('; ')}`);
    this.name = 'DiningValidationError';
    this.issues = issues;
  }
}

export function assertValid(result: ValidationResult, label: string): void {
  if (!result.valid) throw new DiningValidationError(label, result.issues);
}

// ─── Limits ──────────────────────────────────────────────────────────────────

const MAX_TEXT_LENGTH = 5000;
const MAX_PRICE = 100000;
const MAX_RUN_ERRORS = 200;
const MAX_RUN_ERROR_MESSAGE = 2000;
const CURRENCY_RE = /^[A-Z]{3}$/;
const RUN_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const SECRET_PARAM_RE = /[?&](token|api_?key|access_?token)=/i;
const LOCALE_KEYS: readonly string[] = DINING_LOCALES;

type Obj = Record<string, unknown>;

// ─── Primitive checks ────────────────────────────────────────────────────────

class Issues {
  readonly list: ValidationIssue[] = [];

  add(path: string, message: string): void {
    this.list.push({ path, message });
  }

  result(): ValidationResult {
    return { valid: this.list.length === 0, issues: this.list };
  }
}

function isPlainObject(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function checkUrl(value: unknown, path: string, issues: Issues): void {
  if (typeof value !== 'string') return issues.add(path, 'must be a URL string');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return issues.add(path, 'must be an absolute URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') issues.add(path, 'must use http or https');
  if (parsed.username || parsed.password) issues.add(path, 'must not contain credentials');
  if (SECRET_PARAM_RE.test(value)) issues.add(path, 'must not contain secret query parameters');
}

function checkPlatformUrl(value: unknown, path: string, issues: Issues): void {
  checkUrl(value, path, issues);
  if (typeof value !== 'string') return;
  try {
    const host = new URL(value).hostname;
    if (host === 'scrape.do' || host.endsWith('.scrape.do')) {
      issues.add(path, 'must be the platform URL, not a Scrape.do request URL');
    }
  } catch {
    // already reported by checkUrl
  }
}

function checkText(value: unknown, path: string, issues: Issues, maxLength = MAX_TEXT_LENGTH): void {
  if (typeof value !== 'string') return issues.add(path, 'must be a string');
  if (value.trim() === '') return issues.add(path, 'must not be empty');
  if (value !== value.trim()) issues.add(path, 'must not have leading/trailing whitespace');
  if (value.length > maxLength) issues.add(path, `must be at most ${maxLength} characters`);
}

function checkLocalized(
  value: unknown,
  path: string,
  issues: Issues,
  opts: { required?: boolean; url?: boolean } = {}
): void {
  if (value === undefined) {
    if (opts.required) issues.add(path, 'is required');
    return;
  }
  if (!isPlainObject(value)) return issues.add(path, 'must be a LocalizedText object { en?, ar? }');
  const keys = Object.keys(value);
  for (const key of keys) {
    if (!LOCALE_KEYS.includes(key)) issues.add(`${path}.${key}`, 'is not a supported locale (en, ar)');
  }
  const present = DINING_LOCALES.filter(l => value[l] !== undefined);
  if (present.length === 0) return issues.add(path, 'must contain at least one locale');
  for (const locale of present) {
    if (opts.url) checkPlatformUrl(value[locale], `${path}.${locale}`, issues);
    else checkText(value[locale], `${path}.${locale}`, issues);
  }
}

function checkNumber(
  value: unknown,
  path: string,
  issues: Issues,
  opts: { required?: boolean; integer?: boolean; min?: number; max?: number } = {}
): void {
  if (value === undefined) {
    if (opts.required) issues.add(path, 'is required');
    return;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return issues.add(path, 'must be a finite number');
  if (opts.integer && !Number.isInteger(value)) issues.add(path, 'must be an integer');
  if (opts.min !== undefined && value < opts.min) issues.add(path, `must be >= ${opts.min}`);
  if (opts.max !== undefined && value > opts.max) issues.add(path, `must be <= ${opts.max}`);
}

function checkBoolean(value: unknown, path: string, issues: Issues, required = true): void {
  if (value === undefined) {
    if (required) issues.add(path, 'is required');
    return;
  }
  if (typeof value !== 'boolean') issues.add(path, 'must be a boolean');
}

function checkDate(value: unknown, path: string, issues: Issues, required = true): void {
  if (value === undefined) {
    if (required) issues.add(path, 'is required');
    return;
  }
  if (!isValidDate(value)) issues.add(path, 'must be a valid Date');
}

function checkObjectId(value: unknown, path: string, issues: Issues, required = true): void {
  if (value === undefined) {
    if (required) issues.add(path, 'is required');
    return;
  }
  if (!(value instanceof ObjectId)) issues.add(path, 'must be an ObjectId');
}

function checkStringArray(value: unknown, path: string, issues: Issues): void {
  if (!Array.isArray(value)) return issues.add(path, 'must be an array of strings');
  value.forEach((v, i) => checkText(v, `${path}[${i}]`, issues, 200));
}

function checkCurrency(value: unknown, path: string, issues: Issues, required = true): void {
  if (value === undefined) {
    if (required) issues.add(path, 'is required');
    return;
  }
  if (typeof value !== 'string' || !CURRENCY_RE.test(value)) {
    issues.add(path, 'must be an ISO 4217 code (e.g. AED)');
  }
}

function checkEnum(value: unknown, allowed: readonly string[], path: string, issues: Issues): void {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    issues.add(path, `must be one of: ${allowed.join(', ')}`);
  }
}

function checkPlatform(value: unknown, path: string, issues: Issues): void {
  if (!isDiningPlatform(value)) issues.add(path, 'must be a supported dining platform');
}

function checkIdentityField(value: unknown, path: string, issues: Issues): void {
  if (value === undefined) return;
  const problem = checkIdentityToken(value);
  if (problem) issues.add(path, problem);
}

function checkPerLocale(value: unknown, path: string, issues: Issues, kind: 'date' | 'string'): void {
  if (!isPlainObject(value)) return issues.add(path, 'must be an object { en?, ar? }');
  for (const key of Object.keys(value)) {
    if (!LOCALE_KEYS.includes(key)) {
      issues.add(`${path}.${key}`, 'is not a supported locale (en, ar)');
      continue;
    }
    const v = value[key];
    if (v === undefined) continue;
    if (kind === 'date') checkDate(v, `${path}.${key}`, issues);
    else checkText(v, `${path}.${key}`, issues, 128);
  }
}

function checkTimestamps(doc: Obj, issues: Issues, fields: string[]): void {
  for (const f of fields) checkDate(doc[f], f, issues);
  if (isValidDate(doc.createdAt) && isValidDate(doc.updatedAt) && doc.updatedAt < doc.createdAt) {
    issues.add('updatedAt', 'must not be earlier than createdAt');
  }
}

function expectSourceKey(build: () => string, actual: unknown, issues: Issues): void {
  try {
    const expected = build();
    if (actual !== expected) issues.add('sourceKey', `does not match the identity fields (expected ${expected})`);
  } catch (err) {
    issues.add('sourceKey', (err as Error).message);
  }
}

function checkRoot(doc: unknown, issues: Issues): doc is Obj {
  if (!isPlainObject(doc)) {
    issues.add('$', 'must be an object');
    return false;
  }
  checkObjectId(doc._id, '_id', issues, false);
  return true;
}

// ─── Public validators ───────────────────────────────────────────────────────

export function validateLocalizedText(
  value: unknown,
  opts: { required?: boolean; url?: boolean } = {}
): ValidationResult {
  const issues = new Issues();
  checkLocalized(value, '$', issues, opts);
  return issues.result();
}

export function validateRestaurant(doc: unknown): ValidationResult {
  const issues = new Issues();
  if (!checkRoot(doc, issues)) return issues.result();

  checkPlatform(doc.platform, 'platform', issues);
  checkIdentityField(doc.platformRestaurantId, 'platformRestaurantId', issues);
  checkIdentityField(doc.slug, 'slug', issues);
  checkEnum(doc.sourceKeyKind, ['id', 'anchor'], 'sourceKeyKind', issues);

  if (isDiningPlatform(doc.platform)) {
    const platform = doc.platform;
    if (doc.platformRestaurantId !== undefined && doc.sourceKeyKind !== 'id') {
      issues.add('sourceKeyKind', 'must be "id" when platformRestaurantId is present');
    }
    if (doc.sourceKeyKind === 'id') {
      if (doc.platformRestaurantId === undefined) issues.add('platformRestaurantId', 'is required when sourceKeyKind is "id"');
      else expectSourceKey(() => buildRestaurantSourceKey(platform, { kind: 'id', value: doc.platformRestaurantId as string }), doc.sourceKey, issues);
    } else if (doc.sourceKeyKind === 'anchor') {
      if (doc.slug === undefined) issues.add('slug', 'is required when sourceKeyKind is "anchor"');
      else expectSourceKey(() => buildRestaurantSourceKey(platform, { kind: 'anchor', value: doc.slug as string }), doc.sourceKey, issues);
    }
  }

  checkLocalized(doc.name, 'name', issues, { required: true });
  checkLocalized(doc.brandName, 'brandName', issues);
  checkLocalized(doc.description, 'description', issues);
  checkLocalized(doc.url, 'url', issues, { required: true, url: true });
  checkStringArray(doc.cuisines, 'cuisines', issues);
  checkStringArray(doc.tags, 'tags', issues);
  checkStringArray(doc.offers, 'offers', issues);
  checkNumber(doc.rating, 'rating', issues, { min: 0, max: 5 });
  checkNumber(doc.ratingCount, 'ratingCount', issues, { integer: true, min: 0 });
  if (doc.ratingCountText !== undefined) checkText(doc.ratingCountText, 'ratingCountText', issues, 50);
  checkCurrency(doc.currency, 'currency', issues);
  checkNumber(doc.deliveryFee, 'deliveryFee', issues, { min: 0, max: MAX_PRICE });
  checkNumber(doc.minimumOrder, 'minimumOrder', issues, { min: 0, max: MAX_PRICE });
  checkNumber(doc.deliveryTimeMin, 'deliveryTimeMin', issues, { integer: true, min: 0 });
  checkNumber(doc.deliveryTimeMax, 'deliveryTimeMax', issues, { integer: true, min: 0 });
  if (typeof doc.deliveryTimeMin === 'number' && typeof doc.deliveryTimeMax === 'number' && doc.deliveryTimeMin > doc.deliveryTimeMax) {
    issues.add('deliveryTimeMin', 'must not exceed deliveryTimeMax');
  }
  checkBoolean(doc.isOpen, 'isOpen', issues, false);
  checkBoolean(doc.isActive, 'isActive', issues);
  if (doc.imageUrl !== undefined) checkUrl(doc.imageUrl, 'imageUrl', issues);

  if (!isPlainObject(doc.location)) {
    issues.add('location', 'must be an object');
  } else {
    const loc = doc.location;
    for (const f of ['city', 'area', 'address']) if (loc[f] !== undefined) checkText(loc[f], `location.${f}`, issues, 500);
    checkNumber(loc.lat, 'location.lat', issues, { min: -90, max: 90 });
    checkNumber(loc.lng, 'location.lng', issues, { min: -180, max: 180 });
  }

  checkPerLocale(doc.lastScrapedAtByLocale, 'lastScrapedAtByLocale', issues, 'date');
  checkPerLocale(doc.lastRunIdByLocale, 'lastRunIdByLocale', issues, 'string');
  checkTimestamps(doc, issues, ['firstSeenAt', 'createdAt', 'updatedAt']);
  return issues.result();
}

function checkRestaurantRef(doc: Obj, issues: Issues): string | null {
  checkObjectId(doc.restaurantId, 'restaurantId', issues);
  checkIdentityField(doc.platformRestaurantId, 'platformRestaurantId', issues);
  const parsed = typeof doc.restaurantSourceKey === 'string' ? parseSourceKey(doc.restaurantSourceKey) : null;
  if (!parsed || parsed.entity !== 'restaurant') {
    issues.add('restaurantSourceKey', 'must be a valid restaurant sourceKey');
    return null;
  }
  if (parsed.platform !== doc.platform) issues.add('restaurantSourceKey', 'must belong to the same platform');
  if (doc.platformRestaurantId !== undefined && parsed.kind === 'id' && parsed.value !== doc.platformRestaurantId) {
    issues.add('platformRestaurantId', 'does not match restaurantSourceKey');
  }
  return doc.restaurantSourceKey as string;
}

export function validateMenuCategory(doc: unknown): ValidationResult {
  const issues = new Issues();
  if (!checkRoot(doc, issues)) return issues.result();

  checkPlatform(doc.platform, 'platform', issues);
  const restaurantKey = checkRestaurantRef(doc, issues);
  checkIdentityField(doc.platformCategoryId, 'platformCategoryId', issues);
  checkEnum(doc.sourceKeyKind, ['id', 'anchor', 'position'], 'sourceKeyKind', issues);
  checkNumber(doc.sortOrder, 'sortOrder', issues, { integer: true, min: 0 });

  if (restaurantKey) {
    if (doc.platformCategoryId !== undefined && doc.sourceKeyKind !== 'id') {
      issues.add('sourceKeyKind', 'must be "id" when platformCategoryId is present');
    }
    if (doc.sourceKeyKind === 'id') {
      if (doc.platformCategoryId === undefined) issues.add('platformCategoryId', 'is required when sourceKeyKind is "id"');
      else expectSourceKey(() => buildCategorySourceKey(restaurantKey, { kind: 'id', value: doc.platformCategoryId as string }), doc.sourceKey, issues);
    } else if (doc.sourceKeyKind === 'position') {
      if (doc.sortOrder === undefined) issues.add('sortOrder', 'is required when sourceKeyKind is "position"');
      else expectSourceKey(() => buildCategorySourceKey(restaurantKey, { kind: 'position', value: doc.sortOrder as number }), doc.sourceKey, issues);
    } else if (doc.sourceKeyKind === 'anchor') {
      const parsed = typeof doc.sourceKey === 'string' ? parseSourceKey(doc.sourceKey) : null;
      if (!parsed || parsed.kind !== 'anchor' || doc.sourceKey !== buildCategorySourceKey(restaurantKey, { kind: 'anchor', value: parsed.value })) {
        issues.add('sourceKey', 'must be an anchor category key under restaurantSourceKey');
      }
    }
  }

  checkLocalized(doc.name, 'name', issues, { required: true });
  checkBoolean(doc.isActive, 'isActive', issues);
  checkPerLocale(doc.lastScrapedAtByLocale, 'lastScrapedAtByLocale', issues, 'date');
  checkPerLocale(doc.lastRunIdByLocale, 'lastRunIdByLocale', issues, 'string');
  checkTimestamps(doc, issues, ['firstSeenAt', 'createdAt', 'updatedAt']);
  return issues.result();
}

function checkModifierGroup(group: unknown, path: string, issues: Issues): void {
  if (!isPlainObject(group)) return issues.add(path, 'must be an object');
  checkIdentityField(group.groupId, `${path}.groupId`, issues);
  checkLocalized(group.name, `${path}.name`, issues, { required: true });
  checkLocalized(group.description, `${path}.description`, issues);
  checkBoolean(group.required, `${path}.required`, issues, false);
  checkNumber(group.minSelections, `${path}.minSelections`, issues, { integer: true, min: 0 });
  checkNumber(group.maxSelections, `${path}.maxSelections`, issues, { integer: true, min: 1 });
  if (typeof group.minSelections === 'number' && typeof group.maxSelections === 'number' && group.minSelections > group.maxSelections) {
    issues.add(`${path}.minSelections`, 'must not exceed maxSelections');
  }
  if (group.required === true && group.minSelections === 0) {
    issues.add(`${path}.minSelections`, 'must be >= 1 when the group is required');
  }
  if (!Array.isArray(group.options) || group.options.length === 0) {
    return issues.add(`${path}.options`, 'must be a non-empty array');
  }
  group.options.forEach((option, i) => {
    const p = `${path}.options[${i}]`;
    if (!isPlainObject(option)) return issues.add(p, 'must be an object');
    checkIdentityField(option.optionId, `${p}.optionId`, issues);
    checkLocalized(option.name, `${p}.name`, issues, { required: true });
    checkLocalized(option.description, `${p}.description`, issues);
    checkNumber(option.priceDelta, `${p}.priceDelta`, issues, { min: -MAX_PRICE, max: MAX_PRICE });
    checkCurrency(option.currency, `${p}.currency`, issues, false);
    checkBoolean(option.isAvailable, `${p}.isAvailable`, issues, false);
  });
}

export function validateModifierGroup(group: unknown): ValidationResult {
  const issues = new Issues();
  checkModifierGroup(group, '$', issues);
  return issues.result();
}

export function validateMenuItem(doc: unknown): ValidationResult {
  const issues = new Issues();
  if (!checkRoot(doc, issues)) return issues.result();

  checkPlatform(doc.platform, 'platform', issues);
  const restaurantKey = checkRestaurantRef(doc, issues);
  checkIdentityField(doc.platformItemId, 'platformItemId', issues);
  checkEnum(doc.sourceKeyKind, ['id', 'anchor', 'position'], 'sourceKeyKind', issues);
  checkObjectId(doc.categoryId, 'categoryId', issues, false);

  if (restaurantKey) {
    const parsed = typeof doc.sourceKey === 'string' ? parseSourceKey(doc.sourceKey) : null;
    if (doc.platformItemId !== undefined && doc.sourceKeyKind !== 'id') {
      issues.add('sourceKeyKind', 'must be "id" when platformItemId is present');
    }
    if (doc.sourceKeyKind === 'id') {
      if (doc.platformItemId === undefined) issues.add('platformItemId', 'is required when sourceKeyKind is "id"');
      else expectSourceKey(() => buildMenuItemSourceKey(restaurantKey, { kind: 'id', value: doc.platformItemId as string }), doc.sourceKey, issues);
    } else if (doc.sourceKeyKind === 'anchor') {
      if (!parsed || parsed.entity !== 'item' || parsed.kind !== 'anchor' ||
          doc.sourceKey !== buildMenuItemSourceKey(restaurantKey, { kind: 'anchor', value: parsed.value })) {
        issues.add('sourceKey', 'must be an anchor item key under restaurantSourceKey');
      }
    } else if (doc.sourceKeyKind === 'position') {
      if (doc.categoryId === undefined) issues.add('categoryId', 'is required when sourceKeyKind is "position"');
      const key = doc.sourceKey as string;
      if (!parsed || parsed.entity !== 'item' || parsed.kind !== 'position' || !key.startsWith(`${restaurantKey}:category:`)) {
        issues.add('sourceKey', 'must be a position item key under a category of restaurantSourceKey');
      } else {
        const categoryKey = key.slice(0, key.lastIndexOf(':item:'));
        const identity: SourceIdentity = { kind: 'position', value: Number(parsed.value) };
        expectSourceKey(() => buildMenuItemSourceKey(restaurantKey, identity, categoryKey), doc.sourceKey, issues);
      }
    }
  }

  checkLocalized(doc.name, 'name', issues, { required: true });
  checkLocalized(doc.description, 'description', issues);
  checkLocalized(doc.categoryName, 'categoryName', issues);
  checkLocalized(doc.sourceUrl, 'sourceUrl', issues, { required: true, url: true });
  checkNumber(doc.price, 'price', issues, { required: true, min: 0, max: MAX_PRICE });
  checkNumber(doc.originalPrice, 'originalPrice', issues, { min: 0, max: MAX_PRICE });
  if (typeof doc.price === 'number' && typeof doc.originalPrice === 'number' && doc.originalPrice < doc.price) {
    issues.add('originalPrice', 'must not be lower than price');
  }
  checkCurrency(doc.currency, 'currency', issues);
  if (doc.imageUrl !== undefined) checkUrl(doc.imageUrl, 'imageUrl', issues);
  checkBoolean(doc.isAvailable, 'isAvailable', issues);
  checkBoolean(doc.isActive, 'isActive', issues);
  checkBoolean(doc.isPopular, 'isPopular', issues, false);
  checkStringArray(doc.dietaryTags, 'dietaryTags', issues);
  checkNumber(doc.calories, 'calories', issues, { integer: true, min: 0 });

  if (doc.modifiers !== undefined) {
    if (!Array.isArray(doc.modifiers)) issues.add('modifiers', 'must be an array');
    else doc.modifiers.forEach((g, i) => checkModifierGroup(g, `modifiers[${i}]`, issues));
  }

  checkPerLocale(doc.lastSeenAtByLocale, 'lastSeenAtByLocale', issues, 'date');
  checkPerLocale(doc.lastRunIdByLocale, 'lastRunIdByLocale', issues, 'string');
  checkTimestamps(doc, issues, ['firstSeenAt', 'lastSeenAt', 'createdAt', 'updatedAt']);
  return issues.result();
}

export function validateScrapeRun(run: unknown): ValidationResult {
  const issues = new Issues();
  if (!checkRoot(run, issues)) return issues.result();

  if (typeof run.runId !== 'string' || !RUN_ID_RE.test(run.runId)) {
    issues.add('runId', 'must be 8–128 characters of [A-Za-z0-9._:-]');
  }
  checkPlatform(run.platform, 'platform', issues);
  checkEnum(run.locale, DINING_LOCALES, 'locale', issues);
  checkEnum(run.targetType, SCRAPE_RUN_TARGET_TYPES, 'targetType', issues);
  checkEnum(run.trigger, SCRAPE_RUN_TRIGGERS, 'trigger', issues);
  checkEnum(run.status, SCRAPE_RUN_STATUSES, 'status', issues);
  checkPlatformUrl(run.targetUrl, 'targetUrl', issues);
  checkBoolean(run.dryRun, 'dryRun', issues);

  checkDate(run.startedAt, 'startedAt', issues);
  if (run.status === 'running') {
    if (run.finishedAt !== undefined) issues.add('finishedAt', 'must be absent while the run is running');
  } else {
    checkDate(run.finishedAt, 'finishedAt', issues);
    if (isValidDate(run.startedAt) && isValidDate(run.finishedAt) && run.finishedAt < run.startedAt) {
      issues.add('finishedAt', 'must not be earlier than startedAt');
    }
  }
  checkNumber(run.durationMs, 'durationMs', issues, { integer: true, min: 0 });

  if (!isPlainObject(run.counts)) {
    issues.add('counts', 'must be an object');
  } else {
    for (const f of SCRAPE_RUN_COUNT_FIELDS) {
      checkNumber(run.counts[f], `counts.${f}`, issues, { required: true, integer: true, min: 0 });
    }
  }

  if (!Array.isArray(run.errors)) {
    issues.add('errors', 'must be an array');
  } else {
    if (run.errors.length > MAX_RUN_ERRORS) issues.add('errors', `must contain at most ${MAX_RUN_ERRORS} entries`);
    if (run.status === 'failed' && run.errors.length === 0) issues.add('errors', 'must contain at least one entry for a failed run');
    run.errors.forEach((e, i) => {
      const p = `errors[${i}]`;
      if (!isPlainObject(e)) return issues.add(p, 'must be an object');
      checkText(e.stage, `${p}.stage`, issues, 100);
      checkText(e.code, `${p}.code`, issues, 100);
      checkText(e.message, `${p}.message`, issues, MAX_RUN_ERROR_MESSAGE);
      if (typeof e.message === 'string' && SECRET_PARAM_RE.test(e.message)) {
        issues.add(`${p}.message`, 'must not contain secret query parameters');
      }
    });
  }

  if (run.fetch !== undefined) {
    if (!isPlainObject(run.fetch)) {
      issues.add('fetch', 'must be an object');
    } else {
      const f = run.fetch;
      checkNumber(f.statusCode, 'fetch.statusCode', issues, { integer: true, min: 100, max: 599 });
      checkNumber(f.initialStatusCode, 'fetch.initialStatusCode', issues, { integer: true, min: 100, max: 599 });
      if (f.finalUrl !== undefined) checkPlatformUrl(f.finalUrl, 'fetch.finalUrl', issues);
      checkNumber(f.requestCost, 'fetch.requestCost', issues, { min: 0 });
      checkNumber(f.remainingCredits, 'fetch.remainingCredits', issues, { min: 0 });
      checkNumber(f.attempts, 'fetch.attempts', issues, { integer: true, min: 1 });
      checkNumber(f.durationMs, 'fetch.durationMs', issues, { integer: true, min: 0 });
    }
  }

  checkTimestamps(run, issues, ['createdAt', 'updatedAt']);
  return issues.result();
}
