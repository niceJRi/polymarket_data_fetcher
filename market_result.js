const axios = require("axios");
const fs = require("fs");

const WALLET = process.argv[2];
const OUTPUT = "user_positions_all_desc.csv";

const CLOSED_LIMIT = 50;
const POLL_INTERVAL_MS = 5000;

const POSITIONS_API = "https://data-api.polymarket.com/positions";
const CLOSED_API = "https://data-api.polymarket.com/closed-positions";

if (!WALLET) {
  console.log("Usage: node all_positions_live.js 0xYourWallet");
  process.exit(1);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function fmt(v, digits = 6) {
  const n = num(v);
  return n.toFixed(digits).replace(/\.?0+$/, "");
}

function csvEscape(v) {
  const s = String(v ?? "");
  return `"${s.replace(/"/g, '""')}"`;
}

function toET(unixTs) {
  if (!unixTs) return "";
  return new Date(unixTs * 1000)
    .toLocaleString("sv-SE", { timeZone: "America/New_York", hour12: false })
    .replace(" ", "T");
}

function parseETDateTimeToUnix(year, monthName, day, hour, minute, ampm) {
  const months = {
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11
  };

  let h = Number(hour);
  const m = Number(minute);

  const upper = ampm.toUpperCase();
  if (upper === "PM" && h !== 12) h += 12;
  if (upper === "AM" && h === 12) h = 0;

  // Build as America/New_York local wall time
  // Trick: create ISO-like string then reinterpret through Intl offset calc
  const monthIndex = months[monthName.toLowerCase()];
  if (monthIndex === undefined) return 0;

  // Start with UTC approximation
  const approxUtc = Date.UTC(year, monthIndex, Number(day), h, m, 0);

  // Convert that instant to ET parts, compare, then adjust.
  // For this use case, one-pass offset correction is enough.
  const fmtParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: false
  }).formatToParts(new Date(approxUtc));

  const parts = {};
  for (const p of fmtParts) {
    if (p.type !== "literal") parts[p.type] = p.value;
  }

  const etAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );

  const desiredAsUtc = Date.UTC(year, monthIndex, Number(day), h, m, 0);
  const corrected = approxUtc + (desiredAsUtc - etAsUtc);

  return Math.floor(corrected / 1000);
}

function parseMarketWindow(title) {
  if (!title) {
    return {
      marketStartUnix: 0,
      marketEndUnix: 0,
      marketStartET: "",
      marketEndET: ""
    };
  }

  const m = title.match(
    /-\s*([A-Za-z]+)\s+(\d{1,2}),\s*(\d{1,2}):(\d{2})(AM|PM)-(\d{1,2}):(\d{2})(AM|PM)\s*ET/i
  );

  if (!m) {
    return {
      marketStartUnix: 0,
      marketEndUnix: 0,
      marketStartET: "",
      marketEndET: ""
    };
  }

  const now = new Date();
  const year = now.getUTCFullYear();

  const [
    ,
    monthName,
    day,
    sh,
    sm,
    sampm,
    eh,
    em,
    eampm
  ] = m;

  const marketStartUnix = parseETDateTimeToUnix(year, monthName, day, sh, sm, sampm);
  let marketEndUnix = parseETDateTimeToUnix(year, monthName, day, eh, em, eampm);

  // Overnight safety
  if (marketEndUnix < marketStartUnix) {
    marketEndUnix += 86400;
  }

  return {
    marketStartUnix,
    marketEndUnix,
    marketStartET: toET(marketStartUnix),
    marketEndET: toET(marketEndUnix)
  };
}

async function fetchCurrentPositions() {
  const res = await axios.get(POSITIONS_API, {
    params: { user: WALLET },
    timeout: 30000
  });
  return Array.isArray(res.data) ? res.data : [];
}

async function fetchClosedPage(offset = 0) {
  const res = await axios.get(CLOSED_API, {
    params: {
      user: WALLET,
      limit: CLOSED_LIMIT,
      offset,
      sortBy: "TIMESTAMP",
      sortDirection: "DESC"
    },
    timeout: 30000
  });
  return Array.isArray(res.data) ? res.data : [];
}

async function fetchAllClosedPositions() {
  const all = [];
  let offset = 0;

  while (true) {
    const rows = await fetchClosedPage(offset);
    if (!rows.length) break;

    all.push(...rows);

    if (rows.length < CLOSED_LIMIT) break;
    offset += CLOSED_LIMIT;
  }

  return all;
}

function normalizeActive(p) {
  const avgPrice = num(p.avgPrice);
  const totalBought = num(p.totalBought);
  const size = num(p.size);
  const currentValue = num(p.currentValue);
  const cashPnl = num(p.cashPnl);
  const curPrice = num(p.curPrice);

  const marketInfo = parseMarketWindow(p.title || "");

  return {
    status: "Active",
    timestampET: marketInfo.marketEndET,
    timestampUnix: marketInfo.marketEndUnix,
    marketStartET: marketInfo.marketStartET,
    marketStartUnix: marketInfo.marketStartUnix,
    marketEndET: marketInfo.marketEndET,
    marketEndUnix: marketInfo.marketEndUnix,
    result: "",
    market: p.title || "",
    upDown: p.outcome || "",
    price: avgPrice,
    shareAmount: size,
    totalTraded: totalBought,
    amountWon: currentValue,
    pnl: cashPnl,
    currentPrice: curPrice,
    slug: p.slug || "",
    conditionId: p.conditionId || "",
    proxyWallet: p.proxyWallet || "",
    endDate: p.endDate || ""
  };
}

function normalizeClosed(p) {
  const avgPrice = num(p.avgPrice);
  const totalBought = num(p.totalBought);
  const realizedPnl = num(p.realizedPnl);
  const shareAmount = avgPrice > 0 ? totalBought / avgPrice : 0;
  const amountWon = totalBought + realizedPnl;
  const result = realizedPnl >= 0 ? "Won" : "Lost";

  const marketInfo = parseMarketWindow(p.title || "");

  return {
    status: "Closed",
    timestampET: marketInfo.marketEndET || toET(num(p.timestamp)),
    timestampUnix: marketInfo.marketEndUnix || num(p.timestamp),
    marketStartET: marketInfo.marketStartET,
    marketStartUnix: marketInfo.marketStartUnix,
    marketEndET: marketInfo.marketEndET || toET(num(p.timestamp)),
    marketEndUnix: marketInfo.marketEndUnix || num(p.timestamp),
    result,
    market: p.title || "",
    upDown: p.outcome || "",
    price: avgPrice,
    shareAmount,
    totalTraded: totalBought,
    amountWon,
    pnl: realizedPnl,
    currentPrice: "",
    slug: p.slug || "",
    conditionId: p.conditionId || "",
    proxyWallet: p.proxyWallet || "",
    endDate: p.endDate || ""
  };
}

function dedupeRows(rows) {
  const map = new Map();

  for (const r of rows) {
    const key = [
      r.status,
      r.market,
      r.upDown,
      r.conditionId,
      r.price,
      r.shareAmount,
      r.totalTraded,
      r.amountWon,
      r.marketEndUnix
    ].join("|");

    if (!map.has(key)) {
      map.set(key, r);
    }
  }

  return Array.from(map.values());
}

function sortNewestMarketFirst(a, b) {
  if (b.marketEndUnix !== a.marketEndUnix) {
    return b.marketEndUnix - a.marketEndUnix;
  }

  if (b.marketStartUnix !== a.marketStartUnix) {
    return b.marketStartUnix - a.marketStartUnix;
  }

  // same market: show Active first, then Closed
  if (a.status !== b.status) {
    return a.status === "Active" ? -1 : 1;
  }

  return b.timestampUnix - a.timestampUnix;
}

function buildCsv(rows) {
  const header = [
    "status",
    "timestampET",
    "timestampUnix",
    "marketStartET",
    "marketStartUnix",
    "marketEndET",
    "marketEndUnix",
    "result",
    "market",
    "upDown",
    "price",
    "shareAmount",
    "totalTraded",
    "amountWon",
    "pnl",
    "currentPrice",
    "slug",
    "conditionId",
    "proxyWallet",
    "endDate"
  ].join(",") + "\n";

  const lines = rows.map(r =>
    [
      r.status,
      r.timestampET,
      r.timestampUnix,
      r.marketStartET,
      r.marketStartUnix,
      r.marketEndET,
      r.marketEndUnix,
      r.result,
      r.market,
      r.upDown,
      fmt(r.price),
      fmt(r.shareAmount),
      fmt(r.totalTraded),
      fmt(r.amountWon),
      fmt(r.pnl),
      r.currentPrice === "" ? "" : fmt(r.currentPrice),
      r.slug,
      r.conditionId,
      r.proxyWallet,
      r.endDate
    ].map(csvEscape).join(",")
  );

  return header + lines.join("\n") + "\n";
}

async function refreshAll() {
  const [activeRaw, closedRaw] = await Promise.all([
    fetchCurrentPositions(),
    fetchAllClosedPositions()
  ]);

  const activeRows = activeRaw.map(normalizeActive);
  const closedRows = closedRaw.map(normalizeClosed);

  const merged = dedupeRows([...activeRows, ...closedRows]).sort(sortNewestMarketFirst);

  fs.writeFileSync(OUTPUT, buildCsv(merged), "utf8");

  console.log(
    `${new Date().toISOString()} | active=${activeRows.length} | closed=${closedRows.length} | total=${merged.length}`
  );
}

async function main() {
  while (true) {
    try {
      await refreshAll();
    } catch (err) {
      console.log("Refresh error:", err.response?.data || err.message);
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

main();