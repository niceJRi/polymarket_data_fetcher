const axios = require("axios");
const XLSX = require("xlsx");

const API_KEY = "PX8EPZFIVFS6SYMMM24WY42E1NCCV8SKSA";
const CTF_EXCHANGE = "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e";
const POLYGON_API = "https://api.etherscan.io/v2/api";

async function fetchERC20(wallet) {

    const url = `${POLYGON_API}?chainid=137&module=account&action=tokentx&address=${wallet}&startblock=0&endblock=99999999&sort=desc&apikey=${API_KEY}`;

    const res = await axios.get(url);

    return res.data.result;
}

async function fetchERC1155(wallet) {

    const url = `${POLYGON_API}?chainid=137&module=account&action=token1155tx&address=${wallet}&startblock=0&endblock=99999999&sort=desc&apikey=${API_KEY}`;

    const res = await axios.get(url);

    return res.data.result;
}

async function analyze(wallet) {

    const erc20 = await fetchERC20(wallet);
    const erc1155 = await fetchERC1155(wallet);

    const trades = [];

    erc20.forEach(tx => {

        const hash = tx.hash;

        const share = erc1155.find(s => s.hash === hash);

        if (!share) return;

        const time = new Date(tx.timeStamp * 1000);

        let action = "UNKNOWN";

        if (
            tx.from.toLowerCase() === wallet.toLowerCase() &&
            tx.to.toLowerCase() === CTF_EXCHANGE
        ) {
            action = "BUY";
        }

        if (
            tx.to.toLowerCase() === wallet.toLowerCase() &&
            tx.from.toLowerCase() === CTF_EXCHANGE
        ) {
            action = "SELL";
        }

        trades.push({
            Time: time.toISOString(),
            Action: action,
            Amount_USDC: Number(tx.value) / Math.pow(10, tx.tokenDecimal),
            Shares: share.tokenValue,
            TokenID: share.tokenID,
            TxHash: hash
        });

    });

    console.log(`Found ${trades.length} trades`);

    const worksheet = XLSX.utils.json_to_sheet(trades);
    const workbook = XLSX.utils.book_new();

    XLSX.utils.book_append_sheet(workbook, worksheet, "Trades");

    XLSX.writeFile(workbook, "polymarket_trades.xlsx");

    console.log("Excel created: polymarket_trades.xlsx");
}

const wallet = process.argv[2];

if (!wallet) {
    console.log("Usage: node index.js WALLET");
    process.exit();
}

analyze(wallet);