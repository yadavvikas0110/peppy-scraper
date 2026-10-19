import { Db, ObjectId } from 'mongodb';
import { backfillCanonicalItems } from '../canonical-items/canonical-item.backfill';
import { ensureDiningCanonicalItemIndexes, getDiningCanonicalItemCollections } from '../canonical-items/canonical-item.collections';
import { DINING_LOCALES, DiningPlatform } from '../dining.types';
import { backfillRestaurantIdentity } from '../identity/identity.backfill';
import { ensureDiningIdentityIndexes, getDiningIdentityCollections } from '../identity/identity.collections';
import { createDiningIdentityRepositories } from '../identity/identity.service';
import { runStrictItemApproval } from '../item-mappings/item-mapping.approve';
import { DiningItemMatchBatchError, getItemMatchBatchCollections, runItemMatchBatch } from '../item-mappings/item-mapping.batch';
import { ensureDiningItemMappingIndexes } from '../item-mappings/item-mapping.collections';
import { importSeedItemMappings } from '../item-mappings/item-mapping.import';

/*
 * Runs the cross-platform linking pipeline for one restaurant, from stored data only (no network):
 *
 *   identity (group + mapping) → verify group → canonical items (seed platform) →
 *   item matching (other platforms) → strict approvals → seed item mappings
 *
 * Every step is idempotent, so it is safe after every scrape and re-links new menu items on refresh.
 * It only starts once the restaurant has been scraped in every locale, because the matcher compares
 * EN and AR names and never revises its own earlier decisions.
 */

export interface AutoLinkOptions {
  // Promote a group from "auto" to "verified" once two platforms matched on name + address/coordinates.
  autoVerify?: boolean;
  logger?: Pick<Console, 'log' | 'warn'>;
}

export interface AutoLinkSummary {
  restaurantId: string;
  status: 'linked' | 'skipped';
  reason?: string;
  groupId?: string;
  platforms?: DiningPlatform[];
  verified?: boolean;
  canonicalItemsCreated?: number;
  itemsMatched?: number;
  itemsApproved?: number;
  seedMappingsCreated?: number;
  problems: string[];
}

export function isAutoLinkEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DINING_AUTO_LINK?.trim().toLowerCase() !== 'false';
}

export function isAutoVerifyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DINING_AUTO_VERIFY?.trim().toLowerCase() !== 'false';
}

// One linking run at a time per process: two platforms of a new restaurant finishing together must
// not both create a group for it.
let queue: Promise<unknown> = Promise.resolve();
const indexesEnsured = new WeakSet<Db>();

export function autoLinkRestaurant(db: Db, restaurantId: ObjectId, options: AutoLinkOptions = {}): Promise<AutoLinkSummary> {
  const run = queue.then(() => linkRestaurant(db, restaurantId, options));
  queue = run.catch(() => undefined);
  return run;
}

async function ensureIndexes(db: Db): Promise<void> {
  if (indexesEnsured.has(db)) return;
  await ensureDiningIdentityIndexes(db);
  await ensureDiningCanonicalItemIndexes(db);
  await ensureDiningItemMappingIndexes(db);
  indexesEnsured.add(db);
}

async function linkRestaurant(db: Db, restaurantId: ObjectId, options: AutoLinkOptions): Promise<AutoLinkSummary> {
  const logger = options.logger ?? console;
  const summary: AutoLinkSummary = { restaurantId: restaurantId.toHexString(), status: 'skipped', problems: [] };
  const skip = (reason: string): AutoLinkSummary => ({ ...summary, reason });

  await ensureIndexes(db);
  const identity = getDiningIdentityCollections(db);
  const repos = createDiningIdentityRepositories(identity);

  const scrapedInAllLocales = async (id: ObjectId): Promise<boolean> => {
    const r = await identity.restaurants.findOne({ _id: id }, { projection: { lastRunIdByLocale: 1 } });
    return !!r && DINING_LOCALES.every(l => !!r.lastRunIdByLocale?.[l]);
  };
  if (!(await scrapedInAllLocales(restaurantId))) return skip('LOCALES_INCOMPLETE');

  // 1. Identity: creates a group, or joins the matching branch group on another platform.
  const identityReport = await backfillRestaurantIdentity(repos, { restaurantIds: [restaurantId] });
  const failed = identityReport.entries.find(e => e.outcome === 'FAILED');
  if (failed) return skip(`IDENTITY_FAILED: ${failed.error?.message ?? failed.error?.code ?? 'unknown'}`);
  const mapping = await repos.mappings.findActiveByRestaurant(restaurantId);
  if (!mapping || mapping.matchStatus !== 'MATCHED' || !mapping.canonicalRestaurantGroupId) {
    return skip(`IDENTITY_${mapping?.matchStatus ?? 'UNMAPPED'}`);
  }
  const groupId = mapping.canonicalRestaurantGroupId;
  summary.groupId = groupId.toHexString();

  const group = await identity.restaurantGroups.findOne({ _id: groupId });
  if (!group || group.status !== 'active') return skip('GROUP_INACTIVE');
  const members = await identity.restaurantMappings
    .find({ canonicalRestaurantGroupId: groupId, isActive: true, matchStatus: 'MATCHED' }, { projection: { restaurantId: 1, platform: 1 } })
    .toArray();
  summary.platforms = [...new Set(members.map(m => m.platform))];

  // 2. Verify. The matcher only returns MATCHED with a name match plus address/coordinates, and sends
  // anything weaker to REVIEW (which flips the group to "review", never promoted here).
  if (group.identityStatus === 'auto' && summary.platforms.length >= 2 && options.autoVerify !== false) {
    await repos.groups.markVerified(groupId, new Date());
    summary.verified = true;
  } else {
    summary.verified = group.identityStatus === 'verified';
  }

  // 3. Canonical items from the seed platform: the platform already seeding the group, else the
  // platform of the restaurant the group was created from.
  const canonicalCollections = getDiningCanonicalItemCollections(db);
  const existingSeed = await canonicalCollections.canonicalItems.findOne({ restaurantGroupId: groupId, status: 'active' }, { projection: { seedPlatform: 1 } });
  const groupSeedRestaurant = await identity.restaurants.findOne({ _id: group.seedRestaurantId }, { projection: { platform: 1 } });
  const seedPlatform = existingSeed?.seedPlatform ?? groupSeedRestaurant?.platform;
  const seedMember = members.find(m => m.platform === seedPlatform);
  if (!seedPlatform || !seedMember) return skip('SEED_PLATFORM_NOT_IN_GROUP');
  if (!(await scrapedInAllLocales(seedMember.restaurantId))) return skip('SEED_LOCALES_INCOMPLETE');

  const canonical = await backfillCanonicalItems(canonicalCollections, { restaurantId: seedMember.restaurantId, platform: seedPlatform });
  summary.canonicalItemsCreated = canonical.canonicalItemsCreated;
  if (canonical.failures > 0) summary.problems.push(`canonical items: ${canonical.failures} failure(s)`);

  // 4. Match every other platform's items against the seed items, then apply the strict approvals.
  const batchCollections = getItemMatchBatchCollections(db);
  let matched = 0;
  let approved = 0;
  for (const member of members) {
    if (member.platform === seedPlatform) continue;
    const label = `${member.platform}:${member.restaurantId.toHexString()}`;
    if (!(await scrapedInAllLocales(member.restaurantId))) {
      summary.problems.push(`${label}: not scraped in every locale yet`);
      continue;
    }
    try {
      const base = { restaurantGroupId: groupId, restaurantId: member.restaurantId, seedPlatform };
      const plan = await runItemMatchBatch(batchCollections, { ...base, dryRun: true, reportLimit: 1 });
      const applied = await runItemMatchBatch(batchCollections, { ...base, dryRun: false, expectedPlan: plan.plan, reportLimit: 1 });
      matched += applied.decisions.MATCHED;

      const approval = { restaurantGroupId: groupId, restaurantId: member.restaurantId };
      const approvalPlan = await runStrictItemApproval(batchCollections, { ...approval, dryRun: true });
      if (approvalPlan.writes.planned > 0) {
        const done = await runStrictItemApproval(batchCollections, {
          ...approval,
          dryRun: false,
          expectedPlan: approvalPlan.plan,
          note: 'AUTO_LINK: strict approval after scrape',
        });
        approved += done.writes.written ?? 0;
      }
    } catch (err) {
      const message = err instanceof DiningItemMatchBatchError ? `${err.code}: ${err.message}` : String((err as Error)?.message ?? err);
      summary.problems.push(`${label}: ${message}`);
    }
  }
  summary.itemsMatched = matched;
  summary.itemsApproved = approved;

  // 5. Seed item mappings, so the seed platform's own dishes take part in price comparison.
  const seeds = await importSeedItemMappings(batchCollections, { restaurantGroupId: groupId, platform: seedPlatform });
  summary.seedMappingsCreated = seeds.mappingsCreated;
  if (seeds.failures > 0) summary.problems.push(`seed mappings: ${seeds.failures} failure(s)`);

  summary.status = 'linked';
  logger.log(
    `[dining-link] ${summary.restaurantId} group=${summary.groupId} platforms=${summary.platforms.join('+')} verified=${summary.verified} ` +
    `canonical+${summary.canonicalItemsCreated} matched=${matched} approved=${approved} seedMappings+${summary.seedMappingsCreated}` +
    (summary.problems.length ? ` problems=${JSON.stringify(summary.problems)}` : '')
  );
  return summary;
}
