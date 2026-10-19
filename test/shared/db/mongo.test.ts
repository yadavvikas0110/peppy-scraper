/// <reference types="node" />
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { MongoClient } from 'mongodb';
import {
  createMongoConnection,
  dbNameFromUri,
  getMongoConfig,
  redactMongoUri,
} from '../../../src/shared/db/mongo';

const URI = 'mongodb+srv://user:s3cretPass@cluster0.example.mongodb.net/peppy?appName=x';
const silent = { log: () => {}, warn: () => {} };

function fakeClientFactory(opts: { failTimes?: number } = {}) {
  let failures = opts.failTimes ?? 0;
  const stats = { created: 0, connects: 0, closes: 0, dbNames: [] as string[] };
  const createClient = () => {
    stats.created++;
    return {
      connect: async () => {
        stats.connects++;
        await new Promise(r => setTimeout(r, 5));
        if (failures > 0) {
          failures--;
          throw new Error(`getaddrinfo ENOTFOUND while connecting to ${URI}`);
        }
      },
      close: async () => { stats.closes++; },
      db: (name: string) => { stats.dbNames.push(name); return { databaseName: name }; },
    } as unknown as MongoClient;
  };
  return { createClient, stats };
}

describe('mongo config', () => {
  test('missing MONGODB_URI fails only when used', async () => {
    assert.throws(() => getMongoConfig({}), /MONGODB_URI is not set/);
    const conn = createMongoConnection({ env: {}, logger: silent });
    assert.equal(conn.isConnected(), false);
    await assert.rejects(conn.getDb(), /MONGODB_URI is not set/);
  });

  test('database name precedence: MONGODB_DB → URI path → peppy', () => {
    assert.equal(getMongoConfig({ MONGODB_URI: URI, MONGODB_DB: 'other' }).dbName, 'other');
    assert.equal(getMongoConfig({ MONGODB_URI: URI }).dbName, 'peppy');
    assert.equal(getMongoConfig({ MONGODB_URI: 'mongodb://h1:27017,h2:27017/shop?replicaSet=rs' }).dbName, 'shop');
    assert.equal(getMongoConfig({ MONGODB_URI: 'mongodb://localhost:27017/' }).dbName, 'peppy');
    assert.equal(getMongoConfig({ MONGODB_URI: 'mongodb://localhost:27017' }).dbName, 'peppy');
    assert.equal(dbNameFromUri('mongodb://u:p@h/db%20x'), 'db x');
  });

  test('rejects non-mongodb URIs', () => {
    assert.throws(() => getMongoConfig({ MONGODB_URI: 'http://localhost' }), /must start with/);
  });
});

describe('lazy reusable connection', () => {
  test('does not connect until first use, then reuses one client', async () => {
    const { createClient, stats } = fakeClientFactory();
    const conn = createMongoConnection({ env: { MONGODB_URI: URI }, createClient, logger: silent });
    assert.equal(stats.created, 0);

    const [a, b, c] = await Promise.all([conn.getClient(), conn.getClient(), conn.getDb()]);
    await conn.getDb('custom');
    assert.equal(a, b);
    assert.ok(c);
    assert.equal(stats.created, 1);
    assert.equal(stats.connects, 1);
    assert.deepEqual(stats.dbNames, ['peppy', 'custom']);
    assert.equal(conn.isConnected(), true);
  });

  test('failed connect is not cached, next call retries, and the URI is redacted', async () => {
    const { createClient, stats } = fakeClientFactory({ failTimes: 1 });
    const conn = createMongoConnection({ env: { MONGODB_URI: URI }, createClient, logger: silent });

    await assert.rejects(conn.getClient(), (err: Error) => {
      assert.ok(!err.message.includes('s3cretPass'), err.message);
      assert.ok(err.message.includes('<MONGODB_URI>'));
      return true;
    });
    assert.equal(conn.isConnected(), false);
    assert.equal(stats.closes, 1);

    await conn.getClient();
    assert.equal(stats.created, 2);
    assert.equal(conn.isConnected(), true);
  });

  test('close is safe before connecting and resets the connection', async () => {
    const { createClient, stats } = fakeClientFactory();
    const conn = createMongoConnection({ env: { MONGODB_URI: URI }, createClient, logger: silent });
    await conn.close();
    assert.equal(stats.closes, 0);

    await conn.getClient();
    await conn.close();
    assert.equal(stats.closes, 1);
    assert.equal(conn.isConnected(), false);
  });

  test('redactMongoUri strips credentials from arbitrary text', () => {
    const text = 'failed: mongodb://admin:hunter2@10.0.0.1:27017/peppy';
    assert.equal(redactMongoUri(text), 'failed: mongodb://***@10.0.0.1:27017/peppy');
  });
});
