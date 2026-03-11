const axios = require("axios")
const fs = require("fs")

const WALLET = process.argv[2]
const LIMIT = 500

const file = fs.createWriteStream("btc_5min_trades(full).csv")

file.write(
"marketWindow,timestamp,btcPrice,targetPrice,upPrice,downPrice,size,usdcSize,price,side,outcome,result,txHash\n"
)

const marketCache = {}
const btcCache = {}
const orderbookCache = {}

async function getMarketInfo(conditionId){

if(marketCache[conditionId])
return marketCache[conditionId]

try{

const url =
`https://gamma-api.polymarket.com/markets?condition_id=${conditionId}`

const res = await axios.get(url)

if(!res.data || res.data.length === 0)
return {}

const m = res.data[0]

const data = {
targetPrice: m.strike_price || "",
result: m.resolution || ""
}

marketCache[conditionId] = data

return data

}catch(e){

return {}

}

}

async function getBTCPrice(timestamp){

const minute = Math.floor(timestamp / 60)

if(btcCache[minute])
return btcCache[minute]

try{

const start = timestamp - 60
const end = timestamp + 60

const url =
`https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60&start=${new Date(start*1000).toISOString()}&end=${new Date(end*1000).toISOString()}`

const res = await axios.get(url)

if(!res.data || res.data.length === 0)
return ""

const price = res.data[0][4]

btcCache[minute] = price

return price

}catch(e){

return ""

}

}

async function getOrderbook(tokenId){

if(orderbookCache[tokenId])
return orderbookCache[tokenId]

try{

const url =
`https://clob.polymarket.com/book?token_id=${tokenId}`

const res = await axios.get(url)

const book = res.data

const data = {
upPrice: book.bids?.[0]?.price || "",
downPrice: book.asks?.[0]?.price || ""
}

orderbookCache[tokenId] = data

return data

}catch(e){

return {}

}

}

function toMinutes(time){

let [h,m] = time.match(/\d+/g).map(Number)

if(time.includes("PM") && h !== 12)
h += 12

if(time.includes("AM") && h === 12)
h = 0

return h*60 + m

}

async function fetchTrades(){

let before = null

while(true){

let url =
`https://data-api.polymarket.com/activity?user=${WALLET}&limit=${LIMIT}`

if(before)
url += `&before=${before}`

const res = await axios.get(url)

const data = res.data

if(!data || data.length === 0)
break

const trades = data.filter(t => t.type === "TRADE")

for(const t of trades){

const title = t.title || ""

if(!title.includes("Bitcoin Up or Down"))
continue

const match = title.match(/(\d+:\d+[AP]M-\d+:\d+[AP]M)/)

if(!match)
continue

const marketWindow = match[1]

const [start,end] = marketWindow.split("-")

const diff = toMinutes(end) - toMinutes(start)

if(diff !== 5)
continue

const d = new Date(t.timestamp * 1000)

const time = d.toLocaleString("sv-SE", {
timeZone: "America/New_York"
}).replace(" ", "T")

const btcPrice = await getBTCPrice(t.timestamp)

const marketInfo = await getMarketInfo(t.conditionId)

const orderbook = await getOrderbook(t.tokenId)

const line =
`${marketWindow},${time},${btcPrice},${marketInfo.targetPrice || ""},${orderbook.upPrice || ""},${orderbook.downPrice || ""},${t.size},${t.usdcSize},${t.price},${t.side},${t.outcome},${marketInfo.result || ""},${t.transactionHash}\n`

file.write(line)

}

console.log("processed:", trades.length)

before = data[data.length - 1].timestamp

await new Promise(r => setTimeout(r,200))

}

file.end()

}

fetchTrades()