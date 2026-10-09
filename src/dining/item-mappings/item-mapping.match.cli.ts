import dotenv from 'dotenv';
import { ObjectId } from 'mongodb';
import { closeMongo, getMongoConfig, getMongoDb } from '../../shared/db/mongo';
import { DINING_PLATFORMS, DiningPlatform } from '../dining.types';
import { DecisionLine, getItemMatchBatchCollections, ItemMatchBatchInput, runItemMatchBatch } from './item-mapping.batch';
import { ensureDiningItemMappingIndexes } from './item-mapping.collections';

// Development-only cross-platform item matching for one source restaurant. Dry run unless --apply.
//
//   npm run dining:item-mappings-match -- --group=<group _id> --restaurant=<restaurant _id> --seed-platform=talabat
//   npm run dining:item-mappings-match -- ... --apply --expect-plan=<plan from the reviewed dry run>
//
// Options: --json (full report as JSON), --show-matched (list every MATCHED line).
// Reads canonical items, menu items and restaurant mappings; writes only dining_item_mappings (on --apply).

interface Args {
  apply: boolean;
  json: boolean;
  showMatched: boolean;
  input: ItemMatchBatchInput;
}

function objectId(name: string, value: string | undefined): ObjectId {
  if (!value || !/^[0-9a-f]{24}$/i.test(value)) throw new Error(`--${name} must be a 24-character hex ObjectId`);
  return new ObjectId(value);
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  let apply = false;
  let json = false;
  let showMatched = false;
  for (const arg of argv) {
    if (arg === '--apply') apply = true;
    else if (arg === '--dry-run') apply = false;
    else if (arg === '--json') json = true;
    else if (arg === '--show-matched') showMatched = true;
    else {
      const match = /^--(group|restaurant|seed-platform|expect-plan)=(.+)$/.exec(arg);
      if (!match) throw new Error(`Unknown argument: ${arg}`);
      values.set(match[1], match[2]);
    }
  }
  const seedPlatform = values.get('seed-platform');
  if (!seedPlatform || !(DINING_PLATFORMS as readonly string[]).includes(seedPlatform)) {
    throw new Error(`--seed-platform must be one of: ${DINING_PLATFORMS.join(', ')}`);
  }
  if (apply && !values.has('expect-plan')) throw new Error('--apply requires --expect-plan=<plan from the reviewed dry run>');
  return {
    apply,
    json,
    showMatched,
    input: {
      restaurantGroupId: objectId('group', values.get('group')),
      restaurantId: objectId('restaurant', values.get('restaurant')),
      seedPlatform: seedPlatform as DiningPlatform,
      dryRun: !apply,
      expectedPlan: values.get('expect-plan'),
    },
  };
}

const money = (price: number | null, currency?: string | null) => (price === null ? '?' : `${price}${currency ? ` ${currency}` : ''}`);

function printLine(tag: string, l: DecisionLine): void {
  const target = l.canonical ? `${l.canonical.canonicalItemId} "${l.canonical.name ?? '?'}" (seed ${money(l.canonical.seedPrice, l.item.currency)})` : 'none';
  console.log(
    `[dining-item-match]   ${tag} ${l.item.menuItemId} "${l.item.name ?? '?'}" ${money(l.item.price, l.item.currency)} → ${target}` +
      ` | ${l.matchMethod ?? '-'} ${l.confidence} | reasons: ${l.reasons.join(', ') || '-'} | conflicts: ${l.conflicts.join(', ') || '-'}`
  );
  for (const o of l.otherCandidates) console.log(`[dining-item-match]       also: ${o.canonicalItemId} "${o.name ?? '?'}" (seed ${money(o.seedPrice, l.item.currency)})`);
}

async function main(): Promise<void> {
  dotenv.config();
  if (process.env.NODE_ENV === 'production') throw new Error('The item matcher batch is development-only (NODE_ENV=production)');
  const args = parseArgs(process.argv.slice(2));
  const { dbName } = getMongoConfig();
  console.log(`[dining-item-match] ${args.apply ? 'APPLY' : 'DRY RUN'} on database "${dbName}"`);

  const db = await getMongoDb();
  if (args.apply) await ensureDiningItemMappingIndexes(db);
  const report = await runItemMatchBatch(getItemMatchBatchCollections(db), args.input);

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const s = report.scope;
  console.log(`[dining-item-match] group:      ${s.restaurantGroupId} (members: ${s.groupMembers.join(', ')})`);
  console.log(`[dining-item-match] source:     ${s.restaurant.platform}:${s.restaurant.platformRestaurantId ?? '?'} (${s.restaurant.restaurantId}) "${s.restaurant.name ?? '?'}"`);
  console.log(`[dining-item-match] candidates: ${s.canonicalItems} active canonical items seeded from ${s.seedPlatform}`);
  console.log(`[dining-item-match] items:      ${JSON.stringify(report.sourceItems)}`);
  console.log(`[dining-item-match] decisions:  ${JSON.stringify(report.decisions)}`);
  console.log(`[dining-item-match] outcomes:   ${JSON.stringify(report.outcomes)}`);
  console.log(`[dining-item-match] methods:    ${JSON.stringify(report.methods)}`);
  console.log(`[dining-item-match] confidence: ${JSON.stringify(report.confidence)}`);
  console.log(`[dining-item-match] conflicts:  ${JSON.stringify(report.conflicts)}`);
  if (report.duplicateTargets.length) {
    console.log(`[dining-item-match] duplicate targets (held back, not written):`);
    for (const d of report.duplicateTargets) console.log(`[dining-item-match]   ${d.canonical.canonicalItemId} "${d.canonical.name ?? '?'}" ← ${d.items.map(i => `${i.menuItemId} "${i.name}"`).join(', ')}`);
  }
  for (const l of report.keptExisting) printLine('KEPT', l);
  for (const l of report.revisions) printLine('REVISION (not applied)', l);
  for (const l of report.review) printLine('REVIEW', l);
  for (const l of report.unmatched) printLine('UNMATCHED', l);
  if (args.showMatched) for (const l of report.matched) printLine('MATCHED', l);
  for (const e of report.errors) console.log(`[dining-item-match]   ERROR ${e.menuItemId} [${e.code}] ${e.message}`);
  if (report.truncated) console.log('[dining-item-match]   (lists truncated)');
  console.log(`[dining-item-match] writes:     ${JSON.stringify(report.writes)}`);
  console.log(`[dining-item-match] plan:       ${report.plan}${report.dryRun ? ' (dry run: nothing written)' : ''}`);
  if (report.errors.length) process.exitCode = 1;
}

main()
  .catch(err => {
    const code = (err as { code?: string }).code;
    console.error(`[dining-item-match] Refused/failed${code ? ` [${code}]` : ''}: ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => closeMongo());
