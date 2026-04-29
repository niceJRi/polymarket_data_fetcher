const WebSocket = require("ws");

const WS_URL = "wss://ws-live-data.polymarket.com";

// 🔧 change this to 200 or 500
const INTERVAL_MS = 200;

let latestPrice = null;
let latestTs = null;
let lastPrintedTs = null;

const ws = new WebSocket(WS_URL);

ws.on("open", () => {
  console.log("✅ Connected to Polymarket RTDS");

  ws.send(JSON.stringify({
    action: "subscribe",
    subscriptions: [
      {
        topic: "crypto_prices_chainlink",
        type: "*",
        filters: JSON.stringify({ symbol: "btc/usd" })
      }
    ]
  }));
});

// ✅ receive real updates (event-driven)
ws.on("message", (raw) => {
  try {
    const msg = JSON.parse(raw.toString());

    if (msg.type !== "update") return;

    const p = msg.payload;
    if (!p || p.symbol !== "btc/usd") return;

    latestPrice = p.value;
    latestTs = p.timestamp;

  } catch (e) {
    console.error("parse error:", e.message);
  }
});

// 🔥 fixed interval sampler (THIS is what you want)
setInterval(() => {
  if (!latestPrice) return;

  const time = new Date(latestTs).toISOString();

  const isNewTick = latestTs !== lastPrintedTs;

  // optional: mark new vs stale
  const flag = isNewTick ? "🟢" : "⚪";

  lastPrintedTs = latestTs;

  process.stdout.clearLine(0);
  process.stdout.cursorTo(0);
  process.stdout.write(
    `${flag} BTC: $${latestPrice.toFixed(2)} | ${time}`
  );

}, INTERVAL_MS);

ws.on("close", () => {
  console.log("\n❌ Disconnected");
});

ws.on("error", (err) => {
  console.error("WS error:", err.message);
});