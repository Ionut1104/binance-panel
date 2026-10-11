// Endpoint-urile Binance pentru fiecare combinație (piață × testnet).
// Dacă Binance le schimbă, actualizează doar aici.
export const ENDPOINTS = {
  spot: {
    live: {
      rest: 'https://api.binance.com',
      // Stream-uri publice de piață (bookTicker etc.)
      marketWs: 'wss://stream.binance.com:9443/ws',
      // WS-API: plasare/anulare ordine pe WebSocket persistent
      wsApi: 'wss://ws-api.binance.com:443/ws-api/v3',
      // User data stream (fill-uri, balanță) — se atașează listenKey
      userWs: 'wss://stream.binance.com:9443/ws',
    },
    testnet: {
      rest: 'https://testnet.binance.vision',
      marketWs: 'wss://stream.testnet.binance.vision/ws',
      wsApi: 'wss://ws-api.testnet.binance.vision/ws-api/v3',
      userWs: 'wss://stream.testnet.binance.vision/ws',
    },
  },
  futures: {
    live: {
      rest: 'https://fapi.binance.com',
      marketWs: 'wss://fstream.binance.com/ws',
      wsApi: 'wss://ws-fapi.binance.com/ws-fapi/v1',
      userWs: 'wss://fstream.binance.com/ws',
    },
    testnet: {
      rest: 'https://testnet.binancefuture.com',
      marketWs: 'wss://stream.binancefuture.com/ws',
      wsApi: 'wss://testnet.binancefuture.com/ws-fapi/v1',
      userWs: 'wss://stream.binancefuture.com/ws',
    },
  },
};

// Helper: întoarce setul de endpoint-uri pentru configurația curentă.
export function endpointsFor(market, testnet) {
  return ENDPOINTS[market][testnet ? 'testnet' : 'live'];
}
