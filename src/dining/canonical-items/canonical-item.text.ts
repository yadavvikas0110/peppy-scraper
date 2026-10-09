import type { LocalizedText } from '../dining.types';
import { normalizeIdentityText } from '../identity/identity.signals';
import type { CanonicalItemSignals, CanonicalItemVariant } from './canonical-item.types';

/*
 * Deterministic text helpers for canonical items. No translation, no synonyms, no models:
 * English and Arabic tokens are kept side by side exactly as the source wrote them.
 */

export const MAX_SEARCH_KEYWORDS = 150;

const EASTERN_DIGITS = /[٠-٩۰-۹]/g;

function westernDigits(text: string): string {
  return text.replace(EASTERN_DIGITS, d => String((d.charCodeAt(0) - (d >= '۰' ? 0x06f0 : 0x0660)) % 10));
}

// Same folding as restaurant identity, plus Arabic-Indic digits → ASCII so "٢" and "2" agree.
export function normalizeItemText(value: string | undefined | null): string | undefined {
  return typeof value === 'string' ? normalizeIdentityText(westernDigits(value)) : undefined;
}

function localizedValues(text: LocalizedText | undefined): string[] {
  return [text?.en, text?.ar].filter((v): v is string => typeof v === 'string' && v.trim() !== '');
}

function uniqueNormalized(values: string[]): string[] {
  return [...new Set(values.map(normalizeItemText).filter((v): v is string => !!v))];
}

// ─── Search keywords ─────────────────────────────────────────────────────────

const STOPWORDS = new Set(['and', 'with', 'or', 'the', 'of', 'a', 'an', 'in', 'on', 'for', 'to', 'و', 'مع', 'او', 'في', 'من', 'على']);

export function keywordTokens(text: string | undefined): string[] {
  const normalized = normalizeItemText(text);
  if (!normalized) return [];
  // Numbers are kept (quantities/sizes such as "2", "12"); other 1-char tokens and stopwords are noise.
  return normalized.split(' ').filter(t => /^\d/.test(t) || (t.length >= 2 && !STOPWORDS.has(t)));
}

export function buildSearchKeywords(parts: {
  names: LocalizedText;
  aliases?: string[];
  category?: LocalizedText;
  description?: LocalizedText;
}): string[] {
  const ordered = [
    ...localizedValues(parts.names),
    ...(parts.aliases ?? []),
    ...localizedValues(parts.category),
    ...localizedValues(parts.description),
  ];
  const out = new Set<string>();
  for (const text of ordered) {
    for (const token of keywordTokens(text)) {
      if (out.size >= MAX_SEARCH_KEYWORDS) return [...out];
      out.add(token);
    }
  }
  return [...out];
}

export function buildItemSignals(parts: { names: LocalizedText; aliases?: string[]; category?: LocalizedText; description?: LocalizedText }): CanonicalItemSignals {
  return {
    normalizedNames: uniqueNormalized([...localizedValues(parts.names), ...(parts.aliases ?? [])]),
    normalizedDescriptions: uniqueNormalized(localizedValues(parts.description)),
    normalizedCategories: uniqueNormalized(localizedValues(parts.category)),
  };
}

// ─── Variants ────────────────────────────────────────────────────────────────

// A number only counts as a portion when a unit is written right next to it, so "Paneer 65"
// and "3 Cheese Sandwich" carry no variant while "(2 Pcs)" and "12 inch" do.
const UNITS: Array<{ unit: string; count: boolean; pattern: string }> = [
  { unit: 'pcs', count: true, pattern: 'pcs|pc|pieces|piece|nos|no|قطع|قطعة|قطعه|حبات|حبة|حبه' },
  { unit: 'inch', count: false, pattern: 'inches|inch|"|″|بوصة|بوصه|انش|إنش' },
  { unit: 'cm', count: false, pattern: 'cm|سم' },
  { unit: 'ml', count: false, pattern: 'ml|مل' },
  { unit: 'l', count: false, pattern: 'litres|liters|litre|liter|ltr|l|لتر' },
  { unit: 'kg', count: false, pattern: 'kg|كجم|كغ|كيلو' },
  { unit: 'g', count: false, pattern: 'grams|gram|gms|gm|g|جرام|غرام|جم|غ' },
  { unit: 'oz', count: false, pattern: 'oz' },
];

const QUANTITY_RE = new RegExp(
  `(\\d+(?:[.,]\\d+)?)\\s*(${UNITS.map(u => u.pattern).join('|')})(?![\\p{L}\\p{N}])`,
  'iu'
);

const SIZE_WORDS: Record<string, string> = {
  small: 'small', medium: 'medium', regular: 'regular', large: 'large', family: 'family', jumbo: 'jumbo',
  mini: 'mini', xl: 'xl', xxl: 'xxl', 'صغير': 'small', 'وسط': 'medium', 'متوسط': 'medium', 'كبير': 'large', 'عائلي': 'family',
};
const SIZE_RE = new RegExp(`(?<![\\p{L}\\p{N}])(${Object.keys(SIZE_WORDS).join('|')})(?![\\p{L}\\p{N}])`, 'iu');

interface ParsedVariant {
  label: string;
  quantity?: number;
  unit?: string;
  size?: string;
}

function parseVariant(name: string): ParsedVariant | undefined {
  const text = westernDigits(name);
  const q = QUANTITY_RE.exec(text);
  if (q) {
    const quantity = Number(q[1].replace(',', '.'));
    const raw = q[2].toLowerCase();
    const unit = UNITS.find(u => new RegExp(`^(?:${u.pattern})$`, 'iu').test(raw));
    if (unit && Number.isFinite(quantity) && quantity > 0) {
      return { label: q[0].trim(), quantity, unit: unit.unit, size: unit.count ? undefined : `${quantity} ${unit.unit}` };
    }
  }
  const s = SIZE_RE.exec(text);
  if (s) return { label: s[0].trim(), size: SIZE_WORDS[s[1].toLowerCase()] };
  return undefined;
}

const QUANTITY_RE_ALL = new RegExp(QUANTITY_RE.source, 'giu');
const SIZE_RE_ALL = new RegExp(SIZE_RE.source, 'giu');

// Name without its portion/size text ("Plain Dosa (2 Pcs)" → "plain dosa"), normalized.
export function normalizeCoreName(name: string | undefined): string | undefined {
  if (typeof name !== 'string') return undefined;
  return normalizeItemText(westernDigits(name).replace(QUANTITY_RE_ALL, ' ').replace(SIZE_RE_ALL, ' '));
}

export function extractVariant(names: LocalizedText): CanonicalItemVariant | undefined {
  const en = names.en ? parseVariant(names.en) : undefined;
  const ar = names.ar ? parseVariant(names.ar) : undefined;
  const primary = en ?? ar;
  if (!primary) return undefined;
  const label: LocalizedText = {};
  if (en) label.en = en.label;
  if (ar) label.ar = ar.label;
  const variant: CanonicalItemVariant = { label };
  if (primary.size !== undefined) variant.size = primary.size;
  if (primary.quantity !== undefined) variant.quantity = primary.quantity;
  if (primary.unit !== undefined) variant.unit = primary.unit;
  return variant;
}
