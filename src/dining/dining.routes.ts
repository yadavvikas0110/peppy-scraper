import express, { NextFunction, Request, Response, Router } from 'express';
import { requireDiningApiKey } from './dining.auth';
import type { DiningController } from './dining.controller';
import type { DiningCronScheduler } from './cron/dining-cron.scheduler';
import type { DiningSearchController } from './search/dining-search.controller';

export const DINING_API_BASE = '/api/dining';

// Authentication runs before body parsing, so unauthenticated callers never reach validation.
// `cronControl` mounts the admin start/stop/status endpoints for the daily refresh job; pass the
// scheduler handle (or null when its config is broken — the routes then answer 503).
export function createDiningRouter(
  controller: DiningController,
  search?: DiningSearchController,
  cronControl?: DiningCronScheduler | null,
): Router {
  const router = Router();
  router.use(requireDiningApiKey);
  router.use(express.json({ limit: '16kb' }));
  router.post('/scrape', controller.scrape);
  if (search) router.get('/search', search.search);

  if (cronControl !== undefined) {
    const unavailable = (res: Response) =>
      res.status(503).json({ success: false, message: 'Dining cron control unavailable (invalid DINING_CRON_* configuration)' });

    router.get('/cron/status', (_req, res) => {
      if (!cronControl) return unavailable(res);
      res.json({
        success: true,
        enabled: cronControl.scheduled,
        running: cronControl.isRunning(),
        schedule: cronControl.config.schedule,
        timezone: cronControl.config.timezone,
        maxTargets: cronControl.config.maxTargets,
        nextRun: cronControl.nextRun()?.toISOString() ?? null,
      });
    });

    router.post('/cron/trigger', (_req, res) => {
      if (!cronControl) return unavailable(res);
      if (cronControl.isRunning()) {
        return res.json({ success: true, triggered: false, reason: 'A dining refresh is already running' });
      }
      void cronControl.trigger('manual');
      res.json({ success: true, triggered: true });
    });

    router.post('/cron/stop', (_req, res) => {
      if (!cronControl) return unavailable(res);
      const stopped = cronControl.stopCurrent();
      res.json({ success: true, stopped, ...(stopped ? {} : { reason: 'No dining refresh is running' }) });
    });
  }
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
