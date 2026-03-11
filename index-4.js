const axios = require("axios")
const XLSX = require("xlsx")

const WALLET = process.argv[2]

async function fetchAll() {

    let offset = 0
    const limit = 500
    let all = []

    while (true) {

        const url =
        `https://data-api.polymarket.com/closed-positions?user=${WALLET}&limit=${limit}&offset=${offset}&sortBy=timestamp&sortDirection=ASC`

        const res = await axios.get(url)

        const data = res.data

        if (!data.length) break

        all = all.concat(data)

        console.log(`Fetched ${all.length}`)

        offset += limit
    }

    return all
}

async function run() {

    const data = await fetchAll()

    const rows = data.map(p => ({

        Market: p.title,
        Outcome: p.outcome,
        AvgPrice: p.avgPrice,
        SharesBought: p.totalBought,
        PnL: p.realizedPnl,
        EndPrice: p.curPrice,
        EndDate: new Date(p.endDate).toISOString(),
        Timestamp: new Date(p.timestamp * 1000).toISOString(),
        ConditionId: p.conditionId
    }))

    const sheet = XLSX.utils.json_to_sheet(rows)

    const book = XLSX.utils.book_new()

    XLSX.utils.book_append_sheet(book, sheet, "Closed Positions")

    XLSX.writeFile(book, "polymarket_closed_positions.xlsx")

    console.log("Excel exported successfully")
}

run()