import { ObjectId } from 'mongodb';
import { DINING_PLATFORMS } from '../dining.types';
import { validateLocalizedText, ValidationIssue, ValidationResult } from '../dining.validator';
import {
  MAPPING_DECIDERS,
  MATCH_CONFLICTS,
  MATCH_METHODS,
  MATCH_SIGNALS,
  MATCH_STATUSES,
  RESTAURANT_GROUP_STATUSES,
  RESTAURANT_IDENTITY_STATUSES,
} from './identity.types';

type Obj = Record<string, unknown>;

class Issues {
  readonly list: ValidationIssue[] = [];
  add(path: string, message: string): void {
    this.list.push({ path, message });
  }
  result(): ValidationResult {
    return { valid: this.list.length === 0, issues: this.list };
  }
}

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isDate = (v: unknown) => v instanceof Date && !Number.isNaN(v.getTime());

function optionalText(doc: Obj, field: string, max: number, issues: Issues): void {
  const v = doc[field];
  if (v === undefined) return;
  if (typeof v !== 'string' || !v.trim() || v.length > max) issues.add(field, `must be a non-empty string of at most ${max} characters`);
}

function oneOf(doc: Obj, field: string, allowed: readonly string[], issues: Issues, required = true): void {
  const v = doc[field];
  if (v === undefined && !required) return;
  if (typeof v !== 'string' || !allowed.includes(v)) issues.add(field, `must be one of: ${allowed.join(', ')}`);
}

function timestamps(doc: Obj, issues: Issues): void {
  for (const f of ['createdAt', 'updatedAt']) if (!isDate(doc[f])) issues.add(f, 'must be a valid Date');
}

function stringArray(value: unknown, path: string, issues: Issues): void {
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !v)) issues.add(path, 'must be an array of non-empty strings');
}

export function validateRestaurantGroup(doc: unknown): ValidationResult {
  const issues = new Issues();
  if (!isObj(doc)) {
    issues.add('$', 'must be an object');
    return issues.result();
  }
  for (const field of ['canonicalName', 'brandName']) {
    const result = validateLocalizedText(doc[field], { required: field === 'canonicalName' });
    for (const i of result.issues) issues.add(i.path.replace(/^\$/, field), i.message);
  }
  optionalText(doc, 'city', 100, issues);
  optionalText(doc, 'area', 200, issues);
  optionalText(doc, 'address', 500, issues);
  if (doc.location !== undefined) {
    const loc = doc.location;
    if (!isObj(loc)) issues.add('location', 'must be an object');
    else {
      const { lat, lng } = loc;
      if (lat !== undefined && (typeof lat !== 'number' || Math.abs(lat) > 90)) issues.add('location.lat', 'must be a latitude');
      if (lng !== undefined && (typeof lng !== 'number' || Math.abs(lng) > 180)) issues.add('location.lng', 'must be a longitude');
    }
  }
  oneOf(doc, 'status', RESTAURANT_GROUP_STATUSES, issues);
  oneOf(doc, 'identityStatus', RESTAURANT_IDENTITY_STATUSES, issues);
  if (doc.seedRestaurantId !== undefined && !(doc.seedRestaurantId instanceof ObjectId)) issues.add('seedRestaurantId', 'must be an ObjectId');
  if (!isObj(doc.signals)) issues.add('signals', 'must be an object');
  else {
    stringArray(doc.signals.names, 'signals.names', issues);
    stringArray(doc.signals.brands, 'signals.brands', issues);
  }
  for (const banned of ['url', 'rating', 'ratingCount', 'deliveryFee', 'minimumOrder', 'price', 'isOpen', 'currency']) {
    if (banned in doc) issues.add(banned, 'platform-specific data does not belong on a canonical group');
  }
  timestamps(doc, issues);
  return issues.result();
}

export function validateRestaurantMapping(doc: unknown): ValidationResult {
  const issues = new Issues();
  if (!isObj(doc)) {
    issues.add('$', 'must be an object');
    return issues.result();
  }
  if (!(doc.restaurantId instanceof ObjectId)) issues.add('restaurantId', 'must be an ObjectId');
  oneOf(doc, 'platform', DINING_PLATFORMS, issues);
  optionalText(doc, 'platformRestaurantId', 200, issues);
  if (typeof doc.restaurantSourceKey !== 'string' || !doc.restaurantSourceKey) issues.add('restaurantSourceKey', 'is required');
  oneOf(doc, 'matchStatus', MATCH_STATUSES, issues);
  oneOf(doc, 'matchMethod', MATCH_METHODS, issues, doc.matchStatus !== 'UNMATCHED');
  oneOf(doc, 'decidedBy', MAPPING_DECIDERS, issues);

  const hasGroup = doc.canonicalRestaurantGroupId instanceof ObjectId;
  if (doc.canonicalRestaurantGroupId !== undefined && !hasGroup) issues.add('canonicalRestaurantGroupId', 'must be an ObjectId');
  if (doc.matchStatus === 'UNMATCHED' && doc.canonicalRestaurantGroupId !== undefined) issues.add('canonicalRestaurantGroupId', 'must be absent while UNMATCHED');
  if (doc.matchStatus !== 'UNMATCHED' && !hasGroup) issues.add('canonicalRestaurantGroupId', `is required when ${String(doc.matchStatus)}`);

  if (typeof doc.isActive !== 'boolean') issues.add('isActive', 'must be a boolean');
  else if (doc.isActive !== (doc.matchStatus !== 'REJECTED')) issues.add('isActive', 'must be false exactly when REJECTED');

  if (typeof doc.confidence !== 'number' || !(doc.confidence >= 0 && doc.confidence <= 1)) issues.add('confidence', 'must be between 0 and 1');

  const ev = doc.evidence;
  if (!isObj(ev)) issues.add('evidence', 'must be an object');
  else {
    if (!Array.isArray(ev.signals) || ev.signals.some(s => !(MATCH_SIGNALS as readonly unknown[]).includes(s))) issues.add('evidence.signals', 'contains an unknown signal');
    if (!Array.isArray(ev.conflicts) || ev.conflicts.some(s => !(MATCH_CONFLICTS as readonly unknown[]).includes(s))) issues.add('evidence.conflicts', 'contains an unknown conflict');
    optionalText(ev, 'reason', 100, issues);
    optionalText(ev, 'note', 500, issues);
  }
  timestamps(doc, issues);
  return issues.result();
}
