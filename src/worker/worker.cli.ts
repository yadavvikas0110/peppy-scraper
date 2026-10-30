/**
 * Shopping worker CLI (Amazon UAE).
 *
 *   start                         continuous scheduler (discovery every 24h per query, refresh every 12h)
 *   run-once --query <key>        one discovery run for a configured query
 *   run-once --search "<text>" --count N [--broad <B> --sub <S>]   one ad-hoc discovery run
 *   run-once --refresh            one refresh run
 *     [--max-requests N]          hard cap on paid requests for this run
 *   status [--json]               jobs, schedule, budget, backlog, failures
 *   stop                          graceful stop of a running worker
 *
 * Reads .env (and --env-file overrides). See .env.example for SHOPPING_* settings.
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Db } from 'mongodb';
import { loadWorkerConfig, ShoppingQuery, WorkerConfig } from './worker.config';
import { mongoWorkerStore, workerOwnerId, utcDay, WorkerStore, JobRecord } from './worker.store';
import { RequestBudget } from './worker.budget';
import { createWorkerLogger, formatSummary, WorkerLogger } from './worker.logger';
import { discoveryJobId, ensureJobs, executeJob, REFRESH_JOB_ID, runScheduler, SchedulerDeps, writeStatusFile } from './worker.scheduler';
import { JobContext, selectRefreshTargets } from './worker.jobs';
import { assertSafeWriteTarget, closeMongo, getMongoDb } from '../shared/db/mongo';
import { setProviderRequestGate, closeBrowserPool } from '../services/brightdata.service';
import { scrapeBulk, scrapeProductWithRetry } from '../services/playwright.service';
import { ProductsCollection, pushToDatabase, markStaleOffers } from '../cron/push-pipeline';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

interface Runtime {
  config: WorkerConfig;
  db: Db;
  store: WorkerStore;
  logger: WorkerLogger;
  products: ProductsCollection;
  paths: { stopFile: string; statusFile: string; logDir: string };
}

async function bootstrap(opts: { forWrites: boolean }): Promise<Runtime> {
  const config = loadWorkerConfig();
  // Development refuses a production database outright; production requires CONFIRM_PRODUCTION_DB=yes
  const { dbName } = assertSafeWriteTarget();
  if (config.env === 'development' && /prod|live/i.test(dbName)) throw new Error(`development mode cannot use database "${dbName}"`);
  if (opts.forWrites && process.env.ENABLE_CRON === 'true' && process.env.SHOPPING_WORKER_ALLOW_LEGACY_CRON !== 'yes') {
    throw new Error('ENABLE_CRON=true: the legacy nightly cron would scrape alongside this worker. Set ENABLE_CRON=false for the scraper server (or SHOPPING_WORKER_ALLOW_LEGACY_CRON=yes).');
  }
  // Bounded concurrency — the Bright Data semaphores read these on first use
  process.env.BD_UNLOCKER_CONCURRENCY = String(config.maxConcurrency);
  process.env.BD_BROWSER_CONCURRENCY = String(config.maxConcurrency);

  const db = await getMongoDb();
  const paths = {
    stopFile: path.join(config.outputDir, 'shopping-worker.stop'),
    statusFile: path.join(config.outputDir, 'shopping-worker-status.json'),
    logDir: path.join(config.outputDir, 'logs'),
  };
  const logger = createWorkerLogger({ dir: paths.logDir });
  logger.info('worker.config', {
    env: config.env, database: dbName, sites: config.sites.join(','), queries: config.queries.length,
    discoveryEveryH: config.discoveryIntervalMs / 3_600_000, refreshEveryH: config.refreshIntervalMs / 3_600_000,
    dailyRequestBudget: config.dailyRequestBudget, concurrency: config.maxConcurrency, minRequestIntervalMs: config.minRequestIntervalMs,
    backendMapping: process.env.PEPPY_BE_URL && process.env.SCRAPER_API_KEY ? process.env.PEPPY_BE_URL : 'NOT CONFIGURED',
  });
  return { config, db, store: mongoWorkerStore(db), logger, products: db.collection('products_clean') as unknown as ProductsCollection, paths };
}

function makeContextFactory(rt: Runtime, budget: RequestBudget) {
  return (shouldStop: () => boolean): JobContext => ({
    config: rt.config,
    budget,
    logger: rt.logger,
    products: rt.products,
    now: () => new Date(),
    shouldStop: () => shouldStop() || budget.exhausted,
    scrapeBulk: (options, deps) => scrapeBulk(options, deps),
    scrapeProduct: scrapeProductWithRetry,
    push: bundles => pushToDatabase(bundles),
    markStale: () => markStaleOffers(),
  });
}

function schedulerDeps(rt: Runtime, budget: RequestBudget): SchedulerDeps {
  return {
    store: rt.store,
    config: rt.config,
    owner: workerOwnerId(),
    logger: rt.logger,
    makeContext: makeContextFactory(rt, budget),
    now: () => new Date(),
    sleep: async (ms, isStopped) => {
      const until = Date.now() + ms;
      while (Date.now() < until && !isStopped()) await new Promise(r => setTimeout(r, Math.min(1000, until - Date.now())));
    },
    stopFile: rt.paths.stopFile,
    statusFile: rt.paths.statusFile,
  };
}

async function cmdStart(): Promise<number> {
  const rt = await bootstrap({ forWrites: true });
  const budget = new RequestBudget(rt.store, rt.config.dailyRequestBudget, rt.config.minRequestIntervalMs);
  setProviderRequestGate(budget.gate);
  const signals = { stopRequested: false };
  let forced = false;
  const onSignal = (sig: string) => {
    if (signals.stopRequested) {
      if (!forced) { forced = true; rt.logger.warn('worker.force_exit', { signal: sig }); process.exit(130); }
      return;
    }
    signals.stopRequested = true;
    rt.logger.warn('worker.stop_requested', { signal: sig, note: 'finishing the current item; progress is checkpointed' });
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  try { fs.unlinkSync(rt.paths.stopFile); } catch {}

  const result = await runScheduler(schedulerDeps(rt, budget), signals);
  await closeBrowserPool().catch(() => {});
  await closeMongo();
  return result === 'stopped' ? 0 : 1;
}

async function cmdRunOnce(): Promise<number> {
  const rt = await bootstrap({ forWrites: true });
  const owner = workerOwnerId();
  if (!(await rt.store.acquireLock(owner, rt.config.lockTtlMs, new Date()))) {
    const lock = await rt.store.readLock();
    rt.logger.error('run_once.worker_running', { heldBy: lock?.owner, hint: 'stop the worker first (npm run shopping:worker:stop)' });
    await closeMongo();
    return 1;
  }
  try {
    let job: JobRecord;
    let cap: number;
    if (flag('refresh')) {
      await ensureJobs(rt.store, rt.config, new Date());
      job = (await rt.store.getJob(REFRESH_JOB_ID))!;
      cap = Number(arg('max-requests') ?? rt.config.refreshBatchSize * 3);
    } else {
      let query: ShoppingQuery | undefined;
      if (arg('query')) {
        query = rt.config.queries.find(q => q.key === arg('query'));
        if (!query) throw new Error(`Unknown query "${arg('query')}". Configured: ${rt.config.queries.map(q => q.key).join(', ')}`);
      } else if (arg('search')) {
        const count = Number(arg('count') ?? 10);
        if (!Number.isInteger(count) || count < 1 || count > 200) throw new Error('--count must be 1–200');
        const text = arg('search')!;
        query = {
          key: `adhoc-${text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${count}`,
          label: `Ad-hoc: ${text}`, category: text, count,
          broadCategory: arg('broad') ?? 'Electronics', subCategory: arg('sub') ?? 'General',
        };
        rt.config.queries = [...rt.config.queries, query];
      } else {
        throw new Error('run-once needs --query <key>, --search "<text>" or --refresh');
      }
      await ensureJobs(rt.store, rt.config, new Date());
      job = (await rt.store.getJob(discoveryJobId(query)))!;
      // Search pages + one product page each, with retry headroom
      cap = Number(arg('max-requests') ?? query.count * 3 + 10);
    }
    const budget = new RequestBudget(rt.store, rt.config.dailyRequestBudget, rt.config.minRequestIntervalMs, undefined, undefined, cap);
    setProviderRequestGate(budget.gate);
    rt.logger.info('run_once.start', { job: job._id, maxRequests: cap });
    const stop = { requested: false };
    process.on('SIGINT', () => { stop.requested = true; rt.logger.warn('run_once.stop_requested'); });
    const ctx = makeContextFactory(rt, budget)(() => stop.requested);
    const result = await executeJob(job, ctx, { store: rt.store, config: rt.config, now: () => new Date() });
    await writeStatusFile({ store: rt.store, config: rt.config, now: () => new Date(), statusFile: rt.paths.statusFile }, { state: 'idle' });
    return result.outcome === 'complete' ? 0 : 2;
  } finally {
    await rt.store.releaseLock(owner).catch(() => {});
    await closeBrowserPool().catch(() => {});
    await closeMongo();
  }
}

const fmt = (d?: Date | string | null) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 19) + 'Z' : '—');

async function cmdStatus(): Promise<number> {
  const rt = await bootstrap({ forWrites: false });
  const now = new Date();
  const jobs = await ensureJobs(rt.store, rt.config, now).then(() => rt.store.listJobs());
  const lock = await rt.store.readLock();
  const used = await rt.store.budgetUsed(utcDay(now));
  const backlog = (await selectRefreshTargets({ config: { ...rt.config, refreshBatchSize: 1_000_000 }, products: rt.products, now: () => now } as any)).length;
  const runs = await rt.store.recentRuns(20);
  const failures = runs.filter(r => r.outcome !== 'complete').slice(0, 5);
  const lastSuccess = runs.find(r => r.outcome === 'complete');

  if (flag('json')) {
    console.log(JSON.stringify({ now, lock, budget: { used, limit: rt.config.dailyRequestBudget }, refreshBacklog: backlog, jobs, lastSuccess, failures }, null, 2));
    await closeMongo();
    return 0;
  }
  const alive = lock && new Date(lock.expiresAt) > now;
  console.log(`\nShopping worker — ${rt.config.env} — ${now.toISOString()}`);
  console.log(`  worker:   ${alive ? `RUNNING (${lock!.owner}, heartbeat ${fmt(lock!.heartbeatAt)})` : 'not running'}`);
  console.log(`  budget:   ${used}/${rt.config.dailyRequestBudget} paid requests used today (${utcDay(now)} UTC)`);
  console.log(`  backlog:  ${backlog} Amazon offer(s) older than ${rt.config.freshForMs / 3_600_000}h awaiting refresh`);
  console.log(`  last successful run: ${lastSuccess ? `${lastSuccess.jobId} at ${fmt(lastSuccess.finishedAt)}` : '—'}\n`);
  for (const j of jobs) {
    const prog = j.progress ? `  progress ${j.progress.done.length}/${j.progress.targets.length}` : '';
    console.log(`  ${j._id.padEnd(40)} ${String(j.status).padEnd(17)} next ${fmt(j.nextRunAt)}  last ok ${fmt(j.lastSuccessAt)}${prog}`);
    if (j.lastSummary) console.log(`      ${formatSummary(j.lastSummary)}`);
    if (j.lastError) console.log(`      error: ${j.lastError}`);
    for (const issue of j.issues ?? []) console.log(`      issue: ${issue}`);
  }
  if (failures.length) {
    console.log('\n  recent non-complete runs:');
    for (const r of failures) console.log(`    ${fmt(r.finishedAt)}  ${r.jobId}  ${r.outcome}${r.error ? ` — ${r.error}` : ''}`);
  }
  console.log('');
  await closeMongo();
  return 0;
}

async function cmdStop(): Promise<number> {
  const rt = await bootstrap({ forWrites: false });
  const lock = await rt.store.readLock();
  if (!lock || new Date(lock.expiresAt) < new Date()) {
    console.log('No running shopping worker.');
    await closeMongo();
    return 0;
  }
  fs.mkdirSync(path.dirname(rt.paths.stopFile), { recursive: true });
  fs.writeFileSync(rt.paths.stopFile, JSON.stringify({ requestedAt: new Date(), by: workerOwnerId() }));
  if (lock.host === os.hostname()) {
    try { process.kill(lock.pid, 'SIGTERM'); } catch {}
  }
  console.log(`Stop requested for ${lock.owner}; waiting for it to checkpoint and release the lock...`);
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const current = await rt.store.readLock();
    if (!current || current.owner !== lock.owner) {
      console.log('Worker stopped cleanly. Interrupted jobs resume on the next start.');
      await closeMongo();
      return 0;
    }
  }
  console.log('Still finishing the current product after 120s — it will stop at the next checkpoint. Check with shopping:worker:status.');
  await closeMongo();
  return 0;
}

async function main(): Promise<number> {
  switch (process.argv[2]) {
    case 'start': return cmdStart();
    case 'run-once': return cmdRunOnce();
    case 'status': return cmdStatus();
    case 'stop': return cmdStop();
    default:
      console.error('Usage: worker.cli <start|run-once|status|stop> [options]');
      return 64;
  }
}

if (require.main === module) {
  main()
    .then(code => process.exit(code))
    .catch(async e => {
      console.error(`[shopping-worker] ${e.message}`);
      await closeMongo().catch(() => {});
      process.exit(1);
    });
}
