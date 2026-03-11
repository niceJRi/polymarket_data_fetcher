const axios = require("axios");
const XLSX = require("xlsx");

const API_KEY = "PX8EPZFIVFS6SYMMM24WY42E1NCCV8SKSA";
const CTF_EXCHANGE = "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e";
const API = "https://api.etherscan.io/v2/api";

function parseTimeframe(tf) {

    const n = parseInt(tf);

    if (tf.includes("m")) return n * 60;
    if (tf.includes("h")) return n * 3600;
    if (tf.includes("d")) return n * 86400;

    return 3600;
}

async function fetchERC20(wallet) {

    const url =
        `${API}?chainid=137&module=account&action=tokentx&address=${wallet}` +
        `&startblock=0&endblock=99999999&sort=desc&apikey=${API_KEY}`;

    const res = await axios.get(url);

    return res.data.result;
}

async function analyze(wallet, timeframe) {

    const seconds = parseTimeframe(timeframe);

    const now = Math.floor(Date.now() / 1000);

    const txs = await fetchERC20(wallet);

    const filtered = txs.filter(tx => {

        const age = now - Number(tx.timeStamp);

        return age <= seconds &&
               tx.from.toLowerCase() === wallet.toLowerCase() &&
               tx.tokenSymbol.includes("USDC");
    });

    console.log(`Found ${filtered.length} transactions in last ${timeframe}\n`);

    const rows = filtered.map(tx => {

        const time = new Date(tx.timeStamp * 1000);

        return {
            Time: time.toISOString(),
            USDC: Number(tx.value) / Math.pow(10, tx.tokenDecimal),
            TxHash: tx.hash,
            Block: tx.blockNumber
        };
    });

    rows.forEach(r => console.log(r));

    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();

    XLSX.utils.book_append_sheet(workbook, worksheet, "Trades");

    XLSX.writeFile(workbook, `polymarket_${timeframe}.xlsx`);

    console.log(`Excel created: polymarket_${timeframe}.xlsx`);
}

const wallet = process.argv[2];
const timeframe = process.argv[3] || "1h";

if (!wallet) {
    console.log("Usage:");
    console.log("node index.js WALLET [10m | 1h | 1d]");
    process.exit(1);
}

analyze(wallet, timeframe);