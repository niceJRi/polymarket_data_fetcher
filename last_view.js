#!/usr/bin/env node

/**
 * Live BTC 5m trade watcher
 * - Shows ALL trades in the same second, not just one
 * - Groups trades by timestamp for easy reading
 * - Fast polling with native fetch (no axios overhead)
 * - Single screen clear per render cycle
 *
 * Usage:
 *   node last_view.js <WALLET>
 *   node last_view.js <WALLET> --interval=100
 *   node last_view.js <WALLET> --limit=100
 */

const WALLET = process.argv.find((a, i) => i >= 2 && !a.startsWith("--"))
const INTERVAL_MS = Number((process.argv.find(a => a.startsWith("--interval=")) || "").split("=")[1]) || 100
const LIMIT = Number((process.argv.find(a => a.startsWith("--limit=")) || "").split("=")[1]) || 100

if (!WALLET) {
  console.error("Usage: node last_view.js <WALLET> [--interval=100] [--limit=100]")
  process.exit(1)
}

const START_TS = Math.floor(new Date("2026-01-01T00:00:00Z").getTime() / 1000)

// All trade keys seen so far — never re-print a trade
const seenKeys = new Set()
// Rolling list of trade groups to display (newest first)
const displayGroups = []
const DISPLAY_WINDOW_SEC = 3 // only show trades from the last 3 seconds

let pollCount = 0
let fetchMs = 0
let totalNewTrades = 0

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function toET(timestamp) {
  return new Date(timestamp * 1000)
    .toLocaleString("sv-SE", { timeZone: "America/New_York" })
    .replace(" ", "T")
}

function isoNow() {
  return new Date().toLocaleString("sv-SE", { timeZone: "America/New_York" })
}

function isBtc5mTrade(t) {
  const title = (t.title || "").toLowerCase()
  const slug = (t.slug || t.market?.slug || t.marketSlug || "").toLowerCase()

  const isBtc = title.includes("bitcoin") || title.includes("btc") ||
    slug.includes("bitcoin") || slug.includes("btc")

  const isFiveMin = title.includes("5 min") || title.includes("5-min") ||
    title.includes("5 minute") || title.includes("5-minute") ||
    slug.includes("5m") || slug.includes("5-min") || slug.includes("5minute")

  const isDirectional = title.includes("up or down") || title.includes("above") ||
    title.includes("below") || title.includes("higher") || title.includes("lower") ||
    slug.includes("updown") || slug.includes("above") || slug.includes("below")

  return isBtc && isFiveMin && isDirectional
}

function tradeKey(t) {
  return [t.timestamp ?? "", t.transactionHash ?? "", t.side ?? "",
          t.outcome ?? "", t.price ?? "", t.size ?? ""].join("|")
}

async function fetchTrades() {
  const now = Math.floor(Date.now() / 1000)
  const params = new URLSearchParams({
    user: WALLET,
    limit: String(LIMIT),
    offset: "0",
    type: "TRADE",
    sortBy: "TIMESTAMP",
    sortDirection: "DESC",
    start: String(START_TS),
    end: String(now),
  })

  const res = await fetch(`https://data-api.polymarket.com/activity?${params}`, {
    headers: { accept: "application/json", "user-agent": "last_view/2.0" },
    signal: AbortSignal.timeout(5000),
  })

  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

function formatTrade(t, idx) {
  const side = (t.side || "").toUpperCase().padEnd(4)
  const outcome = (t.outcome || "").padEnd(4)
  const price = String(t.price || "").padStart(6)
  const size = String(t.size || "").padStart(10)
  const usdc = String(t.usdcSize || "").padStart(10)
  const hash = (t.transactionHash || "").slice(0, 12) + "..."
  return `  [${idx}] ${side} ${outcome}  price:${price}  size:${size}  usdc:${usdc}  tx:${hash}`
}

function renderScreen() {
  process.stdout.write("\x1Bc")

  console.log("=== BTC 5m Live Trade Watcher ===")
  console.log(`Wallet    : ${WALLET}`)
  console.log(`Time      : ${isoNow()} ET`)
  console.log(`Poll #    : ${pollCount}  |  target ${INTERVAL_MS}ms  actual ${fetchMs}ms`)
  console.log(`New trades: ${totalNewTrades} total seen`)
  console.log("")

  const latestTs = displayGroups.length > 0 ? displayGroups[0].timestamp : 0
  const cutoff = latestTs - DISPLAY_WINDOW_SEC
  const visible = displayGroups.filter(g => g.timestamp >= cutoff)

  if (visible.length === 0) {
    console.log("  Waiting for BTC 5m trades...")
    return
  }

  for (const group of visible) {
    console.log(`── ${toET(group.timestamp)}  (unix: ${group.timestamp})  [${group.trades.length} trade${group.trades.length > 1 ? "s" : ""}]`)
    console.log(`   ${group.trades[0].title || group.trades[0].slug || ""}`)
    for (let i = 0; i < group.trades.length; i++) {
      console.log(formatTrade(group.trades[i], i + 1))
    }
    console.log("")
  }
}

async function poll() {
  while (true) {
    const t0 = Date.now()
    try {
      const rows = await fetchTrades()
      fetchMs = Date.now() - t0
      pollCount++

      if (Array.isArray(rows) && rows.length > 0) {
        const btcTrades = rows.filter(isBtc5mTrade)
        const newTrades = btcTrades.filter(t => {
          const k = tradeKey(t)
          if (seenKeys.has(k)) return false
          seenKeys.add(k)
          return true
        })

        if (newTrades.length > 0) {
          totalNewTrades += newTrades.length

          // Group new trades by timestamp
          const byTs = new Map()
          for (const t of newTrades) {
            const ts = t.timestamp ?? 0
            if (!byTs.has(ts)) byTs.set(ts, [])
            byTs.get(ts).push(t)
          }

          // Prepend newest groups (sorted desc by timestamp)
          const sorted = [...byTs.entries()].sort((a, b) => b[0] - a[0])
          for (const [timestamp, trades] of sorted) {
            displayGroups.unshift({ timestamp, trades })
          }

          // Keep only groups within 3 seconds of the most recent trade
          const latestTs = displayGroups.length > 0 ? displayGroups[0].timestamp : 0
          const cutoff = latestTs - DISPLAY_WINDOW_SEC
          while (displayGroups.length > 0 && displayGroups[displayGroups.length - 1].timestamp < cutoff) {
            displayGroups.pop()
          }

          renderScreen()
        } else {
          // Still update poll stats on screen without full re-render
          // Just update the header lines
          renderScreen()
        }
      }
    } catch (err) {
      fetchMs = Date.now() - t0
      pollCount++
      process.stdout.write("\x1Bc")
      console.error(`=== BTC 5m Live Trade Watcher ===`)
      console.error(`Poll #  : ${pollCount}  |  Failures`)
      console.error(`ERROR   : ${err.message}`)
      console.error(`Retry in ${INTERVAL_MS}ms...`)
    }

    const elapsed = Date.now() - t0
    const wait = Math.max(0, INTERVAL_MS - elapsed)
    await sleep(wait)
  }
}

poll()
