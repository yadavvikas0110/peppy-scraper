/**
 * Master scraping script — 1000 products across electronics, home & appliances.
 * Runs queries sequentially. Each query is independently resumable via checkpoint.
 * Re-running this script skips completed queries and resumes interrupted ones.
 *
 * Usage: npx ts-node scrape-master.ts
 */

import dotenv from 'dotenv';
dotenv.config();

import * as fs from 'fs';
import * as path from 'path';
import { scrapeBulk, withoutEmbeddings } from './src/services/playwright.service';
import { closeBrowser } from './src/services/playwright.service';
import { BundledProduct } from './src/parsers/types';
import { SiteKey } from './src/config/sites';

// ─── Query plan ──────────────────────────────────────────────────────────────
// 11 queries × 4 sites × 25 products = ~1100 raw products → target 1000+ bundles

const ALL_SITES: SiteKey[] = ['amazon', 'noon', 'carrefour', 'sharafdg'];
const ELECTRONICS_SITES: SiteKey[] = ['amazon', 'noon', 'carrefour', 'sharafdg', 'jumbo'];
const BABY_SITES: SiteKey[] = ['mumzworld', 'letstango'];
const FASHION_SITES: SiteKey[] = ['namshi'];

export interface QueryPlan {
  label: string;
  category: string;         // search query string (fallback when no category browse URL)
  categoryKey?: string;     // standardized key mapping to site category browse URLs
  broadCategory: string;    // top-level taxonomy (e.g. "Electronics")
  subCategory: string;      // sub-level taxonomy (e.g. "Smartphones")
  sites: SiteKey[];
  count: number;
}

// Unique per query — several queries share a `category` string (e.g. 'smartphones' on Jumbo and SharafDG)
export function queryKey(q: QueryPlan): string {
  return [q.category.toLowerCase().trim(), [...q.sites].sort().join(','), q.categoryKey ?? ''].join('|');
}

export const QUERIES: QueryPlan[] = [
  // ── Smartphones ────────────────────────────────────────────────────────────
  { label: 'iPhone 16',              category: 'apple iphone 16',                broadCategory: 'Electronics', subCategory: 'Smartphones',           sites: ALL_SITES, count: 20 },
  { label: 'iPhone 15',              category: 'apple iphone 15',                broadCategory: 'Electronics', subCategory: 'Smartphones',           sites: ALL_SITES, count: 20 },
  { label: 'Samsung Galaxy S25',     category: 'samsung galaxy s25',             broadCategory: 'Electronics', subCategory: 'Smartphones',           sites: ALL_SITES, count: 20 },
  { label: 'Samsung Galaxy S24',     category: 'samsung galaxy s24',             broadCategory: 'Electronics', subCategory: 'Smartphones',           sites: ALL_SITES, count: 20 },
  { label: 'Samsung Galaxy A55',     category: 'samsung galaxy a55',             broadCategory: 'Electronics', subCategory: 'Smartphones',           sites: ALL_SITES, count: 15 },
  { label: 'Samsung Galaxy A35',     category: 'samsung galaxy a35',             broadCategory: 'Electronics', subCategory: 'Smartphones',           sites: ALL_SITES, count: 15 },
  { label: 'Xiaomi Smartphone',      category: 'xiaomi smartphone',              broadCategory: 'Electronics', subCategory: 'Smartphones',           sites: ALL_SITES, count: 15 },
  { label: 'OnePlus Smartphone',     category: 'oneplus smartphone',             broadCategory: 'Electronics', subCategory: 'Smartphones',           sites: ALL_SITES, count: 15 },
  { label: 'Huawei Smartphone',      category: 'huawei smartphone',              broadCategory: 'Electronics', subCategory: 'Smartphones',           sites: ALL_SITES, count: 15 },
  { label: 'Google Pixel',           category: 'google pixel 8',                 broadCategory: 'Electronics', subCategory: 'Smartphones',           sites: ALL_SITES, count: 15 },

  // ── Laptops & Computers ────────────────────────────────────────────────────
  { label: 'MacBook Air M3',         category: 'apple macbook air m3',           broadCategory: 'Electronics', subCategory: 'Laptops',               sites: ALL_SITES, count: 20 },
  { label: 'MacBook Pro',            category: 'apple macbook pro',              broadCategory: 'Electronics', subCategory: 'Laptops',               sites: ALL_SITES, count: 15 },
  { label: 'Dell Laptop',            category: 'dell laptop',                    broadCategory: 'Electronics', subCategory: 'Laptops',               sites: ALL_SITES, count: 15 },
  { label: 'HP Laptop',              category: 'hp laptop',                      broadCategory: 'Electronics', subCategory: 'Laptops',               sites: ALL_SITES, count: 15 },
  { label: 'Lenovo ThinkPad',        category: 'lenovo thinkpad laptop',         broadCategory: 'Electronics', subCategory: 'Laptops',               sites: ALL_SITES, count: 15 },
  { label: 'ASUS Gaming Laptop',     category: 'asus gaming laptop',             broadCategory: 'Electronics', subCategory: 'Laptops',               sites: ALL_SITES, count: 15 },
  { label: 'Microsoft Surface',      category: 'microsoft surface laptop',       broadCategory: 'Electronics', subCategory: 'Laptops',               sites: ALL_SITES, count: 15 },

  // ── Tablets ────────────────────────────────────────────────────────────────
  { label: 'iPad Pro',               category: 'apple ipad pro',                 broadCategory: 'Electronics', subCategory: 'Tablets',               sites: ALL_SITES, count: 15 },
  { label: 'iPad Air',               category: 'apple ipad air',                 broadCategory: 'Electronics', subCategory: 'Tablets',               sites: ALL_SITES, count: 15 },
  { label: 'Samsung Galaxy Tab',     category: 'samsung galaxy tab s9',          broadCategory: 'Electronics', subCategory: 'Tablets',               sites: ALL_SITES, count: 15 },

  // ── Audio ──────────────────────────────────────────────────────────────────
  { label: 'AirPods Pro',            category: 'apple airpods pro',              broadCategory: 'Electronics', subCategory: 'Audio & Headphones',    sites: ALL_SITES, count: 15 },
  { label: 'Sony WH Headphones',     category: 'sony wh1000xm5 headphones',      broadCategory: 'Electronics', subCategory: 'Audio & Headphones',    sites: ALL_SITES, count: 15 },
  { label: 'JBL Speaker',            category: 'jbl bluetooth speaker',          broadCategory: 'Electronics', subCategory: 'Audio & Headphones',    sites: ALL_SITES, count: 15 },
  { label: 'Bose Headphones',        category: 'bose noise cancelling headphones', broadCategory: 'Electronics', subCategory: 'Audio & Headphones',  sites: ALL_SITES, count: 15 },
  { label: 'Samsung Soundbar',       category: 'samsung soundbar',               broadCategory: 'Electronics', subCategory: 'Audio & Headphones',    sites: ALL_SITES, count: 15 },

  // ── TVs & Displays ─────────────────────────────────────────────────────────
  { label: 'Samsung QLED 55"',       category: 'samsung qled tv 55 inch',        broadCategory: 'Electronics', subCategory: 'Televisions',           sites: ALL_SITES, count: 15 },
  { label: 'LG OLED TV',             category: 'lg oled tv 55 inch',             broadCategory: 'Electronics', subCategory: 'Televisions',           sites: ALL_SITES, count: 15 },
  { label: 'Sony Bravia TV',         category: 'sony bravia television',         broadCategory: 'Electronics', subCategory: 'Televisions',           sites: ALL_SITES, count: 15 },
  { label: 'TCL Smart TV',           category: 'tcl smart tv 4k',                broadCategory: 'Electronics', subCategory: 'Televisions',           sites: ALL_SITES, count: 15 },
  { label: 'Samsung Monitor',        category: 'samsung curved monitor',         broadCategory: 'Electronics', subCategory: 'Monitors',              sites: ALL_SITES, count: 15 },

  // ── Wearables ──────────────────────────────────────────────────────────────
  { label: 'Apple Watch',            category: 'apple watch series 9',           broadCategory: 'Electronics', subCategory: 'Wearables',             sites: ALL_SITES, count: 15 },
  { label: 'Samsung Galaxy Watch',   category: 'samsung galaxy watch 6',         broadCategory: 'Electronics', subCategory: 'Wearables',             sites: ALL_SITES, count: 15 },
  { label: 'Fitbit Tracker',         category: 'fitbit fitness tracker',         broadCategory: 'Electronics', subCategory: 'Wearables',             sites: ALL_SITES, count: 15 },
  { label: 'Garmin Watch',           category: 'garmin smartwatch',              broadCategory: 'Electronics', subCategory: 'Wearables',             sites: ALL_SITES, count: 15 },

  // ── Gaming ─────────────────────────────────────────────────────────────────
  { label: 'PlayStation 5',          category: 'playstation 5 ps5',              broadCategory: 'Electronics', subCategory: 'Gaming',                sites: ALL_SITES, count: 15 },
  { label: 'Xbox Series X',          category: 'xbox series x',                  broadCategory: 'Electronics', subCategory: 'Gaming',                sites: ALL_SITES, count: 15 },
  { label: 'Gaming Controller',      category: 'gaming controller wireless',     broadCategory: 'Electronics', subCategory: 'Gaming',                sites: ALL_SITES, count: 15 },
  { label: 'Gaming Headset',         category: 'gaming headset ps5',             broadCategory: 'Electronics', subCategory: 'Gaming',                sites: ALL_SITES, count: 15 },

  // ── Cameras ────────────────────────────────────────────────────────────────
  { label: 'Sony Mirrorless Camera', category: 'sony mirrorless camera',         broadCategory: 'Electronics', subCategory: 'Cameras',               sites: ALL_SITES, count: 15 },
  { label: 'Canon DSLR',             category: 'canon dslr camera',              broadCategory: 'Electronics', subCategory: 'Cameras',               sites: ALL_SITES, count: 15 },
  { label: 'GoPro Action Camera',    category: 'gopro action camera',            broadCategory: 'Electronics', subCategory: 'Cameras',               sites: ALL_SITES, count: 15 },

  // ── Smart Home ─────────────────────────────────────────────────────────────
  { label: 'Smart Security Camera',  category: 'wifi security camera indoor',    broadCategory: 'Electronics', subCategory: 'Smart Home',            sites: ALL_SITES, count: 15 },
  { label: 'Smart Doorbell',         category: 'smart video doorbell',           broadCategory: 'Electronics', subCategory: 'Smart Home',            sites: ALL_SITES, count: 15 },
  { label: 'Smart Plug',             category: 'smart plug wifi alexa',          broadCategory: 'Electronics', subCategory: 'Smart Home',            sites: ALL_SITES, count: 15 },
  { label: 'Alexa Echo',             category: 'amazon echo alexa smart speaker', broadCategory: 'Electronics', subCategory: 'Smart Home',           sites: ALL_SITES, count: 15 },

  // ── Kitchen Appliances ─────────────────────────────────────────────────────
  { label: 'Nespresso Machine',      category: 'nespresso coffee machine',       broadCategory: 'Home & Kitchen', subCategory: 'Kitchen Appliances', sites: ALL_SITES, count: 15 },
  { label: 'Philips Air Fryer',      category: 'philips air fryer xxl',          broadCategory: 'Home & Kitchen', subCategory: 'Kitchen Appliances', sites: ALL_SITES, count: 15 },
  { label: 'Instant Pot',            category: 'instant pot pressure cooker',    broadCategory: 'Home & Kitchen', subCategory: 'Kitchen Appliances', sites: ALL_SITES, count: 15 },
  { label: 'KitchenAid Mixer',       category: 'stand mixer kitchen',            broadCategory: 'Home & Kitchen', subCategory: 'Kitchen Appliances', sites: ALL_SITES, count: 15 },
  { label: 'Vitamix Blender',        category: 'blender smoothie maker',         broadCategory: 'Home & Kitchen', subCategory: 'Kitchen Appliances', sites: ALL_SITES, count: 15 },
  { label: 'Microwave Oven',         category: 'microwave oven samsung',         broadCategory: 'Home & Kitchen', subCategory: 'Kitchen Appliances', sites: ALL_SITES, count: 15 },
  { label: 'Electric Kettle',        category: 'electric kettle 1.7l',           broadCategory: 'Home & Kitchen', subCategory: 'Kitchen Appliances', sites: ALL_SITES, count: 15 },
  { label: 'Toaster Oven',           category: 'toaster oven electric',          broadCategory: 'Home & Kitchen', subCategory: 'Kitchen Appliances', sites: ALL_SITES, count: 15 },

  // ── Large Appliances ───────────────────────────────────────────────────────
  { label: 'Samsung Washer',         category: 'samsung washing machine front load', broadCategory: 'Home & Kitchen', subCategory: 'Large Appliances', sites: ALL_SITES, count: 15 },
  { label: 'LG Washer',              category: 'lg washing machine',             broadCategory: 'Home & Kitchen', subCategory: 'Large Appliances',   sites: ALL_SITES, count: 15 },
  { label: 'Samsung Refrigerator',   category: 'samsung refrigerator french door', broadCategory: 'Home & Kitchen', subCategory: 'Large Appliances', sites: ALL_SITES, count: 15 },
  { label: 'LG Refrigerator',        category: 'lg refrigerator double door',    broadCategory: 'Home & Kitchen', subCategory: 'Large Appliances',   sites: ALL_SITES, count: 15 },
  { label: 'Dyson Vacuum',           category: 'dyson vacuum cleaner cordless',  broadCategory: 'Home & Kitchen', subCategory: 'Cleaning Appliances',sites: ALL_SITES, count: 15 },
  { label: 'Robot Vacuum',           category: 'robot vacuum cleaner wifi',      broadCategory: 'Home & Kitchen', subCategory: 'Cleaning Appliances',sites: ALL_SITES, count: 15 },
  { label: 'Split AC 1.5 Ton',       category: 'split air conditioner 1.5 ton',  broadCategory: 'Home & Kitchen', subCategory: 'Air Treatment',      sites: ALL_SITES, count: 15 },
  { label: 'Portable AC',            category: 'portable air conditioner',       broadCategory: 'Home & Kitchen', subCategory: 'Air Treatment',      sites: ALL_SITES, count: 15 },
  { label: 'Dishwasher',             category: 'dishwasher built in',            broadCategory: 'Home & Kitchen', subCategory: 'Large Appliances',   sites: ALL_SITES, count: 15 },
  { label: 'Clothes Dryer',          category: 'clothes dryer heat pump',        broadCategory: 'Home & Kitchen', subCategory: 'Large Appliances',   sites: ALL_SITES, count: 15 },

  // ── Personal Care ──────────────────────────────────────────────────────────
  { label: 'Dyson Hair Dryer',       category: 'dyson hair dryer supersonic',    broadCategory: 'Personal Care', subCategory: 'Hair Care',           sites: ALL_SITES, count: 15 },
  { label: 'Philips Shaver',         category: 'philips electric shaver',        broadCategory: 'Personal Care', subCategory: 'Grooming',            sites: ALL_SITES, count: 15 },
  { label: 'Braun Epilator',         category: 'epilator hair removal',          broadCategory: 'Personal Care', subCategory: 'Grooming',            sites: ALL_SITES, count: 15 },
  { label: 'Electric Toothbrush',    category: 'oral b electric toothbrush',     broadCategory: 'Personal Care', subCategory: 'Oral Care',           sites: ALL_SITES, count: 15 },

  // ── Fitness & Sports ───────────────────────────────────────────────────────
  { label: 'Treadmill',              category: 'treadmill electric home',        broadCategory: 'Fitness & Sports', subCategory: 'Cardio Equipment',  sites: ALL_SITES, count: 15 },
  { label: 'Exercise Bike',          category: 'exercise bike stationary',       broadCategory: 'Fitness & Sports', subCategory: 'Cardio Equipment',  sites: ALL_SITES, count: 15 },
  { label: 'Yoga Mat',               category: 'yoga mat non slip',              broadCategory: 'Fitness & Sports', subCategory: 'Yoga',              sites: ALL_SITES, count: 15 },
  { label: 'Protein Powder',         category: 'whey protein powder',            broadCategory: 'Fitness & Sports', subCategory: 'Supplements & Nutrition', sites: ALL_SITES, count: 15 },

  // ── Home & Furniture ───────────────────────────────────────────────────────
  { label: 'Sofa Set',               category: 'sofa set 3 seater',              broadCategory: 'Home & Kitchen', subCategory: 'Furniture & Bedding',sites: ALL_SITES, count: 15 },
  { label: 'Office Chair',           category: 'ergonomic office chair',         broadCategory: 'Home & Kitchen', subCategory: 'Furniture & Bedding',sites: ALL_SITES, count: 15 },
  { label: 'Bedding Set',            category: 'bedding set queen size',         broadCategory: 'Home & Kitchen', subCategory: 'Furniture & Bedding',sites: ALL_SITES, count: 15 },
  { label: 'Memory Foam Mattress',   category: 'memory foam mattress king',      broadCategory: 'Home & Kitchen', subCategory: 'Furniture & Bedding',sites: ALL_SITES, count: 15 },
  { label: 'Curtains',               category: 'blackout curtains bedroom',      broadCategory: 'Home & Kitchen', subCategory: 'Home Decor',         sites: ALL_SITES, count: 15 },
  { label: 'LED Strip Lights',       category: 'led strip lights smart rgb',     broadCategory: 'Home & Kitchen', subCategory: 'Home Decor',         sites: ALL_SITES, count: 15 },
  { label: 'Air Purifier',           category: 'air purifier hepa filter',       broadCategory: 'Home & Kitchen', subCategory: 'Air Treatment',      sites: ALL_SITES, count: 15 },
  { label: 'Humidifier',             category: 'humidifier cool mist',           broadCategory: 'Home & Kitchen', subCategory: 'Air Treatment',      sites: ALL_SITES, count: 15 },

  // ── Office & Printing ──────────────────────────────────────────────────────
  { label: 'HP Printer',             category: 'hp inkjet printer wireless',     broadCategory: 'Office', subCategory: 'Printers',                   sites: ALL_SITES, count: 15 },
  { label: 'Canon Printer',          category: 'canon all in one printer',       broadCategory: 'Office', subCategory: 'Printers',                   sites: ALL_SITES, count: 15 },
  { label: 'External SSD',           category: 'external ssd 1tb portable',      broadCategory: 'Office', subCategory: 'Storage Devices',            sites: ALL_SITES, count: 15 },
  { label: 'USB Hub',                category: 'usb c hub multiport',            broadCategory: 'Office', subCategory: 'Hubs',                       sites: ALL_SITES, count: 15 },
  { label: 'Webcam',                 category: 'webcam hd 1080p',               broadCategory: 'Office', subCategory: 'Webcams',                    sites: ALL_SITES, count: 15 },

  // ── Jumbo Electronics — category browse pages ──────────────────────────────
  { label: 'Smartphones (Jumbo)',   category: 'smartphones',                    categoryKey: 'smartphones',        broadCategory: 'Electronics', subCategory: 'Smartphones',           sites: ['jumbo'], count: 30 },
  { label: 'Laptops (Jumbo)',       category: 'laptops',                        categoryKey: 'laptops',            broadCategory: 'Electronics', subCategory: 'Laptops',               sites: ['jumbo'], count: 30 },
  { label: 'TVs (Jumbo)',           category: 'televisions',                    categoryKey: 'tvs',                broadCategory: 'Electronics', subCategory: 'Televisions',           sites: ['jumbo'], count: 25 },
  { label: 'Audio (Jumbo)',         category: 'audio headphones',               categoryKey: 'audio',              broadCategory: 'Electronics', subCategory: 'Audio & Headphones',    sites: ['jumbo'], count: 20 },
  { label: 'Gaming (Jumbo)',        category: 'gaming',                         categoryKey: 'gaming',             broadCategory: 'Electronics', subCategory: 'Gaming',                sites: ['jumbo'], count: 20 },
  { label: 'Tablets (Jumbo)',       category: 'tablets',                        categoryKey: 'tablets',            broadCategory: 'Electronics', subCategory: 'Tablets',               sites: ['jumbo'], count: 20 },
  { label: 'Wearables (Jumbo)',     category: 'smart watches',                  categoryKey: 'wearables',          broadCategory: 'Electronics', subCategory: 'Wearables',             sites: ['jumbo'], count: 15 },
  { label: 'Cameras (Jumbo)',       category: 'cameras',                        categoryKey: 'cameras',            broadCategory: 'Electronics', subCategory: 'Cameras',               sites: ['jumbo'], count: 15 },
  { label: 'Kitchen (Jumbo)',       category: 'kitchen appliances',             categoryKey: 'kitchen-appliances', broadCategory: 'Home & Kitchen', subCategory: 'Kitchen Appliances', sites: ['jumbo'], count: 20 },

  // ── SharafDG — category browse pages ──────────────────────────────────────
  { label: 'Smartphones (SharafDG)', category: 'smartphones',                   categoryKey: 'smartphones',        broadCategory: 'Electronics', subCategory: 'Smartphones',           sites: ['sharafdg'], count: 30 },
  { label: 'Laptops (SharafDG)',    category: 'laptops',                        categoryKey: 'laptops',            broadCategory: 'Electronics', subCategory: 'Laptops',               sites: ['sharafdg'], count: 25 },
  { label: 'TVs (SharafDG)',        category: 'televisions',                    categoryKey: 'tvs',                broadCategory: 'Electronics', subCategory: 'Televisions',           sites: ['sharafdg'], count: 25 },
  { label: 'Gaming (SharafDG)',     category: 'gaming',                         categoryKey: 'gaming',             broadCategory: 'Electronics', subCategory: 'Gaming',                sites: ['sharafdg'], count: 20 },
  { label: 'Wearables (SharafDG)',  category: 'smart watches',                  categoryKey: 'wearables',          broadCategory: 'Electronics', subCategory: 'Wearables',             sites: ['sharafdg'], count: 15 },

  // ── Baby & Kids (Mumzworld — category browse + Letstango — Shopify filter) ─
  { label: 'Baby Strollers',        category: 'baby stroller',                  categoryKey: 'baby-strollers',     broadCategory: 'Baby & Kids', subCategory: 'Strollers',             sites: BABY_SITES, count: 25 },
  { label: 'Baby Monitors',         category: 'baby monitor',                   categoryKey: 'baby-monitors',      broadCategory: 'Baby & Kids', subCategory: 'Safety',                sites: ['mumzworld'], count: 20 },
  { label: 'Baby Carriers',         category: 'baby carrier',                   categoryKey: 'baby-carriers',      broadCategory: 'Baby & Kids', subCategory: 'Baby Gear',             sites: ['mumzworld'], count: 20 },
  { label: 'Baby Nursery',          category: 'nursery crib',                   categoryKey: 'nursery',            broadCategory: 'Baby & Kids', subCategory: 'Nursery',               sites: ['mumzworld'], count: 20 },
  { label: 'Baby Feeding',          category: 'baby feeding bottle',            categoryKey: 'baby-feeding',       broadCategory: 'Baby & Kids', subCategory: 'Feeding',               sites: ['mumzworld'], count: 20 },
  { label: 'Baby Care',             category: 'baby care',                      categoryKey: 'baby-care',          broadCategory: 'Baby & Kids', subCategory: 'Baby Care',             sites: ['mumzworld'], count: 20 },
  { label: 'Toys & Games',          category: 'toys games',                     categoryKey: 'toys',               broadCategory: 'Baby & Kids', subCategory: 'Toys & Games',          sites: BABY_SITES, count: 25 },
  { label: 'Baby Clothing',         category: 'baby clothing',                  categoryKey: 'baby-clothing',      broadCategory: 'Baby & Kids', subCategory: 'Clothing',              sites: ['mumzworld'], count: 20 },

  // ── Fashion (Namshi — category browse pages) ───────────────────────────────
  { label: 'Women Fashion',         category: 'women clothing',                 categoryKey: 'women-fashion',      broadCategory: 'Fashion', subCategory: 'Women Clothing',            sites: FASHION_SITES, count: 30 },
  { label: 'Men Fashion',           category: 'men clothing',                   categoryKey: 'men-fashion',        broadCategory: 'Fashion', subCategory: 'Men Clothing',              sites: FASHION_SITES, count: 25 },
  { label: 'Women Shoes',           category: 'women shoes',                    categoryKey: 'women-shoes',        broadCategory: 'Fashion', subCategory: 'Footwear',                  sites: FASHION_SITES, count: 20 },
  { label: 'Men Shoes',             category: 'men shoes',                      categoryKey: 'men-shoes',          broadCategory: 'Fashion', subCategory: 'Footwear',                  sites: FASHION_SITES, count: 20 },
  { label: 'Bags',                  category: 'bags handbags',                  categoryKey: 'bags',               broadCategory: 'Fashion', subCategory: 'Accessories',               sites: FASHION_SITES, count: 20 },
  { label: 'Abayas',                category: 'abayas modest wear',             categoryKey: 'abayas',             broadCategory: 'Fashion', subCategory: 'Modest Wear',               sites: FASHION_SITES, count: 20 },
  { label: 'Kids Fashion',          category: 'kids fashion clothing',          categoryKey: 'kids-fashion',       broadCategory: 'Fashion', subCategory: 'Kids',                      sites: FASHION_SITES, count: 20 },
];

// ─── Master state (tracks completed queries) ──────────────────────────────────

const MASTER_STATE_PATH = path.join(process.cwd(), 'output', 'master_state.json');

interface MasterState {
  startedAt: string;
  completedQueries: string[];         // queryKey() of each finished query
  allBundles: BundledProduct[];
  totalRawScraped: number;
  totalErrors: number;
}

function loadState(): MasterState {
  if (fs.existsSync(MASTER_STATE_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(MASTER_STATE_PATH, 'utf8'));
    } catch {}
  }
  return {
    startedAt: new Date().toISOString(),
    completedQueries: [],
    allBundles: [],
    totalRawScraped: 0,
    totalErrors: 0,
  };
}

function saveState(state: MasterState): void {
  fs.mkdirSync(path.dirname(MASTER_STATE_PATH), { recursive: true });
  fs.writeFileSync(MASTER_STATE_PATH, JSON.stringify({ ...state, allBundles: withoutEmbeddings(state.allBundles) }));
}

// ─── Progress banner ──────────────────────────────────────────────────────────

function printProgress(state: MasterState, current: number, total: number): void {
  const pct = Math.round((current / total) * 100);
  console.log('\n' + '═'.repeat(60));
  console.log(`MASTER PROGRESS: ${current}/${total} queries done (${pct}%)`);
  console.log(`Bundles so far : ${state.allBundles.length}`);
  console.log(`Raw scraped    : ${state.totalRawScraped}`);
  console.log(`Errors         : ${state.totalErrors}`);
  console.log('═'.repeat(60) + '\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const state = loadState();
  const isResume = state.completedQueries.length > 0;

  if (isResume) {
    console.log(`\n[master] Resuming — ${state.completedQueries.length}/${QUERIES.length} queries done, ${state.allBundles.length} bundles so far.\n`);
  } else {
    console.log(`\n[master] Starting fresh — ${QUERIES.length} queries planned.\n`);
  }

  let queryIndex = 0;
  for (const query of QUERIES) {
    queryIndex++;

    if (state.completedQueries.includes(queryKey(query))) {
      console.log(`[master] Skipping "${query.label}" — already done.`);
      continue;
    }

    printProgress(state, queryIndex - 1, QUERIES.length);
    console.log(`[master] ── Query ${queryIndex}/${QUERIES.length}: ${query.label} ──`);

    // Cool-down between queries — lets Unlocker rate limits reset
    if (queryIndex > 1) {
      const cooldown = 15000;
      console.log(`[master] Cooling down ${cooldown / 1000}s before next query...`);
      await new Promise(r => setTimeout(r, cooldown));
    }

    try {
      const result = await scrapeBulk({
        sites: query.sites,
        category: query.category,
        categoryKey: query.categoryKey,
        broadCategory: query.broadCategory,
        subCategory: query.subCategory,
        count: query.count,
      });

      // Merge bundles (dedupe by name across queries)
      state.allBundles.push(...result.bundles);
      state.totalRawScraped += result.totalScraped;
      state.totalErrors += result.errors.length;
      state.completedQueries.push(queryKey(query));
      saveState(state);

      console.log(`[master] "${query.label}" done — ${result.bundleCount} bundles, ${result.totalScraped} raw.`);
    } catch (e: any) {
      console.error(`[master] "${query.label}" FAILED: ${e.message}`);
      // Save state so next run skips completed queries but retries this one
      saveState(state);
    }
  }

  printProgress(state, QUERIES.length, QUERIES.length);

  // ── Save final aggregated output ────────────────────────────────────────────
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputPath = path.join(process.cwd(), 'output', `master_1000products_${timestamp}.json`);

  const finalOutput = {
    generatedAt: new Date().toISOString(),
    totalBundles: state.allBundles.length,
    totalRawScraped: state.totalRawScraped,
    totalErrors: state.totalErrors,
    queriesRun: state.completedQueries.length,
    bundles: state.allBundles,
  };

  fs.writeFileSync(outputPath, JSON.stringify({ ...finalOutput, bundles: withoutEmbeddings(finalOutput.bundles) }));
  console.log(`\n[master] Final output saved → ${outputPath}`);
  console.log(`[master] Total bundles: ${state.allBundles.length} | Raw products: ${state.totalRawScraped}`);

  await closeBrowser();
  process.exit(0);
}

if (require.main === module) {
  main().catch(async e => {
    console.error('[master] Fatal error:', e.message);
    await closeBrowser().catch(() => {});
    process.exit(1);
  });
}
