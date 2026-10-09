import * as http from 'http';
import dotenv from 'dotenv';
import { createDiningApp } from './dining/dining.app';
import { getDiningApiKey, getDiningPort } from './dining/dining.config';
import { createDefaultDiningScrapeContext } from './dining/dining.context';
import { runDiningScrape } from './dining/dining.service';
import { createDefaultDiningSearchService } from './dining/search/dining-search.context';
import { closeMongo } from './shared/db/mongo';

dotenv.config();

const PORT = getDiningPort();
const context = createDefaultDiningScrapeContext();
const app = createDiningApp({ runScrape: request => runDiningScrape(request, context), searchService: createDefaultDiningSearchService() });

const server = http.createServer(app);

server.on('error', (err: NodeJS.ErrnoException) => {
  console.error(`[dining] Failed to start on port ${PORT}: ${err.code ?? err.message}`);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`[dining] Dining scraper service running on http://localhost:${PORT}`);
  console.log(`[dining] Health endpoint: GET http://localhost:${PORT}/health`);
  console.log(`[dining] Scrape endpoint: POST http://localhost:${PORT}/api/dining/scrape (x-api-key required)`);
  console.log(`[dining] Search endpoint: GET http://localhost:${PORT}/api/dining/search?q=... (x-api-key required)`);
  if (!getDiningApiKey()) console.warn('[dining] DINING_API_KEY is not set: scrape endpoints will refuse all requests');
});

function shutdown() {
  console.log('\n[dining] Shutting down...');
  server.close(async () => {
    await closeMongo().catch(err => console.error(`[dining] Mongo close failed: ${err.message}`));
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
