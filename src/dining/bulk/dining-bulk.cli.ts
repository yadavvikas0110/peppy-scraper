import dotenv from 'dotenv';
import { closeMongo, getMongoConfig, getMongoDb, redactMongoUri } from '../../shared/db/mongo';
import { createScrapeDoClient } from '../../shared/scrapedo/scrapedo.client';
import { DINING_COLLECTIONS } from '../db/dining.collections';
import { createDefaultDiningScrapeContext } from '../dining.context';
import { getDeliverooFetchOptions } from '../platforms/deliveroo/deliveroo.adapter';
import { getTalabatFetchOptions } from '../platforms/talabat/talabat.adapter';
import { fetchScrapeDoAccountInfo } from './bulk.credits';
import { candidatesFromDeliverooListing, candidatesFromTalabatListing, storeCandidates } from './bulk.discover';
import { ensureImportQueueIndexes, getImportQueueCollection } from './bulk.collections';
import { mergeDuplicatePairs } from './bulk.duplicates';
import { findDeliverooTwins, talabatSingletons } from './bulk.twins';
import { linkBatch, resetSingletonIdentity } from './bulk.link';
import { runBulkImport } from './bulk.run';
import { selectForBatch } from './bulk.select';
import { computeBulkStats, formatBulkStats } from './bulk.stats';
import type { ImportCandidate } from './bulk.types';

// Bulk import of restaurants (menus in English and Arabic, and the offers on the pages) from platform listing pages.
//
//   discover  read listing pages and queue the restaurants found (--run to fetch; ~1 credit per page)
//   select    pick restaurants into a named batch: pairs, same-brand controls, then the most reviewed
//   plan      what `run` would do and cost (read-only)
//   run       import the batch (--run; ~2 credits per restaurant: one plain request per language)
//   link      map the batch across platforms: identity, then the full dish mapping for groups with two platforms
//   relink    start the mapping over for restaurants alone in an untouched group, then link again (dry run unless --run)
//   twins     for Talabat restaurants with no Deliveroo listing, queue the same brand's Deliveroo branches near them (--run to fetch; ~1 credit per area)
//   duplicates  merge Deliveroo/Talabat listings of the same restaurant still shown apart (whole database; dry run unless --run)
//   stats     what the batch produced, measured from the database
//
// Every command that writes needs --db=<name> and refuses to continue unless it is the database actually in use.
//
//   npm run dining:bulk:dev -- discover --db=dev --deliveroo-url=<url> --talabat-url=<url> --talabat-pages=4 --run
//   npm run dining:bulk:dev -- select --db=dev --batch=pilot-1 --deliveroo=30 --talabat=30 --controls=5
//   npm run dining:bulk:dev -- run --db=dev --batch=pilot-1 --max-credits=140 --concurrency=3 --run

type Command = 'discover' | 'select' | 'plan' | 'run' | 'link' | 'relink' | 'twins' | 'duplicates' | 'stats';
const COMMANDS: Command[] = ['discover', 'select', 'plan', 'run', 'link', 'relink', 'twins', 'duplicates', 'stats'];
const WRITES: Command[] = ['discover', 'select', 'run', 'link', 'relink', 'twins', 'duplicates'];

function parseArgs(argv: string[]) {
  const [command, ...rest] = argv;
  if (!COMMANDS.includes(command as Command)) throw new Error(`Usage: dining:bulk <${COMMANDS.join('|')}> [options]`);
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (const arg of rest) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!m) throw new Error(`Unknown argument: ${arg}`);
    if (m[2] === undefined) flags.add(m[1]);
    else values.set(m[1], m[2]);
  }
  const int = (name: string, fallback: number) => {
    const raw = values.get(name);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a non-negative integer`);
    return n;
  };
  return { command: command as Command, flags, values, int };
}

async function main(): Promise<void> {
  dotenv.config();
  const args = parseArgs(process.argv.slice(2));
  const { dbName } = getMongoConfig();
  console.log(`[bulk] Database "${dbName}"`);
  if (WRITES.includes(args.command)) {
    const expected = args.values.get('db');
    if (!expected) throw new Error(`"${args.command}" writes data: pass --db=${dbName} to confirm the database`);
    if (expected !== dbName) throw new Error(`Refusing to continue: --db=${expected} but the database in use is "${dbName}"`);
  }

  const db = await getMongoDb();
  await ensureImportQueueIndexes(db);
  const queue = getImportQueueCollection(db);
  const batchId = args.values.get('batch');
  const needBatch = () => {
    if (!batchId) throw new Error('--batch=<name> is required');
    return batchId;
  };

  if (args.command === 'discover') {
    const deliverooUrl = args.values.get('deliveroo-url');
    const talabatUrl = args.values.get('talabat-url');
    const pages = args.int('talabat-pages', 1);
    // First Talabat page to fetch, to carry on from where an earlier discover stopped.
    const fromPage = Math.max(1, args.int('talabat-from', 1));
    if (!deliverooUrl && !talabatUrl) throw new Error('Give --deliveroo-url and/or --talabat-url');
    const requests = (deliverooUrl ? 1 : 0) + (talabatUrl ? Math.max(0, pages - fromPage + 1) : 0);
    console.log(`[bulk] discover: ${requests} listing request(s), ~${requests} credits`);
    if (!args.flags.has('run')) {
      console.log('[bulk] Plan only (add --run to fetch)');
      return;
    }
    const scrapeDo = createScrapeDoClient();
    const found: ImportCandidate[] = [];
    const excluded: Array<{ name: string; reason: string }> = [];
    if (deliverooUrl) {
      const res = await scrapeDo.fetchHtml(deliverooUrl, getDeliverooFetchOptions(deliverooUrl, 'en'));
      const page = candidatesFromDeliverooListing(res.html, deliverooUrl);
      found.push(...page.candidates);
      excluded.push(...page.excluded);
      console.log(`[bulk]   deliveroo: ${page.candidates.length} restaurants, ${page.excluded.length} excluded (${res.remainingCredits} credits left)`);
    }
    if (talabatUrl) {
      for (let p = fromPage; p <= pages; p++) {
        const url = p === 1 ? talabatUrl : `${talabatUrl}${talabatUrl.includes('?') ? '&' : '?'}page=${p}`;
        const res = await scrapeDo.fetchHtml(url, getTalabatFetchOptions(url, 'en'));
        const page = candidatesFromTalabatListing(res.html, url);
        if (!page) {
          console.warn(`[bulk]   talabat page ${p}: no vendor data found`);
          continue;
        }
        found.push(...page.candidates);
        excluded.push(...page.excluded);
        console.log(`[bulk]   talabat page ${p}: ${page.candidates.length} restaurants, ${page.excluded.length} excluded (of ${page.totalVendors ?? '?'} vendors in the area; ${res.remainingCredits} credits left)`);
      }
    }
    const stored = await storeCandidates(queue, found);
    console.log(`[bulk] queue: ${stored.added} new, ${stored.alreadyKnown} already known. Excluded as non-restaurants: ${excluded.map(e => e.name).slice(0, 25).join('; ')}${excluded.length > 25 ? '; …' : ''}`);
    return;
  }

  if (args.command === 'select') {
    const batch = needBatch();
    const deliveroo = args.int('deliveroo', 30);
    const talabat = args.int('talabat', 30);
    const controls = args.int('controls', 5);
    const discovered = await queue.find({ status: 'discovered' }).toArray();
    // Restaurants already imported (by an earlier run) are skipped, not scraped again.
    const known = await db.collection(DINING_COLLECTIONS.restaurants).find({}, { projection: { platform: 1, platformRestaurantId: 1 } }).toArray();
    const knownKeys = new Set(known.map(r => `${r.platform}:${r.platformRestaurantId}`));
    const fresh = discovered.filter(c => !knownKeys.has(`${c.platform}:${c.platformRestaurantId}`));
    for (const c of discovered.filter(c => knownKeys.has(`${c.platform}:${c.platformRestaurantId}`))) {
      await queue.updateOne({ _id: c._id }, { $set: { status: 'skipped', reason: 'ALREADY_IMPORTED', updatedAt: new Date() } });
    }
    const picks = selectForBatch(fresh, { quota: { deliveroo, talabat }, controls });
    const tierPriority = { PAIR: 0, CONTROL: 1, FILL: 2 } as const;
    for (const p of picks) {
      await queue.updateOne(
        { platform: p.platform, platformRestaurantId: p.platformRestaurantId },
        { $set: { status: 'queued', batchId: batch, reason: `${p.tier}: ${p.reason}`, pairKey: p.pairKey, priority: tierPriority[p.tier], updatedAt: new Date() } }
      );
    }
    const by = (tier: string) => picks.filter(p => p.tier === tier).length;
    console.log(`[bulk] batch ${batch}: ${picks.length} restaurants queued (${picks.filter(p => p.platform === 'deliveroo').length} Deliveroo, ${picks.filter(p => p.platform === 'talabat').length} Talabat) | PAIR ${by('PAIR')}, CONTROL ${by('CONTROL')}, FILL ${by('FILL')} | skipped as already imported: ${discovered.length - fresh.length}`);
    for (const p of picks.filter(p => p.tier !== 'FILL')) console.log(`  ${p.tier.padEnd(7)} ${p.platform.padEnd(9)} ${p.platformRestaurantId} ${p.pairKey}`);
    return;
  }

  if (args.command === 'plan' || args.command === 'run') {
    const batch = needBatch();
    const maxCredits = args.int('max-credits', 140);
    const reserve = args.int('reserve', 50);
    const concurrency = args.int('concurrency', 3);
    const limit = args.values.has('limit') ? args.int('limit', 0) : undefined;
    const account = await fetchScrapeDoAccountInfo();
    const queued = await queue.find({ batchId: batch, status: 'queued' }).toArray();
    const retryable = await queue.countDocuments({ batchId: batch, status: { $in: ['failed', 'partial'] }, attempts: { $lt: 3 } });
    const estimate = queued.length * 2;
    console.log(`[bulk] batch ${batch}: ${queued.length} queued (${retryable} failed/partial could be retried), ~${estimate} credits (1 per language per restaurant, 5 if a rendered fallback is needed)`);
    if (account) console.log(`[bulk] Scrape.do: ${account.remainingMonthlyRequest} of ${account.maxMonthlyRequest} credits left, ${account.concurrentRequest} concurrent allowed`);
    if (concurrency > (account?.concurrentRequest ?? concurrency)) throw new Error(`--concurrency=${concurrency} exceeds the plan's ${account?.concurrentRequest} concurrent requests`);
    if (account && estimate > account.remainingMonthlyRequest - reserve) console.warn(`[bulk] WARNING: the estimate exceeds the credits above the ${reserve}-credit reserve`);
    if (args.command === 'plan' || !args.flags.has('run')) {
      if (args.command === 'run') console.log('[bulk] Plan only (add --run to import)');
      return;
    }
    if (args.flags.has('retry-failed')) {
      const res = await queue.updateMany({ batchId: batch, status: { $in: ['failed', 'partial'] }, attempts: { $lt: 3 } }, { $set: { status: 'queued', updatedAt: new Date() } });
      console.log(`[bulk] requeued ${res.modifiedCount} failed/partial restaurants`);
    }
    // Bulk imports do not link inline: linking is its own batch step (`link`), so a slow link never stalls the scraping.
    const scrapeContext = {
      ...createDefaultDiningScrapeContext(),
      scrapeDo: createScrapeDoClient({ env: { ...process.env, SCRAPE_DO_CONCURRENCY: String(concurrency) } }),
      afterScrape: undefined,
      trigger: 'queue' as const,
    };
    const summary = await runBulkImport({ queue, scrapeContext }, { batchId: batch, concurrency, maxCredits, reserveCredits: reserve, limit });
    console.log(`[bulk] done in ${Math.round(summary.durationMs / 1000)}s: ${summary.attempted} attempted | imported ${summary.imported}, partial ${summary.partial}, failed ${summary.failed} | ${summary.creditsUsed} credits used${summary.remainingCredits !== undefined ? `, ${summary.remainingCredits} left` : ''}${summary.stoppedReason ? ` | stopped: ${summary.stoppedReason}` : ''}`);
    return;
  }

  if (args.command === 'duplicates') {
    const apply = args.flags.has('run');
    const pairs = await mergeDuplicatePairs(db, apply);
    console.log(`[bulk] ${pairs.length} same-restaurant pair(s) ${apply ? 'processed' : 'found (dry run; add --run to merge)'}`);
    for (const p of pairs) console.log(`  ${p.outcome?.padEnd(8)} ${p.deliveroo.name} <> ${p.talabat.name} | ${p.distanceMeters} m | ${Math.round(p.menuOverlap * 100)}% same dishes`);
    return;
  }

  if (args.command === 'twins') {
    const batch = needBatch();
    const sources = await talabatSingletons(db);
    const listings = new Set(sources.map(s => `${s.lat.toFixed(3)},${s.lng.toFixed(3)}`)).size;
    console.log(`[bulk] twins: ${sources.length} Talabat restaurants have no Deliveroo listing; about ${listings} Deliveroo listing request(s) (~${listings} credits), then ~2 credits per branch to import`);
    if (!args.flags.has('run')) {
      console.log('[bulk] Plan only (add --run to fetch)');
      return;
    }
    const result = await findDeliverooTwins(db, queue, createScrapeDoClient(), sources, { batchId: batch, maxListings: args.int('max-listings', 30), maxPerRestaurant: args.int('per-restaurant', 3) });
    console.log(`[bulk] no Deliveroo branch near: ${result.noBranchOnDeliveroo.join('; ') || '-'}`);
    return;
  }

  if (args.command === 'relink') {
    const apply = args.flags.has('run');
    const reset = await resetSingletonIdentity(db, needBatch(), apply);
    console.log(`[bulk] ${apply ? 'removed' : 'would remove'} ${reset.groupsRemoved} untouched single-restaurant group(s)`);
    if (!apply) return;
  }

  if (args.command === 'link' || args.command === 'relink') {
    const summary = await linkBatch(db, needBatch());
    const linked = summary.fullLinks.filter(l => l.status === 'linked').length;
    console.log(`[bulk] linked: ${summary.restaurants} restaurants | identity ${JSON.stringify(summary.identity)} | strict approvals ${summary.strictApprovals.approved} | ${summary.groupsWithTwoPlatforms} group(s) with two platforms | full link ok ${linked}/${summary.fullLinks.length}`);
    for (const l of summary.fullLinks.filter(x => x.status !== 'linked' || x.problems.length)) console.log(`  ${l.restaurantId}: ${l.status} ${l.reason ?? ''} ${l.problems.join('; ')}`);
    return;
  }

  const stats = await computeBulkStats(db, needBatch());
  console.log(args.flags.has('json') ? JSON.stringify(stats, null, 2) : formatBulkStats(stats));
}

main()
  .catch(err => {
    console.error(`[bulk] Failed: ${redactMongoUri(String((err as Error)?.message ?? err))}`);
    process.exitCode = 1;
  })
  .finally(() => closeMongo());
