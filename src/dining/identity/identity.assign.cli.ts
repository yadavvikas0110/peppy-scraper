import dotenv from 'dotenv';
import { ObjectId } from 'mongodb';
import { closeMongo, getMongoConfig, getMongoDb } from '../../shared/db/mongo';
import { assignToAnchorGroup } from './identity.assign';
import { ensureDiningIdentityIndexes, getDiningIdentityCollections } from './identity.collections';
import { createDiningIdentityRepositories } from './identity.service';

// Development-only manual same-branch assignment. Dry run unless --apply.
//
//   npm run dining:identity-assign -- --restaurant=<restaurant _id> --anchor=<restaurant _id> --note="<evidence>"
//   npm run dining:identity-assign -- ... --expect-group=<group _id from the dry run> --apply
//
// The group is the anchor's active MATCHED group. Writes only dining_restaurant_mappings / dining_restaurant_groups.

interface Args {
  apply: boolean;
  restaurantId: ObjectId;
  anchorRestaurantId: ObjectId;
  note: string;
  expectedGroupId?: ObjectId;
  replaceExisting: boolean;
}

function objectId(name: string, value: string | undefined): ObjectId {
  if (!value || !ObjectId.isValid(value) || new ObjectId(value).toHexString() !== value.toLowerCase()) {
    throw new Error(`--${name} must be a 24-character hex ObjectId`);
  }
  return new ObjectId(value);
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  let apply = false;
  let replaceExisting = false;
  for (const arg of argv) {
    if (arg === '--apply') apply = true;
    else if (arg === '--dry-run') apply = false;
    else if (arg === '--replace-existing') replaceExisting = true;
    else {
      const match = /^--(restaurant|anchor|note|expect-group)=([\s\S]*)$/.exec(arg);
      if (!match) throw new Error(`Unknown argument: ${arg}`);
      values.set(match[1], match[2]);
    }
  }
  if (apply && !values.has('expect-group')) throw new Error('--apply requires --expect-group=<group _id from the dry run>');
  return {
    apply,
    restaurantId: objectId('restaurant', values.get('restaurant')),
    anchorRestaurantId: objectId('anchor', values.get('anchor')),
    note: values.get('note') ?? '',
    expectedGroupId: values.has('expect-group') ? objectId('expect-group', values.get('expect-group')) : undefined,
    replaceExisting,
  };
}

async function main(): Promise<void> {
  dotenv.config();
  if (process.env.NODE_ENV === 'production') throw new Error('The manual identity assignment is development-only (NODE_ENV=production)');
  const args = parseArgs(process.argv.slice(2));
  const { dbName } = getMongoConfig();
  console.log(`[dining-identity-assign] ${args.apply ? 'APPLY' : 'DRY RUN'} on database "${dbName}"`);

  const db = await getMongoDb();
  if (args.apply) await ensureDiningIdentityIndexes(db);
  const repos = createDiningIdentityRepositories(getDiningIdentityCollections(db));
  const report = await assignToAnchorGroup(repos, { ...args, dryRun: !args.apply });

  const name = (r: { platform: string; platformRestaurantId?: string; restaurantId: string; name?: string }) =>
    `${r.platform}:${r.platformRestaurantId ?? '?'} (${r.restaurantId})${r.name ? ` "${r.name}"` : ''}`;
  const m = report.result.mapping;
  console.log(`[dining-identity-assign] restaurant: ${name(report.restaurant)}`);
  console.log(`[dining-identity-assign] anchor:     ${name(report.anchor)}`);
  console.log(`[dining-identity-assign] group:      ${report.groupId} (from the anchor's active mapping)`);
  console.log(`[dining-identity-assign] members before: ${report.membersBefore.map(name).join(', ') || 'none'}`);
  console.log(`[dining-identity-assign] evidence:   ${JSON.stringify(report.evidence)}`);
  console.log(`[dining-identity-assign] outcome:    ${report.result.status}${report.dryRun ? ' (dry run: nothing written)' : ''}`);
  if (report.result.previousGroupId) console.log(`[dining-identity-assign] previous group ${report.result.previousGroupId.toHexString()} → mapping REJECTED`);
  console.log(`[dining-identity-assign] mapping:    ${JSON.stringify({
    _id: m._id, restaurantId: m.restaurantId, platform: m.platform, platformRestaurantId: m.platformRestaurantId,
    canonicalRestaurantGroupId: m.canonicalRestaurantGroupId, matchStatus: m.matchStatus, matchMethod: m.matchMethod,
    confidence: m.confidence, decidedBy: m.decidedBy, isActive: m.isActive, evidence: m.evidence,
  })}`);
}

main()
  .catch(err => {
    const code = (err as { code?: string }).code;
    console.error(`[dining-identity-assign] Refused/failed${code ? ` [${code}]` : ''}: ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => closeMongo());
