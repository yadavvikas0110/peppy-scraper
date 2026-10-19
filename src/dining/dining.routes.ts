import express, { NextFunction, Request, Response, Router } from 'express';
import { requireDiningApiKey } from './dining.auth';
import type { DiningController } from './dining.controller';
import type { DiningSearchController } from './search/dining-search.controller';

export const DINING_API_BASE = '/api/dining';

// Authentication runs before body parsing, so unauthenticated callers never reach validation.
export function createDiningRouter(controller: DiningController, search?: DiningSearchController): Router {
  const router = Router();
  router.use(requireDiningApiKey);
  router.use(express.json({ limit: '16kb' }));
  router.post('/scrape', controller.scrape);
  if (search) router.get('/search', search.search);
  router.use((err: { type?: string }, _req: Request, res: Response, next: NextFunction) => {
    if (err?.type === 'entity.parse.failed') {
      res.status(400).json({ success: false, message: 'Malformed JSON body', error: { stage: 'validation', code: 'INVALID_JSON' } });
      return;
    }
    if (err?.type === 'entity.too.large') {
      res.status(413).json({ success: false, message: 'Request body too large', error: { stage: 'validation', code: 'BODY_TOO_LARGE' } });
      return;
    }
    next(err);
  });
  return router;
}
