import { timingSafeEqual } from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { getDiningApiKey } from './dining.config';

export const DINING_API_KEY_HEADER = 'x-api-key';

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

// Protects /api/dining/*. Fails closed: if DINING_API_KEY is unset, protected routes are unavailable.
export function requireDiningApiKey(req: Request, res: Response, next: NextFunction): void {
  const expected = getDiningApiKey();
  if (!expected) {
    res.status(503).json({ success: false, message: 'Dining API key is not configured' });
    return;
  }
  const provided = req.header(DINING_API_KEY_HEADER);
  if (!provided || !safeEqual(provided, expected)) {
    res.status(401).json({ success: false, message: 'Invalid or missing API key' });
    return;
  }
  next();
}
