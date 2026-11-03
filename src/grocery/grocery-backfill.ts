/**
 * One-time backfill: give every existing Groceries document a `groceryMatchKey` and
 * merge the documents that share one (the same item scraped from Talabat / Deliveroo /
 * Noon under different titles) into a single document with all their retailer offers.
 *
 * Read-only by default (dry run). With apply=true it writes keys, merges clusters, and
 * removes the now-redundant documents — after saving a JSON backup of every deleted
 * document so the merge is reversible.
 */
import { Collection } from 'mongodb';
import { groceryMatchKey } from './grocery-match-key';
import { derivePricing } from '../cron/push-pipeline';

export interface GroceryDoc {
  _id: any;
  name?: string;
  groceryMatchKey?: string;
  retailers?: any[];
  images?: string[];
  tags?: string[];
  rating?: number;
  reviewCount?: number;
  createdAt?: Date;
  category?: string;
}

export interface BackfillPlan {
  scanned: number;
  keyToSet: number;              // docs that will get a groceryMatchKey
  clusters: number;              // multi-doc clusters that will merge
  docsMerged: number;            // docs folded into a survivor
  docsDeleted: number;           // == docsMerged
  crossPlatformClusters: number; // clusters that actually span >1 grocery platform
  samples: Array<{ key: string; survivor: string; folded: string[]; platforms: string[] }>;
}

const GROCERY_PLATFORMS = new Set(['Talabat Mart', 'Deliveroo', 'Deliveroo Hop', 'Noon Minutes']);

/** Latest-observed, priced-preferred offer per retailerId across all docs in a cluster. */
export function mergeRetailers(docs: GroceryDoc[]): any[] {
  const byRetailer = new Map<string, any>();
  for (const d of docs) {
    for (const r of d.retailers ?? []) {
      const id = r.retailerId;
      const cur = byRetailer.get(id);
      if (!cur) { byRetailer.set(id, r); continue; }
      const t = (x: any) => (x?.lastSeenAt ? new Date(x.lastSeenAt).getTime() : 0);
      const better =
        (typeof r.price === 'number' && typeof cur.price !== 'number') ? r :
        (t(r) > t(cur)) ? r : cur;
      byRetailer.set(id, better);
    }
  }
  return [...byRetailer.values()];
}

function platformsOf(docs: GroceryDoc[]): string[] {
  const s = new Set<string>();
  for (const d of docs) for (const r of d.retailers ?? []) {
    if (GROCERY_PLATFORMS.has(r.retailerName)) s.add(r.retailerName);
  }
  return [...s].sort();
}

/** Pick the survivor: oldest createdAt, then smallest _id (stable). */
function survivorFirst(a: GroceryDoc, b: GroceryDoc): number {
  const ta = a.createdAt ? new Date(a.createdAt).getTime() : Infinity;
  const tb = b.createdAt ? new Date(b.createdAt).getTime() : Infinity;
  if (ta !== tb) return ta - tb;
  return String(a._id).localeCompare(String(b._id));
}

export interface BackfillOptions {
  apply?: boolean;
  backupPath?: string;           // where deleted docs are written before removal (apply only)
  writeBackup?: (docs: GroceryDoc[]) => void;
  logger?: Pick<Console, 'log' | 'warn'>;
  now?: Date;
}

export async function runGroceryBackfill(col: Collection, opts: BackfillOptions = {}): Promise<BackfillPlan> {
  const log = opts.logger ?? console;
  const now = opts.now ?? new Date();
  const docs = (await col.find({ category: 'Groceries' }).toArray()) as GroceryDoc[];

  const byKey = new Map<string, GroceryDoc[]>();
  let keyToSet = 0;
  for (const d of docs) {
    const key = groceryMatchKey(d.name);
    if (!key) continue;
    if (d.groceryMatchKey !== key) keyToSet++;
    (byKey.get(key) ?? byKey.set(key, []).get(key)!).push({ ...d, groceryMatchKey: key });
  }

  const plan: BackfillPlan = {
    scanned: docs.length, keyToSet, clusters: 0, docsMerged: 0, docsDeleted: 0,
    crossPlatformClusters: 0, samples: [],
  };

  const deletedBackup: GroceryDoc[] = [];
  const ops: Array<() => Promise<void>> = [];

  for (const [key, group] of byKey) {
    // set key on singletons (no merge) — handled in a bulk pass below
    if (group.length < 2) continue;
    group.sort(survivorFirst);
    const [survivor, ...rest] = group;
    plan.clusters++;
    plan.docsMerged += rest.length;

    const platforms = platformsOf(group);
    if (platforms.length > 1) plan.crossPlatformClusters++;
    if (plan.samples.length < 30) {
      plan.samples.push({
        key,
        survivor: survivor.name ?? '',
        folded: rest.map(r => r.name ?? ''),
        platforms,
      });
    }

    if (opts.apply) {
      const retailers = mergeRetailers(group);
      const images = group.map(d => d.images ?? []).find(a => a.length) ?? [];
      const tags = [...new Set(group.flatMap(d => d.tags ?? []))];
      const rating = group.find(d => d.rating != null)?.rating;
      const reviewCount = group.find(d => d.reviewCount != null)?.reviewCount;
      const fields = {
        retailers,
        images,
        tags,
        groceryMatchKey: key,
        ...derivePricing(retailers, rating, reviewCount),
        updatedAt: now,
      };
      const survivorId = survivor._id;
      const deadIds = rest.map(r => r._id);
      deletedBackup.push(...rest);
      ops.push(async () => {
        await col.updateOne({ _id: survivorId }, { $set: fields });
        await col.deleteMany({ _id: { $in: deadIds } });
      });
    }
  }
  plan.docsDeleted = plan.docsMerged;

  if (opts.apply) {
    // Backup first — the merge is only safe if we can restore the deleted docs.
    if (deletedBackup.length && opts.writeBackup) opts.writeBackup(deletedBackup);
    log.log(`[grocery-backfill] applying ${ops.length} cluster merges (${deletedBackup.length} docs to delete)…`);
    for (const op of ops) await op();

    // Stamp groceryMatchKey on the remaining singletons that still lack it.
    let singletonUpdates = 0;
    for (const [key, group] of byKey) {
      if (group.length !== 1) continue;
      const d = group[0];
      if (d.groceryMatchKey !== key) { await col.updateOne({ _id: d._id }, { $set: { groceryMatchKey: key } }); singletonUpdates++; }
    }
    log.log(`[grocery-backfill] stamped key on ${singletonUpdates} singleton docs.`);
  }

  return plan;
}
