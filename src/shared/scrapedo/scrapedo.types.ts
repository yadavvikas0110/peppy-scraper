// Field names below mirror Scrape.do API query parameters exactly
// (https://scrape.do/documentation/), except `targetHeaders` and `client`,
// which are local-only and never sent as query parameters.

export type ScrapeDoWaitUntil = 'domcontentloaded' | 'load' | 'networkidle0' | 'networkidle2';

export type ScrapeDoDevice = 'desktop' | 'mobile' | 'tablet';

// ─── playWithBrowser actions (sent as a URL-encoded JSON array) ──────────────

export type ScrapeDoBrowserAction =
  | { Action: 'Click'; Selector: string }
  | { Action: 'RealClick'; Selector: string }
  | { Action: 'ClickAndWait'; Selector: string; WaitUntil?: ScrapeDoWaitUntil; Timeout?: number }
  | { Action: 'Tap'; Selector: string }
  | { Action: 'Hover'; Selector: string }
  | { Action: 'Focus'; Selector: string }
  | { Action: 'Wait'; Timeout: number }
  | { Action: 'WaitSelector'; WaitSelector: string; Timeout?: number }
  | { Action: 'WaitForFunction'; Function: string; Timeout?: number }
  | { Action: 'WaitForRequestCompletion'; UrlPattern: string; Timeout?: number }
  | { Action: 'ScrollX'; Value: number }
  | { Action: 'ScrollY'; Value: number }
  | { Action: 'ScrollTo'; Selector: string }
  | { Action: 'Fill'; Selector: string; Value: string }
  | { Action: 'Select'; Selector: string; Value: string }
  | { Action: 'Execute'; Execute: string }
  | { Action: 'RealAction'; Timeout: number };

// ─── Headers forwarded to the target site ────────────────────────────────────

// custom  → customHeaders=true: our headers replace Scrape.do's generated ones
// extra   → extraHeaders=true:  our headers are added on top (sent with the `sd-` prefix)
// forward → forwardHeaders=true: only our headers are sent, nothing auto-generated
export type ScrapeDoHeaderMode = 'custom' | 'extra' | 'forward';

export interface ScrapeDoTargetHeaders {
  mode: ScrapeDoHeaderMode;
  headers: Record<string, string>;
}

// ─── Request options ─────────────────────────────────────────────────────────

export interface ScrapeDoClientOverrides {
  // Retries performed by this client (on top of Scrape.do's internal retries). Overrides SCRAPE_DO_MAX_RETRIES.
  maxRetries?: number;
  // Local HTTP timeout. Overrides SCRAPE_DO_TIMEOUT_MS.
  httpTimeoutMs?: number;
}

export interface ScrapeDoRequestOptions {
  render?: boolean;
  super?: boolean;
  geoCode?: string;
  waitUntil?: ScrapeDoWaitUntil;
  // Milliseconds the headless browser waits after the page loads (0–35000).
  customWait?: number;
  waitSelector?: string;
  blockResources?: boolean;
  device?: ScrapeDoDevice;
  // Sticky proxy session (integer 0–1000000).
  sessionId?: number;
  // Scrape.do server-side timeout in milliseconds (5000–120000, Scrape.do default 60000).
  timeout?: number;
  // Scrape.do internal retry window in milliseconds (Scrape.do default 15000).
  retryTimeout?: number;
  disableRetry?: boolean;
  // Requires render=true. The raw JSON body is returned in `ScrapeDoResponse.html`.
  returnJSON?: boolean;
  // Requires render=true.
  playWithBrowser?: ScrapeDoBrowserAction[];
  setCookies?: string;
  targetHeaders?: ScrapeDoTargetHeaders;
  client?: ScrapeDoClientOverrides;
}

// ─── Response ────────────────────────────────────────────────────────────────

// Parsed returnJSON payload. Only fields documented by Scrape.do are surfaced explicitly;
// everything else stays available on `raw`.
//   networkRequests → XHR/Fetch log captured by the headless browser (never image bodies)
//   actionResults   → one entry per playWithBrowser action, in order (success / error)
export interface ScrapeDoJsonPayload {
  content?: string;
  networkRequests?: unknown[];
  actionResults?: unknown[];
  frames?: unknown[];
  screenShots?: unknown[];
  raw: Record<string, unknown>;
}

export interface ScrapeDoResponse {
  // Raw response body. HTML for normal requests, a JSON string when returnJSON=true.
  html: string;
  statusCode: number;
  // Scrape.do-Initial-Status-Code: first status returned by the target (e.g. 301 before a redirect).
  initialStatusCode?: number;
  // Scrape.do-Resolved-Url when present, otherwise the requested URL.
  finalUrl: string;
  // Scrape.do-Target-Url when present, otherwise the requested URL.
  targetUrl: string;
  resolvedUrl?: string;
  contentType?: string;
  // Scrape.do-Request-Cost
  requestCost?: number;
  // Scrape.do-Remaining-Credits
  remainingCredits?: number;
  attempts: number;
  durationMs: number;
  // Present only when returnJSON=true and the body is a JSON object. `html` still holds the raw body.
  json?: ScrapeDoJsonPayload;
}
