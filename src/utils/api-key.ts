import { timingSafeEqual } from 'crypto';
import * as http from 'http';
import { NextFunction, Request, Response } from 'express';

export const SCRAPER_API_KEY_HEADER = 'x-api-key';

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function expectedKey(): string | undefined {
  return process.env.SCRAPER_API_KEY?.trim() || undefined;
}

export function isApiKeyEnforced(): boolean {
  return !!expectedKey();
}

// Opt-in: when SCRAPER_API_KEY is unset the routes stay open (existing deployments keep
// working) and a warning is logged at startup. Set it here and in peppy-be to enforce.
export function requireScraperApiKey(req: Request, res: Response, next: NextFunction): void {
  const expected = expectedKey();
  if (!expected) return next();
  const provided = req.header(SCRAPER_API_KEY_HEADER);
  if (!provided || !safeEqual(provided, expected)) {
    res.status(401).json({ error: 'Invalid or missing API key' });
    return;
  }
  next();
}

// Browsers cannot set headers on a WebSocket handshake, so `?key=` is accepted as well
export function isAuthorizedUpgrade(req: http.IncomingMessage): boolean {
  const expected = expectedKey();
  if (!expected) return true;
  const header = req.headers[SCRAPER_API_KEY_HEADER];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  const fromQuery = new URL(req.url ?? '/', 'http://localhost').searchParams.get('key') ?? undefined;
  const provided = fromHeader ?? fromQuery;
  return !!provided && safeEqual(provided, expected);
}
