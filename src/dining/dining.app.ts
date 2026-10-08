import express, { Express, NextFunction, Request, Response } from 'express';
import { createDiningController, DiningControllerDeps } from './dining.controller';
import { createDiningRouter, DINING_API_BASE } from './dining.routes';

// Express app for the dining service (no listen()), so tests can start it on an ephemeral port.
export function createDiningApp(deps: DiningControllerDeps): Express {
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (_req, res) => {
    res.json({ success: true, service: 'dining-scraper', status: 'healthy' });
  });

  app.use(DINING_API_BASE, createDiningRouter(createDiningController(deps)));

  app.use((_req, res) => {
    res.status(404).json({ success: false, message: 'Not found' });
  });

  app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ success: false, message: 'Internal error', error: { stage: 'internal', code: 'INTERNAL_ERROR' } });
  });

  return app;
}
