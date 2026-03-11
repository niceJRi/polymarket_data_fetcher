const WebSocket = require("ws")

const ws = new WebSocket(
    "wss://data-stream.binance.vision/ws/btcusdt@trade"
)

ws.on("open", () => {
    console.log("Connected to Binance BTC stream\n")
})

ws.on("message", (data) => {

    const trade = JSON.parse(data)

    const price = trade.p

    const time = new Date().toISOString()

    console.log(`${time} BTC: $${price}`)

})

ws.on("error", (err) => {
    console.log("WebSocket error:", err.message)
})

ws.on("close", () => {
    console.log("Connection closed")
})