import type { Request, Response } from 'express';
import { sanitizeRunMessage } from './repositories/scrape-run.repository';
import {
  DiningScrapeRequest,
  DiningScrapeResult,
  isDiningScrapeError,
  validateDiningScrapeRequest,
} from './dining.service';

// HTTP adapter only: validate the body, call the service, shape the response envelope.
// Authentication is applied by the router (requireDiningApiKey) before this runs.

export interface DiningControllerDeps {
  runScrape: (request: DiningScrapeRequest) => Promise<DiningScrapeResult>;
  logger?: Pick<Console, 'error'>;
}

export function createDiningController(deps: DiningControllerDeps) {
  const logger = deps.logger ?? console;

  async function scrape(req: Request, res: Response): Promise<void> {
    const validation = validateDiningScrapeRequest(req.body);
    if (!validation.ok) {
      res.status(400).json({
        success: false,
        message: 'Invalid scrape request',
        error: { stage: 'validation', code: validation.code, details: validation.errors },
      });
      return;
    }

    try {
      const result = await deps.runScrape(validation.value);
      const message = result.dryRun
        ? 'Dining dry run completed (nothing was written)'
        : result.status === 'partial' ? 'Dining scrape completed with rejected records' : 'Dining scrape completed';
      res.status(200).json({ success: true, message, data: result });
    } catch (err) {
      if (isDiningScrapeError(err)) {
        res.status(err.httpStatus).json({
          success: false,
          message: err.message,
          error: { stage: err.stage, code: err.code, ...(err.details !== undefined ? { details: err.details } : {}) },
          ...(err.runId ? { data: { runId: err.runId } } : {}),
        });
        return;
      }
      logger.error(`[dining] Unexpected scrape error: ${sanitizeRunMessage((err as Error)?.message)}`);
      res.status(500).json({ success: false, message: 'Internal error', error: { stage: 'internal', code: 'INTERNAL_ERROR' } });
    }
  }

  return { scrape };
}

export type DiningController = ReturnType<typeof createDiningController>;
