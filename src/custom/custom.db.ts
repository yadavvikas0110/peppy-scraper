import { MongoClient } from 'mongodb';
import { assertSafeWriteTarget, dbNameFromUri, redactMongoUri } from '../shared/db/mongo';
import type { ProductsCollection } from '../cron/push-pipeline';

/**
 * Write target for the custom scraper — its OWN variables, never the shared MONGODB_URI, so it
 * cannot inherit the production pipeline's database from .env.
 *
 *   CUSTOM_MONGODB_URI   connection string (required for --push)
 *   CUSTOM_MONGODB_DB    database name (default: the one in the URI path)
 *   CUSTOM_DB_ALLOWLIST  comma-separated database names it may write to (default: "dev")
 *
 * The production pipeline writes to "peppy" (src/shared/db/mongo.ts DEFAULT_DB_NAME), which the
 * shared production-name guard does not catch — hence an explicit allowlist here.
 */
export interface CustomDbTarget { uri: string; dbName: string }

export function customDbTarget(env: NodeJS.ProcessEnv = process.env): CustomDbTarget {
  const uri = env.CUSTOM_MONGODB_URI?.trim();
  if (!uri) throw new Error('CUSTOM_MONGODB_URI is not set (see .env.custom)');
  const dbName = env.CUSTOM_MONGODB_DB?.trim() || dbNameFromUri(uri);
  if (!dbName) throw new Error('No database name: set CUSTOM_MONGODB_DB or put it in the CUSTOM_MONGODB_URI path');
  const allow = (env.CUSTOM_DB_ALLOWLIST || 'dev').split(',').map(s => s.trim()).filter(Boolean);
  if (!allow.includes(dbName)) {
    throw new Error(`Refusing to write to database "${dbName}": not in CUSTOM_DB_ALLOWLIST (${allow.join(', ')})`);
  }
  // Production-name guard as a second line (CONFIRM_PRODUCTION_DB is deliberately not passed through)
  assertSafeWriteTarget({ MONGODB_URI: uri, MONGODB_DB: dbName });
  return { uri, dbName };
}

export function describeTarget(t: CustomDbTarget): string {
  const host = /^mongodb(?:\+srv)?:\/\/(?:[^@/]+@)?([^/?]+)/.exec(t.uri)?.[1] ?? '?';
  return `${host}/${t.dbName}.products_clean`;
}

export async function withCustomProductsCollection<T>(
  target: CustomDbTarget,
  fn: (col: ProductsCollection) => Promise<T>,
): Promise<T> {
  const client = new MongoClient(target.uri, { serverSelectionTimeoutMS: 15000 });
  try {
    await client.connect();
    return await fn(client.db(target.dbName).collection('products_clean') as unknown as ProductsCollection);
  } catch (e: any) {
    throw new Error(redactMongoUri(String(e?.message ?? e), target.uri));
  } finally {
    await client.close().catch(() => {});
  }
}
