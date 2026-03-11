const axios = require("axios")
const fs = require("fs")

const WALLET = process.argv[2]
const LIMIT = 500
const MAX_HISTORICAL_OFFSET = 3000
const MIN_WINDOW_SECONDS = 3600
const POLL_INTERVAL_MS = 3000

if (!WALLET) {
  console.log("Usage: node index9.js WALLET")
  process.exit(1)
}

const file = fs.createWriteStream("btc_5min_trades_2026_live.csv", { flags: "w" })
file.write("timestampET,timestampUnix,title,slug,size,usdcSize,price,side,outcome,txHash\n")

const seen = new Set()
let totalFetched = 0
let totalSaved = 0
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

function isBtc5mTrade(t) {
  const title = (t.title || "").toLowerCase()
  const slug = (t.slug || t.market?.slug || t.marketSlug || "").toLowerCase()

  const isBtc =
    title.includes("bitcoin") ||
    title.includes("btc") ||
    slug.includes("bitcoin") ||
    slug.includes("btc")

  const isFiveMin =
    title.includes("5 min") ||
    title.includes("5-min") ||
    title.includes("5 minute") ||
    title.includes("5-minute") ||
    slug.includes("5m") ||
    slug.includes("5-min") ||
    slug.includes("5minute")

  const isDirectional =
    title.includes("up or down") ||
    title.includes("above") ||
    title.includes("below") ||
    title.includes("higher") ||
    title.includes("lower") ||
    slug.includes("updown") ||
    slug.includes("above") ||
    slug.includes("below")

  return isBtc && isFiveMin && isDirectional
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

function writeRow(t) {
  const title = (t.title || "").replace(/"/g, '""')
  const slug = (t.slug || t.market?.slug || t.marketSlug || "").replace(/"/g, '""')

  const line =
    `${toET(t.timestamp)},${t.timestamp},"${title}","${slug}",${t.size ?? ""},${t.usdcSize ?? ""},${t.price ?? ""},${t.side ?? ""},${t.outcome ?? ""},${t.transactionHash ?? ""}\n`

  file.write(line)
}

async function processRows(rows, liveMode = false) {
  let saved = 0

  for (const t of rows) {
    totalFetched++

    if (!t.timestamp) continue
    if (t.timestamp > newestSeenTimestamp) {
      newestSeenTimestamp = t.timestamp
    }

    if (!isBtc5mTrade(t)) continue

    const key = rowKey(t)
    if (seen.has(key)) continue
    seen.add(key)

    writeRow(t)
    saved++
    totalSaved++

    if (liveMode) {
      console.log(`LIVE ${toET(t.timestamp)} | ${t.side} | ${t.outcome} | ${t.price} | ${t.size}`)
    }
  }

  return saved
}

// Backfill newest -> older
async function crawlWindow(startTs, endTs, depth = 0) {
  const indent = " ".repeat(depth * 2)

  if (startTs > endTs) return

  let offset = 0
  let page = 1

  while (offset <= MAX_HISTORICAL_OFFSET) {
    await sleep(150)
    const rows = await fetchPage(startTs, endTs, offset)

    if (!Array.isArray(rows) || rows.length === 0) {
      if (page === 1) {
        console.log(`${indent}window ${startTs}-${endTs} | empty`)
      }
      return
    }

    const saved = await processRows(rows, false)

    console.log(
      `${indent}window ${startTs}-${endTs} | page ${page} | offset ${offset} | fetched ${rows.length} | saved ${saved} | total ${totalSaved}`
    )

    if (rows.length < LIMIT) {
      return
    }

    if (offset === MAX_HISTORICAL_OFFSET && rows.length === LIMIT) {
      const span = endTs - startTs

      if (span <= MIN_WINDOW_SECONDS) {
        console.log(`${indent}dense window hit cap and can't split smaller: ${startTs}-${endTs}`)
        return
      }

      const mid = Math.floor((startTs + endTs) / 2)
      console.log(`${indent}splitting dense window ${startTs}-${endTs}`)

      // newer half first, then older half
      await crawlWindow(mid + 1, endTs, depth + 1)
      await crawlWindow(startTs, mid, depth + 1)
      return
    }

    offset += LIMIT
    page++
  }
}

// Near-real-time tailing of latest page
async function livePoll(startTs) {
  console.log(`\nEntering live polling mode every ${POLL_INTERVAL_MS} ms...\n`)

  while (true) {
    try {
      const endTs = Math.floor(Date.now() / 1000)
      const rows = await fetchPage(startTs, endTs, 0)

      if (Array.isArray(rows) && rows.length > 0) {
        // newest first already; reverse so console/file append feels chronological for newly arrived rows
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
    console.log("Rows saved:", totalSaved)
    console.log("Newest timestamp seen:", newestSeenTimestamp, toET(newestSeenTimestamp))

    await livePoll(startTs)
  } catch (err) {
    file.end()
    console.log("\nFatal error:", err.message)
  }
}

main()