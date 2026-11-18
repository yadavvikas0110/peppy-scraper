import { fetchHTMLViaUnlocker } from './brightdata.service';
import { fetchSitemapViaScrapeDo, scrapeDoEnabledFor } from './scrapedo-transport';

const SITEMAP_BASE = 'https://www.carrefouruae.com/sitemaps';
const SHARD_COUNT = 36; // products0_en.xml … products35_en.xml

// Tokens that indicate the URL is an accessory/case rather than the device itself
const ACCESSORY_SLUGS = [
  'case', 'cover', 'screen-protector', 'glass', 'charger', 'cable', 'adapter',
  'film', 'pouch', 'stand', 'sleeve', 'bag', 'backpack', 'holder', 'mount',
  'dock', 'hub', 'headset', 'earphone', 'earpiece', 'skin', 'folio', 'wallet',
];

function toSlug(keyword: string): string[] {
  return keyword.toLowerCase().split(/\s+/).filter(t => t.length > 1);
}

function urlMatchesKeyword(url: string, tokens: string[]): boolean {
  const path = url.toLowerCase();
  return tokens.every(t => path.includes(t));
}

function isAccessoryUrl(url: string): boolean {
  const path = url.toLowerCase();
  return ACCESSORY_SLUGS.some(s => path.includes(`/${s}`) || path.includes(`-${s}-`) || path.includes(`-${s}/`));
}

async function fetchShardUrls(shardIndex: number): Promise<string[]> {
  const url = `${SITEMAP_BASE}/products${shardIndex}_en.xml`;
  try {
    const xml = scrapeDoEnabledFor('carrefour') ? await fetchSitemapViaScrapeDo(url) : await fetchHTMLViaUnlocker(url);
    return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  } catch {
    return [];
  }
}

export async function carrefourSitemapSearch(category: string, count: number): Promise<string[]> {
  const tokens = toSlug(category);
  const results: string[] = [];

  // Fetch all shards in parallel (Unlocker semaphore manages concurrency)
  const shardIndices = Array.from({ length: SHARD_COUNT }, (_, i) => i);
  const shardResults = await Promise.all(shardIndices.map(i => fetchShardUrls(i)));

  for (const urls of shardResults) {
    for (const url of urls) {
      if (!urlMatchesKeyword(url, tokens)) continue;
      if (isAccessoryUrl(url)) continue;
      const englishUrl = url.replace('/mafuae/ar/', '/mafuae/en/');
      if (!results.includes(englishUrl)) {
        results.push(englishUrl);
        if (results.length >= count) return results;
      }
    }
  }

  // If not enough non-accessory matches, relax the filter
  if (results.length < count) {
    for (const urls of shardResults) {
      for (const url of urls) {
        if (!urlMatchesKeyword(url, tokens)) continue;
        const englishUrl = url.replace('/mafuae/ar/', '/mafuae/en/');
        if (!results.includes(englishUrl)) {
          results.push(englishUrl);
          if (results.length >= count) return results;
        }
      }
    }
  }

  return results.slice(0, count);
}
