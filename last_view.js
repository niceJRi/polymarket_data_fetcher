#!/usr/bin/env node

/**
 * Polymarket live watcher
 *
 * Multi-market mode (default): grouped by coin, 5m + 15m per coin.
 * Single-market mode (--market=KEY): full-screen view of one market.
 *
 * Valid market keys:
 *   btc5m  btc15m  eth5m  eth15m  bnb5m  bnb15m
 *   xrp5m  xrp15m  sol5m  sol15m  hype5m hype15m  doge5m  doge15m
 *
 * Usage:
 *   node last_view.js <WALLET>
 *   node last_view.js <WALLET> --market=btc5m
 *   node last_view.js <WALLET> --market=sol15m --interval=200 --trades=20
 */

const WALLET      = process.argv.find((a, i) => i >= 2 && !a.startsWith("--"))
const MARKET_KEY  = (process.argv.find(a => a.startsWith("--market="))   || "").split("=")[1] || null
const INTERVAL_MS = +(process.argv.find(a => a.startsWith("--interval=")) || "--interval=200").split("=")[1]
const LIMIT       = +(process.argv.find(a => a.startsWith("--limit="))    || "--limit=200").split("=")[1]

const MARKETS = [
  { key: "btc5m",   label: "BTC-5m",   coins: ["bitcoin", "btc"],        interval: 5  },
  { key: "btc15m",  label: "BTC-15m",  coins: ["bitcoin", "btc"],        interval: 15 },
  { key: "eth5m",   label: "ETH-5m",   coins: ["ethereum", "eth"],       interval: 5  },
  { key: "eth15m",  label: "ETH-15m",  coins: ["ethereum", "eth"],       interval: 15 },
  { key: "bnb5m",   label: "BNB-5m",   coins: ["binance", "bnb"],        interval: 5  },
  { key: "bnb15m",  label: "BNB-15m",  coins: ["binance", "bnb"],        interval: 15 },
  { key: "xrp5m",   label: "XRP-5m",   coins: ["ripple", "xrp"],         interval: 5  },
  { key: "xrp15m",  label: "XRP-15m",  coins: ["ripple", "xrp"],         interval: 15 },
  { key: "sol5m",   label: "SOL-5m",   coins: ["solana", "sol"],          interval: 5  },
  { key: "sol15m",  label: "SOL-15m",  coins: ["solana", "sol"],          interval: 15 },
  { key: "hype5m",  label: "HYPE-5m",  coins: ["hyperliquid", "hype"],   interval: 5  },
  { key: "hype15m", label: "HYPE-15m", coins: ["hyperliquid", "hype"],   interval: 15 },
  { key: "doge5m",  label: "DOGE-5m",  coins: ["dogecoin", "doge"],       interval: 5  },
  { key: "doge15m", label: "DOGE-15m", coins: ["dogecoin", "doge"],       interval: 15 },
]

const VALID_KEYS = MARKETS.map(m => m.key)

if (!WALLET) {
  console.error("Usage: node last_view.js <WALLET> [--market=KEY] [--interval=200] [--limit=200] [--trades=N]")
  console.error("Valid market keys:", VALID_KEYS.join("  "))
  process.exit(1)
}

if (MARKET_KEY && !VALID_KEYS.includes(MARKET_KEY)) {
  console.error(`Unknown market "${MARKET_KEY}". Valid keys: ${VALID_KEYS.join("  ")}`)
  process.exit(1)
}

// Default trades shown: 20 in single-market mode, 3 in multi-market mode
const MAX_DISPLAY = +(process.argv.find(a => a.startsWith("--trades=")) || `--trades=${MARKET_KEY ? 20 : 3}`).split("=")[1]

const START_TS     = Math.floor(new Date("2026-01-01T00:00:00Z").getTime() / 1000)
const MAX_STORE    = 150
const NEW_FLASH_MS = 12000

const C = {
  reset:  "\x1B[0m",
  bold:   "\x1B[1m",
  dim:    "\x1B[2m",
  green:  "\x1B[32m",
  red:    "\x1B[31m",
  yellow: "\x1B[33m",
  cyan:   "\x1B[36m",
  white:  "\x1B[97m",
}

const COIN_PAIRS = [
  { label: "BTC",  m5: "btc5m",  m15: "btc15m"  },
  { label: "ETH",  m5: "eth5m",  m15: "eth15m"  },
  { label: "BNB",  m5: "bnb5m",  m15: "bnb15m"  },
  { label: "XRP",  m5: "xrp5m",  m15: "xrp15m"  },
  { label: "SOL",  m5: "sol5m",  m15: "sol15m"  },
  { label: "HYPE", m5: "hype5m", m15: "hype15m" },
  { label: "DOGE", m5: "doge5m", m15: "doge15m" },
]

const INTERVAL_SLUG_RX = {
  5:  /(?<![0-9])5m(?![0-9a-zA-Z])|(?<![0-9])5min/,
  15: /15m|15min/,
}

const mstate = {}
for (const m of MARKETS) {
  mstate[m.key] = {
    currentTitle:  null,
    currentTrades: [],
    prevTitle:     null,
    newMarketAt:   0,
    lastTs:        0,
    totalSeen:     0,
  }
}

const seenKeys = new Set()
let pollCount      = 0
let fetchMs        = 0
let totalNewTrades = 0

const sleep = ms => new Promise(r => setTimeout(r, ms))

function toET(ts) {
  return new Date(ts * 1000)
    .toLocaleString("sv-SE", { timeZone: "America/New_York" })
    .replace(" ", "T")
}

function isoNow() {
  return new Date().toLocaleString("sv-SE", { timeZone: "America/New_York" })
}

function matchesMarket(t, market) {
  const title = (t.title || "").toLowerCase()
  const slug  = (t.slug || t.market?.slug || t.marketSlug || "").toLowerCase()

  const hasCoin = market.coins.some(c => title.includes(c) || slug.includes(c))
  if (!hasCoin) return false

  const n = market.interval
  const hasInterval =
    [`${n} min`, `${n}-min`, `${n} minute`, `${n}-minute`].some(p => title.includes(p)) ||
    INTERVAL_SLUG_RX[n].test(slug)
  if (!hasInterval) return false

  return (
    title.includes("up or down") || title.includes("above") || title.includes("below") ||
    title.includes("higher")     || title.includes("lower") ||
    slug.includes("updown")      || slug.includes("above")  || slug.includes("below")
  )
}

function tradeKey(t) {
  return [t.timestamp ?? "", t.transactionHash ?? "", t.side ?? "",
          t.outcome ?? "", t.price ?? "", t.size ?? ""].join("|")
}

function getTitle(t) {
  return (t.title || t.slug || t.market?.slug || t.marketSlug || "").trim()
}

function processTrade(t, market) {
  const ms    = mstate[market.key]
  const title = getTitle(t)
  const ts    = t.timestamp ?? 0

  ms.totalSeen++

  if (ms.currentTitle === null) {
    ms.currentTitle = title
    ms.lastTs = ts
  } else if (title !== ms.currentTitle) {
    if (ts > ms.lastTs) {
      // Newer trade belongs to a new market/candle period
      ms.prevTitle     = ms.currentTitle
      ms.currentTitle  = title
      ms.currentTrades = []
      ms.newMarketAt   = Date.now()
      ms.lastTs        = ts
    } else {
      return  // older market's trade — discard
    }
  }

  ms.currentTrades.unshift(t)
  if (ms.currentTrades.length > MAX_STORE) ms.currentTrades.length = MAX_STORE
  if (ts > ms.lastTs) ms.lastTs = ts
}

function derivePrices(key) {
  let yesPrice = null
  let noPrice  = null
  for (const t of mstate[key].currentTrades) {
    const o = (t.outcome || "").toUpperCase()
    if (yesPrice === null && o === "YES") yesPrice = Number(t.price)
    if (noPrice  === null && o === "NO")  noPrice  = Number(t.price)
    if (yesPrice !== null && noPrice !== null) break
  }
  return { yesPrice, noPrice }
}

function fmtTrade(t, idx, indent = "    ") {
  const side    = (t.side    || "").toUpperCase()
  const outcome = (t.outcome || "").toUpperCase()
  const price   = Number(t.price    ?? 0).toFixed(3)
  const sz      = Number(t.size     ?? 0).toFixed(2).padStart(10)
  const usdc    = Number(t.usdcSize ?? 0).toFixed(2).padStart(10)
  const hash    = (t.transactionHash || "").slice(0, 10) + "..."
  const ts      = t.timestamp ? toET(t.timestamp).slice(11, 19) : "—"

  const outColor = outcome === "YES" ? C.green : C.red
  const sideStr  = side === "BUY" ? `${C.bold}BUY ${C.reset}` : `${C.dim}SELL${C.reset}`

  return `${indent}[${String(idx).padStart(2)}] ${ts}  ${sideStr} ${outColor}${outcome.padEnd(3)}${C.reset}  p:${price}  sz:${sz}  $:${usdc}  ${C.dim}${hash}${C.reset}`
}

// ─── Multi-market render ──────────────────────────────────────────────────────

// Returns a fixed-height block: 1 header line + MAX_DISPLAY trade lines
function fmtTimeframeBlock(key, label) {
  const ms    = mstate[key]
  const now   = Date.now()
  const isNew = ms.newMarketAt > 0 && (now - ms.newMarketAt) < NEW_FLASH_MS

  const { yesPrice, noPrice } = derivePrices(key)
  const upStr = yesPrice !== null ? `${C.green}↑${yesPrice.toFixed(3)}${C.reset}` : `${C.dim}↑ — ${C.reset}`
  const dnStr = noPrice  !== null ? `${C.red}↓${noPrice.toFixed(3)}${C.reset}`   : `${C.dim}↓ — ${C.reset}`

  const question  = ms.currentTitle ? ms.currentTitle.slice(0, 52) : `${C.dim}(waiting...)${C.reset}`
  const countStr  = `${C.dim}[${ms.currentTrades.length}/${ms.totalSeen}]${C.reset}`
  const newTag    = isNew ? `${C.yellow}${C.bold}★ NEW${C.reset} ` : `      `
  const labelStr  = `${C.bold}${label.padEnd(3)}${C.reset}`

  const lines = []
  lines.push(`  ${labelStr} ${newTag}${question}  ${upStr} ${dnStr} ${countStr}`)

  const show = ms.currentTrades.slice(0, MAX_DISPLAY)
  for (let i = 0; i < MAX_DISPLAY; i++) {
    lines.push(show[i] ? fmtTrade(show[i], i + 1, "      ") : ``)
  }

  return lines
}

function renderAll() {
  const out = []

  out.push(`${C.bold}=== Polymarket Live Trade Watcher ===${C.reset}`)
  out.push(`Wallet : ${C.dim}${WALLET}${C.reset}`)
  out.push(`Time   : ${isoNow()} ET  |  Poll #${pollCount}  ${fetchMs}ms  every ${INTERVAL_MS}ms`)
  out.push(`Trades : ${totalNewTrades} matched  |  showing last ${MAX_DISPLAY} per market`)
  out.push(``)

  for (const pair of COIN_PAIRS) {
    const bar = "━".repeat(Math.max(2, 58 - pair.label.length))
    out.push(`${C.cyan}${C.bold}━━━ ${pair.label} ${bar}${C.reset}`)
    for (const line of fmtTimeframeBlock(pair.m5,  "5m"))  out.push(line)
    out.push(``)
    for (const line of fmtTimeframeBlock(pair.m15, "15m")) out.push(line)
    out.push(``)
  }

  process.stdout.write("\x1B[H")
  for (const line of out) process.stdout.write(`\x1B[2K${line}\n`)
}

// ─── Single-market render ─────────────────────────────────────────────────────

function renderSingle(key) {
  const ms     = mstate[key]
  const market = MARKETS.find(m => m.key === key)
  const now    = Date.now()
  const isNew  = ms.newMarketAt > 0 && (now - ms.newMarketAt) < NEW_FLASH_MS
  const { yesPrice, noPrice } = derivePrices(key)

  const RULE = "═".repeat(62)
  const THIN = "─".repeat(62)

  const out = []

  // Header
  out.push(`${C.bold}=== ${market.label} Live ===${C.reset}  ${C.dim}${WALLET}${C.reset}`)
  out.push(`Time   : ${isoNow()} ET  |  Poll #${pollCount}  ${fetchMs}ms  every ${INTERVAL_MS}ms`)
  out.push(``)

  // New market banner OR normal divider — always exactly 3 lines so height stays fixed
  if (isNew) {
    out.push(`${C.yellow}${C.bold}${RULE}${C.reset}`)
    out.push(`${C.yellow}${C.bold}  ★  NEW MARKET STARTED${C.reset}`)
    out.push(`${C.yellow}${C.bold}${RULE}${C.reset}`)
  } else {
    out.push(`${C.cyan}${RULE}${C.reset}`)
    out.push(`${C.cyan}  CURRENT MARKET${C.reset}`)
    out.push(`${C.cyan}${RULE}${C.reset}`)
  }

  // Market question (up to 2 lines of ~65 chars each, always 2 lines emitted)
  const question   = ms.currentTitle || "(waiting for first trade...)"
  const qLine1     = question.slice(0, 65)
  const qLine2     = question.length > 65 ? question.slice(65, 130) : ""
  out.push(``)
  out.push(`  ${C.bold}${C.white}${qLine1}${C.reset}`)
  out.push(qLine2 ? `  ${C.bold}${C.white}${qLine2}${C.reset}` : ``)

  // Live prices
  out.push(``)
  const upLine = yesPrice !== null
    ? `  ${C.green}${C.bold}↑  YES   ${yesPrice.toFixed(4)}${C.reset}  ${C.dim}(${(yesPrice * 100).toFixed(1)}% chance UP)${C.reset}`
    : `  ${C.dim}↑  YES   —${C.reset}`
  const dnLine = noPrice !== null
    ? `  ${C.red}${C.bold}↓  NO    ${noPrice.toFixed(4)}${C.reset}  ${C.dim}(${(noPrice * 100).toFixed(1)}% chance DOWN)${C.reset}`
    : `  ${C.dim}↓  NO    —${C.reset}`
  out.push(upLine)
  out.push(dnLine)

  // Stats bar
  const lastTime = ms.lastTs ? toET(ms.lastTs).slice(11, 19) : "—"
  out.push(``)
  out.push(`  ${C.dim}Trades this market: ${ms.currentTrades.length}   Total seen: ${ms.totalSeen}   Last: ${lastTime}${C.reset}`)

  // Trade table
  out.push(``)
  out.push(`  ${C.dim}${THIN}${C.reset}`)

  const show = ms.currentTrades.slice(0, MAX_DISPLAY)
  for (let i = 0; i < MAX_DISPLAY; i++) {
    out.push(show[i] ? fmtTrade(show[i], i + 1, "  ") : ``)
  }

  // Previous market
  out.push(``)
  out.push(`  ${C.dim}${THIN}${C.reset}`)
  out.push(`  ${C.dim}PREV  ${ms.prevTitle || "(none)"}${C.reset}`)
  out.push(``)

  process.stdout.write("\x1B[H")
  for (const line of out) process.stdout.write(`\x1B[2K${line}\n`)
}

// ─── Fetch & poll loop ────────────────────────────────────────────────────────

async function fetchTrades() {
  const now    = Math.floor(Date.now() / 1000)
  const params = new URLSearchParams({
    user: WALLET, limit: String(LIMIT), offset: "0",
    type: "TRADE", sortBy: "TIMESTAMP", sortDirection: "DESC",
    start: String(START_TS), end: String(now),
  })
  const res = await fetch(`https://data-api.polymarket.com/activity?${params}`, {
    headers: { accept: "application/json", "user-agent": "last_view/4.1" },
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

async function poll() {
  process.stdout.write("\x1B[?25l")  // hide cursor
  process.stdout.write("\x1Bc")      // clear once at startup

  process.on("SIGINT", () => {
    process.stdout.write("\x1B[?25h\n")
    process.exit(0)
  })

  // In single-market mode only track the requested market for efficiency
  const activeMarkets = MARKET_KEY
    ? MARKETS.filter(m => m.key === MARKET_KEY)
    : MARKETS

  while (true) {
    const t0 = Date.now()

    try {
      const rows = await fetchTrades()
      fetchMs = Date.now() - t0
      pollCount++

      if (Array.isArray(rows)) {
        for (const t of rows) {
          const key = tradeKey(t)
          if (seenKeys.has(key)) continue
          seenKeys.add(key)

          let matched = false
          for (const market of activeMarkets) {
            if (!matchesMarket(t, market)) continue
            processTrade(t, market)
            matched = true
          }
          if (matched) totalNewTrades++
        }
      }
    } catch (_) {
      fetchMs = Date.now() - t0
      pollCount++
    }

    MARKET_KEY ? renderSingle(MARKET_KEY) : renderAll()

    await sleep(Math.max(0, INTERVAL_MS - (Date.now() - t0)))
  }
}

poll()
