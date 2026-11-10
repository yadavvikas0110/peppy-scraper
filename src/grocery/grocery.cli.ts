/**
 * Talabat Mart grocery pilot CLI.
 *
 *   node dist/src/grocery/grocery.cli.js            # dry run (default, writes nothing to DB)
 *   node dist/src/grocery/grocery.cli.js --push     # push products to grocery_products
 *   node dist/src/grocery/grocery.cli.js --max=15   # cap products collected
 *
 * Read-only by default on purpose: a DB write requires the explicit --push flag.
 */
import { runTalabatGroceryPilot } from './grocery-runner';

function parseArgs(argv: string[]): { push: boolean; max?: number } {
  let push = false;
  let max: number | undefined;
  for (const a of argv) {
    if (a === '--push') push = true;
    else if (a.startsWith('--max=')) {
      const n = Number(a.slice('--max='.length));
      if (Number.isInteger(n) && n > 0) max = n;
    }
  }
  return { push, max };
}

async function main(): Promise<void> {
  const { push, max } = parseArgs(process.argv.slice(2));
  await runTalabatGroceryPilot({ dryRun: !push, max });
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('[grocery] fatal:', err?.stack ?? err);
    process.exit(1);
  });
