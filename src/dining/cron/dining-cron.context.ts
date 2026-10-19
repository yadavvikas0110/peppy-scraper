import { getMongoDb } from '../../shared/db/mongo';
import { createDefaultDiningScrapeContext } from '../dining.context';
import type { DiningScrapeContext } from '../dining.service';
import { DiningCronCollections, ensureDiningCronIndexes, getDiningCronCollections } from './dining-cron.collections';
import { DiningCronRunInput, DiningCronRunSummary, runDiningCronJob } from './dining-cron.runner';

// Production wiring for the cron: shared Mongo connection + the normal dining scrape context.
// Nothing connects at import time; the first job connects and ensures the cron indexes.

let collectionsPromise: Promise<DiningCronCollections> | null = null;

export function getDefaultDiningCronCollections(): Promise<DiningCronCollections> {
  if (!collectionsPromise) {
    collectionsPromise = (async () => {
      const db = await getMongoDb();
      await ensureDiningCronIndexes(db);
      return getDiningCronCollections(db);
    })().catch(err => {
      collectionsPromise = null;
      throw err;
    });
  }
  return collectionsPromise;
}

export function createDefaultDiningCronRunner(scrapeContext: DiningScrapeContext = createDefaultDiningScrapeContext()) {
  return (input: DiningCronRunInput): Promise<DiningCronRunSummary> =>
    runDiningCronJob({ collections: getDefaultDiningCronCollections, scrapeContext: { ...scrapeContext, trigger: 'cron' } }, input);
}
