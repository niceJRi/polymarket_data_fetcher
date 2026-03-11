const axios = require("axios")
const fs = require("fs")

const WALLET = process.argv[2]
const LIMIT = 500

const markets = {}
const marketCache = {}

async function fetchMarket(conditionId){

    if(marketCache[conditionId])
        return marketCache[conditionId]

    try{

        const res = await axios.get(
            `https://gamma-api.polymarket.com/markets?condition_ids=${conditionId}`
        )

        const market = res.data?.[0] || null

        marketCache[conditionId] = market

        return market

    }catch(e){

        return null
    }
}

async function fetchTrades(){

    let before = null

    while(true){

        let url =
        `https://data-api.polymarket.com/activity?user=${WALLET}&limit=${LIMIT}`

        if(before)
            url += `&before=${before}`

        const res = await axios.get(url)

        const activity = res.data

        if(!activity || activity.length === 0)
            break

        const trades = activity.filter(a => a.type === "TRADE")

        for(const a of trades){

            const t = a.data

            if(!t) continue

            const conditionId = t.conditionId
            const outcome = t.outcome
            const price = Number(t.price)
            const size = Number(t.size)
            const side = t.side

            const key = `${conditionId}_${outcome}`

            if(!markets[key]){

                markets[key] = {
                    conditionId,
                    outcome,
                    cost:0,
                    shares:0,
                    timestamp:a.timestamp
                }
            }

            const m = markets[key]

            const value = price * size

            if(side === "BUY"){

                m.cost += value
                m.shares += size

            }else{

                m.cost -= value
                m.shares -= size
            }
        }

        console.log("Processed batch")

        before = activity[activity.length-1].timestamp

        await new Promise(r=>setTimeout(r,200))
    }
}

async function exportResults(){

    const file = fs.createWriteStream("polymarket_market_summary.csv")

    file.write(
"Market,Outcome,AvgPrice,SharesBought,PnL,EndPrice,EndDate,ConditionId\n"
)

    for(const key in markets){

        const m = markets[key]

        const market = await fetchMarket(m.conditionId)

        const title = market?.question || "Unknown Market"

        const endPrice =
            market?.resolvedOutcome === m.outcome ? 1 : 0

        const pnl = m.shares * endPrice - m.cost

        const avgPrice = m.cost / (m.shares || 1)

        const line =
`${title},${m.outcome},${avgPrice},${m.shares},${pnl},${endPrice},${market?.endDate},${m.conditionId}\n`

        file.write(line)
    }

    file.end()

    console.log("Export complete → polymarket_market_summary.csv")
}

async function run(){

    console.log("Fetching trades...")

    await fetchTrades()

    console.log("Calculating results...")

    await exportResults()
}

run()