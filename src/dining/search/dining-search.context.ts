import { getMongoDb } from '../../shared/db/mongo';
import { createDiningSearchRepository, DiningSearchRepository, ensureDiningSearchIndexes, getDiningSearchCollections } from './dining-search.repository';
import { createDiningSearchService, DiningSearchService } from './dining-search.service';

// Production wiring: nothing connects at import time; the first search connects and ensures the
// two non-unique search indexes on dining_canonical_items exist.

let repositoryPromise: Promise<DiningSearchRepository> | null = null;

function getDefaultRepository(): Promise<DiningSearchRepository> {
  if (!repositoryPromise) {
    repositoryPromise = (async () => {
      const db = await getMongoDb();
      await ensureDiningSearchIndexes(db);
      return createDiningSearchRepository(getDiningSearchCollections(db));
    })().catch(err => {
      repositoryPromise = null;
      throw err;
    });
  }
  return repositoryPromise;
}

export function createDefaultDiningSearchService(): DiningSearchService {
  return createDiningSearchService(getDefaultRepository);
}
