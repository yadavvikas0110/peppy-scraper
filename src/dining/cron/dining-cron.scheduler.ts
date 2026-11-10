import cron from 'node-cron';
import { DINING_CRON_DEFAULTS, DiningCronConfig, DiningCronConfigError, isDiningCronEnabled, loadDiningCronConfig } from './dining-cron.config';
import type { DiningCronRunInput, DiningCronRunSummary } from './dining-cron.runner';
import type { DiningCronJobTrigger } from './dining-cron.types';

/*
 * Daily trigger for the dining refresh (default 13:00 Asia/Kolkata). Off unless ENABLE_DINING_CRON
 * is true. A bad schedule/time zone disables the cron with an error log instead of crashing the
 * service. A tick that fires while a job is still running is skipped here; the Mongo lock covers
 * other processes.
 */

export type DiningCronJobRunner = (input: DiningCronRunInput) => Promise<DiningCronRunSummary>;

export interface DiningCronScheduler {
  config: DiningCronConfig;
  // True when the daily schedule is registered (ENABLE_DINING_CRON=true with a valid config).
  // Manual trigger()/stopCurrent() work either way, so the admin panel can run dining on demand.
  scheduled: boolean;
  nextRun(): Date | null;
  isRunning(): boolean;
  // Runs a job now (same guards as the schedule). Resolves null when one is already in progress here.
  trigger(trigger?: DiningCronJobTrigger): Promise<DiningCronRunSummary | null>;
  // Aborts the currently running job (after its current scrape) WITHOUT touching the schedule.
  // Returns true when a job was running.
  stopCurrent(): boolean;
  // Stops the schedule, asks the running job to stop after its current scrape, and waits for it.
  stop(): Promise<void>;
}

export interface StartDiningCronSchedulerOptions {
  env?: NodeJS.ProcessEnv;
  runJob: DiningCronJobRunner;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  // Injectable for tests; defaults to node-cron.
  schedule?: (expression: string, fn: () => Promise<void>, options: { timezone: string; name: string; noOverlap: boolean }) => {
    stop(): void | Promise<void>;
    getNextRun(): Date | null;
  };
}

export function startDiningCronScheduler(options: StartDiningCronSchedulerOptions): DiningCronScheduler | null {
  const env = options.env ?? process.env;
  const logger = options.logger ?? console;

  const enabled = isDiningCronEnabled(env);

  let config: DiningCronConfig;
  try {
    config = loadDiningCronConfig(env);
  } catch (err) {
    if (!(err instanceof DiningCronConfigError)) throw err;
    if (enabled) {
      // An enabled-but-misconfigured cron fails loudly and leaves nothing running (old behavior).
      logger.error(`[dining-cron] Not scheduled: ${err.message}`);
      return null;
    }
    // Disabled cron with bad optional values: fall back to defaults so the manual
    // trigger (admin panel) still works.
    logger.warn(`[dining-cron] Ignoring invalid cron settings while disabled: ${err.message}`);
    config = { ...DINING_CRON_DEFAULTS };
  }

  if (!enabled) {
    logger.log('[dining-cron] Schedule disabled (set ENABLE_DINING_CRON=true to refresh dining menus daily). Manual trigger stays available.');
  }

  let current: { promise: Promise<DiningCronRunSummary | null>; controller: AbortController } | null = null;
  let stopped = false;

  const trigger = (kind: DiningCronJobTrigger = 'manual'): Promise<DiningCronRunSummary | null> => {
    if (stopped) return Promise.resolve(null);
    if (current) {
      logger.warn(`[dining-cron] ${kind} trigger ignored: a job is already running in this process`);
      return Promise.resolve(null);
    }
    const controller = new AbortController();
    const promise = options
      .runJob({ trigger: kind, config, signal: controller.signal })
      .catch(err => {
        logger.error(`[dining-cron] Job failed to run: ${(err as Error)?.message ?? err}`);
        return null;
      })
      .finally(() => {
        current = null;
      });
    current = { promise, controller };
    return promise;
  };

  const schedule = options.schedule ?? ((expression, fn, opts) => cron.schedule(expression, fn, opts));
  let task: { stop(): void | Promise<void>; getNextRun(): Date | null } | null = null;
  if (enabled) {
    task = schedule(
      config.schedule,
      async () => {
        await trigger('schedule');
        const next = task?.getNextRun();
        if (next) logger.log(`[dining-cron] Next run: ${next.toISOString()}`);
      },
      { timezone: config.timezone, name: 'dining-cron', noOverlap: true }
    );

    const next = task.getNextRun();
    logger.log(
      `[dining-cron] Enabled: "${config.schedule}" (${config.timezone})` + (next ? `, next run ${next.toISOString()}` : '') +
      `, concurrency ${config.concurrency}, max ${config.maxTargets} scrapes per job`
    );
    if (config.runOnStart) void trigger('startup');
  }

  return {
    config,
    scheduled: enabled,
    nextRun: () => (stopped || !task ? null : task.getNextRun()),
    isRunning: () => current !== null,
    trigger,
    stopCurrent() {
      if (!current) return false;
      logger.log('[dining-cron] Stop requested — aborting the running job after its current scrape.');
      current.controller.abort();
      return true;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      if (task) await task.stop();
      if (current) {
        logger.log('[dining-cron] Waiting for the running job to stop after its current scrape...');
        current.controller.abort();
        await current.promise;
      }
    },
  };
}
