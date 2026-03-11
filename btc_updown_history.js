const axios = require("axios")
const fs = require("fs")
const pLimit = require("p-limit")

const YEAR = 2026

const START = new Date(`${YEAR}-01-01`).getTime()/1000
const END   = new Date(`${YEAR}-12-31`).getTime()/1000

const limit = pLimit(10)   // concurrency control

const file = fs.createWriteStream(`btc_updown_${YEAR}.csv`)

file.write(
"market_slug,outcome,timestamp,price,size,side\n"
)

async function getAllMarkets(){

    let offset = 0
    const limitSize = 1000
    let all = []

    while(true){

        const url =
        `https://gamma-api.polymarket.com/markets?limit=${limitSize}&offset=${offset}`

        const res = await axios.get(url)

        const markets = res.data

        if(!markets || markets.length === 0)
            break

        all.push(...markets)

        offset += limitSize

        console.log("Fetched markets:", all.length)
    }

    return all
}

async function fetchTrades(tokenId, outcome, slug){

    let offset = 0
    const limitSize = 500

    while(true){

        const url =
        `https://data-api.polymarket.com/trades?market=${tokenId}&limit=${limitSize}&offset=${offset}`

        const res = await axios.get(url)

        const trades = res.data

        if(!trades || trades.length === 0)
            break

        for(const t of trades){

            if(t.timestamp < START || t.timestamp > END)
                continue

            const time = new Date(t.timestamp*1000).toISOString()

            file.write(
`${slug},${outcome},${time},${t.price},${t.size},${t.side}\n`
            )
        }

        offset += limitSize
    }

    console.log("Finished:", slug, outcome)
}

async function main(){

    console.log("Downloading markets...")

    const markets = await getAllMarkets()

    console.log("Total markets:", markets.length)

    const btcMarkets = markets.filter(m => {

        if(!m.slug) return false

        if(!m.slug.includes("bitcoin-up-or-down"))
            return false

        const start = new Date(m.startDate).getTime()/1000

        return start >= START && start <= END
    })

    console.log("BTC markets found:", btcMarkets.length)

    let jobs = []

    for(const m of btcMarkets){

        if(!m.outcomeTokens)
            continue

        for(const token of m.outcomeTokens){

            jobs.push(
                limit(() =>
                    fetchTrades(
                        token.tokenId,
                        token.outcome,
                        m.slug
                    )
                )
            )
        }
    }

    await Promise.all(jobs)

    console.log("DONE")
}

main()