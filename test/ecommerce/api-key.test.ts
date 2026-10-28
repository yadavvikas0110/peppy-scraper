/// <reference types="node" />
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'http';
import { requireScraperApiKey, isAuthorizedUpgrade } from '../../src/utils/api-key';

function run(headers: Record<string, string>) {
  let status = 200;
  let nextCalled = false;
  const req: any = { header: (n: string) => headers[n.toLowerCase()] };
  const res: any = { status(s: number) { status = s; return this; }, json() { return this; } };
  requireScraperApiKey(req, res, () => { nextCalled = true; });
  return { status, nextCalled };
}

const upgrade = (url: string, headers: Record<string, string> = {}) =>
  ({ url, headers } as unknown as http.IncomingMessage);

describe('scraper API key', () => {
  afterEach(() => { delete process.env.SCRAPER_API_KEY; });

  test('open when SCRAPER_API_KEY is unset', () => {
    assert.deepEqual(run({}), { status: 200, nextCalled: true });
    assert.equal(isAuthorizedUpgrade(upgrade('/ws/logs')), true);
  });

  test('rejects missing or wrong keys when set', () => {
    process.env.SCRAPER_API_KEY = 'secret';
    assert.deepEqual(run({}), { status: 401, nextCalled: false });
    assert.deepEqual(run({ 'x-api-key': 'nope' }), { status: 401, nextCalled: false });
    assert.deepEqual(run({ 'x-api-key': 'secret' }), { status: 200, nextCalled: true });
  });

  test('WebSocket accepts the key as header or ?key=', () => {
    process.env.SCRAPER_API_KEY = 'secret';
    assert.equal(isAuthorizedUpgrade(upgrade('/ws/logs')), false);
    assert.equal(isAuthorizedUpgrade(upgrade('/ws/logs?key=secret')), true);
    assert.equal(isAuthorizedUpgrade(upgrade('/ws/logs', { 'x-api-key': 'secret' })), true);
  });
});
