import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "ethers"; // v5.8.0
import "dotenv/config";

async function main() {
  if (!process.env.PRIVATE_KEY) {
    throw new Error("PRIVATE_KEY not found in .env");
  }

  const client = new ClobClient(
    "https://clob.polymarket.com",
    137, // Polygon mainnet
    new Wallet(process.env.PRIVATE_KEY)
  );

  // Creates new credentials or derives existing ones
  const credentials = await client.createOrDeriveApiKey();

  console.log(credentials);
  /*
  {
    apiKey: "xxx",
    secret: "xxx",
    passphrase: "xxx"
  }
  */
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});