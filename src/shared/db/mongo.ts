import { Db, MongoClient, MongoClientOptions } from 'mongodb';

// Generic, lazily-connected MongoDB access for new modules.
// Module 1 keeps its own MongoClient usage (src/cron/push-pipeline.ts); this file is independent of it.

export interface MongoConfig {
  uri: string;
  dbName: string;
}

// Same database Module 1 writes to (`client.db('peppy')`) unless overridden.
export const DEFAULT_DB_NAME = 'peppy';

const DEFAULT_CLIENT_OPTIONS: MongoClientOptions = {
  serverSelectionTimeoutMS: 10000,
};

export function dbNameFromUri(uri: string): string | undefined {
  const match = /^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]*)/.exec(uri);
  if (!match || !match[1]) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

export function redactMongoUri(text: string, uri?: string): string {
  let out = uri ? text.split(uri).join('<MONGODB_URI>') : text;
  out = out.replace(/(mongodb(?:\+srv)?:\/\/)[^@/\s]+@/gi, '$1***@');
  return out;
}

// Precedence: MONGODB_DB → database in MONGODB_URI path → 'peppy'.
export function getMongoConfig(env: NodeJS.ProcessEnv = process.env): MongoConfig {
  const uri = env.MONGODB_URI?.trim();
  if (!uri) throw new Error('MONGODB_URI is not set');
  if (!/^mongodb(\+srv)?:\/\//.test(uri)) throw new Error('MONGODB_URI must start with mongodb:// or mongodb+srv://');
  const dbName = env.MONGODB_DB?.trim() || dbNameFromUri(uri) || DEFAULT_DB_NAME;
  return { uri, dbName };
}

export interface MongoConnection {
  getClient(): Promise<MongoClient>;
  getDb(name?: string): Promise<Db>;
  close(): Promise<void>;
  isConnected(): boolean;
}

export interface MongoConnectionDeps {
  env?: NodeJS.ProcessEnv;
  createClient?: (uri: string, options: MongoClientOptions) => MongoClient;
  options?: MongoClientOptions;
  logger?: Pick<Console, 'log' | 'warn'>;
}

export function createMongoConnection(deps: MongoConnectionDeps = {}): MongoConnection {
  const createClient = deps.createClient ?? ((uri, options) => new MongoClient(uri, options));
  const logger = deps.logger ?? console;
  let client: MongoClient | null = null;
  let connecting: Promise<MongoClient> | null = null;
  let dbName = DEFAULT_DB_NAME;

  async function getClient(): Promise<MongoClient> {
    if (client) return client;
    // Concurrent first callers share one connect attempt.
    if (connecting) return connecting;

    const config = getMongoConfig(deps.env ?? process.env);
    dbName = config.dbName;
    connecting = (async () => {
      const candidate = createClient(config.uri, { ...DEFAULT_CLIENT_OPTIONS, ...deps.options });
      try {
        await candidate.connect();
      } catch (err) {
        await candidate.close().catch(() => {});
        const message = redactMongoUri(String((err as Error)?.message ?? 'unknown error'), config.uri);
        throw new Error(`MongoDB connection failed: ${message}`);
      }
      client = candidate;
      logger.log(`[mongo] Connected (db: ${config.dbName})`);
      return candidate;
    })();

    try {
      return await connecting;
    } finally {
      // On failure the next call retries; on success `client` short-circuits.
      connecting = null;
    }
  }

  async function getDb(name?: string): Promise<Db> {
    const c = await getClient();
    return c.db(name ?? dbName);
  }

  async function close(): Promise<void> {
    const pending = connecting;
    const current = client ?? (pending ? await pending.catch(() => null) : null);
    client = null;
    connecting = null;
    if (current) {
      await current.close();
      logger.log('[mongo] Connection closed');
    }
  }

  return { getClient, getDb, close, isConnected: () => client !== null };
}

const defaultConnection = createMongoConnection();

export const getMongoClient = () => defaultConnection.getClient();
export const getMongoDb = (name?: string) => defaultConnection.getDb(name);
export const closeMongo = () => defaultConnection.close();
