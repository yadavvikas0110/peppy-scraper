import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cliArgsFor, createShoppingAutoController, intervalHoursFrom, parseAutoOptions } from '../../src/shopping/shopping-bulk.control';
import { parseArgs } from '../../src/shopping/shopping-bulk.cli';

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 4242;
  signals: string[] = [];
  kill(sig: string) { this.signals.push(sig); return true; }
  exit(code: number | null) { this.stdout.end(); this.stderr.end(); this.emit('exit', code); }
}

function harness(env: NodeJS.ProcessEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bulk-auto-'));
  const spawned: Array<{ cmd: string; args: string[]; opts: any; child: FakeChild }> = [];
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const logs: string[] = [];
  const ctl = createShoppingAutoController({
    outputDir: dir,
    stopFile: path.join(dir, 'stop.signal'),
    lockFile: path.join(dir, 'bulk.lock'),
    env,
    log: l => logs.push(l),
    now: () => new Date('2026-11-27T10:00:00.000Z'),
    spawn: (cmd, args, opts) => { const child = new FakeChild(); spawned.push({ cmd, args, opts, child }); return child as any; },
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: t => { (t as any).cleared = true; },
  });
  return { dir, ctl, spawned, timers, logs, fire: () => { const t = timers.filter(x => !x.cleared).pop()!; t.cleared = true; t.fn(); } };
}

describe('shopping bulk 24/7 control', () => {
  test('start runs a pass, waits the interval, runs the next pass', () => {
    const h = harness({ SHOPPING_BULK_INTERVAL_HOURS: '2' });
    const r = h.ctl.start({ count: 200, maxPages: 30 });
    assert.equal(r.started, true);
    assert.equal(h.spawned.length, 1);
    assert.ok(h.spawned[0].args.join(' ').includes('--count 200 --max-pages 30'));
    assert.equal(h.spawned[0].opts.env.SHOPPING_BULK_TRIGGER, 'cron');
    assert.equal(h.ctl.status().phase, 'running');

    h.spawned[0].child.exit(0);
    assert.equal(h.ctl.status().phase, 'waiting');
    assert.equal(h.timers[h.timers.length - 1].ms, 2 * 3600 * 1000);
    assert.equal(h.ctl.status().nextPassAt, '2026-11-27T12:00:00.000Z');
    assert.match(h.ctl.status().lastPass!.outcome, /finished/);

    h.fire();
    assert.equal(h.spawned.length, 2);
    assert.equal(h.ctl.status().passes, 2);
  });

  test('a second start is refused while 24/7 mode is on', () => {
    const h = harness();
    h.ctl.start({});
    const r = h.ctl.start({ count: 5 });
    assert.equal(r.started, false);
    assert.match(r.reason!, /Already running/);
    assert.equal(h.spawned.length, 1);
  });

  test('stop during a pass writes the stop file and schedules nothing after it ends', () => {
    const h = harness();
    h.ctl.start({});
    const r = h.ctl.stop();
    assert.equal(r.stopped, true);
    assert.ok(fs.existsSync(path.join(h.dir, 'stop.signal')));
    assert.equal(h.ctl.status().phase, 'stopping');
    h.spawned[0].child.exit(3);
    assert.equal(h.ctl.status().phase, 'idle');
    assert.equal(h.timers.length, 0);
    assert.equal(h.ctl.status().lastPass!.outcome, 'stopped');
  });

  test('stop while waiting cancels the next pass', () => {
    const h = harness();
    h.ctl.start({});
    h.spawned[0].child.exit(0);
    h.ctl.stop();
    assert.equal(h.timers[0].cleared, true);
    assert.equal(h.ctl.status().phase, 'idle');
    assert.equal(h.ctl.stop().stopped, false);
  });

  test('24/7 mode survives a service restart and resumes with the same options', () => {
    const h = harness();
    h.ctl.start({ count: 50, platforms: ['amazon', 'noon'] });
    const saved = JSON.parse(fs.readFileSync(path.join(h.dir, 'shopping-bulk.auto.json'), 'utf8'));
    assert.equal(saved.enabled, true);

    const spawned: any[] = [];
    const again = createShoppingAutoController({
      outputDir: h.dir, stopFile: path.join(h.dir, 'stop.signal'), lockFile: path.join(h.dir, 'bulk.lock'), env: {}, log: () => {},
      spawn: (cmd, args) => { spawned.push(args); return new FakeChild() as any; },
      setTimer: () => 0, clearTimer: () => {},
    });
    assert.equal(again.resume(), true);
    assert.ok(spawned[0].join(' ').includes('--platforms amazon,noon --count 50'));
  });

  test('after stop, a restart does not resume', () => {
    const h = harness();
    h.ctl.start({});
    h.ctl.stop();
    const again = createShoppingAutoController({ outputDir: h.dir, env: {}, log: () => {}, spawn: () => { throw new Error('must not spawn'); } });
    assert.equal(again.resume(), false);
  });

  test('refuses to start while a run started outside the API holds the lock', () => {
    const h = harness();
    fs.writeFileSync(path.join(h.dir, 'bulk.lock'), JSON.stringify({ pid: process.pid, startedAt: '2026-11-27T09:00:00Z', mode: 'shopping-bulk' }));
    const r = h.ctl.start({});
    assert.equal(r.started, false);
    assert.match(r.reason!, /outside the API/);
    assert.equal(h.spawned.length, 0);
  });

  test('child output is relayed to the service log', async () => {
    const h = harness();
    h.ctl.start({});
    h.spawned[0].child.stdout.write('[amazon] ✓ one\n[noon] ✓ two\n');
    await new Promise(r => setImmediate(r));
    assert.ok(h.logs.includes('[amazon] ✓ one') && h.logs.includes('[noon] ✓ two'));
  });

  test('shutdown signals the pass but keeps 24/7 mode on for the next boot', async () => {
    const h = harness();
    h.ctl.start({});
    const child = h.spawned[0].child;
    const done = h.ctl.shutdown(50);
    child.exit(130);
    await done;
    assert.ok(child.signals.includes('SIGTERM'));
    assert.equal(h.timers.length, 0);
    const saved = JSON.parse(fs.readFileSync(path.join(h.dir, 'shopping-bulk.auto.json'), 'utf8'));
    assert.equal(saved.enabled, true);
  });

  test('start options are validated', () => {
    assert.match((parseAutoOptions({ count: 0 }) as any).error, /count/);
    assert.match((parseAutoOptions({ platforms: ['ebay'] }) as any).error, /Unknown platform/);
    assert.match((parseAutoOptions({ freshHours: 1.5 }) as any).error, /freshHours/);
    assert.deepEqual(parseAutoOptions({ intervalHours: 0.5, categories: 'tvs, laptops' }), { options: { intervalHours: 0.5, categories: ['tvs', 'laptops'] } });
    assert.deepEqual(cliArgsFor({ freshHours: 0, productConcurrency: 8 }), ['--product-concurrency', '8', '--fresh-hours', '0']);
    const h = harness();
    assert.equal(h.ctl.start({ count: 'x' }).started, false);
    assert.equal(h.spawned.length, 0);
  });

  test('interval comes from the request, then SHOPPING_BULK_INTERVAL_HOURS, then 6 h', () => {
    assert.equal(intervalHoursFrom({ intervalHours: 1 }, { SHOPPING_BULK_INTERVAL_HOURS: '3' }), 1);
    assert.equal(intervalHoursFrom({}, { SHOPPING_BULK_INTERVAL_HOURS: '3' }), 3);
    assert.equal(intervalHoursFrom(undefined, {}), 6);
    assert.equal(intervalHoursFrom(undefined, { SHOPPING_BULK_INTERVAL_HOURS: 'abc' }), 6);
  });
});

describe('shopping bulk CLI defaults from env', () => {
  test('SHOPPING_BULK_* set the defaults; flags still win', () => {
    const env = { SHOPPING_BULK_FRESH_HOURS: '72', SHOPPING_BULK_COUNT: '200', SHOPPING_BULK_MAX_PAGES: '30', SHOPPING_BULK_CATEGORY_CONCURRENCY: '4', SHOPPING_BULK_PRODUCT_CONCURRENCY: '8' };
    const a = parseArgs([], env);
    assert.deepEqual([a.freshHours, a.count, a.maxPages, a.categoryConcurrency, a.productConcurrency], [72, 200, 30, 4, 8]);
    const b = parseArgs(['--fresh-hours', '0', '--count', '5'], env);
    assert.deepEqual([b.freshHours, b.count], [0, 5]);
  });

  test('unset env keeps the built-in defaults; a bad value is reported by name', () => {
    const a = parseArgs([], {});
    assert.deepEqual([a.freshHours, a.count, a.maxPages, a.categoryConcurrency, a.productConcurrency], [24, undefined, 15, 2, 3]);
    assert.throws(() => parseArgs([], { SHOPPING_BULK_FRESH_HOURS: 'abc' }), /SHOPPING_BULK_FRESH_HOURS/);
  });
});

describe('24/7 loop back-off', () => {
  test('interval 0: a finished pass restarts at once, a failed pass waits the back-off', () => {
    const h = harness({ SHOPPING_BULK_INTERVAL_HOURS: '0', AUTO_LOOP_FAILURE_BACKOFF_MINUTES: '15' });
    h.ctl.start({});
    h.spawned[0].child.exit(0);
    assert.equal(h.timers[h.timers.length - 1].ms, 0);
    h.fire();
    h.spawned[1].child.exit(1);
    assert.equal(h.timers[h.timers.length - 1].ms, 15 * 60 * 1000);
    assert.match(h.logs.join('\n'), /back-off 15 min/);
  });
});
