#!/usr/bin/env node

/**
 * Real-time Polymarket BTC 5m Up/Down orderbook watcher
 * + save all orderbook snapshots into one CSV per 5-minute market
 *
 * Usage:
 *   node orderbook_5m.js
 *   node orderbook_5m.js btc-updown-5m-1773345300
 *   node orderbook_5m.js --interval=500
 */

const fs = require("fs");
const path = require("path");

const GAMMA_HOST = "https://gamma-api.polymarket.com";
const CLOB_HOST = "https://clob.polymarket.com";
const MARKET_INTERVAL_SEC = 300; // 5 minutes
const DEFAULT_ASSET = "btc";
const DEFAULT_INTERVAL_MS = 500;
const OUTPUT_DIR = path.join(process.cwd(), "orderbook_logs");
const TOP_TICKS = 5;

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function isoNow() {
  return new Date().toLocaleString("sv-SE", { timeZone: "America/New_York" });
}

function isoNowUtc() {
  return new Date().toISOString();
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
  let intervalMs = DEFAULT_INTERVAL_MS;

  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--interval=")) {
      const value = Number(arg.split("=")[1]);
      if (Number.isFinite(value) && value >= 100) intervalMs = value;
    } else if (!arg.startsWith("--") && !inputSlug) {
      inputSlug = arg;
    }
  }

  return { inputSlug, intervalMs };
}

function buildCandidateSlugs(asset = DEFAULT_ASSET) {
  const now = nowUnix();
  const currentBucket = Math.floor(now / MARKET_INTERVAL_SEC) * MARKET_INTERVAL_SEC;
  const prevBucket = currentBucket - MARKET_INTERVAL_SEC;

  return [
    `${asset}-updown-5m-${currentBucket}`,
    `${asset}-updown-5m-${prevBucket}`,
  ];
}

async function getJson(url) {
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "node-orderbook-5m/1.0" },
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

  // extract start unix timestamp from slug (btc-updown-5m-{ts})
  const slugMatch = (raw.slug || "").match(/btc-updown-5m-(\d+)/);
  const startTimeSec = slugMatch ? Number(slugMatch[1]) : null;

  return {
    slug: raw.slug,
    question: raw.question,
    conditionId: raw.conditionId,
    endDate: raw.endDate,
    outcomes,
    upTokenId: clobTokenIds[safeUpIndex] || "",
    downTokenId: clobTokenIds[safeDownIndex] || "",
    startTimeSec,
  };
}

// Pyth oracle — same source Polymarket uses
let _pythBtcFeedId = null;

function parsePythPrice(priceObj) {
  return Number(priceObj.price) * Math.pow(10, priceObj.expo);
}

async function getPythBtcFeedId() {
  if (_pythBtcFeedId) return _pythBtcFeedId;
  const data = await getJson("https://hermes.pyth.network/v2/price_feeds?query=BTC%2FUSD&asset_type=crypto");
  const feed = data.find(f => f.attributes?.base === "BTC" && f.attributes?.quote_currency === "USD");
  if (!feed) throw new Error("Pyth BTC/USD feed not found");
  _pythBtcFeedId = "0x" + feed.id.replace(/^0x/, "");
  return _pythBtcFeedId;
}

async function fetchBtcPrice() {
  try {
    const feedId = await getPythBtcFeedId();
    const data = await getJson(`https://hermes.pyth.network/v2/updates/price/latest?ids[]=${feedId}`);
    return parsePythPrice(data.parsed[0].price);
  } catch { return null; }
}

async function fetchPriceToBeat(startTimeSec) {
  try {
    const feedId = await getPythBtcFeedId();
    const data = await getJson(`https://hermes.pyth.network/v2/updates/price/${startTimeSec}?ids[]=${feedId}`);
    if (!data?.parsed?.[0]) return null;
    return parsePythPrice(data.parsed[0].price);
  } catch { return null; }
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

async function resolveMarket(inputSlug) {
  if (inputSlug) {
    const raw = await fetchMarketBySlug(inputSlug);
    if (!raw) throw new Error(`Market not found for slug: ${inputSlug}`);
    return parseMarket(raw);
  }

  for (const slug of buildCandidateSlugs(DEFAULT_ASSET)) {
    try {
      const raw = await fetchMarketBySlug(slug);
      if (raw) return parseMarket(raw);
    } catch { /* try next */ }
  }

  throw new Error("Could not find active/current BTC 5m market");
}

async function fetchBook(tokenId) {
  return getJson(`${CLOB_HOST}/book?token_id=${encodeURIComponent(tokenId)}`);
}

function normalizeLevels(levels) {
  if (!Array.isArray(levels)) return [];
  return levels
    .map(x => ({ price: Number(x.price), size: Number(x.size) }))
    .filter(x => Number.isFinite(x.price) && Number.isFinite(x.size));
}

function sortBidsDesc(levels) {
  return [...levels].sort((a, b) => b.price !== a.price ? b.price - a.price : b.size - a.size);
}

function sortAsksAsc(levels) {
  return [...levels].sort((a, b) => a.price !== b.price ? a.price - b.price : b.size - a.size);
}

function summarizeBook(book) {
  const allBids = sortBidsDesc(normalizeLevels(book.bids));
  const allAsks = sortAsksAsc(normalizeLevels(book.asks));

  const bestBid = allBids.length ? allBids[0].price : null;
  const bestAsk = allAsks.length ? allAsks[0].price : null;

  const bids = allBids.slice(0, TOP_TICKS);
  const asks = allAsks.slice(0, TOP_TICKS);

  const spread = bestBid !== null && bestAsk !== null
    ? Number((bestAsk - bestBid).toFixed(6))
    : null;

  return {
    market: book.market,
    assetId: book.asset_id,
    timestamp: book.timestamp,
    hash: book.hash ?? "",
    bestBid,
    bestAsk,
    spread,
    bidSize: bids.length ? bids[0].size : 0,
    askSize: asks.length ? asks[0].size : 0,
    bidDepthAll: bids.reduce((s, x) => s + x.size, 0),
    askDepthAll: asks.reduce((s, x) => s + x.size, 0),
    minOrderSize: book.min_order_size,
    tickSize: book.tick_size,
    bids,
    asks,
    rawBidCount: Array.isArray(book.bids) ? book.bids.length : 0,
    rawAskCount: Array.isArray(book.asks) ? book.asks.length : 0,
  };
}

function movementArrow(current, previous) {
  if (current == null || previous == null) return " ";
  if (current > previous) return "↑";
  if (current < previous) return "↓";
  return "→";
}

function fmtNum(v, digits = 3) {
  if (v == null || Number.isNaN(v)) return "-";
  return Number(v).toFixed(digits);
}

function fmtSize(v) {
  if (v == null || Number.isNaN(v)) return "-";
  return Number(v).toFixed(2);
}

function renderAsks(label, summary, prevSummary) {
  const askMove = movementArrow(summary.bestAsk, prevSummary?.bestAsk);
  console.log(`\n=== ${label} asks (5 ticks near best ask) ===`);
  console.log(`bestAsk      : ${fmtNum(summary.bestAsk)} ${askMove}`);
  console.log(`topAskSize   : ${fmtSize(summary.askSize)} shares`);
  console.log(`askDepth (5) : ${fmtSize(summary.askDepthAll)} shares`);
  console.log(`rawAskCount  : ${summary.rawAskCount}`);
  console.log("");

  if (summary.asks.length === 0) {
    console.log("  -");
  } else {
    for (let i = 0; i < summary.asks.length; i++) {
      const row = summary.asks[i];
      const usdc = (row.price * row.size).toFixed(2);
      console.log(`  [${i + 1}] ${fmtNum(row.price)} x ${fmtSize(row.size)} shares  (~$${usdc} USDC)`);
    }
  }
}

function renderScreen({ market, up, prevUp, down, prevDown, pollCount, intervalMs, fetchMs, csvPath, btcPrice, priceToBeat }) {
  clearScreen();

  const left = timeLeft(market.endDate);
  const diff = btcPrice != null && priceToBeat != null ? btcPrice - priceToBeat : null;
  const diffStr = diff != null ? `${diff >= 0 ? "+" : ""}${diff.toFixed(2)}` : "-";

  console.log("=== BTC 5m Polymarket ===");
  console.log(`Time         : ${isoNow()} ET`);
  console.log(`Market       : ${market.slug}`);
  console.log(`Time left    : ${left}`);
  console.log(`Price to beat: ${priceToBeat != null ? "$" + priceToBeat.toFixed(2) : "-"}`);
  console.log(`BTC price    : ${btcPrice != null ? "$" + btcPrice.toFixed(2) : "-"}`);
  console.log(`Difference   : ${diffStr}`);
  console.log(`Poll #       : ${pollCount}  |  target ${intervalMs}ms  actual ${fetchMs}ms  |  CSV: ${csvPath}`);

  renderAsks("UP", up, prevUp);
  renderAsks("DOWN", down, prevDown);

  console.log("\nPress Ctrl+C to stop.");
}

function escapeCsv(value) {
  if (value == null) return "";
  const s = String(value);
  if (s.includes('"') || s.includes(",") || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function getCsvPathForMarket(slug) {
  return path.join(OUTPUT_DIR, `${slug}.csv`);
}

function ensureCsvHeader(csvPath) {
  if (fs.existsSync(csvPath)) return;

  const header = [
    "captured_at_et", "captured_at_utc", "poll_count", "market_slug",
    "question", "condition_id", "end_date", "market_book_id", "outcome_side",
    "token_id", "book_timestamp", "book_hash", "min_order_size", "tick_size",
    "best_bid", "best_ask", "spread", "top_bid_size", "top_ask_size",
    "bid_depth_all", "ask_depth_all", "bid_levels", "ask_levels",
    "raw_bid_count", "raw_ask_count", "level_type", "level_index", "price", "size",
  ].join(",");

  fs.writeFileSync(csvPath, header + "\n", "utf8");
}

function buildCsvRowsForSide({ market, summary, outcomeSide, capturedAtEt, capturedAtUtc, pollCount }) {
  const rows = [];

  const common = [
    capturedAtEt, capturedAtUtc, pollCount, market.slug, market.question,
    market.conditionId, market.endDate, summary.market, outcomeSide,
    summary.assetId, summary.timestamp, summary.hash, summary.minOrderSize,
    summary.tickSize, summary.bestBid, summary.bestAsk, summary.spread,
    summary.bidSize, summary.askSize, summary.bidDepthAll, summary.askDepthAll,
    summary.bids.length, summary.asks.length, summary.rawBidCount, summary.rawAskCount,
  ];

  for (let i = 0; i < summary.bids.length; i++) {
    rows.push([...common, "bid", i, summary.bids[i].price, summary.bids[i].size]);
  }
  for (let i = 0; i < summary.asks.length; i++) {
    rows.push([...common, "ask", i, summary.asks[i].price, summary.asks[i].size]);
  }
  if (rows.length === 0) {
    rows.push([...common, "", "", "", ""]);
  }

  return rows;
}

function appendSnapshotToCsv({ market, up, down, pollCount }) {
  ensureDir(OUTPUT_DIR);

  const csvPath = getCsvPathForMarket(market.slug);
  ensureCsvHeader(csvPath);

  const capturedAtEt = isoNow();
  const capturedAtUtc = isoNowUtc();

  const upRows = buildCsvRowsForSide({ market, summary: up, outcomeSide: "UP", capturedAtEt, capturedAtUtc, pollCount });
  const downRows = buildCsvRowsForSide({ market, summary: down, outcomeSide: "DOWN", capturedAtEt, capturedAtUtc, pollCount });

  const lines = [...upRows, ...downRows]
    .map(row => row.map(escapeCsv).join(","))
    .join("\n") + "\n";

  fs.appendFileSync(csvPath, lines, "utf8");
  return csvPath;
}

function currentMarketSlugFromTime() {
  const bucket = Math.floor(nowUnix() / MARKET_INTERVAL_SEC) * MARKET_INTERVAL_SEC;
  return `btc-updown-5m-${bucket}`;
}

async function main() {
  const { inputSlug, intervalMs } = parseArgs(process.argv);

  ensureDir(OUTPUT_DIR);

  // --- slow-changing state (refreshed on market rollover only) ---
  let cachedMarket = null;
  let cachedPriceToBeat = null;

  // --- fast-changing state ---
  let prevUp = null;
  let prevDown = null;
  let pollCount = 0;
  let failureCount = 0;

  // Resolve market + priceToBeat once upfront, then only on rollover
  async function refreshMarket() {
    cachedMarket = await resolveMarket(inputSlug);
    if (!cachedMarket.upTokenId || !cachedMarket.downTokenId) {
      throw new Error(`Missing Up/Down token IDs for market ${cachedMarket.slug}`);
    }
    cachedPriceToBeat = cachedMarket.startTimeSec
      ? await fetchPriceToBeat(cachedMarket.startTimeSec)
      : null;
    prevUp = null;
    prevDown = null;
  }

  await refreshMarket();

  while (true) {
    try {
      // Detect market rollover (every 5 min) and refresh slow data
      const expectedSlug = inputSlug || currentMarketSlugFromTime();
      if (cachedMarket.slug !== expectedSlug) {
        await refreshMarket();
      }

      // Hot path: only fetch orderbooks + live price (3 parallel requests)
      const t0 = Date.now();
      const [upBookRaw, downBookRaw, btcPrice] = await Promise.all([
        fetchBook(cachedMarket.upTokenId),
        fetchBook(cachedMarket.downTokenId),
        fetchBtcPrice(),
      ]);
      const fetchMs = Date.now() - t0;

      const up = summarizeBook(upBookRaw);
      const down = summarizeBook(downBookRaw);
      pollCount += 1;
      failureCount = 0;

      const csvPath = appendSnapshotToCsv({ market: cachedMarket, up, down, pollCount });

      renderScreen({
        market: cachedMarket,
        up, prevUp,
        down, prevDown,
        pollCount, intervalMs, fetchMs, csvPath,
        btcPrice,
        priceToBeat: cachedPriceToBeat,
      });

      prevUp = up;
      prevDown = down;
    } catch (err) {
      failureCount += 1;
      clearScreen();
      console.error("Polymarket BTC 5m real-time orderbook");
      console.error(`Updated      : ${isoNow()} ET`);
      console.error(`Poll #       : ${pollCount}`);
      console.error(`Failures     : ${failureCount}`);
      console.error(`Output dir   : ${OUTPUT_DIR}`);
      console.error("\nERROR:");
      console.error(err.message || err);
      console.error(`\nRetrying in ${intervalMs} ms...`);
    }

    await sleep(intervalMs);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
