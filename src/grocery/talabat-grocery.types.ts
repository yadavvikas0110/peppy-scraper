// Raw shape of a Talabat grocery store/category page, read from
// script#__NEXT_DATA__ → props.pageProps.initialState.
//
// Confirmed from a live capture of
//   /uae/grocery/690014/talabat-mart-just-fruits-veg-jumeirah-1/bananas/local?aid=1172
// Grocery pages use `initialState` (restaurant menu pages use `initialMenuState`).
//
// initialState.groceryStore         — store/dark-store header
// initialState.categories[]         — category tree (id/name/slug/subCategories)
// initialState.itemsData.items[]    — the products shown on this (sub)category page

export interface TalabatGroceryStore {
  /** Branch id — the number in /grocery/<branchId>/<slug>. Stable store identity. */
  branchId?: string;
  /** Store display name, e.g. "just fruits & veg". */
  name?: string;
  isDarkStore?: boolean;
  dhVendorId?: string;
}

/** One grocery product exactly as Talabat serves it (prices already in AED major units). */
export interface TalabatGroceryItem {
  /** Platform item id (uuid). */
  id?: string;
  /** Catalogue SKU — the cross-page stable id we key offers on. */
  sku?: string;
  /** Display name; the pack size is usually embedded here (e.g. "…, 150g"). */
  title: string;
  slug?: string;
  description?: string;
  /** Current selling price in AED. */
  price: number;
  /** Was-price in AED; equal to `price` when there is no discount. */
  originalPrice?: number;
  discountPercentage?: number;
  /** Primary image URL. */
  image?: string;
  /** All image URLs for this item. */
  images: string[];
  /** Units in stock; >0 means available. null when the page gives no signal. */
  stockAmount: number | null;
}

export interface TalabatGroceryParseResult {
  store: TalabatGroceryStore;
  items: TalabatGroceryItem[];
  /** The exact URL that was fetched. */
  sourceUrl: string;
  /** Pagination of the current subcategory listing (1-based). 1/1 when not paginated. */
  currentPage: number;
  pageCount: number;
  /** Non-fatal notes (e.g. payload missing, items skipped). */
  warnings: string[];
}

/** One store found in an area grocery listing. */
export interface StoreRef {
  /** Talabat branch id (the number in /grocery/<id>/<slug>). */
  branchId: string;
  /** Store URL without query, e.g. https://www.talabat.com/uae/grocery/690014/<slug> */
  storeUrl: string;
}

/** A crawlable subcategory listing within a store. */
export interface SubcategoryTarget {
  categorySlug: string;
  subCategorySlug: string;
  /** Talabat's own product count for this subcategory (for estimation; may be approximate). */
  count: number;
}
