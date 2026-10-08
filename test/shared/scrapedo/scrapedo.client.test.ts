/// <reference types="node" />
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import {
  buildScrapeDoUrl,
  createScrapeDoClient,
  ScrapeDoHttp,
} from '../../../src/shared/scrapedo/scrapedo.client';
import { getScrapeDoConfig, SCRAPE_DO_DEFAULTS } from '../../../src/shared/scrapedo/scrapedo.config';
import { ScrapeDoError, maskSecrets } from '../../../src/shared/scrapedo/scrapedo.errors';

const TOKEN = 'tok_SECRET_1234567890';
const TARGET = 'https://example.com/menu?id=42&lang=en';

type FakeReply =
  | { status: number; data?: unknown; headers?: Record<string, string> }
  | { throw: unknown };

function fakeHttp(replies: FakeReply[]) {
  const calls: AxiosRequestConfig[] = [];
  const http: ScrapeDoHttp = async (config) => {
    calls.push(config);
    const reply = replies.shift();
    if (!reply) throw new Error('fakeHttp: no more replies queued');
    if ('throw' in reply) throw reply.throw;
    return {
      status: reply.status,
      data: reply.data ?? '',
      headers: reply.headers ?? {},
      statusText: '',
      config,
    } as unknown as AxiosResponse<unknown>;
  };
  return { http, calls };
}

function setup(replies: FakeReply[], env: NodeJS.ProcessEnv = {}) {
  const { http, calls } = fakeHttp(replies);
  const sleeps: number[] = [];
  const logs: string[] = [];
  const client = createScrapeDoClient({
    http,
    env: { SCRAPE_DO_TOKEN: TOKEN, ...env },
    sleep: async (ms) => { sleeps.push(ms); },
    logger: {
      log: (...args: unknown[]) => { logs.push(args.join(' ')); },
      warn: (...args: unknown[]) => { logs.push(args.join(' ')); },
    },
  });
  return { client, calls, sleeps, logs };
}

async function rejection(promise: Promise<unknown>): Promise<ScrapeDoError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof ScrapeDoError, `expected ScrapeDoError, got ${String(err)}`);
    return err;
  }
  assert.fail('expected promise to reject');
}

const HTML = '<html><body><h1>ok</h1></body></html>';

describe('configuration', () => {
  test('missing token raises a config error only when the client is used', async () => {
    const { http, calls } = fakeHttp([]);
    const client = createScrapeDoClient({ http, env: {} });
    const err = await rejection(client.fetchHtml(TARGET));
    assert.equal(err.category, 'config');
    assert.equal(err.retryable, false);
    assert.match(err.message, /SCRAPE_DO_TOKEN/);
    assert.equal(calls.length, 0);
  });

  test('defaults apply when only the token is set', () => {
    const config = getScrapeDoConfig({ SCRAPE_DO_TOKEN: TOKEN });
    assert.equal(config.baseUrl, SCRAPE_DO_DEFAULTS.baseUrl);
    assert.equal(config.timeoutMs, SCRAPE_DO_DEFAULTS.timeoutMs);
    assert.equal(config.concurrency, SCRAPE_DO_DEFAULTS.concurrency);
    assert.equal(config.maxRetries, SCRAPE_DO_DEFAULTS.maxRetries);
  });

  test('invalid numeric env values raise config errors', () => {
    assert.throws(
      () => getScrapeDoConfig({ SCRAPE_DO_TOKEN: TOKEN, SCRAPE_DO_MAX_RETRIES: '50' }),
      (e: unknown) => e instanceof ScrapeDoError && e.category === 'config'
    );
    assert.throws(
      () => getScrapeDoConfig({ SCRAPE_DO_TOKEN: TOKEN, SCRAPE_DO_CONCURRENCY: 'abc' }),
      (e: unknown) => e instanceof ScrapeDoError && e.category === 'config'
    );
  });

  test('invalid request options fail before any HTTP call', async () => {
    const { client, calls } = setup([]);
    const err = await rejection(client.fetchHtml(TARGET, { render: true, customWait: 50000 }));
    assert.equal(err.category, 'config');
    const err2 = await rejection(client.fetchHtml(TARGET, { returnJSON: true }));
    assert.equal(err2.category, 'config');
    const err3 = await rejection(client.fetchHtml('ftp://example.com/file'));
    assert.equal(err3.category, 'config');
    assert.equal(calls.length, 0);
  });
});

describe('success', () => {
  test('returns html and metadata on 200', async () => {
    const { client, calls, sleeps } = setup([{ status: 200, data: HTML }]);
    const res = await client.fetchHtml(TARGET);
    assert.equal(res.html, HTML);
    assert.equal(res.statusCode, 200);
    assert.equal(res.attempts, 1);
    assert.equal(res.finalUrl, TARGET);
    assert.equal(res.targetUrl, TARGET);
    assert.equal(typeof res.durationMs, 'number');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].responseType, 'text');
    assert.deepEqual(sleeps, []);
  });

  test('extracts Scrape.do response headers case-insensitively', async () => {
    const { client } = setup([{
      status: 200,
      data: HTML,
      headers: {
        'scrape.do-request-cost': '25',
        'Scrape.do-Remaining-Credits': '9975',
        'scrape.do-initial-status-code': '301',
        'scrape.do-resolved-url': 'https://example.com/menu/final',
        'scrape.do-target-url': TARGET,
        'content-type': 'text/html; charset=utf-8',
      },
    }]);
    const res = await client.fetchHtml(TARGET);
    assert.equal(res.requestCost, 25);
    assert.equal(res.remainingCredits, 9975);
    assert.equal(res.initialStatusCode, 301);
    assert.equal(res.resolvedUrl, 'https://example.com/menu/final');
    assert.equal(res.finalUrl, 'https://example.com/menu/final');
    assert.equal(res.targetUrl, TARGET);
    assert.equal(res.contentType, 'text/html; charset=utf-8');
  });

  test('missing or malformed numeric headers become undefined', async () => {
    const { client } = setup([{ status: 200, data: HTML, headers: { 'scrape.do-request-cost': 'n/a' } }]);
    const res = await client.fetchHtml(TARGET);
    assert.equal(res.requestCost, undefined);
    assert.equal(res.remainingCredits, undefined);
    assert.equal(res.resolvedUrl, undefined);
  });

  test('empty 200 body is a non-retryable response error', async () => {
    const { client, calls } = setup([{ status: 200, data: '   ' }]);
    const err = await rejection(client.fetchHtml(TARGET));
    assert.equal(err.category, 'response');
    assert.equal(err.retryable, false);
    assert.equal(calls.length, 1);
  });
});

describe('request construction', () => {
  test('maps options to exact Scrape.do parameter names', async () => {
    const { client, calls } = setup([{ status: 200, data: HTML }]);
    await client.fetchHtml(TARGET, {
      render: true,
      super: true,
      geoCode: 'AE',
      waitUntil: 'networkidle2',
      customWait: 1500,
      waitSelector: '[data-testid="menu"]',
      blockResources: false,
      device: 'mobile',
      sessionId: 1234,
      timeout: 60000,
      retryTimeout: 20000,
      disableRetry: true,
      returnJSON: true,
      playWithBrowser: [
        { Action: 'Click', Selector: '#accept' },
        { Action: 'Wait', Timeout: 1000 },
      ],
      setCookies: 'a=1; b=2',
    });

    const sent = new URL(calls[0].url!);
    const p = sent.searchParams;
    assert.equal(`${sent.origin}${sent.pathname}`, 'https://api.scrape.do/');
    assert.equal(p.get('token'), TOKEN);
    assert.equal(p.get('url'), TARGET);
    assert.equal(p.get('render'), 'true');
    assert.equal(p.get('super'), 'true');
    assert.equal(p.get('geoCode'), 'ae');
    assert.equal(p.get('waitUntil'), 'networkidle2');
    assert.equal(p.get('customWait'), '1500');
    assert.equal(p.get('waitSelector'), '[data-testid="menu"]');
    assert.equal(p.get('blockResources'), 'false');
    assert.equal(p.get('device'), 'mobile');
    assert.equal(p.get('sessionId'), '1234');
    assert.equal(p.get('timeout'), '60000');
    assert.equal(p.get('retryTimeout'), '20000');
    assert.equal(p.get('disableRetry'), 'true');
    assert.equal(p.get('returnJSON'), 'true');
    assert.equal(p.get('setCookies'), 'a=1; b=2');
    assert.deepEqual(JSON.parse(p.get('playWithBrowser')!), [
      { Action: 'Click', Selector: '#accept' },
      { Action: 'Wait', Timeout: 1000 },
    ]);
    assert.equal(p.has('customWaitMs'), false);
    assert.equal(p.has('client'), false);
    assert.equal(p.has('targetHeaders'), false);
  });

  test('omits parameters that were not provided', () => {
    const url = buildScrapeDoUrl({ token: TOKEN, baseUrl: 'https://api.scrape.do/' }, TARGET);
    const keys = [...new URL(url).searchParams.keys()];
    assert.deepEqual(keys, ['token', 'url']);
  });

  test('target headers set the matching mode flag and sd- prefix for extra', async () => {
    const { client, calls } = setup([
      { status: 200, data: HTML },
      { status: 200, data: HTML },
    ]);
    await client.fetchHtml(TARGET, {
      targetHeaders: { mode: 'extra', headers: { 'Accept-Language': 'ar-AE' } },
    });
    await client.fetchHtml(TARGET, {
      targetHeaders: { mode: 'custom', headers: { 'User-Agent': 'Mozilla/5.0' } },
    });
    assert.equal(new URL(calls[0].url!).searchParams.get('extraHeaders'), 'true');
    assert.deepEqual(calls[0].headers, { 'sd-Accept-Language': 'ar-AE' });
    assert.equal(new URL(calls[1].url!).searchParams.get('customHeaders'), 'true');
    assert.deepEqual(calls[1].headers, { 'User-Agent': 'Mozilla/5.0' });
  });

  test('scrape.do timeout raises the local HTTP timeout above it', async () => {
    const { client, calls } = setup([{ status: 200, data: HTML }], { SCRAPE_DO_TIMEOUT_MS: '30000' });
    await client.fetchHtml(TARGET, { timeout: 120000 });
    assert.ok((calls[0].timeout ?? 0) > 120000);
  });
});

describe('URL encoding', () => {
  test('target URL is fully encoded and round-trips exactly', async () => {
    const tricky = 'https://example.com/ar/مطعم?q=burger & fries&x=1#frag';
    const { client, calls } = setup([{ status: 200, data: HTML }]);
    await client.fetchHtml(tricky);
    const raw = calls[0].url!;
    assert.match(raw, /[?&]url=https%3A%2F%2Fexample\.com%2Far%2F/);
    assert.ok(!raw.includes('&x=1'), 'target query must not leak into Scrape.do query');
    assert.ok(!raw.includes('#frag'));
    assert.equal(new URL(raw).searchParams.get('url'), tricky);
  });

  test('playWithBrowser JSON is URL-encoded', () => {
    const url = buildScrapeDoUrl(
      { token: TOKEN, baseUrl: 'https://api.scrape.do/' },
      TARGET,
      { render: true, playWithBrowser: [{ Action: 'Fill', Selector: '#q', Value: 'a&b=c' }] }
    );
    assert.ok(url.includes('playWithBrowser=%5B%7B%22Action%22%3A%22Fill%22'));
    assert.equal(
      new URL(url).searchParams.get('playWithBrowser'),
      '[{"Action":"Fill","Selector":"#q","Value":"a&b=c"}]'
    );
  });
});

describe('error classification and retries', () => {
  test('timeout is classified and retried, then reported', async () => {
    const timeoutErr = Object.assign(new Error('timeout of 90000ms exceeded'), { code: 'ECONNABORTED' });
    const { client, calls, sleeps } = setup(
      [{ throw: timeoutErr }, { throw: timeoutErr }],
      { SCRAPE_DO_MAX_RETRIES: '1' }
    );
    const err = await rejection(client.fetchHtml(TARGET));
    assert.equal(err.category, 'timeout');
    assert.equal(err.retryable, true);
    assert.equal(err.attempts, 2);
    assert.equal(calls.length, 2);
    assert.deepEqual(sleeps, [2000]);
  });

  test('network error is classified and recovers on retry', async () => {
    const netErr = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const { client, calls, sleeps } = setup([{ throw: netErr }, { status: 200, data: HTML }]);
    const res = await client.fetchHtml(TARGET);
    assert.equal(res.attempts, 2);
    assert.equal(calls.length, 2);
    assert.deepEqual(sleeps, [2000]);

    const { client: c2 } = setup([{ throw: netErr }], { SCRAPE_DO_MAX_RETRIES: '0' });
    const err = await rejection(c2.fetchHtml(TARGET));
    assert.equal(err.category, 'network');
    assert.equal(err.code, 'ECONNRESET');
    assert.equal(err.retryable, true);
  });

  test('5xx is retried with exponential backoff', async () => {
    const { client, sleeps } = setup([{ status: 502, data: 'Request failed' }, { status: 200, data: HTML }]);
    const res = await client.fetchHtml(TARGET);
    assert.equal(res.attempts, 2);
    assert.deepEqual(sleeps, [2000]);

    const { client: c2, calls, sleeps: s2 } = setup([
      { status: 503 }, { status: 502 }, { status: 500 },
    ]);
    const err = await rejection(c2.fetchHtml(TARGET));
    assert.equal(err.category, 'target_5xx');
    assert.equal(err.statusCode, 500);
    assert.equal(err.attempts, 3);
    assert.equal(calls.length, 3);
    assert.deepEqual(s2, [2000, 4000]);
  });

  test('429 concurrency limit is retryable and honours Retry-After', async () => {
    const { client, sleeps } = setup([
      { status: 429, data: 'Too many requests', headers: { 'retry-after': '5' } },
      { status: 200, data: HTML },
    ]);
    const res = await client.fetchHtml(TARGET);
    assert.equal(res.attempts, 2);
    assert.deepEqual(sleeps, [5000]);
  });

  test('401 invalid token is a non-retryable auth error', async () => {
    const { client, calls, sleeps } = setup([{ status: 401, data: 'Unauthorized: invalid token' }]);
    const err = await rejection(client.fetchHtml(TARGET));
    assert.equal(err.category, 'auth');
    assert.equal(err.retryable, false);
    assert.equal(err.statusCode, 401);
    assert.equal(calls.length, 1);
    assert.deepEqual(sleeps, []);
  });

  test('401 with no credits is a non-retryable quota error', async () => {
    const { client, calls } = setup([
      { status: 401, data: 'You have no credits or your subscription has been suspended' },
    ]);
    const err = await rejection(client.fetchHtml(TARGET));
    assert.equal(err.category, 'quota');
    assert.equal(err.retryable, false);
    assert.equal(calls.length, 1);
  });

  test('400 from Scrape.do is a non-retryable config error', async () => {
    const { client, calls } = setup([{ status: 400, data: 'Bad request' }]);
    const err = await rejection(client.fetchHtml(TARGET));
    assert.equal(err.category, 'config');
    assert.equal(err.retryable, false);
    assert.equal(calls.length, 1);
  });

  test('target 404 and 403 are not retried', async () => {
    const { client, calls } = setup([
      { status: 404, data: '<html>not found</html>', headers: { 'scrape.do-initial-status-code': '404' } },
      { status: 403, data: '<html>denied</html>', headers: { 'scrape.do-initial-status-code': '403' } },
    ]);
    const e404 = await rejection(client.fetchHtml(TARGET));
    assert.equal(e404.category, 'target_4xx');
    assert.equal(e404.retryable, false);
    const e403 = await rejection(client.fetchHtml(TARGET));
    assert.equal(e403.category, 'blocked');
    assert.equal(e403.retryable, false);
    assert.equal(calls.length, 2);
  });
});

describe('secret masking', () => {
  test('maskSecrets removes raw, encoded and token= query values', () => {
    const encodedToken = 'a/b+c==SECRET';
    const text = `boom ${TOKEN} at https://api.scrape.do/?token=${encodeURIComponent(encodedToken)}&url=x and ${encodedToken}`;
    const masked = maskSecrets(text, [TOKEN, encodedToken]);
    assert.ok(!masked.includes(TOKEN));
    assert.ok(!masked.includes(encodedToken));
    assert.ok(!masked.includes(encodeURIComponent(encodedToken)));
    assert.match(masked, /token=\*\*\*/);
  });

  test('token never appears in errors, serialized errors or logs', async () => {
    const leakyNetErr = Object.assign(
      new Error(`connect ECONNREFUSED https://api.scrape.do/?token=${TOKEN}&url=x`),
      { code: 'ECONNREFUSED', config: { url: `https://api.scrape.do/?token=${TOKEN}` } }
    );
    const { client, logs } = setup(
      [
        { status: 401, data: `Invalid token ${TOKEN}` },
        { throw: leakyNetErr },
      ],
      { SCRAPE_DO_MAX_RETRIES: '0' }
    );

    const authErr = await rejection(client.fetchHtml(TARGET));
    const netErr = await rejection(client.fetchHtml(TARGET));

    for (const err of [authErr, netErr]) {
      assert.ok(!err.message.includes(TOKEN), err.message);
      assert.ok(!JSON.stringify(err).includes(TOKEN));
      assert.ok(!String(err.stack).includes(TOKEN));
      assert.equal((err as Error & { cause?: unknown }).cause, undefined);
    }
    assert.ok(logs.length > 0);
    for (const line of logs) assert.ok(!line.includes(TOKEN), line);
  });
});

describe('returnJSON payload', () => {
  const payload = {
    content: HTML,
    networkRequests: [{ url: 'https://example.com/api/menu', method: 'GET' }],
    actionResults: [{ action: 'Click', success: true }, { action: 'Execute', success: false, error: 'not found' }],
    extraField: 1,
  };

  test('exposes parsed payload as optional metadata without changing html', async () => {
    const body = JSON.stringify(payload);
    const { client } = setup([{ status: 200, data: body }]);
    const res = await client.fetchHtml(TARGET, { render: true, returnJSON: true });
    assert.equal(res.html, body);
    assert.equal(res.json?.content, HTML);
    assert.deepEqual(res.json?.networkRequests, payload.networkRequests);
    assert.deepEqual(res.json?.actionResults, payload.actionResults);
    assert.equal(res.json?.raw.extraField, 1);
  });

  test('is absent without returnJSON and tolerant of non-JSON bodies', async () => {
    const { client } = setup([
      { status: 200, data: JSON.stringify(payload) },
      { status: 200, data: HTML },
    ]);
    const plain = await client.fetchHtml(TARGET);
    assert.equal(plain.json, undefined);
    const notJson = await client.fetchHtml(TARGET, { render: true, returnJSON: true });
    assert.equal(notJson.json, undefined);
    assert.equal(notJson.html, HTML);
  });
});

describe('concurrency', () => {
  test('respects SCRAPE_DO_CONCURRENCY per client', async () => {
    let inFlight = 0;
    let peak = 0;
    const http: ScrapeDoHttp = async (config) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 20));
      inFlight--;
      return { status: 200, data: HTML, headers: {}, statusText: '', config } as unknown as AxiosResponse<unknown>;
    };
    const client = createScrapeDoClient({
      http,
      env: { SCRAPE_DO_TOKEN: TOKEN, SCRAPE_DO_CONCURRENCY: '1' },
      logger: { log: () => {}, warn: () => {} },
    });
    await Promise.all([client.fetchHtml(TARGET), client.fetchHtml(TARGET), client.fetchHtml(TARGET)]);
    assert.equal(peak, 1);
  });
});
