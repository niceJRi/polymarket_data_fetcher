import { ClobClient } from "@polymarket/clob-client"
import { Wallet } from "ethers"
import "dotenv/config"

const PRIVATE_KEY = process.env.PRIVATE_KEY

if (!PRIVATE_KEY) {
  throw new Error("PRIVATE_KEY not found in .env")
}

const wallet = new Wallet(PRIVATE_KEY)

console.log("Wallet address:", wallet.address)

const client = new ClobClient(
  "https://clob.polymarket.com",
  137,
  wallet
)

async function main() {

  const creds = await client.createApiKey()

  console.log("API_KEY:", creds.key)
  console.log("API_SECRET:", creds.secret)
  console.log("PASSPHRASE:", creds.passphrase)

}

main()