const axios = require("axios")
const XLSX = require("xlsx")

const WALLET = process.argv[2]
const LIMIT = 500

async function fetchAllActivity() {

    let all = []
    let before = null

    while (true) {

        let url =
        `https://data-api.polymarket.com/activity?user=${WALLET}&limit=${LIMIT}`

        if (before)
            url += `&before=${before}`

        const res = await axios.get(url)

        const data = res.data

        if (!data || data.length === 0) break

        console.log("Fetched activity:", all.length + data.length)

        all = all.concat(data)

        before = data[data.length - 1].timestamp

        await new Promise(r => setTimeout(r, 200))
    }

    return all
}

function calculatePnL(trades) {

    let cashflow = 0

    for (const t of trades) {

        const value = t.price * t.size

        if (t.side === "BUY")
            cashflow -= value
        else
            cashflow += value
    }

    return cashflow
}

async function run() {

    console.log("Fetching activity...")

    const activity = await fetchAllActivity()

    console.log("Total events:", activity.length)

    // keep only fills (real trades)
    const trades = activity.filter(a => a.type === "TRADE")

    console.log("Total trades:", trades.length)

    const markets = {}

    for (const t of trades) {

        const marketId = t.conditionId

        if (!markets[marketId])
            markets[marketId] = []

        markets[marketId].push(t)
    }

    const rows = []

    for (const marketId in markets) {

        const marketTrades = markets[marketId]
            .sort((a,b)=>a.timestamp-b.timestamp)

        const pnl = calculatePnL(marketTrades)

        const result = pnl >= 0 ? "WIN" : "LOSS"

        for (const trade of marketTrades) {

            rows.push({

                Market: trade.marketTitle || "Unknown",
                MarketID: marketId,

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

    XLSX.writeFile(workbook, "polymarket_activity_history.xlsx")

    console.log("Export complete → polymarket_activity_history.xlsx")
}

run()