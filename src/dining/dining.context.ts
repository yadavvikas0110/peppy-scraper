import { getMongoDb } from '../shared/db/mongo';
import { createScrapeDoClient } from '../shared/scrapedo/scrapedo.client';
import { ensureDiningIndexes, getDiningCollections } from './db/dining.collections';
import { createDiningRepositories, DiningRepositories } from './dining.persistence';
import type { DiningScrapeContext } from './dining.service';

// Production wiring: env-configured Scrape.do client and MongoDB. Nothing connects at import time;
// the first scrape connects and makes sure the dining_* indexes (unique identities, run lock) exist.

let repositoriesPromise: Promise<DiningRepositories> | null = null;

function getDefaultRepositories(): Promise<DiningRepositories> {
  if (!repositoriesPromise) {
    repositoriesPromise = (async () => {
      const db = await getMongoDb();
      await ensureDiningIndexes(db);
      return createDiningRepositories(getDiningCollections(db));
    })().catch(err => {
      repositoriesPromise = null;
      throw err;
    });
  }
  return repositoriesPromise;
}

export function createDefaultDiningScrapeContext(): DiningScrapeContext {
  return {
    scrapeDo: createScrapeDoClient(),
    repositories: getDefaultRepositories,
    trigger: 'manual',
  };
}
