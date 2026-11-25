/**
 * Shopping scrape statistics (read-only).
 *
 *   npm run shopping:stats                 # latest bulk run: per category × platform, writes, images, credits
 *   npm run shopping:stats -- --runs 5     # last 5 runs, summed
 *   npm run shopping:stats -- --db         # also: what is stored in products_clean per retailer
 *   npm run shopping:stats -- --import     # store output/shopping-bulk_*.json reports not stored yet (once; skips known runs)
 *   npm run shopping:stats -- --daily 7    # day by day (UAE time), per platform: scraped, failed, credits; written products
 */
import * as fs from 'fs';
import * as path from 'path';
import type { BulkRunReport } from './shopping-bulk';

const pad = (v: unknown, n: number) => String(v ?? '').padEnd(n).slice(0, n);
const padL = (v: unknown, n: number) => String(v ?? '').padStart(n);

export function loadReports(dir: string, runs: number): Array<BulkRunReport & { file: string }> {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => /^shopping-bulk_.*\.json$/.test(f))
    .sort().reverse().slice(0, runs)
    .map(f => ({ ...JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')), file: f }));
}

export interface PlatformStat { links: number; scraped: number; failed: number; pending: number; runs: number; problems: string[] }

/** Per-platform totals across the given reports. */
export function platformStats(reports: BulkRunReport[]): Record<string, PlatformStat> {
  const out: Record<string, PlatformStat> = {};
  for (const r of reports) for (const c of r.categories) for (const s of c.siteResults ?? []) {
    const p = (out[s.site] ??= { links: 0, scraped: 0, failed: 0, pending: 0, runs: 0, problems: [] });
    p.links += s.links ?? 0;
    p.scraped += s.scraped ?? 0;
    p.failed += s.failed ?? 0;
    p.pending += s.pending ?? 0;
    p.runs++;
    if (s.status !== 'complete' && s.reason) p.problems.push(`${c.key}: ${s.status} — ${s.reason.slice(0, 140)}`);
  }
  return out;
}

function printReports(reports: Array<BulkRunReport & { file: string }>): void {
  for (const r of reports) {
    console.log(`\n■ ${r.file}  ${r.status.toUpperCase()}${r.dryRun ? ' (dry run)' : ''}  ${r.startedAt} → ${r.finishedAt}`);
    console.log(`  ${pad('category', 18)} ${pad('status', 9)} ${pad('platform', 12)} ${padL('links', 6)} ${padL('ok', 5)} ${padL('fail', 5)} ${padL('pend', 5)}`);
    for (const c of r.categories) {
      c.siteResults.forEach((s, i) => console.log(`  ${pad(i ? '' : c.key, 18)} ${pad(i ? '' : c.status, 9)} ${pad(s.site, 12)} ${padL(s.links ?? '-', 6)} ${padL(s.scraped, 5)} ${padL(s.failed, 5)} ${padL(s.pending ?? 0, 5)}${s.status !== 'complete' ? `  ${s.status}` : ''}`));
      const w = c.push;
      console.log(`  ${pad('', 18)} → ${c.bundles} products, ${c.comparisons} on 2+ platforms` +
        (w ? `; DB: ${w.mongoInserted} new, ${w.mongoUpdated} updated, ${w.matchedExisting} merged into existing` : '') +
        (c.images ? `; images ${c.images.uploaded} uploaded, ${c.images.failed} failed` : '') + (c.error ? `; ERROR ${c.error.slice(0, 120)}` : ''));
    }
    const t = r.totals;
    console.log(`  TOTAL: ${t.scraped} scraped, ${t.failedPages ?? 0} failed pages, ${t.bundles} products (${t.comparisons} compared), ${t.inserted} new, ${t.updated} updated, ${t.matchedExisting} merged; images ${t.imagesUploaded}/${t.imagesUploaded + t.imagesFailed}`);
    const sd: any = r.scrapeDo;
    if (sd?.byPlatform) {
      console.log(`  Scrape.do: ${sd.pages} pages, ${sd.failedPages} failed, ${sd.credits} credits — ` +
        Object.entries(sd.byPlatform).map(([k, v]: [string, any]) => `${k} ${v.credits}`).join(', ') +
        (sd.images ? `; images via Scrape.do ${sd.images.images} (${sd.images.failed} failed, ${sd.images.credits} credits)` : ''));
    }
  }
}

async function printDb(): Promise<void> {
  const { getMongoDb, closeMongo, getMongoConfig } = await import('../shared/db/mongo');
  const db = await getMongoDb();
  const col = db.collection('products_clean');
  const notGrocery = { category: { $ne: 'Groceries' } };
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const [total, compared, fresh, byRetailer] = await Promise.all([
    col.countDocuments(notGrocery),
    col.countDocuments({ ...notGrocery, 'retailers.1': { $exists: true } }),
    col.countDocuments({ ...notGrocery, updatedAt: { $gte: since } }),
    col.aggregate([
      { $match: notGrocery },
      { $unwind: '$retailers' },
      { $group: {
        _id: '$retailers.retailerId', offers: { $sum: 1 },
        seen24h: { $sum: { $cond: [{ $gte: ['$retailers.lastSeenAt', since] }, 1, 0] } },
        inStock: { $sum: { $cond: [{ $eq: ['$retailers.stockStatus', 'available'] }, 1, 0] } },
      } },
      { $sort: { offers: -1 } },
    ]).toArray(),
  ]);
  console.log(`\n■ Database ${getMongoConfig().dbName}.products_clean (shopping, groceries excluded)`);
  console.log(`  ${total} products, ${compared} with 2+ retailers (price comparison), ${fresh} updated in the last 24 h`);
  console.log(`  ${pad('retailer', 14)} ${padL('offers', 8)} ${padL('seen 24h', 9)} ${padL('in stock', 9)}`);
  for (const r of byRetailer) console.log(`  ${pad(r._id, 14)} ${padL(r.offers, 8)} ${padL(r.seen24h, 9)} ${padL(r.inStock, 9)}`);
  await closeMongo();
}

export function printDaily(rows: any[]): void {
  const days = [...new Set(rows.map(r => r.day))];
  if (!days.length) { console.log('\nNo daily statistics stored yet (they are written at the end of each bulk run).'); return; }
  console.log(`\n■ Daily statistics (UAE calendar day)`);
  for (const day of days) {
    const all = rows.find(r => r.day === day && r.platform === '_all') ?? {};
    console.log(`\n  ${day}: ${all.runs ?? 0} run(s)${all.dryRuns ? ` (${all.dryRuns} dry)` : ''}, ${all.scraped ?? 0} products scraped, ${all.failed ?? 0} failed pages, ` +
      `${all.inserted ?? 0} new + ${all.updated ?? 0} updated in DB (${all.merged ?? 0} merged), ${all.comparisons ?? 0} cross-platform matches, ` +
      `images ${all.imagesUploaded ?? 0} uploaded / ${all.imagesFailed ?? 0} failed, ${all.credits ?? 0} Scrape.do credits`);
    console.log(`  ${pad('platform', 13)} ${padL('links', 7)} ${padL('scraped', 8)} ${padL('failed', 7)} ${padL('success', 8)} ${padL('credits', 8)}`);
    for (const r of rows.filter(x => x.day === day && x.platform !== '_all')) {
      const rate = r.scraped + r.failed ? `${Math.round((r.scraped / (r.scraped + r.failed)) * 100)}%` : '-';
      console.log(`  ${pad(r.platform, 13)} ${padL(r.links ?? 0, 7)} ${padL(r.scraped ?? 0, 8)} ${padL(r.failed ?? 0, 7)} ${padL(rate, 8)} ${padL(r.credits ?? 0, 8)}`);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const runsAt = args.indexOf('--runs');
  const runs = runsAt >= 0 ? Math.max(1, Number(args[runsAt + 1]) || 1) : 1;
  const dir = process.env.SCRAPER_OUTPUT_DIR || path.join(process.cwd(), 'output');
  const reports = loadReports(dir, runs);
  if (!reports.length) console.log(`No bulk run reports in ${dir} yet.`);
  printReports(reports.slice().reverse());
  if (reports.length > 1) {
    console.log(`\n■ Per platform, last ${reports.length} runs`);
    for (const [site, p] of Object.entries(platformStats(reports))) {
      const rate = p.scraped + p.failed ? Math.round((p.scraped / (p.scraped + p.failed)) * 100) : 0;
      console.log(`  ${pad(site, 12)} ${padL(p.scraped, 6)} ok ${padL(p.failed, 5)} failed (${rate}% success)${p.pending ? `, ${p.pending} pending` : ''}`);
      for (const prob of p.problems.slice(0, 3)) console.log(`      ${prob}`);
    }
  }
  if (args.includes('--import')) {
    const { getMongoDb } = await import('../shared/db/mongo');
    const { BULK_RUNS, BULK_DAILY, ensureStatsIndexes, recordBulkRun } = await import('./shopping-bulk.store');
    const db = await getMongoDb();
    await ensureStatsIndexes(db);
    let imported = 0;
    for (const r of loadReports(dir, 100000)) {
      if (await db.collection(BULK_RUNS).findOne({ startedAt: new Date(r.startedAt) })) continue;
      if (await recordBulkRun({ runs: db.collection(BULK_RUNS), daily: db.collection(BULK_DAILY) }, r)) imported++;
    }
    console.log(`\n[stats] imported ${imported} earlier run report(s)`);
  }
  const dailyAt = args.indexOf('--daily');
  if (dailyAt >= 0) {
    const { getMongoDb, closeMongo } = await import('../shared/db/mongo');
    const { readDailyStats } = await import('./shopping-bulk.store');
    printDaily(await readDailyStats(await getMongoDb(), Math.max(1, Number(args[dailyAt + 1]) || 7)));
    if (!args.includes('--db')) await closeMongo();
  }
  if (args.includes('--db')) await printDb();
}

if (require.main === module) {
  main().catch(e => { console.error(`[stats] ${e?.message ?? e}`); process.exit(1); });
}
