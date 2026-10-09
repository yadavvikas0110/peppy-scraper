import type { Request, Response } from 'express';
import { isDiningSearchError } from './dining-search.types';
import { DiningSearchService, safeLogMessage } from './dining-search.service';
import { searchInputFromQueryString } from './dining-search.validation';

// HTTP adapter only: query string → service → envelope. Authentication is applied by the router.

export interface DiningSearchControllerDeps {
  searchService: DiningSearchService;
  logger?: Pick<Console, 'error'>;
}

export function createDiningSearchController(deps: DiningSearchControllerDeps) {
  const logger = deps.logger ?? console;

  async function search(req: Request, res: Response): Promise<void> {
    const parsed = searchInputFromQueryString({ ...(req.query as Record<string, unknown>) });
    if (!parsed.input) {
      res.status(400).json({ success: false, message: 'Invalid search request', error: { stage: 'validation', code: 'INVALID_REQUEST', details: parsed.errors } });
      return;
    }
    try {
      const data = await deps.searchService.search(parsed.input);
      res.status(200).json({ success: true, message: 'Dining search completed', data });
    } catch (err) {
      if (isDiningSearchError(err)) {
        res.status(err.httpStatus).json({
          success: false,
          message: err.message,
          error: { stage: err.code === 'SEARCH_UNAVAILABLE' ? 'search' : 'validation', code: err.code, ...(err.details ? { details: err.details } : {}) },
        });
        return;
      }
      logger.error(`[dining-search] Unexpected search error: ${safeLogMessage(err)}`);
      res.status(500).json({ success: false, message: 'Internal error', error: { stage: 'internal', code: 'INTERNAL_ERROR' } });
    }
  }

  return { search };
}

export type DiningSearchController = ReturnType<typeof createDiningSearchController>;
