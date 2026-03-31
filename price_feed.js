#!/usr/bin/env node

/**
 * Ultra-fast BTC 5m/15m UP/DOWN best ask price feed
 * Uses keep-alive HTTPS connections to reuse TCP sockets
 *
 * Usage:
 *   node price_feed.js
 *   node price_feed.js --market=15m
 *   node price_feed.js --interval=200
 */

const fs    = require("fs");
const path  = require("path");
const https = require("https");

const POLL_MS      = Number((process.argv.find(a => a.startsWith("--interval=")) || "").split("=")[1]) || 200;
const MARKET       = (process.argv.find(a => a.startsWith("--market=")) || "").split("=")[1] || "5m";
const INTERVAL_SEC = MARKET === "15m" ? 900 : 300;
const SLUG_PREFIX  = `btc-updown-${MARKET}`;
const FEED_DIR     = path.resolve(process.cwd(), "price_feeds");
const CSV_HEADER   = "timestamp,up_best_ask,down_best_ask\n";

// keep-alive agent — reuses TCP connections, eliminates handshake per poll
const CLOB_AGENT = new https.Agent({ keepAlive: true, maxSockets: 4, keepAliveMsecs: 30000 });
const GAMMA_AGENT = new https.Agent({ keepAlive: true, maxSockets: 2, keepAliveMsecs: 30000 });

let upTokenId   = null;
let downTokenId = null;
let cachedSlug  = null;
let csvPath     = null;
let pollCount   = 0;
let writeCount  = 0;
let lastFetchMs = 0;

function nowUnix() { return Math.floor(Date.now() / 1000); }

function currentSlug() {
  return `${SLUG_PREFIX}-${Math.floor(nowUnix() / INTERVAL_SEC) * INTERVAL_SEC}`;
}

function httpGet(host, pathStr, agent) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: host, path: pathStr, method: "GET", agent,
        headers: { accept: "application/json", "user-agent": "price-feed/2.0", connection: "keep-alive" } },
      res => {
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => {
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} ${pathStr}`));
          try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
          catch (e) { reject(e); }
        });
      }
    );
    req.setTimeout(3000, () => { req.destroy(new Error("timeout")); });
    req.on("error", reject);
    req.end();
  });
}

function parseMaybeJsonArray(v) {
  if (Array.isArray(v)) return v;
  try { return JSON.parse(v); } catch { return []; }
}

async function resolveTokenIds(slug) {
  const data = await httpGet("gamma-api.polymarket.com", `/markets?slug=${encodeURIComponent(slug)}`, GAMMA_AGENT);
  if (!Array.isArray(data) || data.length === 0) throw new Error(`Market not found: ${slug}`);
  const raw      = data[0];
  const outcomes = parseMaybeJsonArray(raw.outcomes);
  const tokenIds = parseMaybeJsonArray(raw.clobTokenIds).map(String);
  const upIdx    = outcomes.findIndex(x => String(x).toLowerCase().includes("up"));
  const downIdx  = outcomes.findIndex(x => String(x).toLowerCase().includes("down"));
  return {
    upTokenId:   tokenIds[upIdx   >= 0 ? upIdx   : 0] || "",
    downTokenId: tokenIds[downIdx >= 0 ? downIdx : 1] || "",
  };
}

function bestAsk(book) {
  if (!Array.isArray(book.asks) || book.asks.length === 0) return null;
  let min = Infinity;
  for (const l of book.asks) { const p = Number(l.price); if (p < min) min = p; }
  return min === Infinity ? null : min;
}

function ensureCsv(slug) {
  if (!fs.existsSync(FEED_DIR)) fs.mkdirSync(FEED_DIR, { recursive: true });
  const p = path.join(FEED_DIR, `${slug}.csv`);
  if (!fs.existsSync(p) || fs.statSync(p).size === 0) fs.writeFileSync(p, CSV_HEADER, "utf8");
  csvPath = p;
}

function appendRow(upAsk, downAsk) {
  const ts = new Date().toISOString();
  const up = upAsk   != null ? upAsk.toFixed(4)   : "";
  const dn = downAsk != null ? downAsk.toFixed(4) : "";
  fs.appendFileSync(csvPath, `${ts},${up},${dn}\n`, "utf8");
  writeCount++;
}

async function main() {
  if (!fs.existsSync(FEED_DIR)) fs.mkdirSync(FEED_DIR, { recursive: true });

  cachedSlug = currentSlug();
  ({ upTokenId, downTokenId } = await resolveTokenIds(cachedSlug));
  ensureCsv(cachedSlug);

  console.log(`Dir     : ${FEED_DIR}`);
  console.log(`Mode    : BTC ${MARKET}  (${INTERVAL_SEC}s markets) — one CSV per market`);
  console.log(`Interval: ${POLL_MS}ms target`);
  console.log("Running — Ctrl+C to stop\n");

  while (true) {
    const slug = currentSlug();
    if (slug !== cachedSlug) {
      try {
        ({ upTokenId, downTokenId } = await resolveTokenIds(slug));
        cachedSlug = slug;
        ensureCsv(cachedSlug);
      } catch { /* keep old until next attempt */ }
    }

    const t0 = Date.now();
    try {
      const [upBook, downBook] = await Promise.all([
        httpGet("clob.polymarket.com", `/book?token_id=${upTokenId}`,   CLOB_AGENT),
        httpGet("clob.polymarket.com", `/book?token_id=${downTokenId}`, CLOB_AGENT),
      ]);

      lastFetchMs = Date.now() - t0;
      pollCount++;

      const upAsk   = bestAsk(upBook);
      const downAsk = bestAsk(downBook);
      appendRow(upAsk, downAsk);

      process.stdout.write(
        `[${new Date().toISOString()}]  poll:${pollCount}  rows:${writeCount}  up:${upAsk ?? "-"}  down:${downAsk ?? "-"}  fetch:${lastFetchMs}ms\n`
      );
    } catch (err) {
      lastFetchMs = Date.now() - t0;
      pollCount++;
      process.stdout.write(`ERR(${lastFetchMs}ms): ${err.message}\n`);
    }

    const elapsed = Date.now() - t0;
    const wait = Math.max(0, POLL_MS - elapsed);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
  }
}

main().catch(err => { console.error(err); process.exit(1); });
