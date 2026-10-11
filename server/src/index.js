// ═══════════════════════════════════════════════════════════════════
// Punctul de intrare: server Express (servește UI-ul buildat) + un
// WebSocket server prin care browserul vorbește cu backend-ul.
// Un singur "hop" UI → backend → Binance WS-API.
// ═══════════════════════════════════════════════════════════════════
import 'dotenv/config';
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { loadSettings, saveSettings, publicSettings } from './settings.js';
import { BinanceSession } from './session.js';
import { NO_COMPRESSION, noDelayOnSocket, extendRestKeepAlive } from './lowLatency.js';

extendRestKeepAlive();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8787;

const app = express();
// Servim build-ul React din client/dist (după `npm run build` în client/).
app.use(express.static(path.join(__dirname, '..', '..', 'client', 'dist')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', ...NO_COMPRESSION });

let session = null;          // sesiunea Binance activă (una singură)
const clients = new Set();   // UI-urile conectate

// Trimite un mesaj către toate UI-urile.
function broadcast(msg) {
  const raw = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === 1) c.send(raw);
}

// (Re)pornește sesiunea Binance cu setările curente.
async function restartSession() {
  session?.stop();
  session = null;
  const s = loadSettings();
  if (!s.apiKey || !s.apiSecret) {
    broadcast({ type: 'status', status: { wsApi: 'no-keys', market: 'no-keys', user: 'no-keys' } });
    return;
  }
  session = new BinanceSession(s, broadcast);
  await session.start();
}

// ── Protocolul cu UI-ul: mesaje JSON { type, reqId, ...payload } ──
// Răspundem cu { type:'ack'|'err', reqId } ca UI-ul optimist să știe rezultatul.
wss.on('connection', (ws, req) => {
  // Protecție opțională cu token (pentru VPS): /ws?token=XYZ
  const token = process.env.PANEL_TOKEN;
  if (token) {
    const url = new URL(req.url, 'http://x');
    if (url.searchParams.get('token') !== token) { ws.close(4001, 'unauthorized'); return; }
  }

  noDelayOnSocket(req.socket);
  clients.add(ws);
  // La conectare trimitem starea curentă ca UI-ul să se populeze instant.
  ws.send(JSON.stringify({ type: 'settings', settings: publicSettings() }));
  if (session) {
    ws.send(JSON.stringify({ type: 'status', status: session.status }));
    if (session.symbol) {
      ws.send(JSON.stringify(session.symbolMessage()));
      ws.send(JSON.stringify({ type: 'account', balances: session.balances, position: { symbol: session.symbol, ...session.position } }));
      ws.send(JSON.stringify({ type: 'orders', orders: [...session.openOrders.values()] }));
      ws.send(JSON.stringify({ type: 'triggers', triggers: [...session.triggers.values()] }));
      if (session.ticker) ws.send(JSON.stringify({ type: 'ticker', ...session.ticker }));
    }
  }

  ws.on('close', () => clients.delete(ws));

  ws.on('message', async (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    const reply = (obj) => ws.send(JSON.stringify(obj));
    const ok = (result) => reply({ type: 'ack', reqId: m.reqId, action: m.type, result });
    const fail = (e) => reply({
      type: 'err', reqId: m.reqId, action: m.type,
      // Mesaj de eroare lizibil + codul Binance → afișat vizibil în UI.
      message: e.message, code: e.code,
    });

    try {
      switch (m.type) {
        // ── Setări ──
        case 'settings.save': {
          const patch = { ...m.patch };
          // Nu suprascrie cheile dacă vin goale (utilizatorul n-a retastat secretul).
          if (!patch.apiKey) delete patch.apiKey;
          if (!patch.apiSecret) delete patch.apiSecret;
          saveSettings(patch);
          broadcast({ type: 'settings', settings: publicSettings() });
          // Schimbare de market/testnet/chei → reconectăm tot.
          await restartSession();
          return ok();
        }
        case 'settings.get':
          return ok(publicSettings());

        // ── Simboluri ──
        case 'symbols.list':
          if (!session) throw new Error('Neconectat — salvează cheile în Setări.');
          return ok(await session.listSymbols());
        case 'symbol.set':
          if (!session) throw new Error('Neconectat — salvează cheile în Setări.');
          await session.setSymbol(m.symbol);
          return ok();

        // ── Trading (toate primesc clientOrderId din UI pt. optimistic UI) ──
        case 'order.market':
          return ok(await session.marketOrder(m.side, m.qty, { clientOrderId: m.clientOrderId, autoSl: m.autoSl }));
        case 'order.limitOffset':
          return ok(await session.limitOffset(m.side, m.qty, {
            offsetTicks: m.offsetTicks, offsetUsd: m.offsetUsd, tif: m.tif,
            clientOrderId: m.clientOrderId, autoSl: m.autoSl,
          }));
        case 'position.closePct':
          return ok(await session.closePercent(m.pct, m.clientOrderId));
        case 'position.scale':
          return ok(await session.scale(m.pct, m.clientOrderId));
        case 'position.reverse':
          return ok(await session.reverse(m.clientOrderId));
        case 'position.stopTp':
          return ok(await session.stopOrTp(m.kind, { pct: m.pct, ticks: m.ticks, price: m.price }, m.clientOrderId));
        case 'order.cancel':
          await session.cancelOrder(m.orderId);
          await session.refreshOpenOrders().catch(() => {});
          return ok();
        case 'order.cancelAll':
          return ok(await session.cancelAll());

        // ── Intrare condiționată de preț (trigger) ──
        case 'trigger.place':
          return ok(session.addTrigger({
            side: m.side, qty: m.qty, triggerPrice: m.triggerPrice, orderType: m.orderType,
            offsetTicks: m.offsetTicks, offsetUsd: m.offsetUsd, tif: m.tif,
            autoSl: m.autoSl, clientOrderId: m.clientOrderId,
          }));
        case 'trigger.cancel':
          session.cancelTrigger(m.id);
          return ok();
        case 'flatten':                       // ★ butonul roșu KILL
          return ok(await session.flatten(m.clientOrderId));

        // ── Futures ──
        case 'futures.leverage':
          return ok(await session.setLeverage(m.leverage));
        case 'futures.marginType':
          return ok(await session.setMarginType(m.marginType));

        case 'account.refresh':
          await session.refreshAccount();
          return ok();

        default:
          throw new Error(`Mesaj necunoscut: ${m.type}`);
      }
    } catch (e) {
      if (!session && !['settings.save', 'settings.get'].includes(m.type)) {
        return fail(new Error('Neconectat la Binance — verifică Setările.'));
      }
      fail(e);
    }
  });
});

server.listen(PORT, () => {
  console.log(`[server] Panel pornit pe http://localhost:${PORT}`);
  // Pornim sesiunea la boot dacă avem deja chei salvate.
  restartSession().catch((e) => console.error('[session]', e.message));
});
