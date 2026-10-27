import { getMongoDb } from '../shared/db/mongo';
import { createScrapeDoClient } from '../shared/scrapedo/scrapedo.client';
import { ObjectId } from 'mongodb';
import { ensureDiningIndexes, getDiningCollections } from './db/dining.collections';
import { createDiningRepositories, DiningRepositories } from './dining.persistence';
import type { DiningScrapeContext } from './dining.service';
import { ensureDiningOfferIndexes, getDiningOfferCollection } from './offers/offer.collections';
import { syncRestaurantOffers } from './offers/offer.repository';
import { autoLinkRestaurant, isAutoLinkEnabled, isAutoVerifyEnabled } from './linking/dining-auto-link';

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

let offerIndexes: Promise<unknown> | null = null;

export function createDefaultDiningScrapeContext(): DiningScrapeContext {
  return {
    scrapeDo: createScrapeDoClient(),
    repositories: getDefaultRepositories,
    trigger: 'manual',
    offerSink: async ({ platform, locale, restaurantId, runId, offers }) => {
      const db = await getMongoDb();
      offerIndexes ??= ensureDiningOfferIndexes(db).catch(err => {
        offerIndexes = null;
        throw err;
      });
      await offerIndexes;
      await syncRestaurantOffers(getDiningOfferCollection(db), {
        platform,
        platformRestaurantId: offers.platformRestaurantId,
        restaurantId: new ObjectId(restaurantId),
        source: 'menu',
        locale,
        offers: offers.offers,
        runId,
      });
    },
    // Links the restaurant across platforms once it has been scraped (DINING_AUTO_LINK=false disables).
    afterScrape: isAutoLinkEnabled()
      ? async ({ restaurantId }) => {
          await autoLinkRestaurant(await getMongoDb(), new ObjectId(restaurantId), { autoVerify: isAutoVerifyEnabled() });
        }
      : undefined,
  };
}
