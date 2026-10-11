# Binance Panel — fast manual trading terminal

A single-page trading panel (React) with a Node.js backend that sends orders over a **persistent, authenticated Binance WebSocket API connection** instead of per-request REST. Built for fast, keyboard-driven manual execution on **USDT-M Futures** (and Spot), on **Testnet or Live**.

> ⚠️ **Disclaimer** — This is an execution tool, not financial advice. Leveraged trading can liquidate your account. Test thoroughly on Testnet and start with small size on Live.

## Highlights

- **Low-latency execution** — orders go out on an already-open, HMAC-signed WebSocket (no TCP/TLS handshake per click). Compression off, `TCP_NODELAY` on every socket, buttons fire on `mousedown`, REST connection kept warm for the few orders that need it.
- **Keyboard-first** — remappable hotkeys for market/limit entries, scale in/out, partial close, reverse, SL/TP, cancel all and a kill switch that flattens everything.
- **Price-triggered entries** — arm a BUY/SELL that only fires when the live price reaches your level (breakout entries), as market or limit-with-offset.
- **Stop Loss / Take Profit** — independent SL and TP values, each as %, ticks or an exact price; placed as real exchange-side conditional orders.
- **Optional auto Stop Loss** on entry (off by default) computed from the real average fill price.
- **Auto max leverage per symbol** — queries your account's leverage brackets on symbol change.
- **Safety rails** — server-side max USD per order / per position, tick-size & step-size rounding, serialized position-changing operations, and a "close all" that re-reads the real position and retries until flat.
- **Optimistic UI** — instant feedback and sounds on click; fills/rejects reconcile by `clientOrderId` from the user data stream.
- **Encrypted key storage** — API keys are stored on disk with AES-256-GCM (key derived from your `PANEL_SECRET` via scrypt).

## Architecture

```
Browser (React) ──WebSocket──▶ Node backend ──┬─▶ Binance WS-API   (orders, persistent, HMAC)
                                              ├─▶ Market stream    (bookTicker, live price)
                                              ├─▶ User data stream (fills, position, balance)
                                              └─▶ REST             (listenKey, leverage, algo orders, rare calls)
```

- `client/` — React + Vite UI
- `server/` — Express static host + WebSocket server + Binance connections (`session.js` holds trading logic and risk checks)

## Quick start

Requirements: **Node.js ≥ 18** and a Binance API key (start with **Testnet**).

```bash
# 1. Backend
cd server
cp .env.example .env        # then set a long random PANEL_SECRET
npm install

# 2. Frontend (build once, served by the backend)
cd ../client
npm install
npm run build

# 3. Run
cd ../server
npm start                   # http://localhost:8787
```

Open the app → **⚙ Settings** → paste your API key/secret, choose Spot/Futures and Testnet/Live → **Save & Reconnect**.

For development with hot reload: `npm run dev` in `client/` (port 5173) while the backend runs on 8787.

On Windows, `start-panel.bat` starts the server and opens the browser.

### API key recommendations

- Enable **Futures** (and Spot only if you need it). **Never enable Withdrawals.**
- Restrict the key to your IP address if it is stable.
- Use a dedicated key for this panel — don't share one key between several bots trading the same account.
- Futures accounts must be in **One-way position mode** (Hedge mode is not supported).

## Default hotkeys (remappable in Settings)

| Key | Action | Key | Action |
|---|---|---|---|
| `B` / `S` | Buy / Sell market | `H` | Sell custom % |
| `⇧B` / `⇧S` | Buy / Sell limit ± offset | `C` | Close all |
| `Ctrl+B` / `Ctrl+S` | Buy / Sell @ trigger | `I` / `O` | Scale in / out |
| `L` / `T` | Stop loss / Take profit | `R` | Reverse |
| `K` | Kill / flatten all | `X` | Cancel all |
| `1`–`9` | Favorite symbols | `Q` | Focus symbol search |

## Security notes

- `server/.env` and `server/data/` hold your secret and encrypted keys — they are git-ignored. **Never commit them.**
- The backend only needs to be reachable from your own machine. If you expose it, set `PANEL_TOKEN` and keep the port behind an SSH tunnel/VPN.
- The panel enforces `maxOrderUsd` / `maxPositionUsd` server-side before every order.

## Known limitations

- **Futures Testnet rejects `STOP_MARKET` / `TAKE_PROFIT_MARKET`** (error `-4120`). SL/TP can only be validated on Live.
- **Auto SL depends on fill events from the user data stream.** On accounts where Binance does not deliver those events, the auto SL times out (manual SL/TP buttons are unaffected — they read the position over REST).
- Price-trigger entries live in the backend's memory (they are not exchange-side orders) and are lost if the server restarts.
- Hedge mode (`positionSide`) is not implemented.
- Balance display uses the symbol's quote asset; on Multi-Assets-Mode accounts your collateral may be held in another asset (e.g. USDC).

## License

No license specified — all rights reserved by the author unless one is added.
