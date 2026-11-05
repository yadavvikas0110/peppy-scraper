/**
 * Seed the Dubai grocery dark-store master into grocery_stores.
 *   node dist/src/grocery/db/grocery-stores.cli.js --dry-run   # preview, no writes
 *   node dist/src/grocery/db/grocery-stores.cli.js             # upsert 36 stores
 */
import { seedGroceryStores } from './grocery-stores.seed';

async function main(): Promise<void> {
  const dryRun = process.argv.slice(2).includes('--dry-run');
  await seedGroceryStores({ dryRun });
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('[grocery-stores] fatal:', err?.stack ?? err);
    process.exit(1);
  });
