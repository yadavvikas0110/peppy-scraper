import { SiteKey } from './sites';

/**
 * Which sites have an authorized, working data source.
 *
 * Bright Data refuses noon.com (robots.txt / KYC). No other authorized source is configured,
 * so Noon is unsupported: jobs report it as such instead of silently returning no offers, and
 * no workaround transport is used. Once Bright Data approves access for a domain, list the site
 * in BRIGHT_DATA_APPROVED_SITES (comma-separated, e.g. "noon") to enable it.
 */
const KNOWN_BLOCKED: Partial<Record<SiteKey, string>> = {
  noon: 'Bright Data refuses noon.com (robots.txt/KYC restriction) and no other authorized data source is configured',
};

export type SiteSupport = { site: SiteKey; supported: true } | { site: SiteKey; supported: false; reason: string };

export function siteSupport(site: SiteKey, env: NodeJS.ProcessEnv = process.env): SiteSupport {
  const approved = (env.BRIGHT_DATA_APPROVED_SITES || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const reason = KNOWN_BLOCKED[site];
  if (reason && !approved.includes(site)) return { site, supported: false, reason };
  return { site, supported: true };
}

export function partitionSites(sites: SiteKey[], env: NodeJS.ProcessEnv = process.env): {
  supported: SiteKey[];
  unsupported: Array<{ site: SiteKey; reason: string }>;
} {
  const supported: SiteKey[] = [];
  const unsupported: Array<{ site: SiteKey; reason: string }> = [];
  for (const site of sites) {
    const s = siteSupport(site, env);
    if (s.supported) supported.push(site); else unsupported.push({ site, reason: s.reason });
  }
  return { supported, unsupported };
}

export class UnsupportedSitesError extends Error {
  constructor(public readonly unsupported: Array<{ site: SiteKey; reason: string }>) {
    super(`No authorized data source for: ${unsupported.map(u => `${u.site} (${u.reason})`).join('; ')}`);
    this.name = 'UnsupportedSitesError';
  }
}
