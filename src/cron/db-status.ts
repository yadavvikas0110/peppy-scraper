/**
 * Read-only database snapshot: how much data each module holds. Never writes.
 *
 *   npm run db:status                 # database from .env
 *   npm run db:status:prod            # database from .env.prod
 */
import { closeMongo, getMongoConfig, getMongoDb } from '../shared/db/mongo';

const MODULES: Array<[string, RegExp]> = [
  ['Shopping / grocery products', /^products_clean$/],
  ['Grocery', /^grocery/],
  ['Dining', /^dining/],
  ['Scrape stats & monitoring', /^(shopping_bulk_|shopping_worker_|scrape_obs_)/],
];

async function main() {
  const { dbName } = getMongoConfig();
  const db = await getMongoDb();
  const cols = (await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name).sort();
  const counts = new Map<string, number>();
  for (const name of cols) counts.set(name, await db.collection(name).estimatedDocumentCount());

  console.log(`\n■ Database "${dbName}" — ${new Date().toISOString()}`);
  const shown = new Set<string>();
  for (const [label, re] of MODULES) {
    const names = cols.filter(n => re.test(n));
    if (!names.length) continue;
    console.log(`\n  ${label}`);
    for (const n of names) { console.log(`    ${n.padEnd(36)} ${String(counts.get(n)).padStart(9)}`); shown.add(n); }
  }

  if (cols.includes('products_clean')) {
    const p = db.collection('products_clean');
    const [shopping, grocery, compared, byRetailer] = await Promise.all([
      p.countDocuments({ category: { $ne: 'Groceries' } }),
      p.countDocuments({ category: 'Groceries' }),
      p.countDocuments({ category: { $ne: 'Groceries' }, 'retailers.1': { $exists: true } }),
      p.aggregate([
        { $match: { category: { $ne: 'Groceries' } } }, { $unwind: '$retailers' },
        { $group: { _id: '$retailers.retailerId', offers: { $sum: 1 } } }, { $sort: { offers: -1 } },
      ]).toArray(),
    ]);
    console.log(`\n  products_clean split: ${shopping} shopping products (${compared} on 2+ retailers), ${grocery} grocery products`);
    console.log(`  shopping offers per retailer: ${byRetailer.map(r => `${r._id} ${r.offers}`).join(', ') || '—'}`);
  }

  const other = cols.filter(n => !shown.has(n));
  if (other.length) {
    console.log(`\n  Other collections`);
    for (const n of other) console.log(`    ${n.padEnd(36)} ${String(counts.get(n)).padStart(9)}`);
  }
  await closeMongo();
}

main().catch(async e => { console.error(`[db-status] ${e?.message ?? e}`); await closeMongo().catch(() => {}); process.exit(1); });
