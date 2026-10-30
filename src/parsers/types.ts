export interface ProductData {
  productName: string | null;
  productUrl: string | null;
  imageUrl: string | null;       // primary image (first)
  imageUrls: string[];           // all images from this retailer's page
  price: number | null;
  currency: string | null;
  ratings: number | null;
  reviewCount: number | null;
  description: string | null;
  /** true/false only with evidence on the page; null when the page gives no stock signal */
  inStock: boolean | null;
  category: string | null;
  broadCategory?: string | null;
  subCategory?: string | null;
  /** ISO time the page was fetched — the only timestamp an offer's freshness may be based on */
  scrapedAt?: string;
}

export type Parser = (htmlOrJson: any, url: string) => ProductData;

// --- Stock status ---

export type StockStatus = 'available' | 'unavailable' | 'unknown';

/** Maps a parser's evidence to a status. Missing evidence stays unknown — never guessed. */
export function toStockStatus(inStock: boolean | null | undefined): StockStatus {
  if (inStock === true) return 'available';
  if (inStock === false) return 'unavailable';
  return 'unknown';
}

// --- Bundled product types ---

export interface RetailerOffer {
  retailerId: string;
  retailerName: string;
  price: number | null;
  currency: string;
  inStock: boolean | null;
  stockStatus?: StockStatus;
  productUrl: string | null;
  imageUrl: string | null;
  ratings: number | null;
  reviewCount: number | null;
  /** Marketplace ID (ASIN, SKU) when the URL carries one */
  externalId?: string | null;
  canonicalUrl?: string | null;
  /** ISO time this offer was observed on the retailer's site */
  observedAt?: string | null;
}

export interface BundledProduct {
  name: string | null;
  description: string | null;
  category: string;
  broadCategory: string;
  subCategory: string;
  tags: string[];
  images: string[];
  lowestPrice: number | null;
  highestPrice: number | null;
  rating: number | null;
  reviewCount: number | null;
  retailerCount: number;
  retailers: RetailerOffer[];
  embedding?: number[];
}
