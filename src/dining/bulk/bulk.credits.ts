import axios from 'axios';

export interface ScrapeDoAccountInfo {
  isActive: boolean;
  maxMonthlyRequest: number;
  remainingMonthlyRequest: number;
  concurrentRequest: number;
}

// Scrape.do's account endpoint: free (it does not consume credits). Null when it cannot be read.
export async function fetchScrapeDoAccountInfo(token = process.env.SCRAPE_DO_TOKEN): Promise<ScrapeDoAccountInfo | null> {
  if (!token) return null;
  try {
    const res = await axios.get('https://api.scrape.do/info', { params: { token }, timeout: 15_000 });
    const d = res.data as Record<string, unknown>;
    return {
      isActive: d.IsActive === true,
      maxMonthlyRequest: Number(d.MaxMonthlyRequest),
      remainingMonthlyRequest: Number(d.RemainingMonthlyRequest),
      concurrentRequest: Number(d.ConcurrentRequest),
    };
  } catch {
    return null;
  }
}
