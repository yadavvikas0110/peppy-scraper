/**
 * Read-only quality report for a scrape: reads back every product of a scrape output file from
 * the database and checks identity, price, stock, mapping and duplicates.
 *
 * Usage: node --env-file=.env.dev dist/src/worker/ingest-report.js <output-file.json>
 */
import 'dotenv/config';
import * as fs from 'fs';
import { getMongoConfig, getMongoDb, closeMongo } from '../shared/db/mongo';
import { BundledProduct } from '../parsers/types';
import { productRoleOf } from '../services/bundler.service';

export interface ProductCheck {
  asin: string;
  name: string;
  problems: string[];
  row: Record<string, string | number | null>;
}

/** Checks one stored product against what was scraped. Pure, so it is unit-tested. */
export function checkStoredProduct(asin: string, scrapedAt: string | null, docs: any[]): ProductCheck {
  const problems: string[] = [];
  if (docs.length === 0) return { asin, name: '—', problems: ['not stored'], row: {} };
  if (docs.length > 1) problems.push(`duplicate: ${docs.length} products share this ASIN`);
  const doc = docs[0];
  const offer = (doc.retailers ?? []).find((r: any) => r.retailerId === 'amazon' && r.externalId === asin);
  if (!offer) return { asin, name: doc.name, problems: [...problems, 'amazon offer missing'], row: {} };

  if (!/^https:\/\/(www\.)?amazon\.ae\//.test(offer.productUrl ?? '')) problems.push(`url not amazon.ae: ${offer.productUrl}`);
  if (offer.canonicalUrl !== `https://amazon.ae/dp/${asin}`) problems.push(`canonicalUrl ${offer.canonicalUrl}`);
  if (offer.price !== undefined && offer.currency !== 'AED') problems.push(`currency ${offer.currency}`);
  if (!['available', 'unavailable', 'unknown'].includes(offer.stockStatus)) problems.push(`stockStatus ${offer.stockStatus}`);
  if (offer.stockStatus === 'unknown' && offer.inStock !== null) problems.push('unknown stock stored with a boolean inStock');
  if (!doc.images?.length) problems.push('no images');
  if (!doc.categories?.length) problems.push('categories empty');
  if (!Array.isArray(doc.discoveryCategories)) problems.push('discoveryCategories missing');
  if (!doc.productRole) problems.push('productRole missing');
  if (doc.ingestMappingStatus !== 'mapped') problems.push(`mapping ${doc.ingestMappingStatus ?? 'missing'}`);
  if (!doc.variantMappingStatus) problems.push('variant mapping missing');
  if (productRoleOf(doc.name) === 'accessory' && doc.productRole === 'main_product') problems.push('accessory title mapped as main_product');

  const others = (doc.retailers ?? []).filter((r: any) => r !== offer);
  const confirmed = (doc.retailers ?? []).filter((r: any) => r.stockStatus === 'available' && !r.isStale && r.price > 0).map((r: any) => r.price);
  const expectedBest = confirmed.length ? Math.min(...confirmed) : null;
  if ((doc.bestConfirmedPrice ?? null) !== expectedBest) problems.push(`bestConfirmedPrice ${doc.bestConfirmedPrice} ≠ ${expectedBest}`);
  if (scrapedAt && offer.lastSeenAt && new Date(offer.lastSeenAt).toISOString() !== scrapedAt) {
    problems.push(`lastSeenAt ${new Date(offer.lastSeenAt).toISOString()} ≠ scraped ${scrapedAt}`);
  }

  return {
    asin,
    name: doc.name,
    problems,
    row: {
      price: offer.price ?? null,
      stock: offer.stockStatus,
      images: doc.images?.length ?? 0,
      brand: doc.brand ?? null,
      role: doc.productRole ?? null,
      categories: (doc.categories ?? []).join('|'),
      discovery: (doc.discoveryCategories ?? []).join('|') || '—',
      variant: doc.variantGroupId ? `${doc.variantMappingStatus}:${String(doc.variantGroupId).slice(0, 10)}` : (doc.variantMappingStatus ?? null),
      lowest: doc.lowestPrice ?? null,
      bestConfirmed: doc.bestConfirmedPrice ?? null,
      otherRetailers: others.map((r: any) => `${r.retailerId}:${r.price}:${r.stockStatus ?? (r.inStock === false ? 'unavailable' : r.inStock ? 'available' : 'unknown')}`).join(' ') || '—',
      seen: offer.lastSeenAt ? new Date(offer.lastSeenAt).toISOString() : null,
    },
  };
}

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('Usage: ingest-report <scrape-output.json>');
  const out = JSON.parse(fs.readFileSync(file, 'utf8'));
  const bundles: BundledProduct[] = out.bundles ?? [];
  const offers = bundles.flatMap(b => b.retailers.filter(r => r.retailerId === 'amazon' && r.externalId).map(r => ({ asin: r.externalId!, scrapedAt: r.observedAt ?? null })));

  console.log(`[report] database: ${getMongoConfig().dbName} | file: ${file}`);
  console.log(`[report] job status: ${out.status} | sites: ${(out.siteResults ?? []).map((s: any) => `${s.site}=${s.status}`).join(', ')} | bundles: ${bundles.length} | match reviews: ${(out.matchReviews ?? []).length}`);
  const col = (await getMongoDb()).collection('products_clean');
  const checks: ProductCheck[] = [];
  for (const { asin, scrapedAt } of offers) {
    const docs = await col.find({ retailers: { $elemMatch: { retailerId: 'amazon', externalId: asin } } }).toArray();
    checks.push(checkStoredProduct(asin, scrapedAt, docs));
  }
  for (const c of checks) {
    console.log(`\n${c.problems.length ? '✗' : '✓'} ${c.asin}  ${c.name.slice(0, 80)}`);
    console.log('   ' + Object.entries(c.row).map(([k, v]) => `${k}=${v}`).join('  '));
    for (const p of c.problems) console.log(`   ! ${p}`);
  }
  const bad = checks.filter(c => c.problems.length);
  console.log(`\n[report] ${checks.length - bad.length}/${checks.length} products pass all checks`);
  await closeMongo();
  if (bad.length) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(async e => { console.error(`[report] ${e.message}`); await closeMongo().catch(() => {}); process.exit(1); });
}
