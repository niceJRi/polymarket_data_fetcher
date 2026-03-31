#!/usr/bin/env node

const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");

// ---- fetch fix (works on any Node version) ----
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

// ---- constants ----
const WS_URL = "wss://ws-live-data.polymarket.com";
const GAMMA_API = "https://gamma-api.polymarket.com";

const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

// ---- state ----
let currentMarket = null;
let ws = null;
let priceToBeat = null;
let csvStream = null;

// ---- helpers ----

function now() {
  return new Date().toISOString();
}

function getMarketSlug() {
  const nowSec = Math.floor(Date.now() / 1000);
  const bucket = Math.floor(nowSec / 300) * 300;
  return `btc-updown-5m-${bucket}`;
}

function getCsvWriter(market) {
  const filePath = path.join(DATA_DIR, `${market}.csv`);
  const exists = fs.existsSync(filePath);

  const stream = fs.createWriteStream(filePath, { flags: "a" });

  if (!exists) {
    stream.write("timestamp,market,current_price,price_to_beat,diff\n");
  }

  return stream;
}

// ---- fetch price_to_beat ----

async function updatePriceToBeat() {
  try {
    const res = await fetch(`${GAMMA_API}/markets/${currentMarket}`);
    const data = await res.json();

    priceToBeat =
      data?.price_to_beat ||
      data?.strikePrice ||
      data?.strike_price ||
      null;

    if (priceToBeat) {
      console.log(`🎯 price_to_beat: ${priceToBeat}`);
    }
  } catch (err) {
    console.error("price_to_beat fetch error:", err.message);
  }
}

// ---- WS connect ----

function connectWS() {
  ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    console.log("✅ WS connected");

    ws.send(
      JSON.stringify({
        type: "subscribe",
        channel: "market",
        market: currentMarket,
      })
    );
  });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw);

      const currentPrice =
        msg?.price ||
        msg?.last_price ||
        msg?.mark_price ||
        null;

      if (!currentPrice || !priceToBeat) return;

      const diff = currentPrice - priceToBeat;

      console.log(
        `[${now()}]
market : ${currentMarket}
price  : ${currentPrice}
target : ${priceToBeat}
diff   : ${diff.toFixed(2)}
------------------------`
      );

      csvStream.write(
        `${now()},${currentMarket},${currentPrice},${priceToBeat},${diff}\n`
      );
    } catch (err) {
      console.error("WS parse error:", err.message);
    }
  });

  ws.on("error", (err) => {
    console.error("WS error:", err.message);
  });

  ws.on("close", () => {
    console.log("❌ WS closed");
  });
}

// ---- switch market ----

function switchMarket(newMarket) {
  console.log(`🔄 Switching → ${newMarket}`);

  // close old WS + file
  if (ws) ws.close();
  if (csvStream) csvStream.end();

  currentMarket = newMarket;
  priceToBeat = null;

  csvStream = getCsvWriter(currentMarket);

  connectWS();
  updatePriceToBeat();
}

// ---- MAIN ----

(async () => {
  currentMarket = getMarketSlug();
  console.log("🚀 Starting market:", currentMarket);

  csvStream = getCsvWriter(currentMarket);

  connectWS();
  await updatePriceToBeat();

  // update target every 5 sec
  setInterval(updatePriceToBeat, 5000);

  // check market rollover every second
  setInterval(() => {
    const newMarket = getMarketSlug();
    if (newMarket !== currentMarket) {
      switchMarket(newMarket);
    }
  }, 1000);
})();