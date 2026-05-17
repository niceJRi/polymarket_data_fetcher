#!/usr/bin/env node

/**
 * Real-time Polymarket BTC Up/Down best-ask watcher
 * Saves timestamp, up_ask, down_ask to CSV every second.
 *
 * Usage:
 *   node orderbook.js                          # 15m market (default)
 *   node orderbook.js --market=5m              # 5m market
 *   node orderbook.js --market=15m             # 15m market
 *   node orderbook.js btc-updown-15m-1773345300  # specific slug
 */

const fs = require("fs");
const path = require("path");

const GAMMA_HOST = "https://gamma-api.polymarket.com";
const CLOB_HOST = "https://clob.polymarket.com";
const DEFAULT_ASSET = "btc";
const POLL_INTERVAL_MS = 1000;
const OUTPUT_DIR = path.join(process.cwd(), "orderbook_logs");

const MARKET_INTERVALS = {
  "5m": 300,
  "15m": 900,
};
const DEFAULT_MARKET_INTERVAL = "15m";

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function isoNow() {
  return new Date().toLocaleString("sv-SE", { timeZone: "America/New_York" });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function clearScreen() {
  process.stdout.write("\x1Bc");
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function parseArgs(argv) {
  let inputSlug = null;
  let marketInterval = DEFAULT_MARKET_INTERVAL;

  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--market=")) {
      const val = arg.split("=")[1];
      if (MARKET_INTERVALS[val]) marketInterval = val;
    } else if (!arg.startsWith("--") && !inputSlug) {
      inputSlug = arg;
    }
  }

  return { inputSlug, marketInterval };
}

function buildCandidateSlugs(asset, marketInterval) {
  const intervalSec = MARKET_INTERVALS[marketInterval];
  const now = nowUnix();
  const currentBucket = Math.floor(now / intervalSec) * intervalSec;
  const prevBucket = currentBucket - intervalSec;
  return [
    `${asset}-updown-${marketInterval}-${currentBucket}`,
    `${asset}-updown-${marketInterval}-${prevBucket}`,
  ];
}

async function getJson(url) {
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "node-orderbook-realtime/2.0" },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} for ${url}\n${text}`);
  }
  return res.json();
}

async function fetchMarketBySlug(slug) {
  const url = `${GAMMA_HOST}/markets?slug=${encodeURIComponent(slug)}`;
  const items = await getJson(url);
  if (!Array.isArray(items) || items.length === 0) return null;
  return items[0];
}

function parseMaybeJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return []; }
  }
  return [];
}

function parseMarket(raw) {
  const outcomes = parseMaybeJsonArray(raw.outcomes);
  const clobTokenIds = parseMaybeJsonArray(raw.clobTokenIds).map(String);

  const upIndex = outcomes.findIndex(x => String(x).toLowerCase().includes("up"));
  const downIndex = outcomes.findIndex(x => String(x).toLowerCase().includes("down"));

  const safeUpIndex = upIndex >= 0 ? upIndex : 0;
  const safeDownIndex = downIndex >= 0 ? downIndex : (clobTokenIds.length > 1 ? 1 : 0);

  return {
    slug: raw.slug,
    question: raw.question,
    endDate: raw.endDate,
    upTokenId: clobTokenIds[safeUpIndex] || "",
    downTokenId: clobTokenIds[safeDownIndex] || "",
  };
}

async function resolveMarket(inputSlug, marketInterval) {
  if (inputSlug) {
    const raw = await fetchMarketBySlug(inputSlug);
    if (!raw) throw new Error(`Market not found for slug: ${inputSlug}`);
    return parseMarket(raw);
  }

  const candidates = buildCandidateSlugs(DEFAULT_ASSET, marketInterval);
  for (const slug of candidates) {
    try {
      const raw = await fetchMarketBySlug(slug);
      if (raw) return parseMarket(raw);
    } catch { /* try next */ }
  }

  throw new Error(`Could not find active BTC ${marketInterval} market`);
}

async function fetchBook(tokenId) {
  return getJson(`${CLOB_HOST}/book?token_id=${encodeURIComponent(tokenId)}`);
}

function getBestAsk(book) {
  if (!Array.isArray(book.asks) || book.asks.length === 0) return null;
  return book.asks
    .map(x => Number(x.price))
    .filter(p => Number.isFinite(p))
    .reduce((min, p) => (p < min ? p : min), Infinity);
}

function timeLeft(endDateStr) {
  if (!endDateStr) return "--:--";
  const diffMs = Date.parse(endDateStr) - Date.now();
  if (!Number.isFinite(diffMs) || diffMs <= 0) return "00:00";
  const totalSec = Math.floor(diffMs / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function renderScreen({ market, upAsk, downAsk, pollCount, csvPath, marketInterval }) {
  clearScreen();
  console.log(`=== BTC ${marketInterval} Polymarket — Best Ask Watcher ===`);
  console.log(`Time     : ${isoNow()} ET`);
  console.log(`Market   : ${market.slug}`);
  console.log(`Time left: ${timeLeft(market.endDate)}`);
  console.log(`Poll #   : ${pollCount}  |  ${POLL_INTERVAL_MS}ms  |  CSV: ${path.basename(csvPath)}`);
  console.log("");
  console.log(`UP   ask : ${upAsk != null ? upAsk.toFixed(4) : "-"}`);
  console.log(`DOWN ask : ${downAsk != null ? downAsk.toFixed(4) : "-"}`);
  console.log("\nPress Ctrl+C to stop.");
}

function getCsvPath(slug) {
  return path.join(OUTPUT_DIR, `${slug}_best_ask.csv`);
}

function ensureCsvHeader(csvPath) {
  if (fs.existsSync(csvPath)) return;
  fs.writeFileSync(csvPath, "timestamp,up_ask,down_ask\n", "utf8");
}

function appendCsvRow(csvPath, timestamp, upAsk, downAsk) {
  const up = upAsk != null ? upAsk.toFixed(4) : "";
  const down = downAsk != null ? downAsk.toFixed(4) : "";
  fs.appendFileSync(csvPath, `${timestamp},${up},${down}\n`, "utf8");
}

async function main() {
  const { inputSlug, marketInterval } = parseArgs(process.argv);
  ensureDir(OUTPUT_DIR);

  let pollCount = 0;
  let failureCount = 0;
  let currentMarketSlug = null;
  let csvPath = null;

  while (true) {
    try {
      const market = await resolveMarket(inputSlug, marketInterval);

      if (!market.upTokenId || !market.downTokenId) {
        throw new Error(`Missing Up/Down token IDs for market ${market.slug}`);
      }

      if (currentMarketSlug !== market.slug) {
        currentMarketSlug = market.slug;
        csvPath = getCsvPath(market.slug);
        ensureCsvHeader(csvPath);
      }

      const [upBook, downBook] = await Promise.all([
        fetchBook(market.upTokenId),
        fetchBook(market.downTokenId),
      ]);

      const upAsk = getBestAsk(upBook);
      const downAsk = getBestAsk(downBook);
      const timestamp = nowUnix();

      pollCount += 1;
      failureCount = 0;

      appendCsvRow(csvPath, timestamp, upAsk, downAsk);
      renderScreen({ market, upAsk, downAsk, pollCount, csvPath, marketInterval });

    } catch (err) {
      failureCount += 1;
      clearScreen();
      console.error(`BTC ${marketInterval} best-ask watcher`);
      console.error(`Updated  : ${isoNow()} ET`);
      console.error(`Poll #   : ${pollCount}  |  Failures: ${failureCount}`);
      console.error(`\nERROR: ${err.message || err}`);
      console.error(`\nRetrying in ${POLL_INTERVAL_MS}ms...`);
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
