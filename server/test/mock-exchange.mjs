// Binance Futures MOCK — simulează REST + WS-API + market stream + user stream,
// ca să rulăm codul REAL al panelului fără bani și fără chei.
import http from 'http';
import { WebSocketServer } from 'ws';

const SYMBOLS = [
  { symbol: 'TESTUSDT', base: 'TEST', tick: '0.01', step: '0.001', minQty: '0.001', minNotional: '5', pricePrecision: 2, qtyPrecision: 3 },
  { symbol: 'ALTUSDT', base: 'ALT', tick: '0.0001', step: '1', minQty: '1', minNotional: '5', pricePrecision: 4, qtyPrecision: 0 },
  { symbol: 'AKEUSDT', base: 'AKE', tick: '0.01', step: '0.1', minQty: '0.1', minNotional: '5', pricePrecision: 2, qtyPrecision: 1 },
  { symbol: 'CAKEUSDT', base: 'CAKE', tick: '0.01', step: '0.1', minQty: '0.1', minNotional: '5', pricePrecision: 2, qtyPrecision: 1 },
  { symbol: 'TAKEUSDT', base: 'TAKE', tick: '0.01', step: '0.1', minQty: '0.1', minNotional: '5', pricePrecision: 2, qtyPrecision: 1 },
];

export async function startMock(port, opts = {}) {
  const st = {
    // comportamente controlabile din teste
    emitUserEvents: opts.emitUserEvents ?? true,
    fillBeforeAck: false,         // evenimentul de fill ajunge ÎNAINTEA ack-ului WS-API
    rejectAlgo: false,            // STOP_MARKET/TAKE_PROFIT_MARKET -> -4120 (ca pe testnet)
    hedgeMode: false,             // contul cere positionSide (-4061 dacă lipsește)
    ackDelayMs: 5,
    eventDelayMs: 5,
    // stare
    bid: 100, ask: 100.02,
    pos: {},                       // symbol -> {qty, entry}
    open: new Map(),               // orderId -> ordin deschis (LIMIT/STOP)
    history: [],                   // toate ordinele plasate (în ordinea sosirii)
    calls: [],                     // toate request-urile primite
    leverage: {},                  // symbol -> leverage setat
    maxLeverage: 50,
    nextId: 1000,
    all: new Map(),               // clientOrderId|orderId -> obiectul ordinului (status final)
    isolated: {},                 // symbol -> bool
    balance: 1000,
  };
  const userSockets = new Set();
  const mktSockets = new Map();    // ws -> Set(symbolLower)
  const wsapiSockets = new Set();

  const sym = (s) => SYMBOLS.find((x) => x.symbol === s);
  const round = (n, d = 8) => Number(n.toFixed(d));
  const posOf = (s) => (st.pos[s] ||= { qty: 0, entry: 0 });

  // ── push helpers ──
  function pushUser(obj) {
    if (!st.emitUserEvents) return;
    const raw = JSON.stringify(obj);
    for (const ws of userSockets) if (ws.readyState === 1) ws.send(raw);
  }
  function pushTicker(symbol = 'TESTUSDT') {
    for (const [ws, subs] of mktSockets) {
      if (ws.readyState === 1 && subs.has(symbol.toLowerCase())) {
        ws.send(JSON.stringify({ e: 'bookTicker', s: symbol, b: st.bid.toFixed(2), a: st.ask.toFixed(2) }));
      }
    }
  }
  function accountUpdate(symbol) {
    const p = posOf(symbol);
    pushUser({
      e: 'ACCOUNT_UPDATE',
      a: {
        B: [{ a: 'USDT', wb: String(st.balance), cw: String(st.balance) }],
        P: [{ s: symbol, pa: String(p.qty), ep: String(p.entry) }],
      },
    });
  }
  function orderEvent(o, status, extra = {}) {
    pushUser({
      e: 'ORDER_TRADE_UPDATE',
      o: {
        s: o.symbol, c: o.clientOrderId, S: o.side, o: o.type, q: String(o.qty),
        p: String(o.price ?? 0), sp: String(o.stopPrice ?? 0), ap: String(extra.ap ?? 0),
        X: status, i: o.orderId, z: String(extra.z ?? 0), l: String(extra.l ?? 0), L: String(extra.L ?? 0),
      },
    });
  }

  function applyFill(o, price) {
    const p = posOf(o.symbol);
    const signed = o.side === 'BUY' ? o.qty : -o.qty;
    const newQty = round(p.qty + signed);
    if (p.qty === 0 || Math.sign(p.qty) === Math.sign(signed)) {
      p.entry = round((Math.abs(p.qty) * p.entry + o.qty * price) / Math.abs(newQty), 4);
    } else if (newQty !== 0 && Math.sign(newQty) !== Math.sign(p.qty)) {
      p.entry = price;
    }
    p.qty = Math.abs(newQty) < 1e-9 ? 0 : newQty;
    if (p.qty === 0) p.entry = 0;
    o.status = 'FILLED'; o.avgPrice = price; o.executed = o.qty;
    st.open.delete(o.orderId);
    const fillEvt = () => {
      orderEvent(o, 'FILLED', { ap: price, z: o.qty, l: o.qty, L: price });
      accountUpdate(o.symbol);
    };
    return fillEvt;
  }

  function validate(o, params) {
    const s = sym(o.symbol);
    if (!s) return { code: -1121, msg: 'Invalid symbol.' };
    if (st.hedgeMode && !params.positionSide) return { code: -4061, msg: "Order's position side does not match user's setting." };
    const steps = o.qty / Number(s.step);
    if (Math.abs(steps - Math.round(steps)) > 1e-7) return { code: -1111, msg: 'Precision is over the maximum defined for this asset.' };
    if (o.qty < Number(s.minQty)) return { code: -4003, msg: 'Quantity less than zero.' };
    if (o.reduceOnly) {
      const p = posOf(o.symbol);
      const wrongWay = (o.side === 'BUY' && p.qty >= 0) || (o.side === 'SELL' && p.qty <= 0);
      if (wrongWay || o.qty > Math.abs(p.qty) + 1e-9) return { code: -2022, msg: 'ReduceOnly Order is rejected.' };
    }
    return null;
  }

  function newOrder(params) {
    return {
      orderId: st.nextId++,
      clientOrderId: params.newClientOrderId || `mock_${st.nextId}`,
      symbol: params.symbol, side: params.side, type: params.type,
      qty: Number(params.quantity), price: params.price != null ? Number(params.price) : 0,
      stopPrice: params.stopPrice != null ? Number(params.stopPrice) : 0,
      reduceOnly: params.reduceOnly === 'true' || params.reduceOnly === true,
      status: 'NEW',
    };
  }
  const ack = (o) => ({
    orderId: o.orderId, symbol: o.symbol, status: 'NEW', clientOrderId: o.clientOrderId,
    price: String(o.price), origQty: String(o.qty), executedQty: '0.000', type: o.type, side: o.side,
    reduceOnly: o.reduceOnly, stopPrice: String(o.stopPrice), updateTime: Date.now(),
  });

  // Plasează logic un ordin (comun REST/WS-API). Întoarce {error}|{order,afterAck}.
  function place(params) {
    const o = newOrder(params);
    const err = validate(o, params);
    if (err) return { error: err };
    st.history.push({ ...o, t: Date.now() });
    st.all.set(o.clientOrderId, o); st.all.set(String(o.orderId), o);
    const isAlgo = ['STOP_MARKET', 'TAKE_PROFIT_MARKET', 'STOP', 'TAKE_PROFIT'].includes(o.type);
    if (o.type === 'MARKET') {
      const price = o.side === 'BUY' ? st.ask : st.bid;
      const fill = applyFill(o, price);
      return { order: o, fill };
    }
    if (o.type === 'LIMIT') {
      const crosses = (o.side === 'BUY' && o.price >= st.ask) || (o.side === 'SELL' && o.price <= st.bid);
      if (crosses) {
        const fill = applyFill(o, o.side === 'BUY' ? st.ask : st.bid);
        return { order: o, fill };
      }
      st.open.set(o.orderId, o);
      return { order: o, fill: () => orderEvent(o, 'NEW') };
    }
    if (isAlgo) {
      st.open.set(o.orderId, o);
      return { order: o, fill: () => {} };
    }
    return { error: { code: -1116, msg: 'Invalid orderType.' } };
  }

  // la fiecare tick: ordine LIMIT/STOP în așteptare
  function sweepOpen() {
    for (const o of [...st.open.values()]) {
      if (o.type === 'LIMIT') {
        if ((o.side === 'BUY' && st.ask <= o.price) || (o.side === 'SELL' && st.bid >= o.price)) {
          const fill = applyFill(o, o.price);
          setTimeout(fill, st.eventDelayMs);
        }
      } else if (o.stopPrice) {
        const hit = (o.type === 'STOP_MARKET' && ((o.side === 'SELL' && st.bid <= o.stopPrice) || (o.side === 'BUY' && st.ask >= o.stopPrice)))
          || (o.type === 'TAKE_PROFIT_MARKET' && ((o.side === 'SELL' && st.bid >= o.stopPrice) || (o.side === 'BUY' && st.ask <= o.stopPrice)));
        if (hit) {
          const p = posOf(o.symbol);
          o.qty = Math.min(o.qty, Math.abs(p.qty));
          if (o.qty > 0) setTimeout(applyFill(o, o.side === 'BUY' ? st.ask : st.bid), st.eventDelayMs);
          else st.open.delete(o.orderId);
        }
      }
    }
  }

  // ── HTTP (REST) ──
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = Object.fromEntries(url.searchParams);
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    st.calls.push({ kind: 'rest', method: req.method, path: url.pathname, params: p, t: Date.now() });

    const signedOk = !!(p.signature && p.timestamp);
    const needSig = () => (signedOk ? false : (send(401, { code: -1102, msg: 'Mandatory parameter signature was not sent' }), true));

    if (url.pathname === '/fapi/v1/time') return send(200, { serverTime: Date.now() });
    if (url.pathname === '/fapi/v1/ping') return send(200, {});
    if (url.pathname === '/fapi/v1/exchangeInfo') {
      return send(200, {
        symbols: SYMBOLS.map((s) => ({
          symbol: s.symbol, status: 'TRADING', baseAsset: s.base, quoteAsset: 'USDT',
          pricePrecision: s.pricePrecision, quantityPrecision: s.qtyPrecision,
          filters: [
            { filterType: 'PRICE_FILTER', tickSize: s.tick },
            { filterType: 'LOT_SIZE', stepSize: s.step, minQty: s.minQty },
            { filterType: 'MIN_NOTIONAL', notional: s.minNotional },
          ],
        })),
      });
    }
    if (url.pathname === '/fapi/v1/listenKey') return send(200, req.method === 'POST' ? { listenKey: 'MOCKLISTENKEY' } : {});
    if (needSig()) return;

    if (url.pathname === '/fapi/v2/account') {
      return send(200, {
        assets: [{ asset: 'USDT', availableBalance: String(st.balance), walletBalance: String(st.balance) }],
        positions: SYMBOLS.map((s) => ({ symbol: s.symbol, positionAmt: String(posOf(s.symbol).qty), entryPrice: String(posOf(s.symbol).entry), leverage: String(st.leverage[s.symbol] ?? 20), isolated: st.isolated[s.symbol] ?? true })),
      });
    }
    if (url.pathname === '/fapi/v1/openOrders') {
      return send(200, [...st.open.values()].filter((o) => !o.algo && (!p.symbol || o.symbol === p.symbol)).map((o) => ({ ...ack(o) })));
    }
    if (url.pathname === '/fapi/v1/leverageBracket') {
      return send(200, [{ symbol: p.symbol, brackets: [{ bracket: 1, initialLeverage: st.maxLeverage }, { bracket: 2, initialLeverage: Math.floor(st.maxLeverage / 2) }] }]);
    }
    if (url.pathname === '/fapi/v1/leverage' && req.method === 'POST') {
      st.leverage[p.symbol] = Number(p.leverage);
      return send(200, { symbol: p.symbol, leverage: Number(p.leverage) });
    }
    if (url.pathname === '/fapi/v1/marginType' && req.method === 'POST') {
      if (st.isolated[p.symbol] === (p.marginType === 'ISOLATED')) return send(400, { code: -4046, msg: 'No need to change margin type.' });
      st.isolated[p.symbol] = p.marginType === 'ISOLATED';
      return send(200, { code: 200, msg: 'success' });
    }
    if (url.pathname === '/fapi/v1/allOpenOrders' && req.method === 'DELETE') {
      for (const o of [...st.open.values()]) if (o.symbol === p.symbol && !o.algo) { st.open.delete(o.orderId); o.status = 'CANCELED'; orderEvent(o, 'CANCELED'); }
      return send(200, { code: 200, msg: 'The operation of cancel all open order is done.' });
    }
    const CONDITIONAL = ['STOP_MARKET', 'TAKE_PROFIT_MARKET', 'STOP', 'TAKE_PROFIT', 'TRAILING_STOP_MARKET'];
    const algoAck = (o) => ({
      algoId: o.orderId, clientAlgoId: o.clientOrderId, algoType: 'CONDITIONAL', orderType: o.type, symbol: o.symbol,
      side: o.side, quantity: String(o.qty), algoStatus: o.algoStatus || 'NEW', triggerPrice: String(o.stopPrice),
      price: String(o.price), reduceOnly: o.reduceOnly, createTime: Date.now(),
    });
    const algoEvent = (o) => pushUser({ e: 'ALGO_UPDATE', o: { caid: o.clientOrderId, aid: o.orderId, X: o.algoStatus || 'NEW', s: o.symbol } });
    if (url.pathname === '/fapi/v1/order' && req.method === 'POST') {
      // Din 2025-12-09 Binance respinge TOATE tipurile condiționale pe endpoint-ul clasic.
      if (CONDITIONAL.includes(p.type)) return send(400, { code: -4120, msg: 'Order type not supported for this endpoint. Please use the Algo Order API endpoints instead.' });
      const r = place(p);
      if (r.error) return send(400, r.error);
      setTimeout(r.fill, st.eventDelayMs);
      return send(200, ack(r.order));
    }
    if (url.pathname === '/fapi/v1/order' && req.method === 'GET') {
      const o = st.all.get(p.origClientOrderId) || st.all.get(String(p.orderId));
      if (!o || o.algo) return send(400, { code: -2013, msg: 'Order does not exist.' });
      return send(200, { ...ack(o), status: o.status, avgPrice: String(o.avgPrice ?? 0), executedQty: String(o.executed ?? 0) });
    }
    if (url.pathname === '/fapi/v1/algoOrder' && req.method === 'POST') {
      if (st.rejectAlgo) return send(400, { code: -4120, msg: 'algo rejected (test)' });
      if (p.algoType !== 'CONDITIONAL') return send(400, { code: -1102, msg: 'algoType required' });
      if (!CONDITIONAL.includes(p.type)) return send(400, { code: -1116, msg: 'Invalid orderType.' });
      if (p.stopPrice) return send(400, { code: -1104, msg: 'stopPrice not read; use triggerPrice' });
      if (!p.triggerPrice) return send(400, { code: -1102, msg: 'triggerPrice required' });
      const r = place({ symbol: p.symbol, side: p.side, type: p.type, quantity: p.quantity, stopPrice: p.triggerPrice, reduceOnly: p.reduceOnly, newClientOrderId: p.clientAlgoId });
      if (r.error) return send(400, r.error);
      r.order.algo = true;
      algoEvent(r.order);
      return send(200, algoAck(r.order));
    }
    if (url.pathname === '/fapi/v1/openAlgoOrders') {
      return send(200, [...st.open.values()].filter((o) => o.algo && (!p.symbol || o.symbol === p.symbol)).map(algoAck));
    }
    if (url.pathname === '/fapi/v1/algoOrder' && req.method === 'GET') {
      const o = st.all.get(String(p.algoId));
      if (!o || !o.algo) return send(400, { code: -2013, msg: 'Order does not exist.' });
      return send(200, { ...algoAck(o), algoStatus: o.status === 'FILLED' ? 'FINISHED' : o.status });
    }
    if (url.pathname === '/fapi/v1/algoOrder' && req.method === 'DELETE') {
      const o = st.open.get(Number(p.algoId));
      if (!o || !o.algo) return send(400, { code: -2011, msg: 'Unknown order sent.' });
      st.open.delete(o.orderId); o.status = 'CANCELED'; o.algoStatus = 'CANCELED'; algoEvent(o);
      return send(200, { algoId: o.orderId, clientAlgoId: o.clientOrderId, code: '200', msg: 'success' });
    }
    if (url.pathname === '/fapi/v1/algoOpenOrders' && req.method === 'DELETE') {
      for (const o of [...st.open.values()]) if (o.algo && o.symbol === p.symbol) { st.open.delete(o.orderId); o.status = 'CANCELED'; o.algoStatus = 'CANCELED'; algoEvent(o); }
      return send(200, { code: 200, msg: 'The operation of cancel all open order is done.' });
    }
    return send(404, { code: -1, msg: `mock: neimplementat ${req.method} ${url.pathname}` });
  });

  // ── WebSocket (WS-API / market / user) ──
  const wssApi = new WebSocketServer({ noServer: true });
  const wssMkt = new WebSocketServer({ noServer: true });
  const wssUser = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url, 'http://x').pathname;
    const to = path === '/wsapi' ? wssApi : path === '/mkt' ? wssMkt : path.startsWith('/user/') ? wssUser : null;
    if (!to) return socket.destroy();
    to.handleUpgrade(req, socket, head, (ws) => to.emit('connection', ws, req));
  });

  wssUser.on('connection', (ws) => { userSockets.add(ws); ws.on('close', () => userSockets.delete(ws)); });

  wssMkt.on('connection', (ws) => {
    mktSockets.set(ws, new Set());
    ws.on('close', () => mktSockets.delete(ws));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      st.calls.push({ kind: 'mkt', method: m.method, params: m.params, t: Date.now() });
      if (m.method === 'SUBSCRIBE') {
        for (const s of m.params) mktSockets.get(ws).add(s.split('@')[0]);
        ws.send(JSON.stringify({ result: null, id: m.id }));
        setTimeout(() => pushTicker(m.params[0].split('@')[0].toUpperCase()), 10);
      } else if (m.method === 'UNSUBSCRIBE') {
        for (const s of m.params) mktSockets.get(ws).delete(s.split('@')[0]);
        ws.send(JSON.stringify({ result: null, id: m.id }));
      }
    });
  });

  wssApi.on('connection', (ws) => {
    wsapiSockets.add(ws);
    ws.on('close', () => wsapiSockets.delete(ws));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      const params = m.params || {};
      st.calls.push({ kind: 'wsapi', method: m.method, params, t: Date.now() });
      const reply = (obj) => ws.readyState === 1 && ws.send(JSON.stringify({ id: m.id, ...obj }));
      if (!params.signature || !params.apiKey || !params.timestamp) {
        return reply({ status: 400, error: { code: -1102, msg: 'Mandatory parameter was not sent' } });
      }
      if (m.method === 'order.place') {
        if (['STOP_MARKET', 'TAKE_PROFIT_MARKET', 'STOP', 'TAKE_PROFIT', 'TRAILING_STOP_MARKET'].includes(params.type)) {
          return reply({ status: 400, error: { code: -4120, msg: 'Order type not supported for this endpoint. Please use the Algo Order API endpoints instead.' } });
        }
        const r = place(params);
        if (r.error) return setTimeout(() => reply({ status: 400, error: r.error }), st.ackDelayMs);
        if (st.fillBeforeAck) {
          r.fill();                                       // fill-ul pe user stream PRIMUL
          setTimeout(() => reply({ status: 200, result: ack(r.order) }), st.ackDelayMs + 40);
        } else {
          setTimeout(() => reply({ status: 200, result: ack(r.order) }), st.ackDelayMs);
          setTimeout(r.fill, st.ackDelayMs + st.eventDelayMs);
        }
        return;
      }
      if (m.method === 'order.cancel') {
        const o = st.open.get(Number(params.orderId));
        if (!o) return reply({ status: 400, error: { code: -2011, msg: 'Unknown order sent.' } });
        st.open.delete(o.orderId);
        o.status = 'CANCELED';
        setTimeout(() => reply({ status: 200, result: ack(o) }), st.ackDelayMs);
        setTimeout(() => orderEvent(o, 'CANCELED'), st.ackDelayMs + st.eventDelayMs);
        return;
      }
      reply({ status: 400, error: { code: -1, msg: `mock WS-API: ${m.method} neimplementat` } });
    });
  });

  await new Promise((r) => server.listen(port, '127.0.0.1', r));

  const api = {
    state: st,
    port,
    setPrice(mid, symbol = 'TESTUSDT', spread = 0.02) {
      st.bid = mid; st.ask = round(mid + spread, 4);
      pushTicker(symbol);
      sweepOpen();
    },
    resetTrading() {
      st.pos = {}; st.open.clear(); st.all.clear(); st.history.length = 0; st.calls.length = 0;
      st.rejectAlgo = false; st.hedgeMode = false; st.fillBeforeAck = false; st.emitUserEvents = true;
    },
    dropWsApiSockets() { for (const ws of wsapiSockets) ws.terminate(); },
    async close() {
      for (const s of [...userSockets, ...mktSockets.keys(), ...wsapiSockets]) s.terminate();
      await new Promise((r) => server.close(r));
    },
  };
  return api;
}
