// Teste de integrare: rulează codul REAL al sesiunii (session.js) contra unei
// burse Binance Futures simulate (mock-exchange.mjs) — fără bani, fără chei,
// fără rețea. Acoperă execuția, riscul, SL/TP (Algo API), SL automat, trigger-e,
// fallback-ul REST pentru conturi fără user stream și cursele de timing.
// Rulare: `npm test` în server/.
import assert from 'node:assert/strict';
import { ENDPOINTS } from '../src/endpoints.js';
import { BinanceSession } from '../src/session.js';
import { startMock } from './mock-exchange.mjs';

const PORT = 18791;
const mock = await startMock(PORT);
ENDPOINTS.futures.testnet = {
  rest: `http://127.0.0.1:${PORT}`,
  marketWs: `ws://127.0.0.1:${PORT}/mkt`,
  wsApi: `ws://127.0.0.1:${PORT}/wsapi`,
  userWs: `ws://127.0.0.1:${PORT}/user`,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000, label = 'condiție') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(10); }
  throw new Error(`timeout (${ms}ms) așteptând: ${label}`);
}

const msgs = [];
const session = new BinanceSession({
  apiKey: 'k'.repeat(64), apiSecret: 's'.repeat(64), market: 'futures', testnet: true,
  recvWindow: 5000, maxOrderUsd: 1000, maxPositionUsd: 5000,
}, (m) => msgs.push(m));

const st = mock.state;
const results = [];
const origLog = console.log;
console.log = () => {};                       // tăcem zgomotul din session ([time] ...)

async function test(name, fn) {
  const t0 = Date.now();
  try {
    mock.resetTrading();
    msgs.length = 0;
    session.triggers.clear();
    await session.refreshAccount().catch(() => {});
    mock.setPrice(100);
    await until(() => session.ticker && Math.abs(session.ticker.last - 100.01) < 0.05, 2000, 'ticker 100').catch(() => {});
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    origLog(`  PASS  ${name}  (${Date.now() - t0}ms)`);
  } catch (e) {
    results.push({ name, ok: false, err: e.message });
    origLog(`  FAIL  ${name}\n        -> ${e.message.split('\n')[0]}`);
  }
}
const last = () => st.history.at(-1);
const posQty = (s = 'TESTUSDT') => (st.pos[s]?.qty ?? 0);

// ───────────────────────── setup ─────────────────────────
await session.start();
await until(() => session.status.wsApi === 'connected' && session.status.market === 'connected' && session.status.user === 'connected', 5000, 'conexiuni');
await session.setSymbol('TESTUSDT');
await until(() => session.ticker?.symbol === 'TESTUSDT', 3000, 'ticker TESTUSDT');

origLog('\n=== 1. Conectare & simbol ===');
await test('3 conexiuni (WS-API / piață / user stream) conectate', async () => {
  assert.deepEqual(session.status, { wsApi: 'connected', market: 'connected', user: 'connected' });
  assert.ok(session.balances.USDT?.free > 0, 'balanță USDT lipsă');
});
await test('setSymbol: încarcă filtre + setează automat levierul MAXIM al contului', async () => {
  assert.equal(session.filters.TESTUSDT.tickSize, 0.01);
  assert.equal(session.filters.TESTUSDT.stepSize, 0.001);
  assert.equal(st.leverage.TESTUSDT, 50, 'levierul nu a fost setat pe Binance');
  const m = msgs.find((x) => x.type === 'symbol');
  assert.equal(session.leverage, 50);
});
await test('rotunjiri: floor la intrare, nearest la închidere, preț pe tick', async () => {
  assert.equal(session.roundQty(0.1239), 0.123);
  assert.equal(session.roundQty(0.0004), 0);
  assert.equal(session.roundQtyNearest(0.1199999999999), 0.12);   // floor ar da 0.119 (praful vechi)
  assert.equal(session.roundPrice(100.004), 100);
  assert.equal(session.roundPrice(100.006), 100.01);
});
await test('roundQty: fără pas pierdut din zgomot float (0.043, 1.005, 0.29, 1.15)', async () => {
  for (const [q, want] of [[0.043, 0.043], [1.005, 1.005], [0.29, 0.29], [1.15, 1.15], [0.057, 0.057], [4.35, 4.35]]) {
    assert.equal(session.roundQty(q), want, `roundQty(${q})`);
  }
  let bad = 0;
  for (let i = 1; i <= 20000; i++) { const q = parseFloat((i * 0.001).toFixed(3)); if (session.roundQty(q) !== q) bad++; }
  assert.equal(bad, 0, `${bad} multipli de step rotunjiți greșit`);
  assert.equal(session.roundQty(0.0399), 0.039);
});
await test('setSymbol: mesajul "symbol" poartă levierul și marginType reale ale contului', async () => {
  const sm = session.symbolMessage();
  assert.equal(sm.leverage, 50);
  assert.equal(sm.marginType, 'ISOLATED');
  st.isolated.TESTUSDT = false;
  await session.setSymbol('TESTUSDT');
  assert.equal(session.symbolMessage().marginType, 'CROSSED');
  st.isolated.TESTUSDT = true;
});

origLog('\n=== 2. Execuție & risc ===');
await test('BUY MARKET: ordin corect pe WS-API, poziție + fill sosesc pe user stream', async () => {
  await session.marketOrder('BUY', 0.5, { clientOrderId: 'm1' });
  await until(() => session.position.qty === 0.5, 2000, 'poziție 0.5 în cache');
  assert.equal(session.position.entry, 100.02);
  const c = st.calls.find((x) => x.kind === 'wsapi' && x.method === 'order.place');
  assert.equal(c.params.type, 'MARKET');
  assert.equal(c.params.side, 'BUY');
  assert.equal(c.params.quantity, 0.5);
  assert.ok(c.params.signature && c.params.apiKey && c.params.timestamp, 'ordin nesemnat');
  assert.ok(msgs.some((m) => m.type === 'orderUpdate' && m.order.status === 'FILLED' && m.order.clientOrderId === 'm1'));
});
await test('risc: respinge peste maxOrderUsd / cantitate zero / sub notional / peste maxPositionUsd', async () => {
  await assert.rejects(session.marketOrder('BUY', 100, {}), /maxOrderUsd/);
  await assert.rejects(session.marketOrder('BUY', 0.0004, {}), /Cantitate zero/);
  await assert.rejects(session.marketOrder('BUY', 0.01, {}), /minimul notional/);
  await session.marketOrder('BUY', 0.5, {});
  await until(() => session.position.qty === 0.5);
  session.s.maxPositionUsd = 120;
  await assert.rejects(session.marketOrder('BUY', 0.9, {}), /maxPositionUsd/);
  session.s.maxPositionUsd = 5000;
  assert.equal(st.history.length, 1, 'ordine respinse n-ar trebui să ajungă la bursă');
});
await test('Close All / Sell %: închide exact, apoi "nu ai poziție"', async () => {
  await session.marketOrder('BUY', 0.5, {});
  await until(() => session.position.qty === 0.5);
  await session.closePercent(50, 'c50');
  assert.equal(posQty(), 0.25);
  await session.closePercent(100, 'c100');
  assert.equal(posQty(), 0);
  await assert.rejects(session.closePercent(100), /Nu ai poziție/);
});

origLog('\n=== 3. Cont fără evenimente pe user stream (cazul contului tău real) ===');
await test('Close All merge chiar dacă cache-ul de poziție nu se actualizează', async () => {
  st.emitUserEvents = false;
  await session.marketOrder('BUY', 1, {});
  await sleep(60);
  assert.equal(session.position.qty, 0, 'cache-ul ar trebui să fie vechi (nu vin evenimente)');
  await session.closePercent(100, 'cx');
  assert.equal(posQty(), 0);
});
await test('Stop Loss / Take Profit / Scale / Reverse văd poziția reală (REST) fără evenimente', async () => {
  st.emitUserEvents = false;
  await session.marketOrder('BUY', 1, {});
  await sleep(60);
  await session.stopOrTp('sl', { pct: 1 }, 'slx');
  assert.equal(last().type, 'STOP_MARKET');
  await session.scale(50, 'scx');
  assert.equal(posQty(), 1.5);
  await session.reverse('rvx');
  assert.equal(posQty(), -1.5);
});

origLog('\n=== 4. SL / TP ===');
await test('SL/TP long: % din entry, ticks, preț exact — ordine reale reduceOnly pe REST', async () => {
  await session.marketOrder('BUY', 1, {});
  await until(() => session.position.qty === 1);
  await session.stopOrTp('sl', { pct: 1 }, 'a');
  let o = last();
  assert.deepEqual([o.type, o.side, o.reduceOnly, o.stopPrice, o.qty], ['STOP_MARKET', 'SELL', true, 99.02, 1]);
  await session.stopOrTp('tp', { pct: 2 }, 'b');
  o = last();
  assert.deepEqual([o.type, o.side, o.stopPrice], ['TAKE_PROFIT_MARKET', 'SELL', 102.02]);
  await session.stopOrTp('sl', { ticks: 100 }, 'c');
  assert.equal(last().stopPrice, 99.02);                       // 100.02 - 100*0.01
  await session.stopOrTp('sl', { price: 97.5 }, 'd');
  assert.equal(last().stopPrice, 97.5);
});
await test('SL/TP: pleacă pe /fapi/v1/algoOrder (CONDITIONAL, triggerPrice) — nu pe endpoint-ul clasic respins cu -4120', async () => {
  await session.marketOrder('BUY', 1, {});
  await until(() => session.position.qty === 1);
  await session.stopOrTp('sl', { pct: 1 }, 'alg1');
  await session.stopOrTp('tp', { pct: 2 }, 'alg2');
  const algoCalls = st.calls.filter((c) => c.kind === 'rest' && c.path === '/fapi/v1/algoOrder' && c.method === 'POST');
  assert.equal(algoCalls.length, 2);
  assert.equal(algoCalls[0].params.algoType, 'CONDITIONAL');
  assert.equal(algoCalls[0].params.type, 'STOP_MARKET');
  assert.equal(algoCalls[0].params.triggerPrice, '99.02');
  assert.equal(algoCalls[0].params.reduceOnly, 'true');
  assert.equal(algoCalls[0].params.clientAlgoId, 'alg1');
  assert.ok(!st.calls.some((c) => c.path === '/fapi/v1/order' && c.method === 'POST' && /STOP|TAKE_PROFIT/.test(c.params.type)),
    'a încercat endpoint-ul clasic pentru ordin condițional');
  assert.ok(!st.calls.some((c) => c.kind === 'wsapi' && /STOP|TAKE_PROFIT/.test(c.params.type)));
  await until(() => [...session.openOrders.values()].filter((o) => o.algo).length === 2, 2000, 'SL+TP în listă');
  const o = [...session.openOrders.values()].find((x) => x.type === 'STOP_MARKET');
  assert.ok(o.orderId.startsWith('A') && o.stopPrice === 99.02 && o.side === 'SELL');
  await session.cancelOrder(o.orderId);
  assert.ok(![...st.open.values()].some((x) => x.clientOrderId === 'alg1'));
});
await test('Cancel All anulează și SL/TP (Algo Service), nu doar ordinele clasice', async () => {
  await session.marketOrder('BUY', 1, {});
  await until(() => session.position.qty === 1);
  await session.stopOrTp('sl', { pct: 1 }, 'ca1');
  await session.limitOffset('BUY', 0.2, { offsetUsd: -5, clientOrderId: 'ca2' });
  assert.equal(st.open.size, 2);
  await session.cancelAll();
  assert.equal(st.open.size, 0, 'a rămas un ordin deschis pe bursă');
  await sleep(450);
  assert.equal(session.openOrders.size, 0);
});
await test('SL/TP short: SL deasupra entry, TP dedesubt', async () => {
  await session.marketOrder('SELL', 1, {});
  await until(() => session.position.qty === -1);
  await session.stopOrTp('sl', { pct: 1 }, 'a');
  assert.deepEqual([last().side, last().stopPrice], ['BUY', 101]);
  await session.stopOrTp('tp', { pct: 2 }, 'b');
  assert.equal(last().stopPrice, 98);
});
await test('SL/TP: Stop-ul se declanșează la bursă și închide poziția (ciclu complet)', async () => {
  await session.marketOrder('BUY', 1, {});
  await until(() => session.position.qty === 1);
  await session.stopOrTp('sl', { pct: 1 }, 'cyc');
  mock.setPrice(98.9);
  await until(() => posQty() === 0, 2000, 'poziție închisă de stop');
  await until(() => session.position.qty === 0, 2000, 'cache actualizat');
  await until(() => ![...session.openOrders.values()].some((o) => o.clientOrderId === 'cyc'), 2000, 'SL-ul declanșat dispare din lista de ordine');
});
await test('testnet -4120: eroarea Binance ajunge la utilizator cu cod, nu e înghițită', async () => {
  await session.marketOrder('BUY', 1, {});
  await until(() => session.position.qty === 1);
  st.rejectAlgo = true;
  await assert.rejects(session.stopOrTp('sl', { pct: 1 }), (e) => e.code === -4120);
});

origLog('\n=== 5. Scale / Reverse / operații rapide ===');
await test('Scale In/Out + Reverse pe futures', async () => {
  await session.marketOrder('BUY', 1, {});
  await until(() => session.position.qty === 1);
  await session.scale(50, 's1');   assert.equal(posQty(), 1.5);
  await session.scale(-50, 's2');  assert.equal(posQty(), 0.75);
  await session.reverse('r1');     assert.equal(posQty(), -0.75);
});
await test('serializare: Scale In urmat IMEDIAT de Close All lasă contul FLAT (fără praf)', async () => {
  await session.marketOrder('BUY', 1, {});
  await until(() => session.position.qty === 1);
  st.ackDelayMs = 150;
  const a = session.scale(50, 'sa');
  const b = session.closePercent(100, 'sb');
  await Promise.all([a, b]);
  st.ackDelayMs = 5;
  assert.equal(posQty(), 0, 'a rămas praf deschis');
  const seq = st.history.slice(1).map((o) => `${o.side}:${o.qty}`);
  assert.deepEqual(seq, ['BUY:0.5', 'SELL:1.5'], 'ordinea/cantitățile greșite');
});

origLog('\n=== 6. Trigger-e de intrare ===');
await test('trigger în sus: nu se declanșează sub țintă, intră când prețul o atinge', async () => {
  const t = session.addTrigger({ side: 'BUY', qty: 0.1, triggerPrice: 101, orderType: 'MARKET', clientOrderId: 'tg1' });
  assert.equal(t.direction, 'up');
  mock.setPrice(100.5); await sleep(80);
  assert.equal(st.history.length, 0);
  mock.setPrice(101.2);
  await until(() => st.history.length === 1, 2000, 'ordin trimis');
  assert.deepEqual([last().type, last().side, last().qty], ['MARKET', 'BUY', 0.1]);
  assert.equal(session.triggers.size, 0);
  await until(() => msgs.some((m) => m.type === 'triggerFired'), 2000, 'mesaj triggerFired (după ack)');
});
await test('trigger în jos + LIMIT cu offset (tick-uri și $)', async () => {
  const t = session.addTrigger({ side: 'SELL', qty: 0.1, triggerPrice: 99, orderType: 'LIMIT', offsetUsd: 0.3, clientOrderId: 'tg2' });
  assert.equal(t.direction, 'down');
  mock.setPrice(98.9);
  await until(() => st.history.length === 1, 2000);
  assert.equal(last().type, 'LIMIT');
  assert.equal(last().price, 98.6);                              // bid 98.9 - 0.30
});
await test('Cancel All și schimbarea simbolului curăță trigger-ele', async () => {
  session.addTrigger({ side: 'BUY', qty: 0.1, triggerPrice: 150, clientOrderId: 'z1' });
  await session.cancelAll();
  assert.equal(session.triggers.size, 0);
  session.addTrigger({ side: 'BUY', qty: 0.1, triggerPrice: 150, clientOrderId: 'z2' });
  await session.setSymbol('ALTUSDT');
  assert.equal(session.triggers.size, 0);
  await session.setSymbol('TESTUSDT');
  await until(() => session.ticker?.symbol === 'TESTUSDT');
});

origLog('\n=== 7. SL automat ===');
await test('MARKET + SL automat (%, ticks, preț exact) pe prețul REAL de execuție', async () => {
  await session.marketOrder('BUY', 1, { clientOrderId: 'asl1', autoSl: { mode: 'pct', value: 0.5 } });
  assert.deepEqual([last().type, last().side, last().stopPrice, last().reduceOnly], ['STOP_MARKET', 'SELL', 99.52, true]);
  assert.equal(last().clientOrderId, 'asl1_asl');
  await session.marketOrder('BUY', 1, { clientOrderId: 'asl2', autoSl: { mode: 'ticks', value: 50 } });
  assert.equal(last().stopPrice, 99.52);
  await session.marketOrder('BUY', 1, { clientOrderId: 'asl3', autoSl: { mode: 'price', value: 97 } });
  assert.equal(last().stopPrice, 97);
});
await test('SHORT + SL automat: stop DEASUPRA prețului de execuție', async () => {
  await session.marketOrder('SELL', 1, { clientOrderId: 'asl4', autoSl: { mode: 'pct', value: 1 } });
  assert.deepEqual([last().side, last().stopPrice], ['BUY', 101]);
});
await test('cursa fill-înainte-de-ack: SL automat tot se plasează', async () => {
  st.fillBeforeAck = true;
  await session.marketOrder('BUY', 1, { clientOrderId: 'race', autoSl: { mode: 'pct', value: 0.5 } });
  assert.equal(last().type, 'STOP_MARKET');
});
await test('FĂRĂ evenimente pe user stream: SL automat se plasează tot (fill confirmat prin REST), rapid', async () => {
  st.emitUserEvents = false;
  const t0 = Date.now();
  await session.marketOrder('BUY', 1, { clientOrderId: 'noevt', autoSl: { mode: 'pct', value: 0.5 } });
  assert.ok(Date.now() - t0 < 3000, `a durat ${Date.now() - t0}ms`);
  assert.equal(posQty(), 1);
  assert.ok(!msgs.some((m) => m.type === 'autoSlError'), 'nu trebuia să apară autoSlError');
  const sl = st.history.find((o) => o.type === 'STOP_MARKET');
  assert.ok(sl, 'SL-ul nu s-a plasat');
  assert.equal(sl.stopPrice, 99.52);
  assert.ok(msgs.some((m) => m.type === 'orderUpdate' && m.order.status === 'FILLED' && m.order.clientOrderId === 'noevt'),
    'UI-ul n-a primit fill-ul (toast)');
});
await test('LIMIT + SL automat: NU blochează alte comenzi; la fill plasează SL', async () => {
  const t0 = Date.now();
  const r = await session.limitOffset('BUY', 0.5, { offsetUsd: -5, autoSl: { mode: 'pct', value: 1 }, clientOrderId: 'lim1' });
  assert.ok(Date.now() - t0 < 500, 'limit-ul a blocat coada');
  const t1 = Date.now();
  await session.marketOrder('BUY', 0.1, {});
  assert.ok(Date.now() - t1 < 500, 'market-ul a așteptat după limit');
  mock.setPrice(94.9);                                          // limit-ul (95.02) se umple
  await until(() => st.history.some((o) => o.type === 'STOP_MARKET'), 3000, 'SL după fill limit');
  assert.equal(st.history.find((o) => o.type === 'STOP_MARKET').stopPrice, 94.07);
});
await test('LIMIT + SL automat anulat manual: NICIO eroare roșie, niciun SL rămas', async () => {
  const r = await session.limitOffset('BUY', 0.5, { offsetUsd: -5, autoSl: { mode: 'pct', value: 1 }, clientOrderId: 'lim2' });
  await session.cancelOrder(r.orderId);
  await until(() => msgs.some((m) => m.type === 'orderUpdate' && m.order.status === 'CANCELED'), 2000, 'CANCELED');
  await sleep(300);
  assert.ok(!msgs.some((m) => m.type === 'autoSlError'), `autoSlError nedorit: ${msgs.find((m) => m.type === 'autoSlError')?.message}`);
  assert.ok(!st.history.some((o) => o.type === 'STOP_MARKET'));
});
await test('LIMIT + SL automat anulat, FĂRĂ user stream: tot fără eroare roșie', async () => {
  st.emitUserEvents = false;
  const r = await session.limitOffset('BUY', 0.5, { offsetUsd: -5, autoSl: { mode: 'pct', value: 1 }, clientOrderId: 'lim3' });
  await session.cancelOrder(r.orderId);
  await sleep(1500);
  assert.ok(!msgs.some((m) => m.type === 'autoSlError'));
  assert.ok(!st.history.some((o) => o.type === 'STOP_MARKET'));
});

origLog('\n=== 7b. Fallback REST (cont fără user stream) ===');
await test('poziția + fill-ul apar singure în UI (fără niciun eveniment), după un ordin', async () => {
  st.emitUserEvents = false;
  msgs.length = 0;
  await session.marketOrder('BUY', 0.5, { clientOrderId: 'poll1' });
  await until(() => session.position.qty === 0.5, 2500, 'poziție 0.5 prin REST');
  assert.ok(msgs.some((m) => m.type === 'account' && m.position.qty === 0.5), 'UI nu a primit poziția');
  await until(() => msgs.some((m) => m.type === 'orderUpdate' && m.order.status === 'FILLED' && m.order.clientOrderId === 'poll1'), 2500, 'toast fill');
});
await test('poziție modificată din afară e văzută de poll fără nicio acțiune de-a noastră', async () => {
  st.emitUserEvents = false;
  st.pos.TESTUSDT = { qty: 2, entry: 100 };
  session.lastPoll = 0; session.lastOrderActivity = 0;
  await until(() => session.position.qty === 2, 25000, 'poll idle');
});
await test('SL declanșat la bursă, FĂRĂ user stream: poziția și lista se curăță, UI primește fill', async () => {
  st.emitUserEvents = false;
  await session.marketOrder('BUY', 1, { clientOrderId: 'ssl' });
  await until(() => session.position.qty === 1, 2500);
  await session.stopOrTp('sl', { pct: 1 }, 'ssl_sl');
  await until(() => [...session.openOrders.values()].some((o) => o.algo), 2500, 'SL în listă');
  msgs.length = 0;
  mock.setPrice(98.9);
  await until(() => session.position.qty === 0, 6000, 'poziție închisă');
  await until(() => session.openOrders.size === 0, 6000, 'listă curată');
  await until(() => msgs.some((m) => m.type === 'orderUpdate' && m.order.status === 'FILLED'), 6000, 'toast fill SL');
});
await test('fără dubluri: cu stream VIU, un fill e anunțat o singură dată', async () => {
  msgs.length = 0;
  await session.marketOrder('BUY', 0.5, { clientOrderId: 'dup1' });
  await sleep(1800);
  const fills = msgs.filter((m) => m.type === 'orderUpdate' && m.order.status === 'FILLED' && m.order.clientOrderId === 'dup1');
  assert.equal(fills.length, 1, `${fills.length} anunțuri de fill`);
});

origLog('\n=== 8. Flatten, reconectare, limitări cunoscute ===');
await test('KILL/Flatten: anulează ordinele, închide poziția, golește trigger-ele', async () => {
  await session.marketOrder('BUY', 1, {});
  await until(() => session.position.qty === 1);
  await session.limitOffset('BUY', 0.5, { offsetUsd: -5, clientOrderId: 'f1' });
  await session.stopOrTp('sl', { pct: 1 }, 'f2');
  session.addTrigger({ side: 'BUY', qty: 0.1, triggerPrice: 150, clientOrderId: 'f3' });
  await session.flatten('fl');
  assert.equal(posQty(), 0);
  assert.equal(st.open.size, 0);
  assert.equal(session.triggers.size, 0);
});
await test('WS-API cade → se reconectează singur și ordinele merg din nou', async () => {
  mock.dropWsApiSockets();
  await until(() => session.status.wsApi !== 'connected', 2000, 'detectare cădere');
  await until(() => session.status.wsApi === 'connected', 6000, 'reconectare');
  await session.marketOrder('BUY', 0.1, {});
  assert.equal(posQty(), 0.1);
});
await test('Hedge Mode (cont cere positionSide): eroarea -4061 e raportată (LIMITARE cunoscută)', async () => {
  st.hedgeMode = true;
  await assert.rejects(session.marketOrder('BUY', 0.1, {}), (e) => e.code === -4061);
});
await test('listSymbols: lista de simboluri pentru căutare', async () => {
  const l = await session.listSymbols();
  assert.ok(l.includes('AKEUSDT') && l.includes('CAKEUSDT') && l.length === 5);
});

// ───────────────────────── sumar ─────────────────────────
const failed = results.filter((r) => !r.ok);
origLog(`\n=== SUMAR: ${results.length - failed.length}/${results.length} teste trecute ===`);
for (const f of failed) origLog(`  ✗ ${f.name}\n      ${f.err}`);
await mock.close();
process.exit(failed.length ? 1 : 0);
