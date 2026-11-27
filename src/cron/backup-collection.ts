/**
 * Read-only backup of one collection to output/backups/<db>-<collection>-<time>.jsonl (Extended JSON,
 * one document per line — restorable with mongoimport or a small script). Default: products_clean.
 *
 *   npm run db:backup:prod                         # products_clean of the .env.prod database
 *   node --env-file=.env.prod dist/src/cron/backup-collection.js grocery_products
 */
import * as fs from 'fs';
import * as path from 'path';
import { BSON } from 'mongodb';
const { EJSON } = BSON;
import { closeMongo, getMongoConfig, getMongoDb } from '../shared/db/mongo';

async function main() {
  const name = process.argv[2] || 'products_clean';
  const { dbName } = getMongoConfig();
  const db = await getMongoDb();
  const dir = path.join(process.cwd(), 'output', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${dbName}-${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
  const out = fs.createWriteStream(file);
  let n = 0;
  for await (const doc of db.collection(name).find({})) {
    if (!out.write(EJSON.stringify(doc, { relaxed: false }) + '\n')) await new Promise(r => out.once('drain', r));
    n++;
  }
  await new Promise<void>(r => out.end(r));
  console.log(`[backup] ${n} documents from ${dbName}.${name} → ${file}`);
  await closeMongo();
}

main().catch(async e => { console.error(`[backup] ${e?.message ?? e}`); await closeMongo().catch(() => {}); process.exit(1); });
