const axios = require("axios");
const fs = require("fs");

const API_KEY = "PX8EPZFIVFS6SYMMM24WY42E1NCCV8SKSA";
const POLYGON_API = "https://api.etherscan.io/v2/api";

const CTF_EXCHANGE = "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e";

const tokenCache = {};

/* create csv file */
const file = fs.createWriteStream("polymarket_trades_onchain2.csv");

file.write(
"Time,Action,Outcome,Price,USDC,Shares,TokenID,TxHash\n"
);

/* fetch USDC transfers */
async function fetchERC20(wallet) {

  const url =
  `${POLYGON_API}?chainid=137&module=account&action=tokentx&address=${wallet}&startblock=0&endblock=99999999&sort=desc&apikey=${API_KEY}`;

  const res = await axios.get(url);

  return res.data.result;

}

/* fetch share transfers */
async function fetchERC1155(wallet) {

  const url =
  `${POLYGON_API}?chainid=137&module=account&action=token1155tx&address=${wallet}&startblock=0&endblock=99999999&sort=desc&apikey=${API_KEY}`;

  const res = await axios.get(url);

  return res.data.result;

}

/* resolve UP / DOWN */
async function getOutcome(tokenID) {

  if (tokenCache[tokenID]) return tokenCache[tokenID];

  try {

    const res = await axios.get(
      `https://clob.polymarket.com/tokens/${tokenID}`
    );

    let outcome = "Unknown";

    if (res.data.outcome === "Yes") outcome = "UP";
    if (res.data.outcome === "No") outcome = "DOWN";

    tokenCache[tokenID] = outcome;

    return outcome;

  } catch (e) {

    return "Unknown";

  }

}

/* fetch price */
async function getPrice(tokenID) {

  try {

    const res = await axios.get(
      `https://clob.polymarket.com/orderbook/${tokenID}`
    );

    if (res.data.asks && res.data.asks.length > 0)
      return res.data.asks[0][0];

    if (res.data.bids && res.data.bids.length > 0)
      return res.data.bids[0][0];

  } catch (e) {}

  return "";

}

async function analyze(wallet) {

  console.log("Fetching ERC20...");
  const erc20 = await fetchERC20(wallet);

  console.log("Fetching ERC1155...");
  const erc1155 = await fetchERC1155(wallet);

  for (const tx of erc20) {

    const hash = tx.hash;

    const share = erc1155.find(s => s.hash === hash);

    if (!share) continue;

    const tokenID = share.tokenID;

    const outcome = await getOutcome(tokenID);

    const price = await getPrice(tokenID);

    const time = new Date(tx.timeStamp * 1000).toISOString();

    let action = "UNKNOWN";

    if (
      tx.from.toLowerCase() === wallet.toLowerCase() &&
      tx.to.toLowerCase() === CTF_EXCHANGE
    ) {

      action = outcome === "UP" ? "BUY UP" : "BUY DOWN";

    }

    if (
      tx.to.toLowerCase() === wallet.toLowerCase() &&
      tx.from.toLowerCase() === CTF_EXCHANGE
    ) {

      action = outcome === "UP" ? "SELL UP" : "SELL DOWN";

    }

    const usdc =
      Number(tx.value) / Math.pow(10, tx.tokenDecimal);

    const line =
`${time},${action},${outcome},${price},${usdc},${share.tokenValue},${tokenID},${hash}\n`;

    file.write(line);

    console.log("Saved trade:", action, outcome, usdc);

  }

  console.log("Done.");

}

const wallet = process.argv[2];

if (!wallet) {

  console.log("Usage:");
  console.log("node index.js WALLET_ADDRESS");
  process.exit(1);

}

analyze(wallet);