const axios = require("axios")
const fs = require("fs")

const WALLET = process.argv[2]
const LIMIT = 500

const file = fs.createWriteStream("polymarket_history.csv")

file.write("MarketID,Time,Side,Outcome,Shares,Price,TxHash\n")

async function fetchTrades() {

    let before = null

    while (true) {

        let url =
        `https://data-api.polymarket.com/activity?user=${WALLET}&limit=${LIMIT}`

        if (before)
            url += `&before=${before}`

        const res = await axios.get(url)

        const data = res.data

        if (!data || data.length === 0) break

        const trades = data.filter(t => t.type === "TRADE")

        for (const t of trades) {

            const line =
            `${t.conditionId},${t.timestamp},${t.side},${t.outcome},${t.size},${t.price},${t.transactionHash}\n`

            file.write(line)
        }

        console.log("Processed batch", trades)

        before = data[data.length - 1].timestamp

        await new Promise(r => setTimeout(r, 200))
    }

    file.end()
}

fetchTrades()