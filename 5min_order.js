#!/usr/bin/env node

/**
 * Real-time Polymarket BTC 5m Up/Down orderbook watcher
 * Displays levels grouped by a configurable tick size. No CSV output.
 *
 * Usage:
 *   node 5min_order.js
 *   node 5min_order.js --tick=0.01
 *   node 5min_order.js --tick=0.001
 *   node 5min_order.js --interval=1000 --tick=0.01
 *   node 5min_order.js btc-updown-5m-1773345300 --tick=0.005
 */

const GAMMA_HOST = "https://gamma-api.polymarket.com";
const CLOB_HOST = "https://clob.polymarket.com";
const MARKET_INTERVAL_SEC = 300;
const DEFAULT_ASSET = "btc";
const DEFAULT_INTERVAL_MS = 2000;
const DEFAULT_TICK_SIZE = 0.01;

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

function parseArgs(argv) {
  let inputSlug = null;
  let intervalMs = DEFAULT_INTERVAL_MS;
  let tickSize = DEFAULT_TICK_SIZE;

  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--interval=")) {
      const v = Number(arg.split("=")[1]);
      if (Number.isFinite(v) && v >= 250) intervalMs = v;
    } else if (arg.startsWith("--tick=")) {
      const v = Number(arg.split("=")[1]);
      if (Number.isFinite(v) && v > 0) tickSize = v;
    } else if (!arg.startsWith("--") && !inputSlug) {
      inputSlug = arg;
    }
  }

  return { inputSlug, intervalMs, tickSize };
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
    headers: { accept: "application/json", "user-agent": "node-orderbook-realtime/2.0" },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} for ${url}\n${text}`);
  }
  return res.json();
}

async function fetchMarketBySlug(slug) {
  const items = await getJson(`${GAMMA_HOST}/markets?slug=${encodeURIComponent(slug)}`);
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

function groupByTick(levels, tickSize) {
  const buckets = new Map();
  for (const { price, size } of levels) {
    // floor to tick boundary, rounded to avoid float noise
    const key = Math.round(Math.floor(price / tickSize) * tickSize * 1e8) / 1e8;
    const entry = buckets.get(key);
    if (entry) {
      entry.size += size;
    } else {
      buckets.set(key, { price: key, size });
    }
  }
  return Array.from(buckets.values());
}

function summarizeBook(book, tickSize) {
  const rawBids = normalizeLevels(book.bids);
  const rawAsks = normalizeLevels(book.asks);

  const groupedBids = groupByTick(rawBids, tickSize)
    .sort((a, b) => b.price - a.price)
    .slice(0, 5);
  const groupedAsks = groupByTick(rawAsks, tickSize)
    .sort((a, b) => a.price - b.price)
    .slice(0, 5);

  const bestBid = groupedBids.length ? groupedBids[0].price : null;
  const bestAsk = groupedAsks.length ? groupedAsks[0].price : null;
  const spread = bestBid != null && bestAsk != null
    ? Number((bestAsk - bestBid).toFixed(8))
    : null;

  return {
    assetId: book.asset_id,
    minOrderSize: book.min_order_size,
    marketTickSize: book.tick_size,
    bestBid,
    bestAsk,
    spread,
    bids: groupedBids,
    asks: groupedAsks,
    rawBidCount: rawBids.length,
    rawAskCount: rawAsks.length,
  };
}

function movementArrow(current, previous) {
  if (current == null || previous == null) return " ";
  if (current > previous) return "↑";
  if (current < previous) return "↓";
  return "→";
}

function fmtPrice(v, tickSize) {
  if (v == null || Number.isNaN(v)) return "    -    ";
  // show enough decimal places for the tick size
  const digits = Math.max(2, -Math.floor(Math.log10(tickSize)));
  return v.toFixed(digits);
}

function fmtSize(v) {
  if (v == null || Number.isNaN(v)) return "-";
  return v.toFixed(2);
}

function renderSide(name, s, prev, tickSize) {
  const bidMove = movementArrow(s.bestBid, prev?.bestBid);
  const askMove = movementArrow(s.bestAsk, prev?.bestAsk);

  console.log(`\n─── ${name} ──────────────────────────────`);
  console.log(`  bestBid : ${fmtPrice(s.bestBid, tickSize)} ${bidMove}   bestAsk : ${fmtPrice(s.bestAsk, tickSize)} ${askMove}`);
  console.log(`  spread  : ${s.spread != null ? s.spread.toFixed(8) : "-"}   mktTick : ${s.marketTickSize}   minOrder : ${s.minOrderSize}`);
  console.log(`  rawBids : ${s.rawBidCount}  →  ${s.bids.length} tick-buckets    rawAsks : ${s.rawAskCount}  →  ${s.asks.length} tick-buckets`);

  // side-by-side: bids left, asks right
  const colWidth = 28;
  const bidHeader = "  BIDS (price × size)".padEnd(colWidth);
  const askHeader = "  ASKS (price × size)";
  console.log(`\n${bidHeader}${askHeader}`);

  const maxRows = Math.max(s.bids.length, s.asks.length);
  for (let i = 0; i < maxRows; i++) {
    const bid = s.bids[i];
    const ask = s.asks[i];
    const bidStr = bid
      ? `  ${fmtPrice(bid.price, tickSize)} × ${fmtSize(bid.size)}`.padEnd(colWidth)
      : "".padEnd(colWidth);
    const askStr = ask
      ? `  ${fmtPrice(ask.price, tickSize)} × ${fmtSize(ask.size)}`
      : "";
    console.log(`${bidStr}${askStr}`);
  }
}

function renderScreen({ market, up, down, prevUp, prevDown, pollCount, intervalMs, tickSize }) {
  clearScreen();

  const combinedAsk = up.bestAsk != null && down.bestAsk != null ? up.bestAsk + down.bestAsk : null;
  const combinedBid = up.bestBid != null && down.bestBid != null ? up.bestBid + down.bestBid : null;

  console.log("═══ Polymarket BTC 5m Orderbook ═══════════════════════════");
  console.log(`  Time     : ${isoNow()} ET`);
  console.log(`  Market   : ${market.slug}`);
  console.log(`  Question : ${market.question}`);
  console.log(`  End date : ${market.endDate}`);
  console.log(`  Poll #   : ${pollCount}   interval : ${intervalMs}ms   tick : ${tickSize}`);
  console.log(`  Combined : bid ${combinedBid != null ? combinedBid.toFixed(4) : "-"}   ask ${combinedAsk != null ? combinedAsk.toFixed(4) : "-"}`);

  renderSide("UP", up, prevUp, tickSize);
  renderSide("DOWN", down, prevDown, tickSize);

  console.log("\n\nPress Ctrl+C to stop.");
}

async function main() {
  const { inputSlug, intervalMs, tickSize } = parseArgs(process.argv);

  let prevUp = null;
  let prevDown = null;
  let pollCount = 0;
  let failureCount = 0;

  while (true) {
    try {
      const market = await resolveMarket(inputSlug);

      if (!market.upTokenId || !market.downTokenId) {
        throw new Error(`Missing Up/Down token IDs for market ${market.slug}`);
      }

      const [upBookRaw, downBookRaw] = await Promise.all([
        fetchBook(market.upTokenId),
        fetchBook(market.downTokenId),
      ]);

      const up = summarizeBook(upBookRaw, tickSize);
      const down = summarizeBook(downBookRaw, tickSize);

      pollCount += 1;
      failureCount = 0;

      renderScreen({ market, up, down, prevUp, prevDown, pollCount, intervalMs, tickSize });

      prevUp = up;
      prevDown = down;
    } catch (err) {
      failureCount += 1;
      clearScreen();
      console.error("Polymarket BTC 5m orderbook");
      console.error(`Updated  : ${isoNow()} ET`);
      console.error(`Poll #   : ${pollCount}   Failures: ${failureCount}`);
      console.error(`\nERROR: ${err.message || err}`);
      console.error(`\nRetrying in ${intervalMs}ms...`);
    }

    await sleep(intervalMs);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
