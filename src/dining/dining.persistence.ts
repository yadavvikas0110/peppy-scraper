import type { DiningCollections } from './db/dining.collections';
import type { DiningScrapeRunCounts } from './dining.types';
import { emptyScrapeRunCounts } from './dining.types';
import type { DiningMappedMenu, DiningMenuCategoryDto, DiningMenuItemDto } from './platforms/platform.mapper';
import { createMenuCategoryRepository, MenuCategoryRepository } from './repositories/menu-category.repository';
import { createMenuItemRepository, MenuItemRepository } from './repositories/menu-item.repository';
import type { DiningWriteContext, RejectedRecord } from './repositories/repository.types';
import { createRestaurantRepository, RestaurantRepository } from './repositories/restaurant.repository';
import { createScrapeRunRepository, ScrapeRunRepository } from './repositories/scrape-run.repository';

/*
 * Mapped menu → repositories, in order: restaurant → categories → items → inactive marking.
 * No single transaction: each stage is idempotent and a rejected record never blocks the others.
 */

export interface DiningRepositories {
  restaurants: RestaurantRepository;
  categories: MenuCategoryRepository;
  items: MenuItemRepository;
  runs: ScrapeRunRepository;
}

export function createDiningRepositories(collections: DiningCollections): DiningRepositories {
  return {
    restaurants: createRestaurantRepository(collections.restaurants),
    categories: createMenuCategoryRepository(collections.menuCategories),
    items: createMenuItemRepository(collections.menuItems),
    runs: createScrapeRunRepository(collections.scrapeRuns),
  };
}

// ─── Inactive-marking safety guard ───────────────────────────────────────────

export const DINING_INACTIVE_GUARD = {
  // Rejected items (parser + mapper + validation + write) above this share of items seen block it.
  maxRejectedRatio: 0.1,
  // A scrape that keeps fewer than this share of the previously active items is suspicious.
  minRetainedRatio: 0.5,
} as const;

export interface InactiveDecision {
  applied: boolean;
  reasons: string[];
  previousActiveItems: number;
  seenItems: number;
}

export function decideInactiveMarking(input: {
  menu: DiningMappedMenu;
  previousActiveItems: number;
  itemsRejected: number;
  identityDowngrade: boolean;
  allowDeactivation: boolean;
}): InactiveDecision {
  const { menu, previousActiveItems, itemsRejected } = input;
  const seenItems = menu.items.length;
  const reasons: string[] = [];
  if (!input.allowDeactivation) reasons.push('DISABLED_BY_CALLER');
  if (!menu.completeness.complete) reasons.push(...menu.completeness.reasons.map(r => `INCOMPLETE_${r}`));
  if (seenItems === 0) reasons.push('NO_ITEMS');
  if (input.identityDowngrade) reasons.push('IDENTITY_DOWNGRADE');
  const itemsSeen = Math.max(menu.completeness.itemsSeen, seenItems);
  if (itemsSeen > 0 && itemsRejected / itemsSeen > DINING_INACTIVE_GUARD.maxRejectedRatio) reasons.push('TOO_MANY_REJECTED_ITEMS');
  if (previousActiveItems > 0 && seenItems < Math.ceil(previousActiveItems * DINING_INACTIVE_GUARD.minRetainedRatio)) {
    reasons.push('SUSPICIOUS_ITEM_DROP');
  }
  return { applied: reasons.length === 0, reasons: [...new Set(reasons)], previousActiveItems, seenItems };
}

// ─── Persist ─────────────────────────────────────────────────────────────────

export interface PersistOptions extends DiningWriteContext {
  allowDeactivation?: boolean;
}

export interface PersistMenuResult {
  dryRun: boolean;
  restaurantId: string;
  counts: DiningScrapeRunCounts;
  rejected: Array<RejectedRecord & { entity: 'category' | 'item' }>;
  inactive: InactiveDecision;
}

// Records keyed by a weaker identity than the restaurant's active records (e.g. position keys from
// a DOM fallback while ID-keyed items exist) would create duplicates of the same dishes: skip them.
function splitByIdentityStrength<T extends DiningMenuCategoryDto | DiningMenuItemDto>(
  dtos: T[],
  activeKinds: string[]
): { accepted: T[]; downgraded: T[] } {
  if (!activeKinds.includes('id')) return { accepted: dtos, downgraded: [] };
  return {
    accepted: dtos.filter(d => d.sourceKeyKind === 'id'),
    downgraded: dtos.filter(d => d.sourceKeyKind !== 'id'),
  };
}

const downgradeRejection = (sourceKey: string): RejectedRecord => ({
  sourceKey,
  code: 'IDENTITY_DOWNGRADE',
  message: 'Stored records use platform IDs; refusing a weaker (anchor/position) identity that would duplicate them',
});

export async function persistMappedMenu(
  repos: DiningRepositories,
  menu: DiningMappedMenu,
  options: PersistOptions
): Promise<PersistMenuResult> {
  const ctx: DiningWriteContext = { locale: options.locale, runId: options.runId, now: options.now, dryRun: options.dryRun };
  const counts = emptyScrapeRunCounts();
  const rejected: PersistMenuResult['rejected'] = [];

  // 1. Restaurant (failure here is fatal for the scrape).
  const restaurantResult = await repos.restaurants.upsert(menu.restaurant, ctx);
  const restaurant = restaurantResult.restaurant;
  if (restaurantResult.status === 'created') counts.restaurantsCreated = 1;
  else if (restaurantResult.status === 'updated') counts.restaurantsUpdated = 1;
  else counts.restaurantsUnchanged = 1;

  const previousActiveItems = await repos.items.countActive(restaurant);
  const [activeCategoryKinds, activeItemKinds] = await Promise.all([
    repos.categories.activeSourceKeyKinds(restaurant),
    repos.items.activeSourceKeyKinds(restaurant),
  ]);

  // 2. Categories
  const categorySplit = splitByIdentityStrength(menu.categories, activeCategoryKinds);
  const categoryOutcome = await repos.categories.upsertMany(restaurant, categorySplit.accepted, ctx);
  counts.categoriesCreated = categoryOutcome.created;
  counts.categoriesUpdated = categoryOutcome.updated;
  counts.categoriesUnchanged = categoryOutcome.unchanged;
  for (const r of [...categorySplit.downgraded.map(d => downgradeRejection(d.sourceKey)), ...categoryOutcome.rejected]) {
    rejected.push({ ...r, entity: 'category' });
  }
  counts.categoriesRejected = categorySplit.downgraded.length + categoryOutcome.rejected.length;

  // 3. Items (categoryId resolved from the categories written above)
  const itemSplit = splitByIdentityStrength(menu.items, activeItemKinds);
  const itemOutcome = await repos.items.upsertMany(restaurant, itemSplit.accepted, categoryOutcome.idsBySourceKey, ctx);
  counts.itemsSeen = menu.completeness.itemsSeen;
  counts.itemsCreated = itemOutcome.created;
  counts.itemsUpdated = itemOutcome.updated;
  counts.itemsUnchanged = itemOutcome.unchanged;
  for (const r of [...itemSplit.downgraded.map(d => downgradeRejection(d.sourceKey)), ...itemOutcome.rejected]) {
    rejected.push({ ...r, entity: 'item' });
  }
  counts.itemsRejected = menu.completeness.itemsRejected + itemSplit.downgraded.length + itemOutcome.rejected.length;

  // 4. Inactive marking, only for complete and trustworthy scrapes.
  const inactive = decideInactiveMarking({
    menu,
    previousActiveItems,
    itemsRejected: counts.itemsRejected,
    identityDowngrade: itemSplit.downgraded.length > 0 || categorySplit.downgraded.length > 0,
    allowDeactivation: options.allowDeactivation !== false,
  });
  if (inactive.applied) {
    // All keys on the page count as seen, including records rejected above: they still exist.
    counts.itemsMarkedInactive = await repos.items.markMissingInactive(restaurant, menu.items.map(i => i.sourceKey), ctx);
    counts.categoriesMarkedInactive = await repos.categories.markMissingInactive(restaurant, menu.categories.map(c => c.sourceKey), ctx);
  }

  return { dryRun: !!options.dryRun, restaurantId: restaurant._id.toHexString(), counts, rejected, inactive };
}
