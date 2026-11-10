import express, { Express, NextFunction, Request, Response } from 'express';
import { createDiningController, DiningControllerDeps } from './dining.controller';
import { createDiningRouter, DINING_API_BASE } from './dining.routes';
import { createDiningSearchController } from './search/dining-search.controller';
import type { DiningSearchService } from './search/dining-search.service';

export interface DiningAppDeps extends DiningControllerDeps {
  // GET /api/dining/search is only mounted when a search service is provided.
  searchService?: DiningSearchService;
  // Cron control endpoints are only mounted when the scheduler handle is provided
  // (null = config error → the endpoints answer 503; undefined = not mounted).
  cronControl?: import('./cron/dining-cron.scheduler').DiningCronScheduler | null;
}

// Express app for the dining service (no listen()), so tests can start it on an ephemeral port.
export function createDiningApp(deps: DiningAppDeps): Express {
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (_req, res) => {
    res.json({ success: true, service: 'dining-scraper', status: 'healthy' });
  });

  const search = deps.searchService ? createDiningSearchController({ searchService: deps.searchService, logger: deps.logger }) : undefined;
  app.use(DINING_API_BASE, createDiningRouter(createDiningController(deps), search, deps.cronControl));

  app.use((_req, res) => {
    res.status(404).json({ success: false, message: 'Not found' });
  });

  app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ success: false, message: 'Internal error', error: { stage: 'internal', code: 'INTERNAL_ERROR' } });
  });

  return app;
}
