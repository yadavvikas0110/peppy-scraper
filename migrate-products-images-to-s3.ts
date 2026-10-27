import dotenv from 'dotenv';
import path from 'path';
import { closeMongo, getMongoDb } from './src/shared/db/mongo';
import { Semaphore } from './src/utils/semaphore';
import { isOwnS3Url, uploadImageFromUrl } from './src/utils/s3.util';

// Migrates every image URL in products_clean to our S3/CDN:
//   images[]                      -> products/images
//   retailers[].imageUrl          -> products/retailers
//   retailers[].retailerLogo      -> products/logos
// Order of arrays is preserved. A failed image keeps its old URL (never dropped). Re-runnable: own URLs are skipped.
// Usage: npx ts-node migrate-products-images-to-s3.ts [--dry-run] [--limit=N docs] [--doc-concurrency=N] [--image-concurrency=N]

const COLLECTION = 'products_clean';
const flag = (name: string): string | undefined => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const isRemote = (u: unknown): u is string => typeof u === 'string' && /^https?:\/\//.test(u) && !isOwnS3Url(u);

interface Job { path: string; oldUrl: string; folder: string }
interface Failure { id: string; url: string; error: string }

const fmt = (ms: number): string => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m${String(s % 60).padStart(2, '0')}s`;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let err: unknown;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { err = e; await sleep(500 * (i + 1)); }
  }
  throw err;
}

async function main(): Promise<void> {
  dotenv.config();
  dotenv.config({ path: path.join(__dirname, '../shikhar-peppy-backend/.env') }); // S3 creds fallback

  const dryRun = process.argv.includes('--dry-run');
  const docLimit = Number(flag('limit') ?? 0) || Infinity;
  const docSem = new Semaphore(Number(flag('doc-concurrency') ?? 4));
  const imgSem = new Semaphore(Number(flag('image-concurrency') ?? 16));

  const col = (await getMongoDb()).collection(COLLECTION);
  const totalDocs = await col.countDocuments();

  // Pass 1: count the work up front so progress/remaining is exact.
  const urlCache = new Map<string, string>(); // old url -> new url (same image used by several docs)
  let totalImages = 0, docsWithWork = 0;
  const pending = new Set<string>();
  const scan = col.find({}, { projection: { images: 1, retailers: 1 } });
  let scanned = 0;
  for await (const d of scan) {
    if (scanned++ >= docLimit) break;
    const jobs = buildJobs(d as never);
    if (jobs.length) docsWithWork++;
    totalImages += jobs.length;
    for (const j of jobs) pending.add(j.oldUrl);
  }
  console.log(`[products] ${totalDocs} docs in ${COLLECTION}; ${docsWithWork} need work; ${totalImages} image refs (${pending.size} unique URLs)${dryRun ? ' — DRY RUN' : ''}`);
  if (dryRun) { await closeMongo(); return; }

  const start = Date.now();
  const stat = { docsDone: 0, docsFailed: 0, imgDone: 0, imgFailed: 0 };
  const failures: Failure[] = [];
  const log = () => {
    const done = stat.imgDone + stat.imgFailed;
    const elapsed = Date.now() - start;
    const rate = done / (elapsed / 1000) || 0;
    const left = totalImages - done;
    const eta = rate ? fmt((left / rate) * 1000) : '…';
    const pct = totalImages ? ((done / totalImages) * 100).toFixed(1) : '100';
    console.log(
      `[products] images ${done}/${totalImages} (${pct}%) left=${left} ok=${stat.imgDone} failed=${stat.imgFailed} | docs ${stat.docsDone}/${docsWithWork} left=${docsWithWork - stat.docsDone} | ${rate.toFixed(1)} img/s elapsed=${fmt(elapsed)} eta=${eta}`
    );
  };
  const ticker = setInterval(log, 15000);

  const migrateUrl = async (url: string, folder: string, id: string): Promise<string | null> => {
    const key = `${folder}|${url}`;
    const hit = urlCache.get(key);
    if (hit) return hit;
    try {
      const n = await imgSem.wrap(() => withRetry(() => uploadImageFromUrl(url, { folder }), 2));
      urlCache.set(key, n);
      stat.imgDone++;
      return n;
    } catch (e) {
      stat.imgFailed++;
      failures.push({ id, url, error: (e as Error).message });
      return null;
    }
  };

  const processDoc = async (d: { _id: unknown; images?: unknown[]; retailers?: Array<Record<string, unknown>> }): Promise<void> => {
    const jobs = buildJobs(d);
    if (!jobs.length) return;
    const id = String(d._id);
    const results = await Promise.all(jobs.map((j) => migrateUrl(j.oldUrl, j.folder, id)));

    // Only write the paths that actually changed, each guarded by its old value (no clobbering concurrent edits).
    const set: Record<string, string> = {};
    const filter: Record<string, unknown> = { _id: d._id };
    jobs.forEach((j, i) => {
      if (results[i]) { set[j.path] = results[i]!; filter[j.path] = j.oldUrl; }
    });
    if (Object.keys(set).length) {
      const res = await withRetry(() => col.updateOne(filter as never, { $set: set }));
      if (res.matchedCount === 0) { stat.docsFailed++; failures.push({ id, url: '(doc)', error: 'doc changed during migration, re-run to pick it up' }); return; }
    }
    if (Object.keys(set).length < jobs.length) stat.docsFailed++; else stat.docsDone++;
  };

  const cursor = col.find({}, { projection: { images: 1, retailers: 1 } });
  const running = new Set<Promise<void>>();
  let n = 0;
  for await (const d of cursor) {
    if (n++ >= docLimit) break;
    if (!buildJobs(d as never).length) continue;
    await docSem.acquire();
    const p = processDoc(d as never)
      .catch((e) => { stat.docsFailed++; failures.push({ id: String(d._id), url: '(doc)', error: (e as Error).message }); })
      .finally(() => { docSem.release(); running.delete(p); });
    running.add(p);
  }
  await Promise.all(running);
  clearInterval(ticker);

  log();
  console.log(`[products] DONE in ${fmt(Date.now() - start)}. docs ok=${stat.docsDone} docs with failures=${stat.docsFailed}; images ok=${stat.imgDone} failed=${stat.imgFailed}`);
  const shown = failures.slice(0, 50);
  for (const f of shown) console.log(`  FAILED ${f.id} ${f.url} — ${f.error}`);
  if (failures.length > shown.length) console.log(`  …and ${failures.length - shown.length} more. Re-run the script to retry failed ones.`);
  await closeMongo();
}

function buildJobs(d: { images?: unknown[]; retailers?: Array<Record<string, unknown>> }): Job[] {
  const jobs: Job[] = [];
  (d.images ?? []).forEach((u, i) => { if (isRemote(u)) jobs.push({ path: `images.${i}`, oldUrl: u, folder: 'products/images' }); });
  (d.retailers ?? []).forEach((r, i) => {
    if (isRemote(r.imageUrl)) jobs.push({ path: `retailers.${i}.imageUrl`, oldUrl: r.imageUrl, folder: 'products/retailers' });
    if (isRemote(r.retailerLogo)) jobs.push({ path: `retailers.${i}.retailerLogo`, oldUrl: r.retailerLogo, folder: 'products/logos' });
  });
  return jobs;
}

main().catch((e) => { console.error(e); process.exit(1); });
