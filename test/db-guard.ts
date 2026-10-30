/// <reference types="node" />
/**
 * Preloaded by every `npm run test:*` script (node --require).
 *
 * 1. Credentials: several modules call dotenv.config() on import, which would load .env's real
 *    Bright Data / scrape.do / OpenAI / Chroma keys and database URI into a test run. dotenv never
 *    overrides a variable that is already defined, so blanking them here keeps tests offline:
 *    every provider client throws "not set" instead of making a paid request.
 * 2. Tests may only reach a local MongoDB; a non-local connect() fails before a socket is opened.
 */
import { MongoClient } from 'mongodb';

for (const name of [
  'BRIGHT_DATA_API_KEY', 'BRIGHT_DATA_BROWSER_AUTH', 'BRIGHT_DATA_UNLOCKER_ZONE', 'SCRAPE_DO_TOKEN',
  'OPENAI_API_KEY', 'CHROMA_API_KEY', 'CHROMA_TENANT', 'CHROMA_DATABASE',
  'MONGODB_URI', 'MONGODB_DB', 'PEPPY_BE_URL', 'SCRAPER_API_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
]) {
  process.env[name] = '';
}

const LOCAL_URI = /^mongodb:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/;

export function isLocalTestUri(uri: unknown): boolean {
  return typeof uri === 'string' && LOCAL_URI.test(uri);
}

const originalConnect = MongoClient.prototype.connect;
MongoClient.prototype.connect = function guardedConnect(this: MongoClient) {
  // `s.url` holds the connection string the client was constructed with
  const uri = (this as unknown as { s?: { url?: string } }).s?.url;
  if (!isLocalTestUri(uri)) {
    return Promise.reject(new Error('Tests may only connect to a local MongoDB (mongodb://localhost or 127.0.0.1)'));
  }
  return originalConnect.call(this);
} as typeof MongoClient.prototype.connect;
