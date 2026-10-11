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

// Plasă de siguranță: o promisiune respinsă și neprinsă (ex. o eroare de rețea
// rară) ar opri implicit tot procesul în Node.js — și odată cu el trigger-ele
// active. O logăm și mergem mai departe.
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e?.message || e));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8787;
// Implicit ascultăm DOAR pe interfața locală — panelul nu e accesibil din
// rețea (Wi-Fi, LAN). Pe un VPS, accesul se face prin tunel SSH (tot local).
const HOST = process.env.HOST || '127.0.0.1';

// Cine are voie să deschidă WebSocket-ul (= să tranzacționeze). Fără verificarea
// asta, ORICE site deschis în browser ar putea face `new WebSocket('ws://localhost:8787/ws')`
// și trimite ordine în numele tău (browserul nu blochează WebSocket-uri cross-site).
// Permitem doar pagini servite de pe localhost (panelul însuși, Vite dev pe :5173)
// + ce adaugi explicit în ALLOWED_ORIGINS (ex. un reverse proxy cu HTTPS).
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const EXTRA_ORIGINS = new Set((process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean));
function originAllowed(origin) {
  // Fără Origin = nu e un browser (ex. script local). Accesul din rețea e deja
  // închis de HOST=127.0.0.1, iar pe un VPS expus rămâne și PANEL_TOKEN.
  if (!origin) return true;
  if (EXTRA_ORIGINS.has(origin)) return true;
  try {
    return LOOPBACK.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

const app = express();
app.disable('x-powered-by');
// Headere de securitate. Cel mai important: panelul NU poate fi încărcat într-un
// iframe de alt site (anti-clickjacking) — altfel o pagină rău-intenționată l-ar
// putea pune invizibil peste propriile butoane și te-ar păcăli să dai click pe
// BUY/SELL (butoanele execută la mousedown). CSP: doar scripturi/stiluri proprii,
// conexiuni doar către propriul server.
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:",
    "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'", "object-src 'none'",
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
// Servim build-ul React din client/dist (după `npm run build` în client/).
app.use(express.static(path.join(__dirname, '..', '..', 'client', 'dist')));

const server = http.createServer(app);
const wss = new WebSocketServer({
  server, path: '/ws', ...NO_COMPRESSION,
  maxPayload: 64 * 1024,               // comenzile UI au < 1 KB; refuzăm mesaje uriașe

  verifyClient: ({ origin }) => {
    const ok = originAllowed(origin);
    if (!ok) console.warn(`[security] conexiune WebSocket respinsă de la origin străin: ${origin}`);
    return ok;
  },
});

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
  // Un mesaj malformat sau prea mare emite 'error' pe socket — fără handler,
  // Node.js ar opri TOT serverul (inclusiv trigger-ele active). Închidem doar
  // conexiunea respectivă; `ws` o termină singur după eroare.
  ws.on('error', (e) => console.warn('[ws] conexiune închisă:', e.code || e.message));

  ws.on('message', async (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (!m || typeof m !== 'object' || Array.isArray(m)) return;   // ex. "null", "123", "[]"
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

server.listen(PORT, HOST, () => {
  console.log(`[server] Panel pornit pe http://localhost:${PORT} (ascultă pe ${HOST})`);
  // Pornim sesiunea la boot dacă avem deja chei salvate.
  restartSession().catch((e) => console.error('[session]', e.message));
});
