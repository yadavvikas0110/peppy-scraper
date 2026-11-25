/**
 * Product images through Scrape.do, for retailer CDNs that refuse direct downloads
 * (Carrefour's cdn.mafrservices.com answers with an empty HTML page — measured 25 Nov 2026).
 *
 * Hosts listed in SCRAPE_DO_IMAGE_HOSTS (default: cdn.mafrservices.com) are fetched through Scrape.do
 * as binary, checked to really be an image (magic bytes), then uploaded to S3 like any other image.
 * Options are tried cheapest first; each successful response costs Scrape.do credits.
 */
import axios from 'axios';
import { buildScrapeDoUrl } from '../shared/scrapedo/scrapedo.client';
import { getScrapeDoConfig } from '../shared/scrapedo/scrapedo.config';
import type { ScrapeDoRequestOptions } from '../shared/scrapedo/scrapedo.types';

export const DEFAULT_SCRAPE_DO_IMAGE_HOSTS = ['cdn.mafrservices.com'];
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

export function scrapeDoImageHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.SCRAPE_DO_IMAGE_HOSTS;
  if (raw === undefined) return DEFAULT_SCRAPE_DO_IMAGE_HOSTS;
  return raw.split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
}

export function needsScrapeDoForImage(url: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!env.SCRAPE_DO_TOKEN?.trim()) return false;
  let host: string;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  return scrapeDoImageHosts(env).some(h => host === h || host.endsWith(`.${h}`));
}

/** Image type from the file's first bytes (the CDN's content-type is not trusted). */
export function sniffImageType(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buf.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  if (buf.subarray(4, 12).toString('ascii').startsWith('ftypavi')) return 'image/avif';
  return null;
}

const IMAGE_RUNGS: ScrapeDoRequestOptions[] = [{}, { geoCode: 'ae' }, { super: true, geoCode: 'ae' }];

export type HttpGet = (url: string) => Promise<{ status: number; data: Buffer; headers: Record<string, unknown> }>;

const defaultGet: HttpGet = async url => {
  const res = await axios.get<ArrayBuffer>(url, { responseType: 'arraybuffer', timeout: 90_000, maxContentLength: MAX_IMAGE_BYTES, validateStatus: () => true });
  return { status: res.status, data: Buffer.from(res.data), headers: res.headers as Record<string, unknown> };
};

export interface ScrapeDoImageUsage { images: number; failed: number; credits: number }
export const scrapeDoImageUsage: ScrapeDoImageUsage = { images: 0, failed: 0, credits: 0 };

/** Downloads one image through Scrape.do. Throws "Not an image …" when no option returned one. */
export async function fetchImageViaScrapeDo(imageUrl: string, get: HttpGet = defaultGet, env: NodeJS.ProcessEnv = process.env): Promise<{ body: Buffer; contentType: string }> {
  const config = getScrapeDoConfig(env);
  const reasons: string[] = [];
  for (const rung of IMAGE_RUNGS) {
    let res;
    try {
      res = await get(buildScrapeDoUrl(config, imageUrl, { ...rung, timeout: 45_000 }));
    } catch (e: any) {
      reasons.push(`network: ${String(e?.message ?? e).slice(0, 80)}`);
      continue;
    }
    const cost = Number(res.headers['scrape.do-request-cost'] ?? 0);
    if (Number.isFinite(cost)) scrapeDoImageUsage.credits += cost;
    if (res.status === 401 || res.status === 402) throw new Error(`Scrape.do account problem (HTTP ${res.status}) while fetching an image`);
    if (res.status === 404 || res.status === 410) { const e: any = new Error(`Image gone (HTTP ${res.status})`); e.response = { status: res.status }; throw e; }
    const type = res.status === 200 ? sniffImageType(res.data) : null;
    if (type) { scrapeDoImageUsage.images++; return { body: res.data, contentType: type }; }
    reasons.push(`${JSON.stringify(rung)}: HTTP ${res.status}, ${res.data.length} bytes, not an image`);
  }
  scrapeDoImageUsage.failed++;
  throw new Error(`Not an image via Scrape.do (${reasons.join(' | ')}): ${imageUrl}`);
}
