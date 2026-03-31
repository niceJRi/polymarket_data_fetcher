#!/usr/bin/env node

/**
 * BTC 5m Up/Down history saver + live appender
 *
 * Features:
 * - Backfill historical resolved 5m BTC markets
 * - Append each row to CSV immediately
 * - Keep watching for newly closed markets in near real time
 *
 * Usage:
 *   node 5min_result_live.js --days=3
 *   node 5min_result_live.js --days=1 --out=btc_5m_results_live.csv
 *   node 5min_result_live.js --start=2026-03-20T00:00:00Z --end=2026-03-24T23:59:59Z
 *
 * Node.js 18+
 */

const fs = require("fs");
const path = require("path");

const GAMMA_HOST = "https://gamma-api.polymarket.com";
const DEFAULT_OUT = "btc_5m_results_live.csv";
const HEADER = [
  "slug",
  "market_id",
  "question",
  "winner",
  "start_unix",
  "end_unix",
  "start_iso",
  "end_iso",
  "closed",
  "active",
  "archived",
  "endDate",
  "closedTime",
  "outcomes",
  "outcomePrices",
  "volume",
  "liquidity",
  "url",
];

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    out: DEFAULT_OUT,
    days: 1,
    start: null,
    end: null,
    pauseMs: 120,
    livePollMs: 10000, // check every 10 sec for newly closed market
  };

  for (const arg of args) {
    if (arg.startsWith("--out=")) opts.out = arg.split("=")[1];
    else if (arg.startsWith("--days=")) opts.days = Number(arg.split("=")[1]);
    else if (arg.startsWith("--start=")) opts.start = arg.split("=")[1];
    else if (arg.startsWith("--end=")) opts.end = arg.split("=")[1];
    else if (arg.startsWith("--pauseMs=")) opts.pauseMs = Number(arg.split("=")[1]);
    else if (arg.startsWith("--livePollMs=")) opts.livePollMs = Number(arg.split("=")[1]);
  }

  return opts;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function floorTo5Min(tsSec) {
  return Math.floor(tsSec / 300) * 300;
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function rowToCsv(row, headers) {
  return headers.map((h) => csvEscape(row[h])).join(",");
}

function safeJsonParse(v, fallback = null) {
  if (v == null) return fallback;
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}

function normalizeWinner(v) {
  if (!v) return null;
  const s = String(v).trim().toLowerCase();
  if (s === "up" || s === "yes") return "Up";
  if (s === "down" || s === "no") return "Down";
  return null;
}

function inferWinnerFromMarket(market) {
  const direct = [
    market?.winner,
    market?.winningOutcome,
    market?.winning_outcome,
    market?.resolvedOutcome,
    market?.resolved_outcome,
    market?.result,
    market?.outcome,
  ];

  for (const item of direct) {
    const x = normalizeWinner(item);
    if (x) return x;
  }

  const outcomes = safeJsonParse(market?.outcomes, market?.outcomes);
  const outcomePrices = safeJsonParse(market?.outcomePrices, market?.outcomePrices);

  const idxCandidates = [
    market?.winnerIndex,
    market?.winner_index,
    market?.winningOutcomeIndex,
    market?.resolvedOutcomeIndex,
    market?.outcomeIndex,
  ];

  if (Array.isArray(outcomes)) {
    for (const idx of idxCandidates) {
      if (Number.isInteger(idx) && outcomes[idx] != null) {
        const x = normalizeWinner(outcomes[idx]);
        if (x) return x;
      }
    }
  }

  if (Array.isArray(outcomes) && Array.isArray(outcomePrices) && outcomes.length === outcomePrices.length) {
    let maxIdx = -1;
    let maxVal = -Infinity;

    for (let i = 0; i < outcomePrices.length; i++) {
      const p = Number(outcomePrices[i]);
      if (Number.isFinite(p) && p > maxVal) {
        maxVal = p;
        maxIdx = i;
      }
    }

    if (maxIdx >= 0 && maxVal >= 0.99) {
      const x = normalizeWinner(outcomes[maxIdx]);
      if (x) return x;
    }
  }

  return null;
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      accept: "application/json,text/plain,*/*",
      "user-agent": "Mozilla/5.0",
    },
  });

  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`HTTP ${res.status} for ${url}`);
  }

  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "user-agent": "Mozilla/5.0",
    },
  });

  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`HTTP ${res.status} for ${url}`);
  }

  return res.text();
}

async function fetchMarketBySlug(slug) {
  const url = `${GAMMA_HOST}/markets/slug/${slug}`;
  return fetchJson(url);
}

async function scrapeWinnerFromEventPage(slug) {
  const url = `https://polymarket.com/event/${slug}`;
  const html = await fetchText(url);
  if (!html) return null;

  let m = html.match(/final outcome was ["“]?([A-Za-z]+)["”]?/i);
  if (m) return normalizeWinner(m[1]);

  m = html.match(/resolved[^<]{0,100}["“](Up|Down)["”]/i);
  if (m) return normalizeWinner(m[1]);

  m = html.match(/The final outcome was ["“]?([A-Za-z]+)["”]?/i);
  if (m) return normalizeWinner(m[1]);

  return null;
}

function buildRow(slug, market, winner) {
  const ts = Number((slug.match(/^btc-updown-5m-(\d{10})$/) || [])[1] || NaN);
  const endTs = Number.isFinite(ts) ? ts + 300 : null;
  const outcomes = safeJsonParse(market?.outcomes, market?.outcomes);
  const outcomePrices = safeJsonParse(market?.outcomePrices, market?.outcomePrices);

  return {
    slug,
    market_id: market?.id ?? "",
    question: market?.question ?? "",
    winner: winner ?? "",
    start_unix: Number.isFinite(ts) ? ts : "",
    end_unix: Number.isFinite(endTs) ? endTs : "",
    start_iso: Number.isFinite(ts) ? new Date(ts * 1000).toISOString() : "",
    end_iso: Number.isFinite(endTs) ? new Date(endTs * 1000).toISOString() : "",
    closed: market?.closed ?? "",
    active: market?.active ?? "",
    archived: market?.archived ?? "",
    endDate: market?.endDate ?? market?.endDateIso ?? "",
    closedTime: market?.closedTime ?? "",
    outcomes: Array.isArray(outcomes) ? outcomes.join("|") : "",
    outcomePrices: Array.isArray(outcomePrices) ? outcomePrices.join("|") : "",
    volume: market?.volume ?? market?.volumeNum ?? "",
    liquidity: market?.liquidity ?? market?.liquidityNum ?? "",
    url: `https://polymarket.com/event/${slug}`,
  };
}

function ensureCsvFile(filePath) {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
    fs.writeFileSync(filePath, HEADER.join(",") + "\n", "utf8");
  }
}

function loadExistingSlugs(filePath) {
  const set = new Set();

  if (!fs.existsSync(filePath)) return set;

  const txt = fs.readFileSync(filePath, "utf8").trim();
  if (!txt) return set;

  const lines = txt.split(/\r?\n/);
  if (lines.length <= 1) return set;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const firstComma = line.indexOf(",");
    if (firstComma > 0) {
      const slug = line.slice(0, firstComma);
      if (slug) set.add(slug);
    }
  }

  return set;
}

function appendRow(filePath, row) {
  fs.appendFileSync(filePath, rowToCsv(row, HEADER) + "\n", "utf8");
}

function getBackfillRange(opts) {
  if (opts.start || opts.end) {
    if (!opts.start || !opts.end) {
      throw new Error("When using --start or --end, provide both.");
    }

    const startMs = Date.parse(opts.start);
    const endMs = Date.parse(opts.end);

    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      throw new Error("Invalid --start or --end.");
    }

    return {
      startSec: floorTo5Min(Math.floor(startMs / 1000)),
      endSec: floorTo5Min(Math.floor(endMs / 1000)),
    };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const lastClosedMarketStartSec = floorTo5Min(nowSec) - 300;
  const intervals = Math.max(1, Math.floor((opts.days * 24 * 60 * 60) / 300));

  return {
    startSec: lastClosedMarketStartSec - (intervals - 1) * 300,
    endSec: lastClosedMarketStartSec,
  };
}

async function fetchResolvedRowForSlug(slug) {
  let market = null;
  let winner = null;

  try {
    market = await fetchMarketBySlug(slug);
  } catch (err) {
    console.error(`fetch error ${slug}: ${err.message}`);
  }

  if (market) {
    winner = inferWinnerFromMarket(market);
  }

  if (!winner) {
    try {
      winner = await scrapeWinnerFromEventPage(slug);
    } catch (err) {
      // ignore scrape errors
    }
  }

  if (!market && !winner) return null;

  return buildRow(slug, market, winner);
}

async function backfill(opts, outPath, savedSlugs) {
  const { startSec, endSec } = getBackfillRange(opts);
  console.log(`Backfill: ${new Date(startSec * 1000).toISOString()} -> ${new Date(endSec * 1000).toISOString()}`);

  let n = 0;

  for (let ts = startSec; ts <= endSec; ts += 300) {
    const slug = `btc-updown-5m-${ts}`;

    if (savedSlugs.has(slug)) {
      console.log(`skip existing ${slug}`);
      continue;
    }

    const row = await fetchResolvedRowForSlug(slug);
    if (row) {
      appendRow(outPath, row);
      savedSlugs.add(slug);
      n++;
      console.log(`saved ${slug} winner=${row.winner || "unknown"} [appended now]`);
    } else {
      console.log(`missing ${slug}`);
    }

    await sleep(opts.pauseMs);
  }

  console.log(`Backfill done. newly appended=${n}`);
}

function getLastClosedMarketStartSec() {
  const nowSec = Math.floor(Date.now() / 1000);
  return floorTo5Min(nowSec) - 300;
}

async function watchLive(opts, outPath, savedSlugs) {
  console.log(`Live watch started. Poll every ${opts.livePollMs} ms`);

  while (true) {
    try {
      const lastClosedStartSec = getLastClosedMarketStartSec();

      // only one newly closed market every 5 minutes, but this catches missed ones too
      for (let ts = lastClosedStartSec - 1800; ts <= lastClosedStartSec; ts += 300) {
        const slug = `btc-updown-5m-${ts}`;
        if (savedSlugs.has(slug)) continue;

        const row = await fetchResolvedRowForSlug(slug);
        if (row) {
          appendRow(outPath, row);
          savedSlugs.add(slug);
          console.log(`LIVE saved ${slug} winner=${row.winner || "unknown"} [appended now]`);
        }
      }
    } catch (err) {
      console.error(`live loop error: ${err.message}`);
    }

    await sleep(opts.livePollMs);
  }
}

async function main() {
  const opts = parseArgs();
  const outPath = path.resolve(process.cwd(), opts.out);

  ensureCsvFile(outPath);
  const savedSlugs = loadExistingSlugs(outPath);

  console.log(`CSV file: ${outPath}`);
  console.log(`Already saved rows: ${savedSlugs.size}`);

  await backfill(opts, outPath, savedSlugs);
  await watchLive(opts, outPath, savedSlugs);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});