#!/usr/bin/env node

/**
 * Real-time Polymarket BTC 5m Up/Down full orderbook watcher
 * + save all orderbook snapshots into one CSV per 5-minute market
 *
 * Usage:
 *   node fetch_btc_5m_orderbook_realtime.js
 *   node fetch_btc_5m_orderbook_realtime.js btc-updown-5m-1773345300
 *   node fetch_btc_5m_orderbook_realtime.js --interval=2000
 *   node fetch_btc_5m_orderbook_realtime.js btc-updown-5m-1773345300 --interval=1000
 *
 * Notes:
 * - Public data only, no auth needed
 * - If no slug is passed, it keeps resolving the current BTC 5m market
 * - It refreshes the terminal on every poll
 * - Shows full orderbook, not just top 5 levels
 * - Saves one CSV file per 5-minute market
 */

const fs = require("fs");
const path = require("path");

const GAMMA_HOST = "https://gamma-api.polymarket.com";
const CLOB_HOST = "https://clob.polymarket.com";
const MARKET_INTERVAL_SEC = 300;
const DEFAULT_ASSET = "btc";
const DEFAULT_INTERVAL_MS = 2000;
const OUTPUT_DIR = path.join(process.cwd(), "orderbook_logs");

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function isoNow() {
  return new Date().toLocaleString("sv-SE", {
    timeZone: "America/New_York",
  });
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
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function parseArgs(argv) {
  let inputSlug = null;
  let intervalMs = DEFAULT_INTERVAL_MS;

  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--interval=")) {
      const value = Number(arg.split("=")[1]);
      if (Number.isFinite(value) && value >= 250) {
        intervalMs = value;
      }
    } else if (!arg.startsWith("--") && !inputSlug) {
      inputSlug = arg;
    }
  }

  return { inputSlug, intervalMs };
}

function buildCandidateSlugs(asset = DEFAULT_ASSET) {
  const now = nowUnix();
  const currentBucket = Math.floor(now / MARKET_INTERVAL_SEC) * MARKET_INTERVAL_SEC;
  const prevBucket = Math.floor((now - MARKET_INTERVAL_SEC) / MARKET_INTERVAL_SEC) * MARKET_INTERVAL_SEC;

  return [
    `${asset}-updown-5m-${currentBucket}`,
    `${asset}-updown-5m-${prevBucket}`,
  ];
}

async function getJson(url) {
  const res = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "node-orderbook-realtime/1.3",
    },
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
  if (!Array.isArray(items) || items.length === 0) {
    return null;
  }
  return items[0];
}

function parseMaybeJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return [];
    }
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
    conditionId: raw.conditionId,
    endDate: raw.endDate,
    outcomes,
    upTokenId: clobTokenIds[safeUpIndex] || "",
    downTokenId: clobTokenIds[safeDownIndex] || "",
  };
}

async function resolveMarket(inputSlug) {
  if (inputSlug) {
    const raw = await fetchMarketBySlug(inputSlug);
    if (!raw) {
      throw new Error(`Market not found for slug: ${inputSlug}`);
    }
    return parseMarket(raw);
  }

  const candidates = buildCandidateSlugs(DEFAULT_ASSET);
  for (const slug of candidates) {
    try {
      const raw = await fetchMarketBySlug(slug);
      if (raw) {
        return parseMarket(raw);
      }
    } catch {
      // try next
    }
  }

  throw new Error("Could not find active/current BTC 5m market");
}

async function fetchBook(tokenId) {
  const url = `${CLOB_HOST}/book?token_id=${encodeURIComponent(tokenId)}`;
  return getJson(url);
}

function normalizeLevels(levels) {
  if (!Array.isArray(levels)) return [];

  return levels
    .map(x => ({
      price: Number(x.price),
      size: Number(x.size),
    }))
    .filter(x => Number.isFinite(x.price) && Number.isFinite(x.size));
}

function sortBidsDesc(levels) {
  return [...levels].sort((a, b) => {
    if (b.price !== a.price) return b.price - a.price;
    return b.size - a.size;
  });
}

function sortAsksAsc(levels) {
  return [...levels].sort((a, b) => {
    if (a.price !== b.price) return a.price - b.price;
    return b.size - a.size;
  });
}

function summarizeBook(book) {
  const allBids = sortBidsDesc(normalizeLevels(book.bids));
  const allAsks = sortAsksAsc(normalizeLevels(book.asks));

  const bestBid = allBids.length ? allBids[0].price : null;
  const bestAsk = allAsks.length ? allAsks[0].price : null;

  const bidDepthAll = allBids.reduce((sum, x) => sum + x.size, 0);
  const askDepthAll = allAsks.reduce((sum, x) => sum + x.size, 0);

  const spread =
    bestBid !== null && bestAsk !== null
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
    bidSize: allBids.length ? allBids[0].size : 0,
    askSize: allAsks.length ? allAsks[0].size : 0,
    bidDepthAll,
    askDepthAll,
    minOrderSize: book.min_order_size,
    tickSize: book.tick_size,
    bids: allBids,
    asks: allAsks,
    rawBidCount: Array.isArray(book.bids) ? book.bids.length : 0,
    rawAskCount: Array.isArray(book.asks) ? book.asks.length : 0,
  };
}

function movementArrow(current, previous) {
  if (current == null) return " ";
  if (previous == null) return " ";
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

function renderLevels(title, bids, asks) {
  console.log(title);

  console.log("  BIDS (best -> worse)");
  if (bids.length === 0) {
    console.log("    -");
  } else {
    for (const row of bids) {
      console.log(`    ${fmtNum(row.price)} x ${fmtSize(row.size)}`);
    }
  }

  console.log("  ASKS (best -> worse)");
  if (asks.length === 0) {
    console.log("    -");
  } else {
    for (const row of asks) {
      console.log(`    ${fmtNum(row.price)} x ${fmtSize(row.size)}`);
    }
  }
}

function renderSide(name, summary, prevSummary) {
  const bidMove = movementArrow(summary.bestBid, prevSummary?.bestBid);
  const askMove = movementArrow(summary.bestAsk, prevSummary?.bestAsk);

  console.log(`\n=== ${name} ===`);
  console.log(`assetId      : ${summary.assetId}`);
  console.log(`timestamp    : ${summary.timestamp}`);
  console.log(`bestBid      : ${fmtNum(summary.bestBid)} ${bidMove}`);
  console.log(`bestAsk      : ${fmtNum(summary.bestAsk)} ${askMove}`);
  console.log(`spread       : ${fmtNum(summary.spread, 6)}`);
  console.log(`topBidSize   : ${fmtSize(summary.bidSize)}`);
  console.log(`topAskSize   : ${fmtSize(summary.askSize)}`);
  console.log(`bidDepthAll  : ${fmtSize(summary.bidDepthAll)}`);
  console.log(`askDepthAll  : ${fmtSize(summary.askDepthAll)}`);
  console.log(`bidLevels    : ${summary.bids.length}`);
  console.log(`askLevels    : ${summary.asks.length}`);
  console.log(`rawBidCount  : ${summary.rawBidCount}`);
  console.log(`rawAskCount  : ${summary.rawAskCount}`);
  console.log(`minOrderSize : ${summary.minOrderSize}`);
  console.log(`tickSize     : ${summary.tickSize}`);

  renderLevels("Full orderbook", summary.bids, summary.asks);
}

function renderScreen({ market, up, down, prevUp, prevDown, pollCount, intervalMs, csvPath }) {
  clearScreen();

  const combinedBestAsk =
    up.bestAsk != null && down.bestAsk != null
      ? up.bestAsk + down.bestAsk
      : null;

  const combinedBestBid =
    up.bestBid != null && down.bestBid != null
      ? up.bestBid + down.bestBid
      : null;

  const inefficiency =
    combinedBestAsk != null && combinedBestBid != null
      ? combinedBestAsk - combinedBestBid
      : null;

  console.log("Polymarket BTC 5m real-time FULL orderbook");
  console.log(`Updated      : ${isoNow()} ET`);
  console.log(`Poll #       : ${pollCount}`);
  console.log(`Interval     : ${intervalMs} ms`);
  console.log(`CSV file     : ${csvPath}`);
  console.log(`Market slug  : ${market.slug}`);
  console.log(`Question     : ${market.question}`);
  console.log(`ConditionId  : ${market.conditionId}`);
  console.log(`End date     : ${market.endDate}`);
  console.log(`Outcomes     : ${market.outcomes.join(", ")}`);
  console.log(`Up token     : ${market.upTokenId}`);
  console.log(`Down token   : ${market.downTokenId}`);

  renderSide("UP", up, prevUp);
  renderSide("DOWN", down, prevDown);

  console.log("\n=== COMBINED ===");
  console.log(`bestBid Up+Down : ${fmtNum(combinedBestBid)}`);
  console.log(`bestAsk Up+Down : ${fmtNum(combinedBestAsk)}`);
  console.log(`mid inefficiency: ${fmtNum(inefficiency, 6)}`);

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
    "captured_at_et",
    "captured_at_utc",
    "poll_count",
    "market_slug",
    "question",
    "condition_id",
    "end_date",
    "market_book_id",
    "outcome_side",
    "token_id",
    "book_timestamp",
    "book_hash",
    "min_order_size",
    "tick_size",
    "best_bid",
    "best_ask",
    "spread",
    "top_bid_size",
    "top_ask_size",
    "bid_depth_all",
    "ask_depth_all",
    "bid_levels",
    "ask_levels",
    "raw_bid_count",
    "raw_ask_count",
    "level_type",
    "level_index",
    "price",
    "size",
  ].join(",");

  fs.writeFileSync(csvPath, header + "\n", "utf8");
}

function buildCsvRowsForSide({
  market,
  summary,
  outcomeSide,
  capturedAtEt,
  capturedAtUtc,
  pollCount,
}) {
  const rows = [];

  const common = {
    capturedAtEt,
    capturedAtUtc,
    pollCount,
    marketSlug: market.slug,
    question: market.question,
    conditionId: market.conditionId,
    endDate: market.endDate,
    marketBookId: summary.market,
    outcomeSide,
    tokenId: summary.assetId,
    bookTimestamp: summary.timestamp,
    bookHash: summary.hash,
    minOrderSize: summary.minOrderSize,
    tickSize: summary.tickSize,
    bestBid: summary.bestBid,
    bestAsk: summary.bestAsk,
    spread: summary.spread,
    topBidSize: summary.bidSize,
    topAskSize: summary.askSize,
    bidDepthAll: summary.bidDepthAll,
    askDepthAll: summary.askDepthAll,
    bidLevels: summary.bids.length,
    askLevels: summary.asks.length,
    rawBidCount: summary.rawBidCount,
    rawAskCount: summary.rawAskCount,
  };

  for (let i = 0; i < summary.bids.length; i++) {
    const level = summary.bids[i];
    rows.push([
      common.capturedAtEt,
      common.capturedAtUtc,
      common.pollCount,
      common.marketSlug,
      common.question,
      common.conditionId,
      common.endDate,
      common.marketBookId,
      common.outcomeSide,
      common.tokenId,
      common.bookTimestamp,
      common.bookHash,
      common.minOrderSize,
      common.tickSize,
      common.bestBid,
      common.bestAsk,
      common.spread,
      common.topBidSize,
      common.topAskSize,
      common.bidDepthAll,
      common.askDepthAll,
      common.bidLevels,
      common.askLevels,
      common.rawBidCount,
      common.rawAskCount,
      "bid",
      i,
      level.price,
      level.size,
    ]);
  }

  for (let i = 0; i < summary.asks.length; i++) {
    const level = summary.asks[i];
    rows.push([
      common.capturedAtEt,
      common.capturedAtUtc,
      common.pollCount,
      common.marketSlug,
      common.question,
      common.conditionId,
      common.endDate,
      common.marketBookId,
      common.outcomeSide,
      common.tokenId,
      common.bookTimestamp,
      common.bookHash,
      common.minOrderSize,
      common.tickSize,
      common.bestBid,
      common.bestAsk,
      common.spread,
      common.topBidSize,
      common.topAskSize,
      common.bidDepthAll,
      common.askDepthAll,
      common.bidLevels,
      common.askLevels,
      common.rawBidCount,
      common.rawAskCount,
      "ask",
      i,
      level.price,
      level.size,
    ]);
  }

  if (rows.length === 0) {
    rows.push([
      common.capturedAtEt,
      common.capturedAtUtc,
      common.pollCount,
      common.marketSlug,
      common.question,
      common.conditionId,
      common.endDate,
      common.marketBookId,
      common.outcomeSide,
      common.tokenId,
      common.bookTimestamp,
      common.bookHash,
      common.minOrderSize,
      common.tickSize,
      common.bestBid,
      common.bestAsk,
      common.spread,
      common.topBidSize,
      common.topAskSize,
      common.bidDepthAll,
      common.askDepthAll,
      common.bidLevels,
      common.askLevels,
      common.rawBidCount,
      common.rawAskCount,
      "",
      "",
      "",
      "",
    ]);
  }

  return rows;
}

function appendSnapshotToCsv({ market, up, down, pollCount }) {
  ensureDir(OUTPUT_DIR);

  const csvPath = getCsvPathForMarket(market.slug);
  ensureCsvHeader(csvPath);

  const capturedAtEt = isoNow();
  const capturedAtUtc = isoNowUtc();

  const upRows = buildCsvRowsForSide({
    market,
    summary: up,
    outcomeSide: "UP",
    capturedAtEt,
    capturedAtUtc,
    pollCount,
  });

  const downRows = buildCsvRowsForSide({
    market,
    summary: down,
    outcomeSide: "DOWN",
    capturedAtEt,
    capturedAtUtc,
    pollCount,
  });

  const lines = [...upRows, ...downRows]
    .map(row => row.map(escapeCsv).join(","))
    .join("\n") + "\n";

  fs.appendFileSync(csvPath, lines, "utf8");
  return csvPath;
}

async function fetchSnapshot(inputSlug) {
  const market = await resolveMarket(inputSlug);

  if (!market.upTokenId || !market.downTokenId) {
    throw new Error(`Missing Up/Down token IDs for market ${market.slug}`);
  }

  const [upBookRaw, downBookRaw] = await Promise.all([
    fetchBook(market.upTokenId),
    fetchBook(market.downTokenId),
  ]);

  return {
    market,
    up: summarizeBook(upBookRaw),
    down: summarizeBook(downBookRaw),
  };
}

async function main() {
  const { inputSlug, intervalMs } = parseArgs(process.argv);

  ensureDir(OUTPUT_DIR);

  let prevUp = null;
  let prevDown = null;
  let pollCount = 0;
  let failureCount = 0;
  let currentMarketSlug = null;

  while (true) {
    try {
      const { market, up, down } = await fetchSnapshot(inputSlug);
      pollCount += 1;
      failureCount = 0;

      if (currentMarketSlug !== market.slug) {
        currentMarketSlug = market.slug;
        prevUp = null;
        prevDown = null;
      }

      const csvPath = appendSnapshotToCsv({
        market,
        up,
        down,
        pollCount,
      });

      renderScreen({
        market,
        up,
        down,
        prevUp,
        prevDown,
        pollCount,
        intervalMs,
        csvPath,
      });

      prevUp = up;
      prevDown = down;
    } catch (err) {
      failureCount += 1;
      clearScreen();
      console.error("Polymarket BTC 5m real-time FULL orderbook");
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