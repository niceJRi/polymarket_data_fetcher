require('dotenv').config();
const axios = require('axios');
const { createObjectCsvWriter } = require('csv-writer');
const fs = require('fs');

// Initialize Polymarket API URL and wallet client
const POLYMARKET_API_URL = "https://gamma-api.polymarket.com/markets";
const POLYMKT_CLOB_URL = "https://clob.polymarket.com";
const TIME_INTERVAL_15MIN = 900; // 15 minutes in seconds
const TIME_INTERVAL_5MIN = 300;  // 5 minutes in seconds

// Fetches the market data from Polymarket API
async function fetchMarketData() {
  try {
    const response = await axios.get(POLYMARKET_API_URL);
    return response.data;
  } catch (error) {
    console.error("Error fetching market data:", error);
    return [];
  }
}

// Fetches the order book for the given token
async function fetchOrderBook(token) {
  try {
    const response = await axios.get(`${POLYMKT_CLOB_URL}/orderBook/${token}`);
    return response.data;
  } catch (error) {
    console.error(`Error fetching order book for token ${token}:`, error);
    return null;
  }
}

// Check if the best ask prices satisfy the condition
function checkPriceCondition(upBestAsk, downBestAsk) {
  return (upBestAsk + downBestAsk <= 0.8);
}

// Save results to a CSV file
function saveResultsToCSV(data) {
  const csvWriter = createObjectCsvWriter({
    path: 'polymarket_results.csv',
    header: [
      { id: 'timestamp', title: 'Timestamp' },
      { id: 'upMarket', title: 'Up Market' },
      { id: 'downMarket', title: 'Down Market' },
      { id: 'upBestAsk', title: 'Up Best Ask' },
      { id: 'downBestAsk', title: 'Down Best Ask' },
      { id: 'conditionMet', title: 'Condition Met' },
    ],
  });

  csvWriter.writeRecords(data).then(() => {
    console.log("Results saved to polymarket_results.csv");
  });
}

// Main function to fetch markets, check prices, and save the result
async function main() {
  const markets = await fetchMarketData();

  // Filter for BTC 15min Up/Down markets
  const btc15minMarkets = markets.filter(market => 
    market.question && market.question.includes("Bitcoin Up or Down") && market.active
  );

  if (btc15minMarkets.length === 0) {
    console.log("No BTC 15min Up/Down market found.");
    return;
  }

  const results = [];

  // Loop through each BTC 15min market
  for (const market of btc15minMarkets) {
    const upToken = market.tokens[0].token_id;
    const downToken = market.tokens[1].token_id;

    // Get the order book for 5min and 15min markets
    const upBook15min = await fetchOrderBook(upToken);
    const downBook15min = await fetchOrderBook(downToken);

    if (!upBook15min || !downBook15min) {
      console.log("Error fetching order books.");
      continue;
    }

    // Fetch the first 5min order book for 15min market
    const upBook5min = await fetchOrderBook(upToken);
    const downBook5min = await fetchOrderBook(downToken);

    // Get the best ask prices for 5min and 15min markets
    const upBestAsk5min = upBook5min.bids ? upBook5min.bids[0].price : null;
    const downBestAsk15min = downBook15min.bids ? downBook15min.bids[0].price : null;

    if (upBestAsk5min && downBestAsk15min) {
      const conditionMet = checkPriceCondition(upBestAsk5min, downBestAsk15min);

      // Add to results
      results.push({
        timestamp: new Date().toISOString(),
        upMarket: upToken,
        downMarket: downToken,
        upBestAsk: upBestAsk5min,
        downBestAsk: downBestAsk15min,
        conditionMet: conditionMet ? 'Yes' : 'No',
      });
    }
  }

  // Save the results to CSV
  saveResultsToCSV(results);
}

main();