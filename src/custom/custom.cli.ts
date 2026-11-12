/**
 * Custom scraper CLI — Shopping & Luxury products from Namshi, Mumzworld, Jumbo and Letstango with
 * our own transport (plain HTTP + local headless Chromium). Independent of the Bright Data /
 * Scrape.do pipelines: own config, lock, stop signal, output folder and database variables.
 *
 *   npm run custom:scrape                                 # all sites, scrape → JSON only
 *   npm run custom:scrape -- --site namshi --limit 5      # one site, 5 per category
 *   npm run custom:scrape -- --category perfumes          # one category key
 *   npm run custom:scrape:push                            # scrape + write to CUSTOM_MONGODB_URI (allowlisted DB)
 *   npm run custom:stop                                   # ask a running scrape to stop
 *
 * Flags: --site a,b  --category k1,k2  --limit N  --push  --no-s3  --ai (OpenAI tags/embeddings on push)
 * Env (.env.custom): CUSTOM_MONGODB_URI, CUSTOM_MONGODB_DB, CUSTOM_DB_ALLOWLIST, CUSTOM_SCRAPER_ENABLED,
 *                    S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET, S3_REGION, CDN_URL (required for --push)
 */
import * as fs from 'fs';
import * as path from 'path';

// ── 1. Isolation — before any module that calls dotenv is loaded ──────────────
// Several shared modules run dotenv.config() on import, which would pull the main pipeline's
// .env (Bright Data, Scrape.do, Chroma, backend URL, production MONGODB_URI) into this process.
// dotenv never overrides a defined variable, so blanking them here keeps them out for good.
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const value = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };

const ISOLATED_VARS = [
  'BRIGHT_DATA_API_KEY', 'BRIGHT_DATA_BROWSER_AUTH', 'BRIGHT_DATA_UNLOCKER_ZONE', 'BRIGHT_DATA_APPROVED_SITES',
  'SCRAPE_DO_TOKEN', 'CHROMA_API_KEY', 'CHROMA_TENANT', 'CHROMA_DATABASE',
  'PEPPY_BE_URL', 'SCRAPER_API_KEY', 'MONGODB_URI', 'MONGODB_DB', 'CONFIRM_PRODUCTION_DB',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
];
for (const name of ISOLATED_VARS) process.env[name] = '';
if (!flag('ai')) process.env.OPENAI_API_KEY = '';

const OUTPUT_DIR = path.join(process.cwd(), 'output', 'custom');
export const CUSTOM_LOCK_FILE = path.join(process.cwd(), 'output', 'cron.custom.lock');
export const CUSTOM_STOP_FILE = path.join(process.cwd(), 'output', 'stop.custom.signal');

let ownsLock = false;

function lockHolderAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === 'EPERM'; } // EPERM: alive, other user
}

function acquireCustomLock(): boolean {
  fs.mkdirSync(path.dirname(CUSTOM_LOCK_FILE), { recursive: true });
  const body = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), mode: 'custom' });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(CUSTOM_LOCK_FILE, body, { flag: 'wx' }); // atomic: fails if the file exists
      ownsLock = true;
      return true;
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e;
      let lock: any = null;
      try { lock = JSON.parse(fs.readFileSync(CUSTOM_LOCK_FILE, 'utf8')); } catch {}
      if (lock?.pid && lockHolderAlive(lock.pid)) {
        console.error(`[custom] Already running (PID ${lock.pid}, since ${lock.startedAt}).`);
        return false;
      }
      console.warn('[custom] Stale lock — previous run exited without cleanup. Proceeding.');
      try { fs.unlinkSync(CUSTOM_LOCK_FILE); } catch {}
    }
  }
  return false;
}

/** Removes the lock only if this process created it — never another run's. */
function releaseCustomLock(): void {
  if (!ownsLock) return;
  try { fs.unlinkSync(CUSTOM_LOCK_FILE); } catch {}
  ownsLock = false;
}

async function main(): Promise<number> {
  if (process.env.CUSTOM_SCRAPER_ENABLED === 'false') {
    console.log('[custom] CUSTOM_SCRAPER_ENABLED=false — not running.');
    return 0;
  }

  // Loaded only now, after isolation
  const { CUSTOM_SITES } = require('./core/types') as typeof import('./core/types');
  const { loadCustomConfig } = require('./custom.config') as typeof import('./custom.config');
  const { customDbTarget, describeTarget } = require('./custom.db') as typeof import('./custom.db');
  const { runCustomScrape } = require('./custom.runner') as typeof import('./custom.runner');

  const sites = (value('site')?.split(',').map(s => s.trim()).filter(Boolean) ?? [...CUSTOM_SITES]) as any[];
  const unknown = sites.filter(s => !(CUSTOM_SITES as readonly string[]).includes(s));
  if (unknown.length) { console.error(`[custom] Unknown site(s): ${unknown.join(', ')} (supported: ${CUSTOM_SITES.join(', ')})`); return 2; }
  const limitRaw = value('limit');
  const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;
  if (limitRaw && !(limit! >= 1 && limit! <= 200)) { console.error('[custom] --limit must be 1–200'); return 2; }

  const config = loadCustomConfig(value('config') ? path.resolve(value('config')!) : undefined);
  // Resolve (and refuse) the write target before spending any requests
  const push = flag('push') ? customDbTarget() : undefined;
  if (push) console.log(`[custom] Push target: ${describeTarget(push)}`);

  // Images go to our S3/CDN before they are stored. Pushing retailer-hosted images needs an explicit --no-s3.
  let s3: import('./core/images-s3').ImageRehoster | undefined;
  if (push && !flag('no-s3')) {
    const { isS3Configured, isOwnS3Url, uploadImageFromUrl } = require('../utils/s3.util') as typeof import('../utils/s3.util');
    if (!isS3Configured()) {
      console.error('[custom] S3 is not configured: set S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET, S3_REGION and CDN_URL in .env.custom (or pass --no-s3 to store retailer image URLs).');
      return 2;
    }
    const { ImageRehoster } = require('./core/images-s3') as typeof import('./core/images-s3');
    s3 = new ImageRehoster((url, folder) => uploadImageFromUrl(url, { folder }), isOwnS3Url);
    console.log(`[custom] Images → S3 bucket ${process.env.S3_BUCKET}${process.env.CDN_URL ? ` (served via ${process.env.CDN_URL})` : ''}`);
  } else if (push) {
    console.warn('[custom] --no-s3: storing retailer-hosted image URLs.');
  }

  if (!acquireCustomLock()) return 1;
  try { fs.unlinkSync(CUSTOM_STOP_FILE); } catch {}
  try {
    const result = await runCustomScrape(config, {
      sites,
      categoryKeys: value('category')?.split(',').map(s => s.trim()).filter(Boolean),
      limit,
      push,
      s3,
      ai: flag('ai'),
      outputDir: OUTPUT_DIR,
      shouldStop: () => fs.existsSync(CUSTOM_STOP_FILE),
    });

    console.log('\n──────── Custom scraper summary ────────');
    for (const s of result.sites) {
      console.log(`${s.site.padEnd(10)} ${s.status.padEnd(8)} valid ${String(s.valid).padStart(3)}  rejected ${String(s.rejected).padStart(3)}  ${s.reason ?? ''}`);
      for (const c of s.categories) console.log(`   ${c.key.padEnd(16)} ${c.valid}/${c.wanted} (candidates ${c.candidates}, rejected ${c.rejected})${c.error ? ` ERROR ${c.error}` : ''}`);
      console.log(`   coverage % ${JSON.stringify(s.coverage)}`);
    }
    console.log(`requests: ${result.requests.http} HTTP, ${result.requests.browserRenders} browser renders (local, no third party)`);
    if (result.push) {
      const p = result.push;
      console.log(`push → ${p.target}: ${p.bundles} bundles, ${p.mongoInserted} inserted, ${p.mongoUpdated} updated, ${p.matchedExisting} merged into existing, ${p.skipped} skipped${p.errors.length ? `, errors: ${p.errors.join('; ')}` : ''}`);
    }
    if (result.s3) {
      const s = result.s3;
      console.log(`s3 → ${s.uploaded} uploaded, ${s.alreadyOwn} already on S3, ${s.failed} failed (kept retailer URL); ${s.storedImagesReplaced} stored URL(s) switched on ${s.storedDocumentsUpdated} existing document(s)`);
    }
    console.log(`output: ${result.outputFile}`);
    const sitesOk = result.sites.every(s => s.status === 'complete' || s.status === 'partial');
    const pushOk = !result.push || result.push.errors.length === 0;
    return sitesOk && pushOk ? 0 : 1;
  } finally {
    releaseCustomLock();
  }
}

main().then(code => process.exit(code)).catch(e => {
  const { redactMongoUri } = require('../shared/db/mongo');
  console.error(`[custom] Fatal: ${redactMongoUri(String(e?.message ?? e))}`);
  releaseCustomLock();
  process.exit(1);
});
