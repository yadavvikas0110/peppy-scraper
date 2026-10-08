import type { ScrapeDoClient } from '../shared/scrapedo/scrapedo.client';
import { isScrapeDoError } from '../shared/scrapedo/scrapedo.errors';
import type { ScrapeDoResponse } from '../shared/scrapedo/scrapedo.types';
import { redactMongoUri } from '../shared/db/mongo';
import { DiningRepositories, InactiveDecision, persistMappedMenu } from './dining.persistence';
import {
  DINING_LOCALES,
  DiningLocale,
  DiningPlatform,
  DiningScrapeRunCounts,
  DiningScrapeRunError,
  DiningScrapeRunFetch,
  DiningScrapeRunTrigger,
} from './dining.types';
import { DiningValidationError, validateRestaurant } from './dining.validator';
import { DiningMappedMenu, DiningMappingError, DiningMenuCompleteness } from './platforms/platform.mapper';
import { DiningPlatformRegistry, getDiningPlatformModule, getSupportedDiningPlatforms } from './platforms/platform.registry';
import { PLATFORM_REJECTION_CODES } from './platforms/platform.types';
import { applyUpdate } from './repositories/document-update';
import { DiningIdentityDowngradeError, issuesMessage } from './repositories/repository.types';
import { buildRestaurantUpdate } from './repositories/restaurant.repository';
import {
  DiningRunConflictError,
  MAX_RUN_ERRORS,
  sanitizeFetchMetadata,
  sanitizeRunMessage,
} from './repositories/scrape-run.repository';

/*
 * Dining scrape orchestrator, independent of Express (callable from HTTP, cron, queue, CLI):
 *
 *   validate → registry → run(running) → fetch options → Scrape.do → parse → map
 *   → validate canonical restaurant → persist (restaurant → categories → items) → run(finished)
 *
 * Platform specifics live behind the registry (adapter + mapper); nothing here knows Deliveroo.
 */

// ─── Request validation ──────────────────────────────────────────────────────

export interface DiningScrapeRequest {
  platform: DiningPlatform;
  locale: DiningLocale;
  // Normalized by the platform adapter (locale path segment ensured).
  targetUrl: string;
  dryRun: boolean;
}

export type DiningRequestErrorCode = 'INVALID_REQUEST' | 'UNSUPPORTED_PLATFORM' | 'UNSUPPORTED_LOCALE';

export interface DiningRequestFieldError {
  field: string;
  code: DiningRequestErrorCode;
  message: string;
}

export type DiningRequestValidation =
  | { ok: true; value: DiningScrapeRequest }
  | { ok: false; code: DiningRequestErrorCode; errors: DiningRequestFieldError[] };

const ALLOWED_FIELDS = new Set(['platform', 'locale', 'targetUrl', 'dryRun']);
const MAX_URL_LENGTH = 2048;

export function validateDiningScrapeRequest(
  body: unknown,
  registry: DiningPlatformRegistry = getDiningPlatformModule
): DiningRequestValidation {
  const errors: DiningRequestFieldError[] = [];
  const invalid = (field: string, message: string) => errors.push({ field, code: 'INVALID_REQUEST', message });

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, code: 'INVALID_REQUEST', errors: [{ field: 'body', code: 'INVALID_REQUEST', message: 'must be a JSON object' }] };
  }
  const input = body as Record<string, unknown>;
  for (const key of Object.keys(input)) if (!ALLOWED_FIELDS.has(key)) invalid(key, 'is not an allowed field');

  const { platform, locale, targetUrl, dryRun } = input;
  const module = typeof platform === 'string' ? registry(platform) : undefined;
  if (typeof platform !== 'string' || platform.trim() === '') invalid('platform', 'is required');
  else if (!module) {
    errors.push({ field: 'platform', code: 'UNSUPPORTED_PLATFORM', message: `must be one of: ${getSupportedDiningPlatforms().join(', ')}` });
  }

  const localeOk = typeof locale === 'string' && (DINING_LOCALES as readonly string[]).includes(locale);
  if (typeof locale !== 'string' || locale.trim() === '') invalid('locale', 'is required');
  else if (!localeOk) errors.push({ field: 'locale', code: 'UNSUPPORTED_LOCALE', message: `must be one of: ${DINING_LOCALES.join(', ')}` });

  let normalizedUrl: string | undefined;
  if (typeof targetUrl !== 'string' || targetUrl.trim() === '') invalid('targetUrl', 'is required');
  else if (targetUrl.length > MAX_URL_LENGTH) invalid('targetUrl', `must be at most ${MAX_URL_LENGTH} characters`);
  else if (module) {
    const url = targetUrl.trim();
    if (!module.adapter.matchesUrl(url)) invalid('targetUrl', `must be a ${platform} restaurant menu URL`);
    else if (localeOk) {
      const urlLocale = module.adapter.detectLocale(url, locale as DiningLocale);
      if (urlLocale !== locale) invalid('targetUrl', `is a "${urlLocale}" page but locale is "${locale}"`);
      else normalizedUrl = module.adapter.toLocaleUrl(url, locale as DiningLocale);
    }
  }

  if (dryRun !== undefined && typeof dryRun !== 'boolean') invalid('dryRun', 'must be a boolean');

  if (errors.length) {
    const code = errors.some(e => e.code === 'UNSUPPORTED_PLATFORM')
      ? 'UNSUPPORTED_PLATFORM'
      : errors.some(e => e.code === 'UNSUPPORTED_LOCALE') ? 'UNSUPPORTED_LOCALE' : 'INVALID_REQUEST';
    return { ok: false, code, errors };
  }
  return {
    ok: true,
    value: { platform: platform as DiningPlatform, locale: locale as DiningLocale, targetUrl: normalizedUrl as string, dryRun: dryRun === true },
  };
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export type DiningScrapeStage = 'validation' | 'lock' | 'setup' | 'fetch' | 'parse' | 'map' | 'validate' | 'persist';

// Messages are safe for API responses: no stack traces, tokens or credential-bearing URLs.
export class DiningScrapeError extends Error {
  readonly stage: DiningScrapeStage;
  readonly code: string;
  readonly httpStatus: number;
  readonly runId?: string;
  readonly details?: unknown;

  constructor(init: { stage: DiningScrapeStage; code: string; httpStatus: number; message: string; runId?: string; details?: unknown }) {
    super(sanitizeRunMessage(init.message));
    this.name = 'DiningScrapeError';
    this.stage = init.stage;
    this.code = init.code;
    this.httpStatus = init.httpStatus;
    this.runId = init.runId;
    this.details = init.details;
  }
}

export function isDiningScrapeError(err: unknown): err is DiningScrapeError {
  return err instanceof DiningScrapeError;
}

// ─── Context & result ────────────────────────────────────────────────────────

export interface DiningScrapeContext {
  scrapeDo: Pick<ScrapeDoClient, 'fetchHtml'>;
  repositories: DiningRepositories | (() => Promise<DiningRepositories>);
  registry?: DiningPlatformRegistry;
  trigger?: DiningScrapeRunTrigger;
  now?: () => Date;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  // false → never mark unseen items inactive for this call.
  allowDeactivation?: boolean;
}

export interface DiningScrapeResult {
  runId: string;
  platform: DiningPlatform;
  locale: DiningLocale;
  targetUrl: string;
  status: 'succeeded' | 'partial';
  dryRun: boolean;
  // Undefined for a dry run of a restaurant that is not stored yet.
  restaurantId?: string;
  counts: DiningScrapeRunCounts;
  fetch: DiningScrapeRunFetch;
  durationMs: number;
  completeness: DiningMenuCompleteness;
  inactive: InactiveDecision;
  warnings: { total: number; byCode: Record<string, number> };
  errors: DiningScrapeRunError[];
}

// ─── Orchestration ───────────────────────────────────────────────────────────

// In-process guard (the scrape-run unique index covers multiple processes).
const activeTargets = new Set<string>();

function fetchMetadata(response: ScrapeDoResponse): DiningScrapeRunFetch {
  return sanitizeFetchMetadata({
    statusCode: response.statusCode,
    initialStatusCode: response.initialStatusCode,
    finalUrl: response.finalUrl,
    requestCost: response.requestCost,
    remainingCredits: response.remainingCredits,
    attempts: response.attempts,
    durationMs: response.durationMs,
  });
}

function countByCode(menu: DiningMappedMenu): Record<string, number> {
  const out: Record<string, number> = {};
  for (const w of menu.warnings) out[w.code] = (out[w.code] ?? 0) + 1;
  return out;
}

// Step 8: the canonical restaurant must be valid on its own; categories/items are validated
// record-by-record by the repositories (invalid ones are rejected, the rest persist).
function validateCanonicalRestaurant(menu: DiningMappedMenu, locale: DiningLocale, runId: string, now: Date): string | null {
  const doc = applyUpdate(null, buildRestaurantUpdate(menu.restaurant, { locale, runId, now }));
  const check = validateRestaurant(doc);
  return check.valid ? null : issuesMessage(check.issues);
}

async function resolveRepositories(context: DiningScrapeContext): Promise<DiningRepositories> {
  try {
    return typeof context.repositories === 'function' ? await context.repositories() : context.repositories;
  } catch (err) {
    throw new DiningScrapeError({
      stage: 'setup', code: 'DATABASE_UNAVAILABLE', httpStatus: 503,
      message: `Dining database is unavailable: ${redactMongoUri(String((err as Error)?.message ?? err))}`,
    });
  }
}

export async function runDiningScrape(input: unknown, context: DiningScrapeContext): Promise<DiningScrapeResult> {
  const now = context.now ?? (() => new Date());
  const logger = context.logger ?? console;
  const registry = context.registry ?? getDiningPlatformModule;

  // 1. Validate
  const validation = validateDiningScrapeRequest(input, registry);
  if (!validation.ok) {
    throw new DiningScrapeError({ stage: 'validation', code: validation.code, httpStatus: 400, message: 'Invalid scrape request', details: validation.errors });
  }
  const request = validation.value;

  // 2. Platform module
  const { adapter, mapper } = registry(request.platform)!;

  const lockKey = `${request.platform}|${request.locale}|${request.targetUrl}`;
  if (activeTargets.has(lockKey)) {
    throw new DiningScrapeError({ stage: 'lock', code: 'RUN_IN_PROGRESS', httpStatus: 409, message: 'A scrape for this platform, locale and URL is already running' });
  }
  activeTargets.add(lockKey);

  try {
    const repos = await resolveRepositories(context);

    // 3. Scrape run (also the cross-process lock)
    let runId: string;
    let startedAt: Date;
    try {
      const run = await repos.runs.createRunning({
        platform: request.platform,
        locale: request.locale,
        targetType: 'restaurant',
        targetUrl: request.targetUrl,
        trigger: context.trigger ?? 'manual',
        dryRun: request.dryRun,
      }, now());
      runId = run.runId;
      startedAt = run.startedAt;
    } catch (err) {
      if (err instanceof DiningRunConflictError) {
        throw new DiningScrapeError({ stage: 'lock', code: 'RUN_IN_PROGRESS', httpStatus: 409, message: err.message, runId: err.runningRunId });
      }
      throw new DiningScrapeError({ stage: 'setup', code: 'RUN_CREATE_FAILED', httpStatus: 500, message: `Could not create scrape run: ${redactMongoUri(String((err as Error)?.message))}` });
    }

    let fetch: DiningScrapeRunFetch | undefined;
    const fail = async (stage: DiningScrapeStage, code: string, httpStatus: number, message: string, details?: unknown) => {
      const error = new DiningScrapeError({ stage, code, httpStatus, message, runId, details });
      try {
        await repos.runs.finishRun(runId, { status: 'failed', errors: [{ stage, code, message: error.message }], fetch }, now());
      } catch (finishErr) {
        logger.error(`[dining] Could not close run ${runId}: ${sanitizeRunMessage((finishErr as Error)?.message)}`);
      }
      logger.warn(`[dining] Run ${runId} failed at ${stage} (${code}): ${error.message}`);
      return error;
    };

    // 4–5. Platform fetch options → generic Scrape.do client
    let response: ScrapeDoResponse;
    try {
      response = await context.scrapeDo.fetchHtml(request.targetUrl, adapter.getFetchOptions(request.targetUrl, request.locale));
    } catch (err) {
      if (isScrapeDoError(err)) {
        fetch = sanitizeFetchMetadata({ statusCode: err.statusCode, initialStatusCode: err.initialStatusCode, attempts: err.attempts });
        const status = err.category === 'config' ? 503 : 502;
        throw await fail('fetch', `SCRAPE_DO_${err.category.toUpperCase()}`, status, err.message);
      }
      throw await fail('fetch', 'FETCH_FAILED', 502, 'The page could not be fetched');
    }
    fetch = fetchMetadata(response);
    logger.log(
      `[dining] ${request.platform} ${request.locale} run ${runId}: fetched status=${fetch.statusCode ?? 'n/a'} ` +
      `cost=${fetch.requestCost ?? 'n/a'} remaining=${fetch.remainingCredits ?? 'n/a'} attempts=${fetch.attempts ?? 'n/a'}`
    );
    await repos.runs.recordFetch(runId, fetch, now()).catch(err =>
      logger.warn(`[dining] Could not record fetch metadata for ${runId}: ${sanitizeRunMessage((err as Error)?.message)}`)
    );

    // 6. Parse
    let parsed: unknown;
    try {
      parsed = adapter.parse(response.html, { locale: request.locale, sourceUrl: request.targetUrl });
    } catch (err) {
      throw await fail('parse', 'PARSE_FAILED', 422, `The page could not be parsed: ${(err as Error)?.message ?? 'unknown error'}`);
    }

    // 7. Map
    let menu: DiningMappedMenu;
    try {
      menu = mapper.map(parsed);
    } catch (err) {
      if (err instanceof DiningMappingError) throw await fail('map', err.code, 422, err.message);
      throw await fail('map', 'MAPPING_FAILED', 500, `Mapping failed: ${(err as Error)?.message ?? 'unknown error'}`);
    }
    if (menu.items.length === 0) {
      throw await fail('parse', 'NO_MENU_ITEMS', 422, 'No menu items could be extracted from the page', { warnings: countByCode(menu) });
    }

    // 8. Validate canonical restaurant
    const restaurantProblem = validateCanonicalRestaurant(menu, request.locale, runId, now());
    if (restaurantProblem) throw await fail('validate', 'INVALID_RESTAURANT', 422, `Restaurant failed validation: ${restaurantProblem}`);

    // 9. Persist (restaurant → categories → items → guarded inactive marking)
    let persisted;
    try {
      persisted = await persistMappedMenu(repos, menu, {
        locale: request.locale,
        runId,
        now: now(),
        dryRun: request.dryRun,
        allowDeactivation: context.allowDeactivation,
      });
    } catch (err) {
      if (err instanceof DiningValidationError) throw await fail('validate', 'INVALID_RESTAURANT', 422, err.message);
      if (err instanceof DiningIdentityDowngradeError) throw await fail('persist', 'IDENTITY_DOWNGRADE', 409, err.message);
      throw await fail('persist', 'PERSISTENCE_FAILED', 500, `Saving the menu failed: ${redactMongoUri(String((err as Error)?.message ?? err))}`);
    }

    // 10. Finish run
    const errors: DiningScrapeRunError[] = [
      ...menu.warnings
        .filter(w => PLATFORM_REJECTION_CODES.has(w.code))
        .map(w => ({ stage: 'map', code: w.code, message: `${w.scope}${w.itemIndex !== undefined ? ` #${w.itemIndex}` : ''}: ${w.message}` })),
      ...persisted.rejected.map(r => ({ stage: 'persist', code: r.code, message: `${r.entity} ${r.sourceKey}: ${r.message}` })),
    ].slice(0, MAX_RUN_ERRORS);
    const counts = persisted.counts;
    const status = counts.itemsRejected > 0 || counts.categoriesRejected > 0 ? 'partial' : 'succeeded';

    const finished = await repos.runs.finishRun(runId, { status, counts, errors, fetch }, now()).catch(err => {
      logger.error(`[dining] Could not close run ${runId}: ${sanitizeRunMessage((err as Error)?.message)}`);
      return null;
    });

    logger.log(
      `[dining] Run ${runId} ${status}${request.dryRun ? ' (dry run)' : ''}: items created=${counts.itemsCreated} ` +
      `updated=${counts.itemsUpdated} unchanged=${counts.itemsUnchanged} rejected=${counts.itemsRejected} inactive=${counts.itemsMarkedInactive}`
    );

    // 11. Result
    return {
      runId,
      platform: request.platform,
      locale: request.locale,
      targetUrl: request.targetUrl,
      status,
      dryRun: request.dryRun,
      restaurantId: request.dryRun && counts.restaurantsCreated === 1 ? undefined : persisted.restaurantId,
      counts,
      fetch,
      durationMs: finished?.durationMs ?? Math.max(0, now().getTime() - startedAt.getTime()),
      completeness: menu.completeness,
      inactive: persisted.inactive,
      warnings: { total: menu.warnings.length, byCode: countByCode(menu) },
      errors: errors.slice(0, 20),
    };
  } finally {
    activeTargets.delete(lockKey);
  }
}
