const axios = require("axios")
const fs = require("fs")

const WALLET = process.argv[2]
const LIMIT = 500
const MAX_HISTORICAL_OFFSET = 3000
const MIN_WINDOW_SECONDS = 3600
const POLL_INTERVAL_MS = 3000

if (!WALLET) {
  console.log("Usage: node trades.js WALLET")
  process.exit(1)
}

const MARKETS = [
  { key: "btc5m",   coins: ["bitcoin", "btc"],         interval: 5,  file: "btc_5min_trades_2026_live.csv" },
  { key: "btc15m",  coins: ["bitcoin", "btc"],         interval: 15, file: "btc_15min_trades_2026_live.csv" },
  { key: "eth5m",   coins: ["ethereum", "eth"],        interval: 5,  file: "eth_5min_trades_2026_live.csv" },
  { key: "eth15m",  coins: ["ethereum", "eth"],        interval: 15, file: "eth_15min_trades_2026_live.csv" },
  { key: "bnb5m",   coins: ["binance", "bnb"],         interval: 5,  file: "bnb_5min_trades_2026_live.csv" },
  { key: "bnb15m",  coins: ["binance", "bnb"],         interval: 15, file: "bnb_15min_trades_2026_live.csv" },
  { key: "xrp5m",   coins: ["ripple", "xrp"],          interval: 5,  file: "xrp_5min_trades_2026_live.csv" },
  { key: "xrp15m",  coins: ["ripple", "xrp"],          interval: 15, file: "xrp_15min_trades_2026_live.csv" },
  { key: "sol5m",   coins: ["solana", "sol"],           interval: 5,  file: "sol_5min_trades_2026_live.csv" },
  { key: "sol15m",  coins: ["solana", "sol"],           interval: 15, file: "sol_15min_trades_2026_live.csv" },
  { key: "hype5m",  coins: ["hyperliquid", "hype"],    interval: 5,  file: "hype_5min_trades_2026_live.csv" },
  { key: "hype15m", coins: ["hyperliquid", "hype"],    interval: 15, file: "hype_15min_trades_2026_live.csv" },
  { key: "doge5m",  coins: ["dogecoin", "doge"],        interval: 5,  file: "doge_5min_trades_2026_live.csv" },
  { key: "doge15m", coins: ["dogecoin", "doge"],        interval: 15, file: "doge_15min_trades_2026_live.csv" },
]

// (?<![0-9])5m(?![0-9a-zA-Z]) prevents "15m" from matching the 5m rule
const INTERVAL_SLUG_RX = {
  5:  /(?<![0-9])5m(?![0-9a-zA-Z])|(?<![0-9])5min/,
  15: /15m|15min/,
}

const CSV_HEADER = "timestampET,timestampUnix,title,slug,size,usdcSize,price,side,outcome,txHash\n"

for (const m of MARKETS) {
  m.stream = fs.createWriteStream(m.file, { flags: "w" })
  m.stream.write(CSV_HEADER)
  m.seen = new Set()
  m.saved = 0
}

let totalFetched = 0
let requestCount = 0
let newestSeenTimestamp = 0

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function unixFromUTC(year, month, day, hour = 0, min = 0, sec = 0) {
  return Math.floor(Date.UTC(year, month, day, hour, min, sec) / 1000)
}

function toET(timestamp) {
  return new Date(timestamp * 1000)
    .toLocaleString("sv-SE", { timeZone: "America/New_York" })
    .replace(" ", "T")
}

function buildUrl(startTs, endTs, offset) {
  const params = new URLSearchParams({
    user: WALLET,
    limit: String(LIMIT),
    offset: String(offset),
    type: "TRADE",
    sortBy: "TIMESTAMP",
    sortDirection: "DESC",
    start: String(startTs),
    end: String(endTs),
  })
  return `https://data-api.polymarket.com/activity?${params.toString()}`
}

async function fetchPage(startTs, endTs, offset) {
  const url = buildUrl(startTs, endTs, offset)
  requestCount++
  try {
    const res = await axios.get(url, { timeout: 30000 })
    return res.data
  } catch (err) {
    const status = err.response?.status
    const body = err.response?.data
    console.log("\nRequest failed")
    console.log("URL:", url)
    console.log("Status:", status || "unknown")
    if (body) {
      console.log("Response:", typeof body === "string" ? body : JSON.stringify(body))
    }
    throw err
  }
}

function matchesMarket(t, market) {
  const title = (t.title || "").toLowerCase()
  const slug = (t.slug || t.market?.slug || t.marketSlug || "").toLowerCase()

  const hasCoin = market.coins.some(c => title.includes(c) || slug.includes(c))
  if (!hasCoin) return false

  const n = market.interval
  const titlePatterns = [`${n} min`, `${n}-min`, `${n} minute`, `${n}-minute`]
  const hasInterval = titlePatterns.some(p => title.includes(p)) || INTERVAL_SLUG_RX[n].test(slug)
  if (!hasInterval) return false

  return (
    title.includes("up or down") || title.includes("above") || title.includes("below") ||
    title.includes("higher") || title.includes("lower") ||
    slug.includes("updown") || slug.includes("above") || slug.includes("below")
  )
}

function rowKey(t) {
  return [
    t.timestamp ?? "",
    t.transactionHash ?? "",
    t.side ?? "",
    t.outcome ?? "",
    t.price ?? "",
    t.size ?? "",
  ].join("_")
}

function writeRow(stream, t) {
  const title = (t.title || "").replace(/"/g, '""')
  const slug = (t.slug || t.market?.slug || t.marketSlug || "").replace(/"/g, '""')
  stream.write(
    `${toET(t.timestamp)},${t.timestamp},"${title}","${slug}",${t.size ?? ""},${t.usdcSize ?? ""},${t.price ?? ""},${t.side ?? ""},${t.outcome ?? ""},${t.transactionHash ?? ""}\n`
  )
}

function totalSaved() {
  return MARKETS.reduce((s, m) => s + m.saved, 0)
}

async function processRows(rows, liveMode = false) {
  let savedThisBatch = 0

  for (const t of rows) {
    totalFetched++
    if (!t.timestamp) continue
    if (t.timestamp > newestSeenTimestamp) newestSeenTimestamp = t.timestamp

    const key = rowKey(t)

    for (const market of MARKETS) {
      if (!matchesMarket(t, market)) continue
      if (market.seen.has(key)) continue
      market.seen.add(key)
      writeRow(market.stream, t)
      market.saved++
      savedThisBatch++

      if (liveMode) {
        console.log(`LIVE [${market.key}] ${toET(t.timestamp)} | ${t.side} | ${t.outcome} | ${t.price} | ${t.size}`)
      }
    }
  }

  return savedThisBatch
}

async function crawlWindow(startTs, endTs, depth = 0) {
  const indent = " ".repeat(depth * 2)
  if (startTs > endTs) return

  let offset = 0
  let page = 1

  while (offset <= MAX_HISTORICAL_OFFSET) {
    await sleep(150)
    const rows = await fetchPage(startTs, endTs, offset)

    if (!Array.isArray(rows) || rows.length === 0) {
      if (page === 1) console.log(`${indent}window ${startTs}-${endTs} | empty`)
      return
    }

    const saved = await processRows(rows, false)

    console.log(
      `${indent}window ${startTs}-${endTs} | page ${page} | offset ${offset} | fetched ${rows.length} | saved ${saved} | total ${totalSaved()}`
    )

    if (rows.length < LIMIT) return

    if (offset === MAX_HISTORICAL_OFFSET && rows.length === LIMIT) {
      const span = endTs - startTs
      if (span <= MIN_WINDOW_SECONDS) {
        console.log(`${indent}dense window hit cap and can't split smaller: ${startTs}-${endTs}`)
        return
      }
      const mid = Math.floor((startTs + endTs) / 2)
      console.log(`${indent}splitting dense window ${startTs}-${endTs}`)
      await crawlWindow(mid + 1, endTs, depth + 1)
      await crawlWindow(startTs, mid, depth + 1)
      return
    }

    offset += LIMIT
    page++
  }
}

async function livePoll(startTs) {
  console.log(`\nEntering live polling mode every ${POLL_INTERVAL_MS} ms...\n`)

  while (true) {
    try {
      const endTs = Math.floor(Date.now() / 1000)
      const rows = await fetchPage(startTs, endTs, 0)

      if (Array.isArray(rows) && rows.length > 0) {
        const freshOnly = rows.filter(r => (r.timestamp || 0) >= newestSeenTimestamp - 5)
        await processRows(freshOnly.reverse(), true)
      }
    } catch (err) {
      console.log("Live poll error:", err.message)
    }

    await sleep(POLL_INTERVAL_MS)
  }
}

async function main() {
  try {
    const startTs = unixFromUTC(2026, 0, 1, 0, 0, 0)
    const endTs = Math.floor(Date.now() / 1000)

    console.log("Backfilling from NOW back to 2026-01-01 00:00:00 UTC...\n")
    await crawlWindow(startTs, endTs, 0)

    console.log("\nBackfill complete")
    console.log("Requests:", requestCount)
    console.log("Rows fetched:", totalFetched)
    console.log("Rows saved:", totalSaved())
    for (const m of MARKETS) {
      console.log(`  ${m.key}: ${m.saved} rows → ${m.file}`)
    }
    console.log("Newest timestamp seen:", newestSeenTimestamp, toET(newestSeenTimestamp))

    await livePoll(startTs)
  } catch (err) {
    for (const m of MARKETS) m.stream.end()
    console.log("\nFatal error:", err.message)
  }
}

main()
