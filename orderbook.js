import axios from "axios"
import { ClobClient } from "@polymarket/clob-client"

const client = new ClobClient("https://clob.polymarket.com", 137)

async function main(){

    const res = await axios.get(
        "https://gamma-api.polymarket.com/markets"
    )

    const markets = res.data

    // find active BTC 5m market
    const btcMarket = markets.find(m =>
        m.question &&
        m.question.includes("Bitcoin Up or Down") &&
        m.active === true
    )

    if(!btcMarket){
        console.log("No BTC 5m market found")
        return
    }

    console.log("Market:", btcMarket.question)

    const upToken = btcMarket.tokens[0].token_id
    const downToken = btcMarket.tokens[1].token_id

    console.log("UP token:", upToken)
    console.log("DOWN token:", downToken)

    const upBook = await client.getOrderBook(upToken)
    const downBook = await client.getOrderBook(downToken)

    console.log("\n===== UP =====")
    console.log("Best Bid:", upBook.bids[0])
    console.log("Best Ask:", upBook.asks[0])

    console.log("\n===== DOWN =====")
    console.log("Best Bid:", downBook.bids[0])
    console.log("Best Ask:", downBook.asks[0])

}

main()