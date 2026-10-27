import dotenv from 'dotenv';
import { readFileSync } from 'fs';
import { ObjectId } from 'mongodb';
import { closeMongo, getMongoConfig, getMongoDb } from '../../shared/db/mongo';
import { getItemMatchBatchCollections } from './item-mapping.batch';
import { ensureDiningItemMappingIndexes } from './item-mapping.collections';
import { DecisionLine, ManualDecisionsInput, parseDecisionEntries, runManualItemDecisions } from './item-mapping.decisions';

// Development-only: applies a human-reviewed decisions file for one source restaurant. Dry run unless --apply.
//
//   npm run dining:item-mappings-decide -- --file=<decisions.json> --group=<group _id> --restaurant=<restaurant _id>
//   npm run dining:item-mappings-decide -- ... --apply --expect-plan=<plan from the reviewed dry run>
//
// Options: --json (full report as JSON). Entries of other restaurants in the file are ignored.
// Writes only dining_item_mappings (on --apply), through the manual approve / remap / reject paths.

interface Args {
  apply: boolean;
  json: boolean;
  input: ManualDecisionsInput;
}

function objectId(name: string, value: string | undefined): ObjectId {
  if (!value || !/^[0-9a-f]{24}$/i.test(value)) throw new Error(`--${name} must be a 24-character hex ObjectId`);
  return new ObjectId(value);
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  let apply = false;
  let json = false;
  for (const arg of argv) {
    if (arg === '--apply') apply = true;
    else if (arg === '--dry-run') apply = false;
    else if (arg === '--json') json = true;
    else {
      const match = /^--(file|group|restaurant|expect-plan)=([\s\S]+)$/.exec(arg);
      if (!match) throw new Error(`Unknown argument: ${arg}`);
      values.set(match[1], match[2]);
    }
  }
  if (!values.has('file')) throw new Error('--file=<decisions.json> is required');
  if (apply && !values.has('expect-plan')) throw new Error('--apply requires --expect-plan=<plan from the reviewed dry run>');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(values.get('file')!, 'utf8'));
  } catch {
    throw new Error('--file could not be read as JSON');
  }
  return {
    apply,
    json,
    input: {
      restaurantGroupId: objectId('group', values.get('group')),
      restaurantId: objectId('restaurant', values.get('restaurant')),
      entries: parseDecisionEntries(raw),
      dryRun: !apply,
      expectedPlan: values.get('expect-plan'),
    },
  };
}

function printLine(l: DecisionLine): void {
  const from = l.fromCanonicalItemId ?? 'none';
  const to = l.canonicalItemId ? `${l.canonicalItemId} "${l.canonicalName ?? '?'}"` : 'none';
  console.log(`[dining-item-decide]   ${l.decision.padEnd(13)} ${l.menuItemId} "${l.name ?? '?'}" (${from} → ${to})${l.refusals.length ? ` | REFUSED ${l.refusals.join(', ')}` : ''}`);
}

async function main(): Promise<void> {
  dotenv.config();
  if (process.env.NODE_ENV === 'production') throw new Error('Manual item decisions are development-only (NODE_ENV=production)');
  const args = parseArgs(process.argv.slice(2));
  const { dbName } = getMongoConfig();
  console.log(`[dining-item-decide] ${args.apply ? 'APPLY' : 'DRY RUN'} on database "${dbName}"`);

  const db = await getMongoDb();
  if (args.apply) await ensureDiningItemMappingIndexes(db);
  const report = await runManualItemDecisions(getItemMatchBatchCollections(db), args.input);

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const r = report.restaurant;
  console.log(`[dining-item-decide] source:   ${r.platform}:${r.platformRestaurantId ?? '?'} (${r.restaurantId}) "${r.name ?? '?'}"`);
  console.log(`[dining-item-decide] entries:  ${report.entriesInFile - report.otherRestaurants} for this restaurant (${report.otherRestaurants} other restaurants ignored)`);
  console.log(`[dining-item-decide] writable: ${report.writable.length}; kept in REVIEW: ${report.kept.length}; refused: ${report.refused.length}; by decision ${JSON.stringify(report.byDecision)}`);
  for (const l of [...report.writable, ...report.kept, ...report.refused]) printLine(l);
  for (const e of report.errors) console.log(`[dining-item-decide]   ERROR ${e.menuItemId} [${e.code}] ${e.message}`);
  console.log(`[dining-item-decide] writes:   ${JSON.stringify(report.writes)}`);
  console.log(`[dining-item-decide] plan:     ${report.plan}${report.dryRun ? ' (dry run: nothing written)' : ''}`);
  if (report.errors.length || report.refused.length) process.exitCode = 1;
}

main()
  .catch(err => {
    const code = (err as { code?: string }).code;
    console.error(`[dining-item-decide] Refused/failed${code ? ` [${code}]` : ''}: ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => closeMongo());
