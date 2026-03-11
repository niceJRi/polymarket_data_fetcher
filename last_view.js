const axios = require("axios")

const WALLET = process.argv[2]
const LIMIT = 50
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
  return new Date(timestamp * 1000)
    .toLocaleString("sv-SE", { timeZone: "America/New_York" })
    .replace(" ", "T")
}

function buildUrl() {
  const now = Math.floor(Date.now() / 1000)
  const startTs = Math.floor(new Date("2026-01-01T00:00:00Z").getTime() / 1000)

  const params = new URLSearchParams({
    user: WALLET,
    limit: String(LIMIT),
    offset: "0",
    type: "TRADE",
    sortBy: "TIMESTAMP",
    sortDirection: "DESC",
    start: String(startTs),
    end: String(now),
  })

  return `https://data-api.polymarket.com/activity?${params.toString()}`
}

async function fetchLatestPage() {
  const url = buildUrl()
  const res = await axios.get(url, { timeout: 30000 })
  return res.data
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

function printTrade(t, isFirst = false) {
  console.clear()

  console.log(isFirst ? "Watching latest BTC 5m trade...\n" : "New latest BTC 5m trade detected\n")
  console.log("Time ET   :", toET(t.timestamp))
  console.log("Unix      :", t.timestamp)
  console.log("Title     :", t.title || "")
  console.log("Slug      :", t.slug || t.market?.slug || t.marketSlug || "")
  console.log("Side      :", t.side || "")
  console.log("Outcome   :", t.outcome || "")
  console.log("Price     :", t.price || "")
  console.log("Size      :", t.size || "")
  console.log("USDC Size :", t.usdcSize || "")
  console.log("Tx Hash   :", t.transactionHash || "")
}

async function pollLatestTrade() {
  console.log("Starting live terminal watcher...\n")

  while (true) {
    try {
      const rows = await fetchLatestPage()

      if (Array.isArray(rows) && rows.length > 0) {
        const latestTrade = rows.find(isBtc5mTrade)

        if (latestTrade) {
          const key = tradeKey(latestTrade)

          if (!lastSeenKey) {
            lastSeenKey = key
            printTrade(latestTrade, true)
          } else if (key !== lastSeenKey) {
            lastSeenKey = key
            printTrade(latestTrade, false)
          }
        } else {
          console.log("No BTC 5m trade found on latest page.")
        }
      } else {
        console.log("No data returned.")
      }
    } catch (err) {
      console.log("Poll error:", err.response?.status || "", err.message)
    }

    await sleep(POLL_INTERVAL_MS)
  }
}

pollLatestTrade()