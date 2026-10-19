import type { ObjectId } from 'mongodb';
import { sanitizeRunMessage } from '../repositories/scrape-run.repository';
import { buildOffers, computeCheapestOffer, pickLocalized, SearchMappingDoc } from './dining-search.offers';
import { rankCandidates } from './dining-search.ranking';
import type { DiningSearchRepository, SearchCanonicalDoc, SearchGroupDoc } from './dining-search.repository';
import {
  DINING_SEARCH_LIMITS,
  DiningSearchError,
  DiningSearchRequest,
  DiningSearchResponse,
  DisplayField,
  isDiningSearchError,
  SearchCanonicalItem,
  SearchResult,
} from './dining-search.types';
import { normalizeSearchQuery, validateDiningSearchRequest } from './dining-search.validation';

/*
 * Canonical item search + price comparison, independent of Express (HTTP, CLI and tests call it).
 * Read-only; a search costs at most 8 bulk reads whatever the number of results:
 *   candidates (2) → confirmed mappings → [all mappings of those source items, menu items, groups]
 *   → [restaurants, restaurant mappings]
 */

export interface DiningSearchService {
  search(input: unknown): Promise<DiningSearchResponse>;
}

export interface DiningSearchServiceOptions {
  logger?: Pick<Console, 'error'>;
}

const hex = (id: ObjectId) => id.toHexString();
const unique = (ids: ObjectId[]) => [...new Map(ids.map(id => [hex(id), id])).values()];

export function safeLogMessage(err: unknown): string {
  return sanitizeRunMessage((err as Error)?.message)
    .replace(/mongodb(\+srv)?:\/\/\S+/gi, '<mongodb uri>')
    .replace(/\b(token|api[_-]?key|password|passwd|secret|authorization)(\s*[=:]\s*)\S+/gi, '$1$2***');
}

function toCanonicalItem(doc: SearchCanonicalDoc, locale: DiningSearchRequest['locale']): SearchCanonicalItem {
  const fallbackFields: DisplayField[] = [];
  const pick = (field: DisplayField, text: SearchCanonicalDoc['canonicalName'] | undefined) => {
    const picked = pickLocalized(text, locale);
    if (picked.fallback) fallbackFields.push(field);
    return picked.text;
  };
  const display = {
    name: pick('name', doc.canonicalName),
    description: pick('description', doc.canonicalDescription),
    category: pick('category', doc.category),
    fallbackFields,
  };
  return {
    id: hex(doc._id),
    restaurantGroupId: hex(doc.restaurantGroupId),
    name: { ...doc.canonicalName },
    ...(doc.canonicalDescription ? { description: { ...doc.canonicalDescription } } : {}),
    ...(doc.category ? { category: { ...doc.category } } : {}),
    ...(doc.variant ? { variant: doc.variant } : {}),
    display,
  };
}

function toRestaurantGroup(groupId: ObjectId, group: SearchGroupDoc | undefined, locale: DiningSearchRequest['locale']) {
  return {
    restaurantGroupId: hex(groupId),
    name: group ? { ...group.canonicalName } : {},
    displayName: group ? pickLocalized(group.canonicalName, locale).text : null,
    ...(group?.city ? { city: group.city } : {}),
    ...(group?.area ? { area: group.area } : {}),
  };
}

export function createDiningSearchService(
  repository: DiningSearchRepository | (() => Promise<DiningSearchRepository>),
  options: DiningSearchServiceOptions = {}
): DiningSearchService {
  const logger = options.logger ?? console;
  const getRepository = typeof repository === 'function' ? repository : async () => repository;

  async function run(request: DiningSearchRequest): Promise<DiningSearchResponse> {
    const repo = await getRepository();
    const query = normalizeSearchQuery(request.query);
    const prefixTokens = query.tokens.filter(t => t.length >= DINING_SEARCH_LIMITS.minPrefixLength && !/^\d/.test(t));

    const { items, capped } = await repo.findCanonicalCandidates({
      normalizedQuery: query.normalized,
      tokens: query.tokens,
      prefixTokens,
      restaurantGroupId: request.restaurantGroupId,
      cap: DINING_SEARCH_LIMITS.candidateCap,
    });
    let ranked = rankCandidates(items, query, request.locale);

    // With a platform filter, only canonical items that have a confirmed offer on those platforms qualify.
    let mappings: SearchMappingDoc[];
    if (request.platforms) {
      mappings = await repo.findConfirmedMappings(ranked.map(r => r.item._id), request.platforms);
      const withOffer = new Set(mappings.filter(m => m.canonicalItemId).map(m => hex(m.canonicalItemId!)));
      ranked = ranked.filter(r => withOffer.has(hex(r.item._id)));
    }
    const page = ranked.slice(0, request.limit);
    const pageIds = new Set(page.map(r => hex(r.item._id)));
    mappings = request.platforms
      ? mappings!.filter(m => m.canonicalItemId && pageIds.has(hex(m.canonicalItemId)))
      : await repo.findConfirmedMappings(page.map(r => r.item._id));

    const menuItemIds = unique(mappings.map(m => m.menuItemId));
    const [allConfirmed, menuItems, groups] = await Promise.all([
      repo.findConfirmedMappingsForMenuItems(menuItemIds),
      repo.findMenuItems(menuItemIds),
      repo.findRestaurantGroups(unique(page.map(r => r.item.restaurantGroupId))),
    ]);
    const restaurantIds = unique([...menuItems.map(i => i.restaurantId), ...mappings.map(m => m.restaurantId)]);
    const [restaurants, restaurantGroupOf] = await Promise.all([repo.findRestaurants(restaurantIds), repo.findRestaurantGroupIds(restaurantIds)]);

    const canonicalTargets = new Map<string, Set<string>>();
    for (const m of allConfirmed) {
      if (!m.canonicalItemId) continue;
      const key = hex(m.menuItemId);
      canonicalTargets.set(key, (canonicalTargets.get(key) ?? new Set()).add(hex(m.canonicalItemId)));
    }
    const sources = {
      menuItems: new Map(menuItems.map(i => [hex(i._id), i])),
      restaurants: new Map(restaurants.map(r => [hex(r._id), r])),
      restaurantGroupOf,
      conflictingMenuItems: new Set([...canonicalTargets].filter(([, targets]) => targets.size > 1).map(([id]) => id)),
    };
    const groupById = new Map(groups.map(g => [hex(g._id), g]));
    const mappingsByCanonical = new Map<string, SearchMappingDoc[]>();
    for (const m of mappings) {
      if (!m.canonicalItemId) continue;
      const key = hex(m.canonicalItemId);
      mappingsByCanonical.set(key, [...(mappingsByCanonical.get(key) ?? []), m]);
    }

    const results: SearchResult[] = [];
    for (const { item, match } of page) {
      const { offers, excluded } = buildOffers(item, mappingsByCanonical.get(hex(item._id)) ?? [], sources, request.locale);
      if (request.platforms && offers.length === 0) continue;
      results.push({
        canonicalItem: toCanonicalItem(item, request.locale),
        restaurant: toRestaurantGroup(item.restaurantGroupId, groupById.get(hex(item.restaurantGroupId)), request.locale),
        match,
        offers,
        ...computeCheapestOffer(offers),
        excludedOffers: excluded,
      });
    }

    return {
      query: {
        query: request.query,
        normalized: query.normalized,
        tokens: query.tokens,
        locale: request.locale,
        restaurantGroupId: request.restaurantGroupId ? hex(request.restaurantGroupId) : null,
        platforms: request.platforms ?? null,
        limit: request.limit,
      },
      total: results.length,
      truncated: capped || ranked.length > request.limit,
      results,
    };
  }

  return {
    async search(input) {
      const validation = validateDiningSearchRequest(input);
      if (!validation.ok) throw new DiningSearchError(validation.code, 400, 'Invalid search request', validation.errors);
      try {
        return await run(validation.value);
      } catch (err) {
        if (isDiningSearchError(err)) throw err;
        logger.error(`[dining-search] Search failed: ${safeLogMessage(err)}`);
        throw new DiningSearchError('SEARCH_UNAVAILABLE', 503, 'Search is temporarily unavailable');
      }
    },
  };
}
