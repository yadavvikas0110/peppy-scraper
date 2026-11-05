import { getMongoConfig, redactMongoUri } from '../../shared/db/mongo';
import { MongoClient } from 'mongodb';
import { GROCERY_COLLECTIONS, GroceryPlatform, GroceryStore, ensureGroceryIndexes } from './grocery.collections';

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

function store(platform: GroceryPlatform, name: string, area: string): GroceryStore {
  return { storeKey: `${platform}:${slug(name)}`, platform, name, city: 'Dubai', area, isActive: true };
}

// Dubai dark-store master (as provided by ops). Platform-specific scraping addresses (Talabat area
// ids, Deliveroo geohash URLs) are filled into `hubReference` as they are confirmed.
export const GROCERY_STORES: GroceryStore[] = [
  // ── noon Minutes (18) ──
  store('noon-minutes', 'Noon Minutes – Downtown Dubai', 'Burj Khalifa / Boulevard Plaza'),
  store('noon-minutes', 'Noon Minutes – Jumeirah Lakes Towers', 'Goldcrest Views Tower / Cluster V'),
  store('noon-minutes', 'Noon Minutes – Deira', 'Al Sabkha / Al Muteena'),
  store('noon-minutes', 'Noon Minutes – Dubai Silicon Oasis', 'Lynx Tower / Nadd Hessa'),
  store('noon-minutes', 'Noon Minutes – Al Barsha South', 'Arjan Community'),
  store('noon-minutes', 'Noon Minutes – Mirdif', '53rd Street'),
  store('noon-minutes', 'Noon Minutes – Dubai Investments Park 2', 'South Industrial Grid'),
  store('noon-minutes', 'Noon Minutes – Jumeirah Golf Estates', 'Luxury Suburban Hub'),
  store('noon-minutes', 'Noon Minutes – Madinat Al Mataar', 'Airport Residential Zone'),
  store('noon-minutes', 'Noon Minutes – Madinat Hind 3', 'Al Ain Road / Outer Dubailand'),
  store('noon-minutes', 'Noon Minutes – International City', 'Warsan First / France Cluster'),
  store('noon-minutes', 'Noon Minutes – Ras Al Khor Industrial 3', 'Central Logistics Node'),
  store('noon-minutes', 'Noon Minutes – Al Mina', 'Port Rashid Corridor'),
  store('noon-minutes', 'Noon Minutes – Al Twar 5', 'Noon In Minutes 33'),
  store('noon-minutes', 'Noon Minutes – Al Qusais Industrial 4', 'NOON DXB 15'),
  store('noon-minutes', 'Noon Minutes – Wadi Al Safa 2 & 6', 'Dubailand Corridor'),
  store('noon-minutes', 'Noon Minutes – Jumeirah 1', 'Coastal Residential Zone'),
  store('noon-minutes', 'Noon Minutes – IMPZ', 'International Media Production Zone'),
  // ── Talabat Mart (12) ──
  store('talabat', 'Talabat Mart – Dubai Marina', 'Bay Central Tower / Marina View'),
  store('talabat', 'Talabat Mart – Business Bay', 'Executive Towers / Canal'),
  store('talabat', 'Talabat Mart – Dubai Land', 'Turin Boulevard Road / Al Hebiah 1'),
  store('talabat', 'Talabat Mart – Nadd Hessa', 'Dubai Silicon Oasis Boundary'),
  store('talabat', 'Talabat Mart – Warsan', 'Dubai Textile City'),
  store('talabat', 'Talabat Mart – Jumeirah Street', 'Coastal Strip'),
  store('talabat', 'Talabat Mart – Semmer Villas', 'Silicon Oasis Community'),
  store('talabat', 'Talabat Mart – Al Barsha 1', 'TECOM / Barsha'),
  store('talabat', 'Talabat Mart – Al Quoz Industrial 3', 'Industrial Replenishment Hub'),
  store('talabat', 'Talabat Mart – Dubai Investment Park 1', 'Green Community Gateway'),
  store('talabat', 'Talabat Mart – Karama', 'Bur Dubai'),
  store('talabat', 'Talabat Mart – Al Nahda 2', 'Northern Residential Zone'),
  // ── Deliveroo Hop (6) ──
  store('deliveroo', 'Deliveroo Hop – Downtown Dubai', 'Burj Al Nujoom Tower, Shop 6, Al Asayel Street'),
  store('deliveroo', 'Deliveroo Hop – Jumeirah Lakes Towers', 'Goldcrest Views 1, Cluster V'),
  store('deliveroo', 'Deliveroo Hop – Dubai Land', 'Control Tower, Sheikh Mohammed Bin Zayed Road'),
  store('deliveroo', 'Deliveroo Hop – Motor City', 'Business Park Motor City'),
  store('deliveroo', 'Deliveroo Hop – Umm Ramool', 'AJD Building'),
  store('deliveroo', 'Deliveroo Hop – Jebel Ali', '35 Street, Jebel Ali Industrial First'),
];

/** Idempotent upsert of the dark-store master into grocery_stores (keyed by storeKey). */
export async function seedGroceryStores(opts: { dryRun?: boolean } = {}): Promise<{ upserted: number; total: number }> {
  const { uri, dbName } = getMongoConfig();
  if (opts.dryRun) {
    console.log(`[grocery-stores] DRY RUN — would upsert ${GROCERY_STORES.length} stores into ${dbName}.${GROCERY_COLLECTIONS.stores}`);
    return { upserted: 0, total: GROCERY_STORES.length };
  }
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
  try {
    await client.connect();
    const db = client.db(dbName);
    await ensureGroceryIndexes(db);
    const col = db.collection<GroceryStore>(GROCERY_COLLECTIONS.stores);
    const now = new Date();
    const res = await col.bulkWrite(
      GROCERY_STORES.map(s => ({
        updateOne: { filter: { storeKey: s.storeKey }, update: { $set: { ...s, updatedAt: now } }, upsert: true },
      })),
      { ordered: false },
    );
    const upserted = (res.upsertedCount ?? 0) + (res.modifiedCount ?? 0);
    console.log(`[grocery-stores] upserted ${upserted}/${GROCERY_STORES.length} into ${dbName}.${GROCERY_COLLECTIONS.stores}`);
    return { upserted, total: GROCERY_STORES.length };
  } catch (e: any) {
    throw new Error(redactMongoUri(String(e?.message ?? e), uri));
  } finally {
    await client.close().catch(() => {});
  }
}
