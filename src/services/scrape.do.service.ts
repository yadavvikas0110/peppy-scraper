import { parseAmazonSearch } from '../parsers/search/amazon.search.parser';
import { parseNoonSearch } from '../parsers/search/noon.search.parser';
import { parseCarrefourSearch } from '../parsers/search/carrefour.search.parser';
import { ProductData } from '../parsers/types';
import { fetchHTMLViaUnlocker, scrapeProductBD } from './brightdata.service';
import { fetchListingViaScrapeDo, scrapeDoEnabledForUrl, scrapeProductViaScrapeDo } from './scrapedo-transport';

export async function scrapeProduct(targetUrl: string): Promise<ProductData> {
  return scrapeDoEnabledForUrl(targetUrl) ? scrapeProductViaScrapeDo(targetUrl) : scrapeProductBD(targetUrl);
}

export async function fetchHTML(targetUrl: string): Promise<string> {
  return scrapeDoEnabledForUrl(targetUrl) ? fetchListingViaScrapeDo(targetUrl) : fetchHTMLViaUnlocker(targetUrl);
}

export async function scrapeCategory(targetUrl: string, limit: number = 5): Promise<ProductData[]> {
  const hostname = new URL(targetUrl).hostname;

  let parserFn: (html: string, baseUrl: string) => string[];
  if (hostname.includes('amazon.ae')) {
    parserFn = parseAmazonSearch;
  } else if (hostname.includes('noon.com')) {
    parserFn = parseNoonSearch;
  } else if (hostname.includes('carrefouruae.com')) {
    parserFn = parseCarrefourSearch;
  } else {
    throw new Error('Unsupported e-commerce site for category search: ' + hostname);
  }

  const html = await fetchHTML(targetUrl);
  let links = parserFn(html, targetUrl);

  if (links.length > limit) links = links.slice(0, limit);

  const results: ProductData[] = [];
  const settled = await Promise.all(
    links.map(link =>
      scrapeProduct(link).catch(e => {
        console.error(`Failed to scrape product ${link}:`, e.message);
        return null;
      })
    )
  );

  for (const item of settled) {
    if (item) results.push(item);
  }

  return results;
}
