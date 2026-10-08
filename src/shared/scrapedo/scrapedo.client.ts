import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import { Semaphore } from '../../utils/semaphore';
import { getScrapeDoConfig, ScrapeDoConfig } from './scrapedo.config';
import { ScrapeDoError, isScrapeDoError, maskSecrets } from './scrapedo.errors';
import {
  ScrapeDoHeaderMode,
  ScrapeDoJsonPayload,
  ScrapeDoRequestOptions,
  ScrapeDoResponse,
  ScrapeDoTargetHeaders,
} from './scrapedo.types';

export type ScrapeDoHttp = (config: AxiosRequestConfig) => Promise<AxiosResponse<unknown>>;

export interface ScrapeDoClientDeps {
  http?: ScrapeDoHttp;
  sleep?: (ms: number) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  logger?: Pick<Console, 'log' | 'warn'>;
}

export interface ScrapeDoClient {
  fetchHtml(targetUrl: string, options?: ScrapeDoRequestOptions): Promise<ScrapeDoResponse>;
}

// ─── Limits (from Scrape.do documentation) ───────────────────────────────────

const SCRAPE_DO_TIMEOUT = { min: 5000, max: 120000, default: 60000 };
const CUSTOM_WAIT = { min: 0, max: 35000 };
const SESSION_ID = { min: 0, max: 1000000 };
const CLIENT_MAX_RETRIES = { min: 0, max: 5 };

const HTTP_TIMEOUT_MARGIN_MS = 10000;
const BACKOFF_BASE_MS = 2000;
const BACKOFF_MAX_MS = 30000;
const BODY_SNIPPET_LENGTH = 200;

const HEADER_MODE_PARAM: Record<ScrapeDoHeaderMode, string> = {
  custom: 'customHeaders',
  extra: 'extraHeaders',
  forward: 'forwardHeaders',
};

const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

// ─── Validation ──────────────────────────────────────────────────────────────

function configError(message: string): ScrapeDoError {
  return new ScrapeDoError({ category: 'config', message });
}

function assertInt(name: string, value: number | undefined, min: number, max: number): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw configError(`${name} must be an integer between ${min} and ${max}`);
  }
}

function validateRequest(targetUrl: string, options: ScrapeDoRequestOptions): void {
  if (typeof targetUrl !== 'string' || targetUrl.trim() === '') {
    throw configError('targetUrl is required');
  }
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    throw configError('targetUrl must be an absolute URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw configError('targetUrl must use http or https');
  }

  assertInt('timeout', options.timeout, SCRAPE_DO_TIMEOUT.min, SCRAPE_DO_TIMEOUT.max);
  assertInt('customWait', options.customWait, CUSTOM_WAIT.min, CUSTOM_WAIT.max);
  assertInt('sessionId', options.sessionId, SESSION_ID.min, SESSION_ID.max);
  assertInt('retryTimeout', options.retryTimeout, 1, SCRAPE_DO_TIMEOUT.max);
  assertInt('client.maxRetries', options.client?.maxRetries, CLIENT_MAX_RETRIES.min, CLIENT_MAX_RETRIES.max);
  assertInt('client.httpTimeoutMs', options.client?.httpTimeoutMs, 1000, 600000);

  if (options.geoCode !== undefined && !/^[a-z]{2}$/i.test(options.geoCode)) {
    throw configError('geoCode must be a 2-letter country code');
  }
  if (options.returnJSON && !options.render) {
    throw configError('returnJSON requires render=true');
  }
  if (options.playWithBrowser !== undefined) {
    if (!options.render) throw configError('playWithBrowser requires render=true');
    if (!Array.isArray(options.playWithBrowser) || options.playWithBrowser.length === 0) {
      throw configError('playWithBrowser must be a non-empty array of actions');
    }
  }
  if (options.targetHeaders) {
    const { mode, headers } = options.targetHeaders;
    if (!HEADER_MODE_PARAM[mode]) throw configError('targetHeaders.mode must be custom, extra or forward');
    for (const [name, value] of Object.entries(headers ?? {})) {
      if (!HEADER_NAME_RE.test(name)) throw configError('targetHeaders contains an invalid header name');
      if (typeof value !== 'string' || /[\r\n]/.test(value)) {
        throw configError('targetHeaders values must be single-line strings');
      }
    }
  }
}

// ─── Request construction ────────────────────────────────────────────────────

export function buildScrapeDoUrl(
  config: Pick<ScrapeDoConfig, 'token' | 'baseUrl'>,
  targetUrl: string,
  options: ScrapeDoRequestOptions = {}
): string {
  const params: Array<[string, string]> = [
    ['token', config.token],
    ['url', targetUrl],
  ];
  const add = (key: string, value: string | number | boolean | undefined) => {
    if (value !== undefined) params.push([key, String(value)]);
  };

  add('render', options.render);
  add('super', options.super);
  add('geoCode', options.geoCode?.toLowerCase());
  add('waitUntil', options.waitUntil);
  add('customWait', options.customWait);
  add('waitSelector', options.waitSelector);
  add('blockResources', options.blockResources);
  add('device', options.device);
  add('sessionId', options.sessionId);
  add('timeout', options.timeout);
  add('retryTimeout', options.retryTimeout);
  add('disableRetry', options.disableRetry);
  add('returnJSON', options.returnJSON);
  if (options.playWithBrowser) add('playWithBrowser', JSON.stringify(options.playWithBrowser));
  add('setCookies', options.setCookies);
  if (options.targetHeaders) add(HEADER_MODE_PARAM[options.targetHeaders.mode], true);

  const query = params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return `${config.baseUrl}?${query}`;
}

export function buildTargetHeaders(target?: ScrapeDoTargetHeaders): Record<string, string> {
  if (!target) return {};
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(target.headers ?? {})) {
    const key = target.mode === 'extra' && !/^sd-/i.test(name) ? `sd-${name}` : name;
    out[key] = value;
  }
  return out;
}

// ─── Response handling ───────────────────────────────────────────────────────

function readHeader(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() !== wanted || value === undefined || value === null) continue;
    return Array.isArray(value) ? value.join(', ') : String(value);
  }
  return undefined;
}

function readNumberHeader(headers: unknown, name: string): number | undefined {
  const raw = readHeader(headers, name);
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function bodyToString(data: unknown): string {
  if (data === undefined || data === null) return '';
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

function optionalArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

// Lenient by design: a body that is not a JSON object leaves `json` undefined instead of failing.
export function parseJsonPayload(body: string): ScrapeDoJsonPayload | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const raw = parsed as Record<string, unknown>;
  return {
    content: typeof raw.content === 'string' ? raw.content : undefined,
    networkRequests: optionalArray(raw.networkRequests),
    actionResults: optionalArray(raw.actionResults),
    frames: optionalArray(raw.frames),
    screenShots: optionalArray(raw.screenShots),
    raw,
  };
}

function parseRetryAfterMs(headers: unknown): number | undefined {
  const seconds = readNumberHeader(headers, 'retry-after');
  return seconds !== undefined && seconds >= 0 ? seconds * 1000 : undefined;
}

export function classifyResponse(
  status: number,
  headers: unknown,
  body: string,
  secrets: Array<string | undefined>
): ScrapeDoError | null {
  if (status >= 200 && status < 300) return null;

  const initialStatusCode = readNumberHeader(headers, 'scrape.do-initial-status-code');
  // Scrape.do-generated errors carry no initial target status; target-derived ones do.
  const fromTarget = initialStatusCode !== undefined;
  const snippet = maskSecrets(body.slice(0, BODY_SNIPPET_LENGTH).replace(/\s+/g, ' ').trim(), secrets);
  const detail = !fromTarget && snippet ? `: ${snippet}` : '';
  const base = { statusCode: status, initialStatusCode };

  if (status === 401 && !fromTarget) {
    if (/credit|subscription|suspend|quota|expired/i.test(body)) {
      return new ScrapeDoError({
        ...base,
        category: 'quota',
        message: `Scrape.do rejected the request: no credits or subscription inactive (401)${detail}`,
      });
    }
    return new ScrapeDoError({ ...base, category: 'auth', message: `Scrape.do authentication failed (401)${detail}` });
  }

  if (status === 429) {
    const retryAfterMs = parseRetryAfterMs(headers);
    if (!fromTarget) {
      return new ScrapeDoError({
        ...base,
        category: 'quota',
        retryable: true,
        retryAfterMs,
        message: `Scrape.do concurrency limit exceeded (429)${detail}`,
      });
    }
    return new ScrapeDoError({
      ...base,
      category: 'blocked',
      retryable: true,
      retryAfterMs,
      message: 'Target site rate-limited the request (429)',
    });
  }

  if (status === 400 && !fromTarget) {
    return new ScrapeDoError({ ...base, category: 'config', message: `Scrape.do rejected the request parameters (400)${detail}` });
  }

  if (status === 403) {
    return new ScrapeDoError({ ...base, category: 'blocked', message: `Request was blocked (403)${detail}` });
  }

  if (status >= 400 && status < 500) {
    return new ScrapeDoError({ ...base, category: 'target_4xx', message: `Target responded with ${status}${detail}` });
  }

  if (status >= 500) {
    return new ScrapeDoError({ ...base, category: 'target_5xx', message: `Scrape.do/target failure (${status})${detail}` });
  }

  return new ScrapeDoError({ ...base, category: 'response', message: `Unexpected Scrape.do response status ${status}` });
}

export function classifyThrown(err: unknown, secrets: Array<string | undefined>): ScrapeDoError {
  if (isScrapeDoError(err)) return err;

  const e = (err ?? {}) as { code?: unknown; message?: unknown };
  const code = typeof e.code === 'string' ? e.code : undefined;
  const message = maskSecrets(typeof e.message === 'string' ? e.message : String(err), secrets);

  const isTimeout =
    code === 'ETIMEDOUT' ||
    code === 'ESOCKETTIMEDOUT' ||
    (code === 'ECONNABORTED' && /timeout/i.test(message)) ||
    /timeout|timed out/i.test(message);

  if (isTimeout) {
    return new ScrapeDoError({ category: 'timeout', code, message: `Scrape.do request timed out: ${message}` });
  }
  return new ScrapeDoError({
    category: 'network',
    code,
    message: `Network error contacting Scrape.do (${code ?? 'unknown'}): ${message}`,
  });
}

function backoffDelay(attempt: number, retryAfterMs?: number): number {
  const exponential = BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
  return Math.min(BACKOFF_MAX_MS, Math.max(exponential, retryAfterMs ?? 0));
}

function safeHost(targetUrl: string): string {
  try {
    return new URL(targetUrl).host;
  } catch {
    return 'invalid-url';
  }
}

// ─── Client ──────────────────────────────────────────────────────────────────

export function createScrapeDoClient(deps: ScrapeDoClientDeps = {}): ScrapeDoClient {
  const http: ScrapeDoHttp = deps.http ?? (config => axios.request(config));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const logger = deps.logger ?? console;
  // Own limiter instance: Module 2 never shares Module 1's Bright Data semaphores.
  let limiter: Semaphore | null = null;

  async function fetchHtml(targetUrl: string, options: ScrapeDoRequestOptions = {}): Promise<ScrapeDoResponse> {
    const config = getScrapeDoConfig(deps.env ?? process.env);
    validateRequest(targetUrl, options);

    if (!limiter) limiter = new Semaphore(config.concurrency);
    const activeLimiter = limiter;

    const secrets = [config.token];
    const maxAttempts = (options.client?.maxRetries ?? config.maxRetries) + 1;
    const httpTimeoutMs =
      options.client?.httpTimeoutMs ??
      Math.max(config.timeoutMs, (options.timeout ?? SCRAPE_DO_TIMEOUT.default) + HTTP_TIMEOUT_MARGIN_MS);

    const requestConfig: AxiosRequestConfig = {
      method: 'GET',
      url: buildScrapeDoUrl(config, targetUrl, options),
      headers: buildTargetHeaders(options.targetHeaders),
      timeout: httpTimeoutMs,
      responseType: 'text',
      transformResponse: [(data: unknown) => data],
      validateStatus: () => true,
    };

    const host = safeHost(targetUrl);
    const startedAt = Date.now();

    for (let attempt = 1; ; attempt++) {
      try {
        // The slot is held only for the HTTP call, never during backoff sleeps.
        const response = await activeLimiter.wrap(() => http(requestConfig));
        const body = bodyToString(response.data);

        const failure = classifyResponse(response.status, response.headers, body, secrets);
        if (failure) throw failure;
        if (body.trim() === '') {
          throw new ScrapeDoError({
            category: 'response',
            statusCode: response.status,
            message: 'Scrape.do returned an empty body',
          });
        }

        const resolvedUrl = readHeader(response.headers, 'scrape.do-resolved-url');
        const result: ScrapeDoResponse = {
          html: body,
          statusCode: response.status,
          initialStatusCode: readNumberHeader(response.headers, 'scrape.do-initial-status-code'),
          finalUrl: resolvedUrl ?? targetUrl,
          targetUrl: readHeader(response.headers, 'scrape.do-target-url') ?? targetUrl,
          resolvedUrl,
          contentType: readHeader(response.headers, 'content-type'),
          requestCost: readNumberHeader(response.headers, 'scrape.do-request-cost'),
          remainingCredits: readNumberHeader(response.headers, 'scrape.do-remaining-credits'),
          attempts: attempt,
          durationMs: Date.now() - startedAt,
        };
        if (options.returnJSON) {
          const json = parseJsonPayload(body);
          if (json) result.json = json;
        }

        logger.log(
          `[scrapedo] ${host} → ${result.statusCode} in ${result.durationMs}ms ` +
          `(attempts: ${attempt}, cost: ${result.requestCost ?? 'n/a'})`
        );
        return result;
      } catch (raw) {
        const err = classifyThrown(raw, secrets);
        err.attempts = attempt;
        const label = `${err.category}${err.statusCode ? ` ${err.statusCode}` : ''}`;

        if (!err.retryable || attempt >= maxAttempts) {
          logger.warn(`[scrapedo] ${host} failed after ${attempt} attempt(s) (${label}): ${err.message}`);
          throw err;
        }

        const delay = backoffDelay(attempt, err.retryAfterMs);
        logger.warn(`[scrapedo] ${host} attempt ${attempt}/${maxAttempts} failed (${label}) — retrying in ${delay}ms`);
        await sleep(delay);
      }
    }
  }

  return { fetchHtml };
}

let defaultClient: ScrapeDoClient | null = null;

export function fetchHtml(targetUrl: string, options?: ScrapeDoRequestOptions): Promise<ScrapeDoResponse> {
  if (!defaultClient) defaultClient = createScrapeDoClient();
  return defaultClient.fetchHtml(targetUrl, options);
}
