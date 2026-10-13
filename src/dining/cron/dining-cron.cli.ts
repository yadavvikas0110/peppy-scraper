import dotenv from 'dotenv';
import { closeMongo, getMongoConfig, getMongoDb, redactMongoUri } from '../../shared/db/mongo';
import { createDefaultDiningScrapeContext } from '../dining.context';
import { DINING_LOCALES, DiningLocale, DiningPlatform } from '../dining.types';
import { getSupportedDiningPlatforms } from '../platforms/platform.registry';
import { getDiningCronCollections } from './dining-cron.collections';
import { isDiningCronEnabled, loadDiningCronConfig } from './dining-cron.config';
import { getDefaultDiningCronCollections } from './dining-cron.context';
import { createDiningCronJobRepository } from './dining-cron.repository';
import { runDiningCronJob } from './dining-cron.runner';
import { DiningCronPlanFilter, loadDiningCronPlan } from './dining-cron.targets';

// Operator tool for the daily dining refresh (works whether or not ENABLE_DINING_CRON is set).
//
//   npm run dining:cron                       what the next job would scrape + estimated credits (read-only)
//   npm run dining:cron -- --status           recent jobs (add --limit=N)
//   npm run dining:cron -- --run              run one job now (uses Scrape.do credits, writes the menus)
//   npm run dining:cron -- --run --dry-run    scrape and parse but write no menu data (still uses credits)
//
// Filters for --plan/--run: --platform=deliveroo,talabat --restaurant=<_id>,<_id> --locale=en,ar. Add --json for JSON output.

type Mode = 'plan' | 'run' | 'status';

interface Args {
  mode: Mode;
  dryRun: boolean;
  json: boolean;
  limit: number;
  filter: DiningCronPlanFilter;
}

function list(value: string): string[] {
  return value.split(',').map(v => v.trim()).filter(Boolean);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { mode: 'plan', dryRun: false, json: false, limit: 10, filter: {} };
  const platforms = getSupportedDiningPlatforms();
  for (const arg of argv) {
    if (arg === '--plan') args.mode = 'plan';
    else if (arg === '--run') args.mode = 'run';
    else if (arg === '--status') args.mode = 'status';
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--json') args.json = true;
    else {
      const match = /^--(platform|restaurant|locale|limit)=(.*)$/.exec(arg);
      if (!match) throw new Error(`Unknown argument: ${arg}`);
      const [, key, value] = match;
      if (key === 'platform') {
        const bad = list(value).filter(p => !platforms.includes(p as DiningPlatform));
        if (bad.length) throw new Error(`--platform must be one of ${platforms.join(', ')} (got ${bad.join(', ')})`);
        args.filter.platforms = list(value) as DiningPlatform[];
      } else if (key === 'restaurant') {
        const ids = list(value);
        if (ids.some(id => !/^[a-f0-9]{24}$/i.test(id))) throw new Error('--restaurant must be 24-character hex ObjectIds');
        args.filter.restaurantIds = ids;
      } else if (key === 'locale') {
        const bad = list(value).filter(l => !DINING_LOCALES.includes(l as DiningLocale));
        if (bad.length) throw new Error(`--locale must be one of ${DINING_LOCALES.join(', ')}`);
        args.filter.locales = list(value) as DiningLocale[];
      } else {
        const limit = Number(value);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('--limit must be an integer between 1 and 100');
        args.limit = limit;
      }
    }
  }
  if (args.dryRun && args.mode !== 'run') throw new Error('--dry-run only applies to --run');
  return args;
}

function print(json: boolean, value: unknown, lines: () => void): void {
  if (json) console.log(JSON.stringify(value, null, 2));
  else lines();
}

async function main(): Promise<void> {
  dotenv.config();
  const args = parseArgs(process.argv.slice(2));
  const config = loadDiningCronConfig();
  const { dbName } = getMongoConfig();
  if (!args.json) {
    console.log(
      `[dining-cron] Database "${dbName}"; schedule "${config.schedule}" (${config.timezone}); ` +
      `ENABLE_DINING_CRON=${isDiningCronEnabled() ? 'true' : 'false'}`
    );
  }

  if (args.mode === 'status') {
    const db = await getMongoDb();
    const jobs = await createDiningCronJobRepository(getDiningCronCollections(db).jobs).listRecent(args.limit);
    print(args.json, jobs, () => {
      if (!jobs.length) console.log('[dining-cron] No jobs recorded yet');
      for (const j of jobs) {
        const t = j.totals;
        console.log(
          `${j.startedAt.toISOString()}  ${j.jobId}  ${j.trigger.padEnd(8)} ${j.status.padEnd(9)}` +
          `${j.abortReason ? ` (${j.abortReason})` : ''}${j.skipReason ? ` (${j.skipReason})` : ''}  ` +
          `targets ${t.targetsSucceeded}/${t.targetsPlanned} ok, ${t.targetsPartial} partial, ${t.targetsFailed} failed, ${t.targetsSkipped} skipped; ` +
          `items +${t.itemsCreated} ~${t.itemsUpdated} -${t.itemsMarkedInactive}; changes ${t.changesRecorded}; credits ${t.creditsUsed}` +
          (j.durationMs !== undefined ? `; ${Math.round(j.durationMs / 1000)}s` : '')
        );
      }
    });
    return;
  }

  if (args.mode === 'plan') {
    const db = await getMongoDb();
    const { plan, restaurants } = await loadDiningCronPlan(getDiningCronCollections(db), { filter: args.filter, maxTargets: config.maxTargets });
    print(args.json, { plan, restaurants }, () => {
      for (const r of restaurants) {
        console.log(`  ${r.platform.padEnd(9)} ${r.restaurantId}  ${r.restaurantName ?? '?'}`);
        for (const t of r.targets) console.log(`      ${t.locale}  ~${t.estimatedCredits} credits  ${t.url}`);
      }
      for (const s of plan.skipped) console.log(`  SKIP ${s.platform} ${s.restaurantId} ${s.restaurantName ?? ''} ${s.locale ?? ''}: ${s.reason}`);
      for (const [platform, p] of Object.entries(plan.byPlatform)) {
        console.log(`[dining-cron] ${platform}: ${p!.restaurants} restaurants, ${p!.targets} scrapes, ~${p!.estimatedCredits} credits`);
      }
      console.log(
        `[dining-cron] Total per job: ${plan.restaurants} restaurants, ${plan.targets} Scrape.do requests, ` +
        `~${plan.estimatedCredits} credits (~${plan.estimatedCredits * 30}/month at one job per day)`
      );
    });
    return;
  }

  const controller = new AbortController();
  const onSignal = () => {
    console.warn('\n[dining-cron] Stopping after the current scrape (Ctrl+C again to force)...');
    controller.abort();
    process.removeListener('SIGINT', onSignal);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const summary = await runDiningCronJob(
    { collections: getDefaultDiningCronCollections, scrapeContext: { ...createDefaultDiningScrapeContext(), trigger: 'cron' } },
    { trigger: 'manual', config, dryRun: args.dryRun, filter: args.filter, signal: controller.signal }
  );
  if (args.json) console.log(JSON.stringify(summary, null, 2));
  if (summary.status === 'failed' || summary.status === 'aborted') process.exitCode = 1;
  if (summary.status === 'skipped') process.exitCode = 2;
}

main()
  .catch(err => {
    console.error(`[dining-cron] Failed: ${redactMongoUri(String((err as Error)?.message ?? err))}`);
    process.exitCode = 1;
  })
  .finally(() => closeMongo());
