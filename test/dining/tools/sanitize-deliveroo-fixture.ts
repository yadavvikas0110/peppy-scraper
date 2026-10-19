/// <reference types="node" />
/*
 * DEVELOPER-ONLY fixture tool. Never imported by the service or the test suite. No network, no MongoDB.
 *
 *   npx ts-node test/dining/tools/sanitize-deliveroo-fixture.ts <name> <en|ar> --from-file <raw.html> [--meta <raw.meta.json>] [--force]
 *
 * Writes test/dining/fixtures/deliveroo-<name>-<locale>.html (sanitized, see deliveroo-fixture.sanitize.ts)
 * and a .meta.json with non-secret fetch metadata.
 */
import * as fs from 'fs';
import * as path from 'path';
import { DELIVEROO_FETCH_DEFAULTS, detectDeliverooLocale, isDeliverooMenuUrl } from '../../../src/dining/platforms/deliveroo/deliveroo.adapter';
import { DELIVEROO_FIXTURE_DROPPED, sanitizeDeliverooHtml } from './deliveroo-fixture.sanitize';

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures');

function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

function main(): void {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const fromFile = option(args, '--from-file');
  const metaFile = option(args, '--meta');
  const positional = args.filter((a, i) => !a.startsWith('--') && !['--from-file', '--meta'].includes(args[i - 1]));
  const [name, locale] = positional;
  if (!name || !/^[a-z0-9-]+$/.test(name) || (locale !== 'en' && locale !== 'ar') || !fromFile) {
    throw new Error('Usage: sanitize-deliveroo-fixture.ts <name> <en|ar> --from-file <raw.html> [--meta <raw.meta.json>] [--force]');
  }

  const prior = metaFile ? (JSON.parse(fs.readFileSync(metaFile, 'utf8')) as Record<string, unknown>) : {};
  const url = typeof prior.url === 'string' ? prior.url : undefined;
  if (url && (!isDeliverooMenuUrl(url) || detectDeliverooLocale(url) !== locale)) throw new Error(`Not a ${locale} Deliveroo menu URL`);

  const htmlPath = path.join(FIXTURE_DIR, `deliveroo-${name}-${locale}.html`);
  const metaPath = path.join(FIXTURE_DIR, `deliveroo-${name}-${locale}.meta.json`);
  if (fs.existsSync(htmlPath) && !force) {
    throw new Error(`${path.relative(process.cwd(), htmlPath)} already exists — pass --force to overwrite`);
  }

  const rawHtml = fs.readFileSync(fromFile, 'utf8');
  const sanitized = sanitizeDeliverooHtml(rawHtml);
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  fs.writeFileSync(htmlPath, sanitized);
  const meta = {
    platform: 'deliveroo',
    locale,
    url,
    capturedAt: prior.capturedAt,
    scrapeDoOptions: prior.scrapeDoOptions ?? DELIVEROO_FETCH_DEFAULTS,
    statusCode: prior.statusCode,
    finalUrl: prior.finalUrl,
    requestCost: prior.requestCost,
    attempts: prior.attempts,
    durationMs: prior.durationMs,
    rawBytes: Buffer.byteLength(rawHtml),
    fixtureBytes: Buffer.byteLength(sanitized),
    sanitized: { dropped: DELIVEROO_FIXTURE_DROPPED },
  };
  fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`[fixture] saved ${path.relative(process.cwd(), htmlPath)} (${meta.fixtureBytes} of ${meta.rawBytes} bytes kept)`);
}

try {
  main();
} catch (err) {
  console.error(`[fixture] failed: ${(err as Error).message}`);
  process.exitCode = 1;
}
