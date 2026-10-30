import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { TAG_ANCHORS } from '../config/tag-anchors';
import { getBroadCategoryBaseTags } from '../config/taxonomy';
import { embedText, embedBatch, cosineSimilarity, meanVector, isEmbeddingAvailable } from './embedding.service';
import { BundledProduct } from '../parsers/types';

interface AnchorVector {
  tag: string;
  threshold: number;
  vector: number[];
}

const ANCHOR_CACHE_PATH = path.join(process.cwd(), 'output', 'anchor-cache.json');

let anchorVectors: AnchorVector[] = [];
let initialized = false;
let initializing: Promise<void> | null = null;

// ── Init: embed all tag anchors once, cache to disk ─────────────────────────

// Concurrent callers share one init; a failed init can be retried by the next call
export function initVectorTagger(): Promise<void> {
  if (initialized) return Promise.resolve();
  return initializing ??= loadAnchors().finally(() => { initializing = null; });
}

async function loadAnchors(): Promise<void> {
  if (!isEmbeddingAvailable()) {
    console.warn('[vector-tagger] OPENAI_API_KEY not set — vector tagging disabled, using base tags only');
    initialized = true;
    return;
  }

  // Try loading from cache
  if (fs.existsSync(ANCHOR_CACHE_PATH)) {
    try {
      const cached = JSON.parse(fs.readFileSync(ANCHOR_CACHE_PATH, 'utf8'));
      if (cached.version === anchorCacheVersion() && Array.isArray(cached.anchors)) {
        anchorVectors = cached.anchors;
        console.log(`[vector-tagger] Loaded ${anchorVectors.length} anchor vectors from cache`);
        initialized = true;
        return;
      }
      console.log('[vector-tagger] Anchor cache stale — recomputing');
    } catch {
      console.log('[vector-tagger] Anchor cache corrupt — recomputing');
    }
  }

  console.log(`[vector-tagger] Computing embeddings for ${TAG_ANCHORS.length} tag anchors...`);

  // Flatten all example sentences
  const allExamples = TAG_ANCHORS.flatMap(a => a.examples);
  const allVectors = await embedBatch(allExamples);

  // Reassemble per-tag and compute mean vector
  let offset = 0;
  anchorVectors = TAG_ANCHORS.map(anchor => {
    const count = anchor.examples.length;
    const tagVectors = allVectors.slice(offset, offset + count);
    offset += count;
    return {
      tag: anchor.tag,
      threshold: anchor.threshold,
      vector: meanVector(tagVectors),
    };
  });

  // Save cache
  fs.mkdirSync(path.dirname(ANCHOR_CACHE_PATH), { recursive: true });
  fs.writeFileSync(ANCHOR_CACHE_PATH, JSON.stringify({
    version: anchorCacheVersion(),
    anchors: anchorVectors,
    computedAt: new Date().toISOString(),
  }));
  console.log(`[vector-tagger] ${anchorVectors.length} anchor vectors computed and cached`);
  initialized = true;
}

// Version hash = md5 of all example strings — cache invalidates when anchors change
function anchorCacheVersion(): string {
  const content = TAG_ANCHORS.flatMap(a => a.examples).join('|');
  return crypto.createHash('md5').update(content).digest('hex').slice(0, 10);
}

// ── Tag a single text string ─────────────────────────────────────────────────

export async function tagText(text: string): Promise<string[]> {
  if (!initialized) await initVectorTagger();
  if (anchorVectors.length === 0) return [];

  const vec = await embedText(text.slice(0, 1000)); // cap input length
  const tags = new Set<string>();

  for (const anchor of anchorVectors) {
    const sim = cosineSimilarity(vec, anchor.vector);
    if (sim >= anchor.threshold) {
      tags.add(anchor.tag);
    }
  }
  return [...tags];
}

// ── Tag a bundle ─────────────────────────────────────────────────────────────

export async function tagBundleWithVectors(
  bundle: BundledProduct,
  broadCategory: string,
  subCategory: string,
): Promise<string[]> {
  const tagSet = new Set<string>();

  // 1. Base tags from taxonomy — always applied
  const baseTags = getBroadCategoryBaseTags(broadCategory, subCategory);
  baseTags.forEach(t => tagSet.add(t));

  // 2. Vector similarity tags
  if (isEmbeddingAvailable() && anchorVectors.length > 0) {
    const searchText = [bundle.name, bundle.description, bundle.category]
      .filter(Boolean)
      .join(' ');
    try {
      const vectorTags = await tagText(searchText);
      vectorTags.forEach(t => tagSet.add(t));
    } catch (e: any) {
      console.warn(`[vector-tagger] Tagging failed for "${bundle.name}" — base tags only: ${e.message}`);
    }
  }

  // 3. Price tier
  const tier = priceTierTag(bundle.lowestPrice);
  if (tier) tagSet.add(tier);

  // 4. Social proof
  if (bundle.retailerCount >= 3) tagSet.add('widely-available');
  else if (bundle.retailerCount >= 2) tagSet.add('multi-retailer');
  if (bundle.rating !== null && bundle.rating >= 4.5) tagSet.add('top-rated');
  if (bundle.reviewCount !== null && bundle.reviewCount >= 1000) tagSet.add('popular');

  return [...tagSet].sort();
}

function priceTierTag(price: number | null): string | null {
  if (price === null) return null;
  if (price < 200)  return 'budget';
  if (price < 500)  return 'affordable';
  if (price < 1500) return 'mid-range';
  if (price < 5000) return 'premium';
  return 'luxury';
}

// ── Generate embedding for a bundle (for MongoDB vector search) ───────────────

export async function getBundleEmbedding(bundle: BundledProduct): Promise<number[] | null> {
  if (!isEmbeddingAvailable()) return null;
  const text = [bundle.name, bundle.description, ...(bundle.tags ?? []).slice(0, 20)]
    .filter(Boolean)
    .join(' ')
    .slice(0, 800);
  try {
    return await embedText(text);
  } catch (e: any) {
    console.warn(`[vector-tagger] Embedding failed for "${bundle.name}": ${e.message}`);
    return null;
  }
}

export function isVectorTaggerReady(): boolean {
  return initialized && anchorVectors.length > 0;
}
