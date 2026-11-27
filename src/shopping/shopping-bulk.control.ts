import * as path from 'path';
import { SITE_KEYS } from '../config/sites';
import { SHOPPING_BULK_LOCK_FILE, SHOPPING_BULK_STOP_FILE } from '../utils/stop-signal';
import { AutoLoopDeps, createAutoLoopController, intervalHoursOf, listOf, nodeCliCommand, parseNumberFields } from '../utils/auto-loop.control';

/**
 * Shopping bulk pipeline in 24/7 mode (POST /api/shopping/bulk/start | stop, GET /api/shopping/bulk/status):
 * one full pass of shopping-bulk.cli, wait SHOPPING_BULK_INTERVAL_HOURS, next pass … until stop. Every pass skips
 * products scraped within SHOPPING_BULK_FRESH_HOURS. See src/utils/auto-loop.control.ts for the loop itself.
 */

export interface AutoOptions {
  count?: number;
  categories?: string[];
  platforms?: string[];
  categoryConcurrency?: number;
  productConcurrency?: number;
  maxPages?: number;
  freshHours?: number;
  intervalHours?: number;
}

const LIMITS = {
  count: [1, 500], categoryConcurrency: [1, 10], productConcurrency: [1, 20],
  maxPages: [1, 200], freshHours: [0, 24 * 30], intervalHours: [0, 24 * 7],
} as const;

const EXIT_OUTCOME: Record<number, string> = { 0: 'finished (complete or partial — see the run report)', 1: 'failed', 2: 'skipped (another bulk run holds the lock)', 3: 'stopped', 130: 'stopped' };

export function parseAutoOptions(body: any): { options: AutoOptions } | { error: string } {
  const b = body && typeof body === 'object' ? body : {};
  const nums = parseNumberFields<AutoOptions>(b, LIMITS);
  if ('error' in nums) return nums;
  const options: AutoOptions = { ...nums.options };
  const platforms = listOf(b.platforms);
  const unknown = platforms.filter(p => !(SITE_KEYS as readonly string[]).includes(p));
  if (unknown.length) return { error: `Unknown platform(s): ${unknown.join(', ')} (known: ${SITE_KEYS.join(', ')})` };
  if (platforms.length) options.platforms = platforms;
  const categories = listOf(b.categories);
  if (categories.length) options.categories = categories;
  return { options };
}

/** CLI flags for one pass. Anything not given here comes from SHOPPING_BULK_* in the environment. */
export function cliArgsFor(o: AutoOptions): string[] {
  const a: string[] = [];
  if (o.categories?.length) a.push('--categories', o.categories.join(','));
  if (o.platforms?.length) a.push('--platforms', o.platforms.join(','));
  if (o.count !== undefined) a.push('--count', String(o.count));
  if (o.categoryConcurrency !== undefined) a.push('--category-concurrency', String(o.categoryConcurrency));
  if (o.productConcurrency !== undefined) a.push('--product-concurrency', String(o.productConcurrency));
  if (o.maxPages !== undefined) a.push('--max-pages', String(o.maxPages));
  if (o.freshHours !== undefined) a.push('--fresh-hours', String(o.freshHours));
  return a;
}

export function intervalHoursFrom(o: AutoOptions | undefined, env: NodeJS.ProcessEnv): number {
  return intervalHoursOf(o, env, 'SHOPPING_BULK_INTERVAL_HOURS');
}

export interface ControlDeps extends AutoLoopDeps {
  stopFile?: string;
  lockFile?: string;
}

export function createShoppingAutoController(deps: ControlDeps = {}) {
  return createAutoLoopController<AutoOptions>({
    name: 'shopping-bulk',
    // Ounass (via Scrape.do) sends headers above Node's 16 KB default
    command: () => nodeCliCommand(__dirname, 'shopping-bulk.cli', path.extname(__filename), ['--max-http-header-size=131072']),
    parseOptions: parseAutoOptions,
    argsFor: cliArgsFor,
    intervalEnv: 'SHOPPING_BULK_INTERVAL_HOURS',
    stopFiles: [deps.stopFile ?? SHOPPING_BULK_STOP_FILE],
    lockFiles: [deps.lockFile ?? SHOPPING_BULK_LOCK_FILE],
    exitOutcome: EXIT_OUTCOME,
    childEnv: { SHOPPING_BULK_TRIGGER: 'cron' },
  }, deps);
}

export type ShoppingAutoController = ReturnType<typeof createShoppingAutoController>;

let singleton: ShoppingAutoController | null = null;
export function shoppingAuto(): ShoppingAutoController {
  return (singleton ??= createShoppingAutoController());
}
