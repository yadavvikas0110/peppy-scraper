import type { ObjectId } from 'mongodb';
import { extractVariant, keywordTokens, normalizeCoreName, normalizeItemText } from '../canonical-items/canonical-item.text';
import type { CanonicalItemVariant } from '../canonical-items/canonical-item.types';
import type { DiningMenuItem, DiningPlatform, LocalizedText, MenuModifierGroup } from '../dining.types';
import { ITEM_MATCHER_CONFIG, ItemMatcherConfig } from './item-matcher.config';
import type { ItemMatchEvidence, ItemMatchMethod } from './item-mapping.types';

/*
 * Deterministic item matcher. Pure — no MongoDB, no network, no models.
 *
 * Input: one source item, a small candidate set of canonical items from the SAME restaurant
 * group (with reference data from their already-mapped source items), and a context.
 * Output: MATCHED / REVIEW / UNMATCHED with confidence, method and evidence.
 *
 * Never MATCHED on name alone, never on image, never on price (price is not even an input).
 */

// Identity-relevant fields of a source item. Built by toMatchSource(), which deliberately drops price.
export interface ItemMatchSource {
  platform: DiningPlatform;
  name: LocalizedText;
  description?: LocalizedText;
  category?: LocalizedText;
  modifiers?: MenuModifierGroup[];
  imageUrl?: string;
}

export interface ItemMatchReference {
  platform: DiningPlatform;
  modifiers?: MenuModifierGroup[];
  imageUrl?: string;
}

export interface ItemMatchCandidate {
  canonicalItemId: ObjectId;
  restaurantGroupId: ObjectId;
  canonicalName: LocalizedText;
  aliases?: string[];
  canonicalDescription?: LocalizedText;
  category?: LocalizedText;
  variant?: CanonicalItemVariant;
  // Source items already MATCHED to this canonical item (modifier/image evidence lives there).
  references?: ItemMatchReference[];
  // Platforms with an active MATCHED source item on this canonical item, excluding the item being matched.
  matchedPlatforms?: DiningPlatform[];
}

export interface ItemMatchContext {
  restaurantGroupId: ObjectId;
  config?: ItemMatcherConfig;
}

export interface CandidateScore {
  canonicalItemId: ObjectId;
  confidence: number;
  method: ItemMatchMethod;
  plausible: boolean;
  matchable: boolean;
  evidence: ItemMatchEvidence;
}

export interface ItemMatchDecision {
  status: 'MATCHED' | 'REVIEW' | 'UNMATCHED';
  canonicalItemId?: ObjectId;
  matchMethod?: ItemMatchMethod;
  confidence: number;
  evidence: ItemMatchEvidence;
  ranked: CandidateScore[];
}

export function toMatchSource(item: Pick<DiningMenuItem, 'platform' | 'name' | 'description' | 'categoryName' | 'modifiers' | 'imageUrl'>): ItemMatchSource {
  return {
    platform: item.platform,
    name: item.name,
    description: item.description,
    category: item.categoryName,
    modifiers: item.modifiers,
    imageUrl: item.imageUrl,
  };
}

const round = (n: number) => Math.round(n * 1000) / 1000;

function texts(t: LocalizedText | undefined): Array<{ locale: 'en' | 'ar'; value: string }> {
  const out: Array<{ locale: 'en' | 'ar'; value: string }> = [];
  if (t?.en) out.push({ locale: 'en', value: t.en });
  if (t?.ar) out.push({ locale: 'ar', value: t.ar });
  return out;
}

export function tokenDice(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return (2 * shared) / (A.size + B.size);
}

// ─── Signals ────────────────────────────────────────────────────────────────

export function scoreName(
  source: LocalizedText,
  candidate: { canonicalName: LocalizedText; aliases?: string[] },
  config: ItemMatcherConfig = ITEM_MATCHER_CONFIG
): { score: number; reason?: string } {
  const src = texts(source);
  const cand = [...texts(candidate.canonicalName).map(t => t.value), ...(candidate.aliases ?? [])];
  const candFull = new Set(cand.map(normalizeItemText).filter(Boolean));
  const candCore = new Set(cand.map(normalizeCoreName).filter(Boolean));

  for (const s of src) if (candFull.has(normalizeItemText(s.value))) return { score: 1, reason: `NAME_EXACT_${s.locale.toUpperCase()}` };
  for (const s of src) {
    const core = normalizeCoreName(s.value);
    if (core && candCore.has(core)) return { score: config.coreNameScore, reason: 'NAME_CORE_EXACT' };
  }
  let best = 0;
  for (const s of src) for (const c of cand) best = Math.max(best, tokenDice(keywordTokens(s.value), keywordTokens(c)));
  return best > 0 ? { score: round(best * config.partialNameScale), reason: 'NAME_SIMILAR' } : { score: 0 };
}

function scoreText(a: LocalizedText | undefined, b: LocalizedText | undefined): number | undefined {
  const A = texts(a);
  const B = texts(b);
  if (A.length === 0 || B.length === 0) return undefined;
  let best = 0;
  for (const x of A) {
    for (const y of B) {
      if (x.locale !== y.locale) continue;
      if (normalizeItemText(x.value) === normalizeItemText(y.value)) return 1;
      best = Math.max(best, tokenDice(keywordTokens(x.value), keywordTokens(y.value)));
    }
  }
  return round(best);
}

export function compareVariants(source?: CanonicalItemVariant, candidate?: CanonicalItemVariant): { score?: number; reasons: string[]; conflicts: string[] } {
  if (!source && !candidate) return { reasons: [], conflicts: [] };
  if (!source || !candidate) return { score: 0.5, reasons: [], conflicts: ['VARIANT_ONLY_ONE_SIDE'] };
  const conflicts: string[] = [];
  if (source.unit && candidate.unit && source.unit !== candidate.unit) conflicts.push('UNIT_MISMATCH');
  else if (source.quantity !== undefined && candidate.quantity !== undefined && source.quantity !== candidate.quantity) conflicts.push('QUANTITY_MISMATCH');
  // "12 inch" is both a quantity and a size: one differing fact is penalised once.
  if (source.size && candidate.size && source.size !== candidate.size && conflicts.length === 0) conflicts.push('SIZE_MISMATCH');
  if (conflicts.length) return { score: 0, reasons: [], conflicts };
  return { score: 1, reasons: ['VARIANT_MATCH'], conflicts: [] };
}

function groupKeys(group: MenuModifierGroup, locale: 'en' | 'ar'): string | undefined {
  return normalizeItemText(group.name?.[locale]);
}

function optionKeys(groups: MenuModifierGroup[], locale: 'en' | 'ar'): string[] {
  return groups.flatMap(g => g.options.map(o => normalizeItemText(o.name?.[locale]))).filter((k): k is string => !!k);
}

export function compareModifiers(
  source: MenuModifierGroup[] | undefined,
  reference: MenuModifierGroup[] | undefined,
  config: ItemMatcherConfig = ITEM_MATCHER_CONFIG
): { score?: number; reasons: string[]; conflicts: string[] } {
  const hasSrc = !!source?.length;
  const hasRef = !!reference?.length;
  if (!hasSrc && !hasRef) return { reasons: [], conflicts: [] };
  if (!hasSrc || !hasRef) return { reasons: [hasSrc ? 'MODIFIERS_ONLY_ON_SOURCE' : 'MODIFIERS_ONLY_ON_CANDIDATE'], conflicts: [] };

  let optionDice = 0;
  let groupDice = 0;
  for (const l of ['en', 'ar'] as const) {
    optionDice = Math.max(optionDice, tokenDice(optionKeys(source!, l), optionKeys(reference!, l)));
    groupDice = Math.max(
      groupDice,
      tokenDice(source!.map(g => groupKeys(g, l)).filter((k): k is string => !!k), reference!.map(g => groupKeys(g, l)).filter((k): k is string => !!k))
    );
  }

  // Structure of groups that share a name: required flag and selection limits.
  let checks = 0;
  let agree = 0;
  let requiredDiffers = false;
  let limitsDiffer = false;
  for (const g of source!) {
    const twin = reference!.find(r => (['en', 'ar'] as const).some(l => groupKeys(g, l) && groupKeys(g, l) === groupKeys(r, l)));
    if (!twin) continue;
    for (const [a, b, kind] of [[g.required, twin.required, 'required'], [g.minSelections, twin.minSelections, 'limits'], [g.maxSelections, twin.maxSelections, 'limits']] as const) {
      if (a === undefined || b === undefined) continue;
      checks++;
      if (a === b) agree++;
      else if (kind === 'required') requiredDiffers = true;
      else limitsDiffer = true;
    }
  }
  const structure = checks > 0 ? agree / checks : 0;
  const score = round(0.5 * optionDice + 0.3 * groupDice + 0.2 * structure);

  const reasons: string[] = [];
  const conflicts: string[] = [];
  if (score >= 0.8) reasons.push('MODIFIERS_AGREE');
  if (optionDice < config.thresholds.modifierConflictBelow) conflicts.push('MODIFIER_OPTIONS_DIFFER');
  if (requiredDiffers) conflicts.push('MODIFIER_REQUIRED_DIFFERS');
  if (limitsDiffer) conflicts.push('MODIFIER_LIMITS_DIFFER');
  return { score, reasons, conflicts };
}

function imageKey(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return `${u.hostname.toLowerCase()}${u.pathname}`;
  } catch {
    return undefined;
  }
}

// ─── Candidate scoring ──────────────────────────────────────────────────────

export function scoreCandidate(source: ItemMatchSource, candidate: ItemMatchCandidate, config: ItemMatcherConfig = ITEM_MATCHER_CONFIG): CandidateScore {
  const { weights: W, thresholds: T } = config;
  const reasons: string[] = [];
  const conflicts: string[] = [];
  const evidence: ItemMatchEvidence = { reasons, conflicts };

  const name = scoreName(source.name, candidate, config);
  evidence.nameScore = name.score;
  if (name.reason) reasons.push(name.reason);

  const description = scoreText(source.description, candidate.canonicalDescription);
  if (description !== undefined) {
    evidence.descriptionScore = description;
    if (description >= T.descriptionSupportMin) reasons.push('DESCRIPTION_SIMILAR');
  }

  const category = scoreText(source.category, candidate.category);
  if (category !== undefined) {
    evidence.categoryScore = category;
    if (category >= T.categorySupportMin) reasons.push('CATEGORY_MATCH');
    else if (category < T.categoryConflictBelow) conflicts.push('CATEGORY_DIFFERENT');
  }

  const variant = compareVariants(extractVariant(source.name), candidate.variant ?? extractVariant(candidate.canonicalName));
  if (variant.score !== undefined) evidence.variantScore = variant.score;
  reasons.push(...variant.reasons);
  conflicts.push(...variant.conflicts);

  let modifiers: ReturnType<typeof compareModifiers> | undefined;
  for (const ref of candidate.references ?? []) {
    const m = compareModifiers(source.modifiers, ref.modifiers, config);
    if (!modifiers || (m.score ?? -1) > (modifiers.score ?? -1)) modifiers = m;
  }
  if (!modifiers && source.modifiers?.length) modifiers = { reasons: ['MODIFIERS_ONLY_ON_SOURCE'], conflicts: [] };
  if (modifiers) {
    if (modifiers.score !== undefined) evidence.modifierScore = modifiers.score;
    reasons.push(...modifiers.reasons);
    conflicts.push(...modifiers.conflicts);
  }

  const srcImage = imageKey(source.imageUrl);
  const refImages = (candidate.references ?? []).map(r => imageKey(r.imageUrl)).filter(Boolean);
  if (srcImage && refImages.length) {
    evidence.imageScore = refImages.includes(srcImage) ? 1 : 0;
    reasons.push(evidence.imageScore ? 'IMAGE_SAME' : 'IMAGE_DIFFERENT');
  }

  if (candidate.matchedPlatforms?.includes(source.platform)) conflicts.push('PLATFORM_ALREADY_MAPPED');

  let confidence =
    W.name * name.score +
    W.description * (description ?? 0) +
    W.category * (category ?? 0) +
    W.modifiers * (evidence.modifierScore ?? 0) +
    W.image * (evidence.imageScore ?? 0);
  for (const c of conflicts) confidence -= config.penalties[c] ?? 0;
  confidence = round(Math.min(1, Math.max(0, confidence)));

  const corroborated =
    (description ?? 0) >= T.descriptionSupportMin ||
    (category ?? 0) >= T.categorySupportMin ||
    (evidence.modifierScore ?? 0) >= T.modifierSupportMin;
  const excluded = conflicts.some(c => config.excludeConflicts.includes(c));
  const blocked = conflicts.some(c => config.reviewConflicts.includes(c));
  const plausible = !excluded && name.score >= T.nameCandidateMin && confidence >= T.reviewMin;
  const matchable = plausible && !blocked && corroborated && name.score >= T.nameMatchMin && confidence >= T.matchMin;
  if (plausible && !matchable && !corroborated) reasons.push('INSUFFICIENT_CORROBORATION');

  return { canonicalItemId: candidate.canonicalItemId, confidence, method: pickMethod(name, evidence, config), plausible, matchable, evidence };
}

function pickMethod(name: { score: number; reason?: string }, ev: ItemMatchEvidence, config: ItemMatcherConfig): ItemMatchMethod {
  const textSignals = [ev.descriptionScore, ev.categoryScore].filter((s): s is number => s !== undefined);
  if (name.score === 1 && textSignals.length > 0 && textSignals.every(s => s === 1)) return 'EXACT_NORMALIZED';
  if (name.reason === 'NAME_CORE_EXACT' && ev.variantScore === 1) return 'VARIANT';
  const W = config.weights;
  const contributions: Array<[ItemMatchMethod, number]> = [
    ['NAME_DESCRIPTION', W.description * (ev.descriptionScore ?? 0)],
    ['MODIFIER', W.modifiers * (ev.modifierScore ?? 0)],
    ['NAME_CATEGORY', W.category * (ev.categoryScore ?? 0)],
  ];
  const top = contributions.reduce((a, b) => (b[1] > a[1] ? b : a));
  return top[1] > 0 ? top[0] : 'EXACT_NORMALIZED';
}

// ─── Decision ───────────────────────────────────────────────────────────────

export function matchItem(source: ItemMatchSource, candidates: ItemMatchCandidate[], context: ItemMatchContext): ItemMatchDecision {
  const config = context.config ?? ITEM_MATCHER_CONFIG;
  // Never compare across restaurant groups, even if a caller passes such a candidate.
  const scoped = candidates.filter(c => c.restaurantGroupId.equals(context.restaurantGroupId));
  const ranked = scoped
    .map(c => scoreCandidate(source, c, config))
    .sort((a, b) => b.confidence - a.confidence || a.canonicalItemId.toHexString().localeCompare(b.canonicalItemId.toHexString()));
  const plausible = ranked.filter(r => r.plausible);

  if (plausible.length === 0) {
    const reasons = scoped.length === 0 ? ['NO_CANDIDATES'] : ['NO_PLAUSIBLE_CANDIDATE'];
    if (candidates.length !== scoped.length) reasons.push('OTHER_GROUP_CANDIDATES_IGNORED');
    // Keep the closest same-name candidate's evidence (e.g. SIZE_MISMATCH) for audit; no canonicalItemId.
    const closest = ranked.find(r => (r.evidence.nameScore ?? 0) >= config.thresholds.nameCandidateMin);
    if (!closest) return { status: 'UNMATCHED', confidence: 0, evidence: { reasons, conflicts: [] }, ranked };
    const evidence: ItemMatchEvidence = {
      ...closest.evidence,
      reasons: [...reasons, ...closest.evidence.reasons],
      conflicts: [...closest.evidence.conflicts],
      candidateCanonicalItemIds: [closest.canonicalItemId],
    };
    return { status: 'UNMATCHED', confidence: 0, evidence, ranked };
  }

  const [top, second] = plausible;
  const ambiguous = !!second && top.confidence - second.confidence < config.thresholds.ambiguityMargin;
  const evidence: ItemMatchEvidence = {
    ...top.evidence,
    reasons: [...top.evidence.reasons],
    conflicts: [...top.evidence.conflicts],
  };
  if (plausible.length > 1) evidence.candidateCanonicalItemIds = plausible.slice(0, 5).map(p => p.canonicalItemId);

  if (top.matchable && !ambiguous) {
    return { status: 'MATCHED', canonicalItemId: top.canonicalItemId, matchMethod: top.method, confidence: top.confidence, evidence, ranked };
  }
  if (ambiguous) evidence.conflicts.push('AMBIGUOUS_CANDIDATES');
  return { status: 'REVIEW', canonicalItemId: top.canonicalItemId, matchMethod: top.method, confidence: top.confidence, evidence, ranked };
}
