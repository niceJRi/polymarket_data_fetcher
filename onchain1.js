import { ethers } from "ethers"
import fs from "fs"
import axios from "axios"

const WALLET = process.argv[2]?.toLowerCase()

if(!WALLET){
  console.log("Usage: node fetch_wallet_trades_onchain.js WALLET")
  process.exit()
}

/* Polygon RPC */
const provider = new ethers.providers.JsonRpcProvider(
  "https://polygon-mainnet.infura.io/v3/e0fe187b40764270bca35ec48c248c26"
)

/* Conditional Tokens contract */
const CONDITIONAL_TOKENS =
"0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"

/* ABI */
const abi = [
"event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)"
]

const contract = new ethers.Contract(
CONDITIONAL_TOKENS,
abi,
provider
)

/* CSV file */
const file = fs.createWriteStream("wallet_trades.csv")

file.write(
"market,timestamp,side,outcome,shares,tokenId,txHash\n"
)

/* tokenId cache */
const tokenCache = {}

/* resolve token → market + outcome */
async function resolveToken(tokenId){

if(tokenCache[tokenId])
return tokenCache[tokenId]

try{

const res = await axios.get(
`https://gamma-api.polymarket.com/tokens/${tokenId}`
)

const data = res.data

tokenCache[tokenId] = {
market: data.market?.question || "unknown",
outcome: data.outcome || "unknown"
}

return tokenCache[tokenId]

}catch(e){

return {
market: "unknown",
outcome: "unknown"
}

}

}

/* block scan range */
let startBlock = 30000000
const latest = await provider.getBlockNumber()
const step = 2000

console.log("Scanning blocks", startBlock, "→", latest)

while(startBlock < latest){

const endBlock = Math.min(startBlock + step, latest)

console.log("Scanning", startBlock, "-", endBlock)

const events = await contract.queryFilter(
contract.filters.TransferSingle(),
startBlock,
endBlock
)

for(const e of events){

let from = e.args.from.toLowerCase()
let to = e.args.to.toLowerCase()

if(from !== WALLET && to !== WALLET)
continue

const tokenId = e.args.id.toString()
const shares = e.args.value.toString()

const { market, outcome } =
await resolveToken(tokenId)

const side = to === WALLET ? "BUY" : "SELL"

const block = await provider.getBlock(e.blockNumber)

const timestamp =
new Date(block.timestamp * 1000).toISOString()

const line =
`${market},${timestamp},${side},${outcome},${shares},${tokenId},${e.transactionHash}\n`

file.write(line)
fs.fsyncSync(file.fd)
console.log("TRADE FOUND:", side, outcome, shares)

}

startBlock = endBlock + 1

}

/* done */
file.end()

console.log("Finished scanning.")