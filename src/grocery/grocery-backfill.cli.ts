/**
 * CLI: backfill groceryMatchKey + merge cross-platform duplicate grocery documents.
 *
 *   npm run grocery:backfill-match-key            # DRY RUN (reads only, writes nothing)
 *   npm run grocery:backfill-match-key -- --apply # writes keys, merges & deletes dups
 *
 * Dry run is the default and must be reviewed before --apply. On --apply the documents
 * that get removed are written to output/grocery-backfill-backup-<ts>.json first.
 */
import { MongoClient } from 'mongodb';
import * as fs from 'fs';
import * as path from 'path';
import { getMongoConfig, redactMongoUri } from '../shared/db/mongo';
import { runGroceryBackfill } from './grocery-backfill';

async function main() {
  const apply = process.argv.includes('--apply');
  const { uri, dbName } = getMongoConfig();
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
  console.log(`[grocery-backfill] ${apply ? 'APPLY (writes)' : 'DRY RUN (read-only)'} → ${dbName}.products_clean`);

  try {
    await client.connect();
    const col = client.db(dbName).collection('products_clean');

    const backupPath = path.join(process.cwd(), 'output', `grocery-backfill-backup-${Date.now()}.json`);
    const plan = await runGroceryBackfill(col, {
      apply,
      writeBackup: (docs) => {
        fs.mkdirSync(path.dirname(backupPath), { recursive: true });
        fs.writeFileSync(backupPath, JSON.stringify(docs, null, 2));
        console.log(`[grocery-backfill] backup of ${docs.length} deleted docs → ${backupPath}`);
      },
    });

    console.log('\n──────── PLAN ────────');
    console.log(`scanned Groceries docs      : ${plan.scanned}`);
    console.log(`docs that get a match key   : ${plan.keyToSet}`);
    console.log(`clusters to merge (>1 doc)  : ${plan.clusters}`);
    console.log(`  of which cross-platform   : ${plan.crossPlatformClusters}`);
    console.log(`docs folded & deleted       : ${plan.docsDeleted}`);
    console.log('\nsample merges (survivor ⇐ folded | platforms):');
    for (const s of plan.samples) {
      console.log(`• ${s.survivor}`);
      for (const f of s.folded) console.log(`    ⇐ ${f}`);
      console.log(`    platforms: [${s.platforms.join(', ')}]  key=${s.key}`);
    }
    if (!apply) console.log('\nDRY RUN — nothing written. Re-run with --apply after review.');
    else console.log('\nAPPLIED.');
  } catch (e: any) {
    console.error('[grocery-backfill] failed:', redactMongoUri(String(e?.message ?? e), uri));
    process.exitCode = 1;
  } finally {
    await client.close().catch(() => {});
  }
}

main();
