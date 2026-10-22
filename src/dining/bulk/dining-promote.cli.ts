import dotenv from 'dotenv';
import { readFileSync } from 'fs';
import { Db, Document, MongoClient, ObjectId } from 'mongodb';
import { dbNameFromUri, getMongoConfig, redactMongoUri } from '../../shared/db/mongo';

// Copies the dining data of a reviewed bulk import from one database to another (dev → prod), additively.
//
//   node --env-file=.env.dev dist/src/dining/bulk/dining-promote.cli.js --from=dev --to=prod [--batch=<id>...] [--run]
//
// Source is the database in the process environment (.env.dev); target is the database in `.env`. Both names must be
// confirmed with --from and --to, and only database names are ever printed. Nothing existing in the target is changed,
// replaced or deleted:
//   - a restaurant already in the target (same platform + platform id) is skipped, with everything that belongs to it;
//   - a restaurant group is copied only when none of its members is already in the target;
//   - documents keep their IDs, so mappings, canonical dishes and dish links stay consistent;
//   - a duplicate key in the target skips that document.
// Dry run unless --run.

const COLLECTIONS = {
  restaurants: 'dining_restaurants',
  categories: 'dining_menu_categories',
  items: 'dining_menu_items',
  offers: 'dining_restaurant_offers',
  groups: 'dining_restaurant_groups',
  mappings: 'dining_restaurant_mappings',
  canonical: 'dining_canonical_items',
  itemMappings: 'dining_item_mappings',
  runs: 'dining_scrape_runs',
} as const;

function args() {
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  for (const a of process.argv.slice(2)) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (!m) throw new Error(`Unknown argument: ${a}`);
    if (m[2] === undefined) flags.add(m[1]);
    else values.set(m[1], [...(values.get(m[1]) ?? []), m[2]]);
  }
  return { values, flags };
}

async function insertMissing(target: Db, name: string, docs: Array<Record<string, unknown>>, apply: boolean): Promise<{ planned: number; written: number; duplicates: number }> {
  if (!apply || !docs.length) return { planned: docs.length, written: 0, duplicates: 0 };
  let written = 0;
  let duplicates = 0;
  for (let i = 0; i < docs.length; i += 500) {
    try {
      const res = await target.collection(name).insertMany(docs.slice(i, i + 500) as never[], { ordered: false });
      written += res.insertedCount;
    } catch (err) {
      const e = err as { code?: number; result?: { insertedCount?: number }; writeErrors?: Array<{ code?: number }> };
      const dup = (e.writeErrors ?? []).filter(w => w.code === 11000).length;
      if (e.code !== 11000 && dup === 0) throw err;
      written += e.result?.insertedCount ?? 0;
      duplicates += dup || 1;
    }
  }
  return { planned: docs.length, written, duplicates };
}

async function main(): Promise<void> {
  const { values, flags } = args();
  const source = getMongoConfig(process.env);
  const targetEnv = dotenv.parse(readFileSync('.env'));
  const target = getMongoConfig(targetEnv as NodeJS.ProcessEnv);
  console.log(`[promote] source database "${source.dbName}", target database "${target.dbName}"`);
  if (values.get('from')?.[0] !== source.dbName) throw new Error(`Pass --from=${source.dbName} to confirm the source database`);
  if (values.get('to')?.[0] !== target.dbName) throw new Error(`Pass --to=${target.dbName} to confirm the target database`);
  if (source.dbName === target.dbName && dbNameFromUri(source.uri) === dbNameFromUri(target.uri) && source.uri === target.uri) throw new Error('Source and target are the same database');
  const apply = flags.has('run');

  const sourceClient = await new MongoClient(source.uri).connect();
  const targetClient = await new MongoClient(target.uri).connect();
  try {
    const from = sourceClient.db(source.dbName);
    const to = targetClient.db(target.dbName);

    // Which source restaurants: those of the named import batches, or every restaurant in the source.
    const batches = values.get('batch');
    let restaurantFilter: Record<string, unknown> = {};
    if (batches?.length) {
      const queued = await from.collection('dining_import_queue').find({ batchId: { $in: batches }, restaurantId: { $exists: true } }, { projection: { restaurantId: 1 } }).toArray();
      restaurantFilter = { _id: { $in: queued.map(q => q.restaurantId as ObjectId) } };
    }
    const restaurants = await from.collection(COLLECTIONS.restaurants).find(restaurantFilter).toArray();
    const inTarget = new Set(
      (await to.collection(COLLECTIONS.restaurants).find({}, { projection: { platform: 1, platformRestaurantId: 1, sourceKey: 1 } }).toArray()).flatMap(r => [`${r.platform}:${r.platformRestaurantId}`, `k:${r.sourceKey}`])
    );
    const isNew = (r: Document) => !inTarget.has(`${r.platform}:${r.platformRestaurantId}`) && !inTarget.has(`k:${r.sourceKey}`);
    const fresh = restaurants.filter(isNew);
    const skippedExisting = restaurants.length - fresh.length;
    const freshIds = new Set(fresh.map(r => r._id.toHexString()));

    // Groups: only those whose members are all new to the target.
    const mappings = await from.collection(COLLECTIONS.mappings).find({ restaurantId: { $in: fresh.map(r => r._id as ObjectId) } }).toArray();
    const groupIds = [...new Map(mappings.filter(m => m.canonicalRestaurantGroupId).map(m => [String(m.canonicalRestaurantGroupId), m.canonicalRestaurantGroupId as ObjectId])).values()];
    const groupMembers = await from.collection(COLLECTIONS.mappings).find({ canonicalRestaurantGroupId: { $in: groupIds } }, { projection: { restaurantId: 1, canonicalRestaurantGroupId: 1 } }).toArray();
    const blocked = new Set<string>();
    const targetRestaurantIds = new Set((await to.collection(COLLECTIONS.restaurants).find({}, { projection: { _id: 1 } }).toArray()).map(r => r._id.toHexString()));
    for (const m of groupMembers) {
      const id = (m.restaurantId as ObjectId).toHexString();
      if (!freshIds.has(id) || targetRestaurantIds.has(id)) blocked.add(String(m.canonicalRestaurantGroupId));
    }
    const groupsToCopy = groupIds.filter(g => !blocked.has(g.toHexString()));
    const groupSet = new Set(groupsToCopy.map(g => g.toHexString()));
    // Mappings follow their group. A restaurant whose group was held back is copied without a mapping (it can be linked later).
    const groupMappingsAll = await from.collection(COLLECTIONS.mappings).find({ canonicalRestaurantGroupId: { $in: groupsToCopy } }).toArray();

    const byRestaurant = { restaurantId: { $in: fresh.map(r => r._id as ObjectId) } };
    const runIds = [...new Set(fresh.flatMap(r => Object.values((r.lastRunIdByLocale ?? {}) as Record<string, string>)))];
    const plan: Array<[string, Array<Record<string, unknown>>]> = [
      [COLLECTIONS.restaurants, fresh as never],
      [COLLECTIONS.categories, (await from.collection(COLLECTIONS.categories).find(byRestaurant).toArray()) as never],
      [COLLECTIONS.items, (await from.collection(COLLECTIONS.items).find(byRestaurant).toArray()) as never],
      [COLLECTIONS.offers, (await from.collection(COLLECTIONS.offers).find(byRestaurant).toArray()) as never],
      [COLLECTIONS.groups, (await from.collection(COLLECTIONS.groups).find({ _id: { $in: groupsToCopy } }).toArray()) as never],
      [COLLECTIONS.mappings, groupMappingsAll as never],
      [COLLECTIONS.canonical, (await from.collection(COLLECTIONS.canonical).find({ restaurantGroupId: { $in: groupsToCopy } }).toArray()) as never],
      [COLLECTIONS.itemMappings, (await from.collection(COLLECTIONS.itemMappings).find({ restaurantGroupId: { $in: groupsToCopy } }).toArray()) as never],
      [COLLECTIONS.runs, (await from.collection(COLLECTIONS.runs).find({ runId: { $in: runIds } }).toArray()) as never],
    ];

    console.log(`[promote] ${restaurants.length} source restaurants: ${fresh.length} new to "${target.dbName}", ${skippedExisting} already there (left untouched); ${groupIds.length - groupsToCopy.length} group(s) held back because a member already exists in the target`);
    for (const [name, docs] of plan) {
      const r = await insertMissing(to, name, docs, apply);
      console.log(`[promote]   ${name.padEnd(28)} ${String(r.planned).padStart(6)} ${apply ? `written ${r.written}${r.duplicates ? `, duplicates skipped ${r.duplicates}` : ''}` : 'planned'}`);
    }
    if (!apply) console.log('[promote] Dry run only (add --run to write)');
  } finally {
    await sourceClient.close();
    await targetClient.close();
  }
}

main().catch(err => {
  console.error(`[promote] Failed: ${redactMongoUri(String((err as Error)?.message ?? err))}`);
  process.exitCode = 1;
});
