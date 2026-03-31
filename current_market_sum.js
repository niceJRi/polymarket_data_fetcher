const axios = require("axios")

const WALLET = process.argv[2]
const LIMIT = 200
const POLL_INTERVAL_MS = 3000

if (!WALLET) {
  console.log("Usage: node index9.js WALLET")
  process.exit(1)
}

let lastSeenKey = null

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function toET(timestamp) {
  if (!timestamp) return ""
  return new Date(timestamp * 1000)
    .toLocaleString("sv-SE", { timeZone: "America/New_York" })
    .replace(" ", "T")
}

function formatNum(v, digits = 4) {
  const n = Number(v || 0)
  if (!Number.isFinite(n)) return "0"
  return n.toFixed(digits)
}

function getSlug(t) {
  return t.slug || t.market?.slug || t.marketSlug || ""
}

function buildActivityUrl(offset = 0, limit = LIMIT) {
  const now = Math.floor(Date.now() / 1000)
  const startTs = Math.floor(new Date("2026-01-01T00:00:00Z").getTime() / 1000)

  const params = new URLSearchParams({
    user: WALLET,
    limit: String(limit),
    offset: String(offset),
    type: "TRADE",
    sortBy: "TIMESTAMP",
    sortDirection: "DESC",
    start: String(startTs),
    end: String(now),
  })

  return `https://data-api.polymarket.com/activity?${params.toString()}`
}

async function fetchActivityPage(offset = 0, limit = LIMIT) {
  const url = buildActivityUrl(offset, limit)
  const res = await axios.get(url, { timeout: 30000 })
  return res.data
}

async function fetchAllActivity(maxPages = 10) {
  const all = []

  for (let page = 0; page < maxPages; page++) {
    const offset = page * LIMIT
    const rows = await fetchActivityPage(offset, LIMIT)

    if (!Array.isArray(rows) || rows.length === 0) break

    all.push(...rows)

    if (rows.length < LIMIT) break
  }

  return all
}

function isBtc5mTrade(t) {
  const title = (t.title || "").toLowerCase()
  const slug = getSlug(t).toLowerCase()

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

function tradeKey(t) {
  return [
    t.timestamp ?? "",
    t.transactionHash ?? "",
    t.side ?? "",
    t.outcome ?? "",
    t.price ?? "",
    t.size ?? "",
  ].join("_")
}

/**
 * Parse market window from title like:
 * "Bitcoin Up or Down - March 16, 7:00AM-7:05AM ET"
 */
function parseTimeframeFromTitle(title) {
  if (!title) return null

  const m = title.match(
    /-\s*([A-Za-z]+)\s+(\d{1,2}),\s*(\d{1,2}):(\d{2})(AM|PM)\s*-\s*(\d{1,2}):(\d{2})(AM|PM)\s*ET/i
  )

  if (!m) return null

  const [
    ,
    monthName,
    dayStr,
    startHourStr,
    startMinuteStr,
    startAmpm,
    endHourStr,
    endMinuteStr,
    endAmpm,
  ] = m

  const year = new Date().getFullYear()
  const monthMap = {
    january: 0,
    february: 1,
    march: 2,
    april: 3,
    may: 4,
    june: 5,
    july: 6,
    august: 7,
    september: 8,
    october: 9,
    november: 10,
    december: 11,
  }

  const month = monthMap[monthName.toLowerCase()]
  if (month == null) return null

  function to24h(hour12, ampm) {
    let h = Number(hour12)
    const upper = ampm.toUpperCase()
    if (upper === "AM") {
      if (h === 12) h = 0
    } else {
      if (h !== 12) h += 12
    }
    return h
  }

  const startHour = to24h(startHourStr, startAmpm)
  const endHour = to24h(endHourStr, endAmpm)
  const day = Number(dayStr)
  const startMinute = Number(startMinuteStr)
  const endMinute = Number(endMinuteStr)

  // Build ET-local dates by formatting through America/New_York offset logic
  // easiest robust approach:
  const now = new Date()
  const approxStartUtc = new Date(Date.UTC(year, month, day, startHour, startMinute, 0))
  const approxEndUtc = new Date(Date.UTC(year, month, day, endHour, endMinute, 0))

  // adjust UTC dates so when rendered in ET they match intended wall-clock
  const startTs = localEtWallClockToUnix(year, month, day, startHour, startMinute)
  const endTs = localEtWallClockToUnix(year, month, day, endHour, endMinute)

  if (!startTs || !endTs) return null

  return {
    startTs,
    endTs,
    startET: toET(startTs),
    endET: toET(endTs),
  }
}

/**
 * Convert an America/New_York wall-clock datetime to unix timestamp.
 * This avoids trusting the slug.
 */
function localEtWallClockToUnix(year, month, day, hour, minute) {
  for (let offsetHours = -6; offsetHours <= -4; offsetHours++) {
    const utcMillis = Date.UTC(year, month, day, hour - offsetHours, minute, 0)
    const d = new Date(utcMillis)

    const rendered = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(d)

    const obj = {}
    for (const p of rendered) {
      if (p.type !== "literal") obj[p.type] = p.value
    }

    if (
      Number(obj.year) === year &&
      Number(obj.month) === month + 1 &&
      Number(obj.day) === day &&
      Number(obj.hour) === hour &&
      Number(obj.minute) === minute
    ) {
      return Math.floor(utcMillis / 1000)
    }
  }

  return null
}

async function fetchMarketSnapshot(slug) {
  if (!slug) return null

  try {
    const params = new URLSearchParams({ slug })
    const url = `https://gamma-api.polymarket.com/markets?${params.toString()}`
    const res = await axios.get(url, { timeout: 30000 })

    const market = Array.isArray(res.data) ? res.data[0] : res.data
    if (!market) return null

    let currentUpPrice = null
    let currentDownPrice = null

    const outcomes = Array.isArray(market.outcomes) ? market.outcomes : []
    const outcomePrices = Array.isArray(market.outcomePrices) ? market.outcomePrices : []

    for (let i = 0; i < outcomes.length; i++) {
      const name = String(outcomes[i] || "").toLowerCase()
      const price = Number(outcomePrices[i])

      if (name === "up" && Number.isFinite(price)) currentUpPrice = price
      if (name === "down" && Number.isFinite(price)) currentDownPrice = price
    }

    return {
      market,
      currentUpPrice,
      currentDownPrice,
    }
  } catch {
    return null
  }
}

function summarizeSideTrades(rows, outcomeName) {
  const filtered = rows.filter(
    t => String(t.outcome || "").toLowerCase() === outcomeName.toLowerCase()
  )

  let totalShares = 0
  let totalUsdc = 0

  for (const t of filtered) {
    const shares = Number(t.size || 0)
    const usdc =
      t.usdcSize != null
        ? Number(t.usdcSize)
        : Number(t.price || 0) * Number(t.size || 0)

    if (Number.isFinite(shares)) totalShares += shares
    if (Number.isFinite(usdc)) totalUsdc += usdc
  }

  return {
    totalShares,
    totalUsdc,
    avgPrice: totalShares > 0 ? totalUsdc / totalShares : 0,
  }
}

function filterRowsForCurrentMarket(allRows, latestTrade, timeframe) {
  const latestSlug = getSlug(latestTrade)

  return allRows.filter(t => {
    if (getSlug(t) !== latestSlug) return false
    if (!timeframe) return true

    const ts = Number(t.timestamp || 0)

    // include only rows inside the exact current market window
    return ts >= timeframe.startTs && ts <= timeframe.endTs
  })
}

function printDashboard(latestTrade, marketRows, marketSnapshot, timeframe) {
  const slug = getSlug(latestTrade)

  const up = summarizeSideTrades(marketRows, "up")
  const down = summarizeSideTrades(marketRows, "down")

  console.clear()

  console.log("Watching latest BTC 5m trade...\n")

  console.log("Latest Trade")
  console.log("Time ET   :", toET(latestTrade.timestamp))
  console.log("Unix      :", latestTrade.timestamp)
  console.log("Title     :", latestTrade.title || "")
  console.log("Slug      :", slug)
  console.log("Side      :", latestTrade.side || "")
  console.log("Outcome   :", latestTrade.outcome || "")
  console.log("Price     :", latestTrade.price || "")
  console.log("Size      :", latestTrade.size || "")
  console.log("USDC Size :", latestTrade.usdcSize || "")
  console.log("Tx Hash   :", latestTrade.transactionHash || "")

  console.log("\nCurrent Market Timeframe")
  if (timeframe) {
    console.log("Start ET  :", timeframe.startET)
    console.log("End ET    :", timeframe.endET)
  } else {
    console.log("Timeframe : could not parse from title")
  }

  console.log("\nUP")
  console.log("Shares            :", formatNum(up.totalShares, 4))
  console.log("Deposited USDC    :", formatNum(up.totalUsdc, 4))
  console.log("Average UP Price  :", formatNum(up.avgPrice, 4))
  console.log(
    "Current UP Price  :",
    marketSnapshot?.currentUpPrice == null ? "N/A" : formatNum(marketSnapshot.currentUpPrice, 4)
  )

  console.log("\nDOWN")
  console.log("Shares            :", formatNum(down.totalShares, 4))
  console.log("Deposited USDC    :", formatNum(down.totalUsdc, 4))
  console.log("Average DOWN Price:", formatNum(down.avgPrice, 4))
  console.log(
    "Current DOWN Price:",
    marketSnapshot?.currentDownPrice == null ? "N/A" : formatNum(marketSnapshot.currentDownPrice, 4)
  )

  console.log("\nRows In Current Market:", marketRows.length)
}

async function pollLatestTrade() {
  console.log("Starting live terminal watcher...\n")

  while (true) {
    try {
      const latestPage = await fetchActivityPage(0, LIMIT)

      if (Array.isArray(latestPage) && latestPage.length > 0) {
        const latestTrade = latestPage.find(isBtc5mTrade)

        if (!latestTrade) {
          console.clear()
          console.log("No BTC 5m trade found on latest page.")
          await sleep(POLL_INTERVAL_MS)
          continue
        }

        const key = tradeKey(latestTrade)
        if (!lastSeenKey || key !== lastSeenKey) {
          lastSeenKey = key
        }

        const timeframe = parseTimeframeFromTitle(latestTrade.title || "")
        const allRows = await fetchAllActivity(10)
        const marketRows = filterRowsForCurrentMarket(allRows, latestTrade, timeframe)
        const marketSnapshot = await fetchMarketSnapshot(getSlug(latestTrade))

        printDashboard(latestTrade, marketRows, marketSnapshot, timeframe)
      } else {
        console.clear()
        console.log("No data returned.")
      }
    } catch (err) {
      console.clear()
      console.log("Poll error:", err.response?.status || "", err.message)
    }

    await sleep(POLL_INTERVAL_MS)
  }
}

pollLatestTrade()