const axios = require("axios");
const XLSX = require("xlsx");

// your etherscan/polygonscan API key
const API_KEY = "PX8EPZFIVFS6SYMMM24WY42E1NCCV8SKSA";

// Polymarket CTF Exchange contract
const CTF_EXCHANGE = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";

async function fetchTransactions(wallet) {

    const url =
        `https://api.etherscan.io/v2/api` +
        `?chainid=137` +
        `&module=account` +
        `&action=tokentx` +
        `&address=${wallet}` +
        `&startblock=0` +
        `&endblock=99999999` +
        `&sort=desc` +
        `&apikey=${API_KEY}`;

    const res = await axios.get(url);

    const txs = res.data.result;

    const filtered = txs.filter(tx =>
        tx.from.toLowerCase() === wallet.toLowerCase() &&
        tx.to.toLowerCase() === CTF_EXCHANGE.toLowerCase() &&
        tx.tokenSymbol.includes("USDC")
    );

    console.log(`Found ${filtered.length} OUT transactions\n`);

    const rows = filtered.map(tx => {

        const time = new Date(Number(tx.timeStamp) * 1000);
    
        return {
            Time: time.toISOString(),
            Amount_USDC: Number(tx.value) / Math.pow(10, tx.tokenDecimal),
            Token: tx.tokenSymbol,
            TxHash: tx.hash,
            Block: tx.blockNumber
        };
    
    });

    rows.forEach(r => console.log(r));

    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();

    XLSX.utils.book_append_sheet(workbook, worksheet, "Transactions");

    XLSX.writeFile(workbook, "ctf_exchange_out_transactions.xlsx");

    console.log("\nExcel file created: ctf_exchange_out_transactions.xlsx");
}

const wallet = process.argv[2];

if (!wallet) {
    console.log("Usage:");
    console.log("node index.js WALLET_ADDRESS");
    process.exit(1);
}

fetchTransactions(wallet);