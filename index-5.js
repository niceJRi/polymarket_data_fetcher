const axios = require("axios")
const XLSX = require("xlsx")

const WALLET = process.argv[2]
const LIMIT = 500

async function fetchAllTrades() {

    let all = []
    let before = null

    while (true) {

        let url =
        `https://data-api.polymarket.com/trades?user=${WALLET}&limit=${LIMIT}`

        if (before)
            url += `&before=${before}`

        const res = await axios.get(url)

        const trades = res.data

        if (!trades || trades.length === 0) break

        all = all.concat(trades)

        console.log(`Fetched trades: ${all.length}`)

        before = trades[trades.length - 1].timestamp

        await new Promise(r => setTimeout(r, 200)) // avoid rate limit
    }

    return all
}

async function fetchMarket(conditionId) {

    const url =
    `https://gamma-api.polymarket.com/markets?condition_ids=${conditionId}`

    const res = await axios.get(url)

    if (!res.data || res.data.length === 0) return null

    return res.data[0]
}

function calculatePnL(trades, resolvedOutcome) {

    let cost = 0
    let shares = 0

    for (const t of trades) {

        const value = t.price * t.size

        if (t.side === "BUY") {

            cost += value
            shares += t.size

        } else {

            cost -= value
            shares -= t.size
        }
    }

    if (!resolvedOutcome) return 0

    const payout =
        trades[0].outcome === resolvedOutcome
        ? shares * 1
        : 0

    return payout - cost
}

async function run() {

    console.log("Fetching ALL trades...")

    const trades = await fetchAllTrades()

    console.log("Total trades:", trades.length)

    const markets = {}

    for (const t of trades) {

        if (!markets[t.conditionId])
            markets[t.conditionId] = []

        markets[t.conditionId].push(t)
    }

    const rows = []

    for (const conditionId in markets) {

        const marketTrades = markets[conditionId]
            .sort((a,b)=>a.timestamp-b.timestamp)

        const market = await fetchMarket(conditionId)

        const title = market ? market.question : "Unknown Market"
        const resolved = market ? market.resolvedOutcome : null

        const pnl = calculatePnL(marketTrades, resolved)

        const result = pnl > 0 ? "WIN" : "LOSS"

        for (const trade of marketTrades) {

            rows.push({

                Market: title,
                MarketID: conditionId,
                Result: result,
                PnL: pnl,

                Time: new Date(trade.timestamp * 1000).toISOString(),

                Side: trade.side,
                Outcome: trade.outcome,
                Shares: trade.size,
                Price: trade.price,

                TxHash: trade.transactionHash
            })
        }
    }

    const sheet = XLSX.utils.json_to_sheet(rows)

    const workbook = XLSX.utils.book_new()

    XLSX.utils.book_append_sheet(workbook, sheet, "Trades")

    XLSX.writeFile(workbook, "polymarket_full_history.xlsx")

    console.log("Export complete → polymarket_full_history.xlsx")
}

run()