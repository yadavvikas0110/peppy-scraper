import dotenv from 'dotenv';
import { ObjectId } from 'mongodb';
import { closeMongo, getMongoConfig, getMongoDb } from '../../shared/db/mongo';
import { ApprovalLine, ItemApprovalInput, runStrictItemApproval } from './item-mapping.approve';
import { getItemMatchBatchCollections } from './item-mapping.batch';
import { ensureDiningItemMappingIndexes } from './item-mapping.collections';

// Development-only strict approval of matcher REVIEW decisions for one source restaurant. Dry run unless --apply.
//
//   npm run dining:item-mappings-approve -- --group=<group _id> --restaurant=<restaurant _id>
//   npm run dining:item-mappings-approve -- ... --apply --expect-plan=<plan from the reviewed dry run> [--note="<evidence>"]
//
// Options: --json (full report as JSON), --show-skipped (list every skipped item with its reasons),
//          --allow-unique-twin (waive AMBIGUOUS_CANDIDATES for unique bilingual twins; must match between dry run and apply).
// Writes only dining_item_mappings (on --apply), through the manual approval path.

interface Args {
  apply: boolean;
  json: boolean;
  showSkipped: boolean;
  input: ItemApprovalInput;
}

function objectId(name: string, value: string | undefined): ObjectId {
  if (!value || !/^[0-9a-f]{24}$/i.test(value)) throw new Error(`--${name} must be a 24-character hex ObjectId`);
  return new ObjectId(value);
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  let apply = false;
  let json = false;
  let showSkipped = false;
  let allowUniqueTwin = false;
  for (const arg of argv) {
    if (arg === '--apply') apply = true;
    else if (arg === '--dry-run') apply = false;
    else if (arg === '--json') json = true;
    else if (arg === '--show-skipped') showSkipped = true;
    else if (arg === '--allow-unique-twin') allowUniqueTwin = true;
    else {
      const match = /^--(group|restaurant|expect-plan|note)=([\s\S]+)$/.exec(arg);
      if (!match) throw new Error(`Unknown argument: ${arg}`);
      values.set(match[1], match[2]);
    }
  }
  if (apply && !values.has('expect-plan')) throw new Error('--apply requires --expect-plan=<plan from the reviewed dry run>');
  return {
    apply,
    json,
    showSkipped,
    input: {
      restaurantGroupId: objectId('group', values.get('group')),
      restaurantId: objectId('restaurant', values.get('restaurant')),
      dryRun: !apply,
      expectedPlan: values.get('expect-plan'),
      note: values.get('note'),
      allowUniqueTwin,
    },
  };
}

function printLine(tag: string, l: ApprovalLine): void {
  const target = l.canonicalItemId ? `${l.canonicalItemId} "${l.canonicalName ?? '?'}"` : 'none';
  const waived = l.waived ? ` (waived ${l.waived}: unique bilingual twin)` : '';
  console.log(`[dining-item-approve]   ${tag} ${l.menuItemId} "${l.name ?? '?'}" → ${target}${waived}${l.skips.length ? ` | ${l.skips.join(', ')}` : ''}`);
}

async function main(): Promise<void> {
  dotenv.config();
  if (process.env.NODE_ENV === 'production') throw new Error('Strict item approval is development-only (NODE_ENV=production)');
  const args = parseArgs(process.argv.slice(2));
  const { dbName } = getMongoConfig();
  console.log(`[dining-item-approve] ${args.apply ? 'APPLY' : 'DRY RUN'} on database "${dbName}"${args.input.allowUniqueTwin ? ' (--allow-unique-twin)' : ''}`);

  const db = await getMongoDb();
  if (args.apply) await ensureDiningItemMappingIndexes(db);
  const report = await runStrictItemApproval(getItemMatchBatchCollections(db), args.input);

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const r = report.restaurant;
  console.log(`[dining-item-approve] source:     ${r.platform}:${r.platformRestaurantId ?? '?'} (${r.restaurantId}) "${r.name ?? '?'}"`);
  console.log(`[dining-item-approve] review:     ${report.reviewInspected} active REVIEW decisions inspected`);
  console.log(`[dining-item-approve] approvable: ${report.approvable.length}`);
  console.log(`[dining-item-approve] skipped:    ${report.skipped.length} ${JSON.stringify(report.skippedByReason)}`);
  for (const l of report.approvable) printLine('APPROVE', l);
  if (args.showSkipped) for (const l of report.skipped) printLine('SKIP', l);
  for (const e of report.errors) console.log(`[dining-item-approve]   ERROR ${e.menuItemId} [${e.code}] ${e.message}`);
  console.log(`[dining-item-approve] writes:     ${JSON.stringify(report.writes)}`);
  console.log(`[dining-item-approve] plan:       ${report.plan}${report.dryRun ? ' (dry run: nothing written)' : ''}`);
  if (report.errors.length) process.exitCode = 1;
}

main()
  .catch(err => {
    const code = (err as { code?: string }).code;
    console.error(`[dining-item-approve] Refused/failed${code ? ` [${code}]` : ''}: ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => closeMongo());
