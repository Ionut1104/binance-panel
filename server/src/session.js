// ═══════════════════════════════════════════════════════════════════
// BinanceSession — creierul backend-ului.
// Ține toate conexiunile pentru configurația curentă (spot/futures ×
// testnet/live), starea live (preț, poziție, balanță, ordine) și
// implementează acțiunile de trading cu verificări de risc.
// ═══════════════════════════════════════════════════════════════════
import { endpointsFor } from './endpoints.js';
import { BinanceRest } from './rest.js';
import { BinanceWsApi } from './wsApi.js';
import { MarketStream } from './marketStream.js';
import { UserStream } from './userStream.js';
import { syncTime } from './timeSync.js';

export class BinanceSession {
  constructor(settings, broadcast) {
    this.s = settings;             // setările decriptate (chei, market, limite)
    this.broadcast = broadcast;    // trimite un mesaj către toate UI-urile conectate
    this.symbol = null;
    this.filters = {};             // per simbol: tickSize, stepSize, minQty, minNotional
    this.ticker = null;            // ultimul bookTicker
    this.balances = {};            // asset → { free, locked }
    this.position = { qty: 0, entry: 0 };  // qty > 0 = long, < 0 = short
    this.openOrders = new Map();   // orderId → ordin
    this.status = { wsApi: 'disconnected', market: 'disconnected', user: 'disconnected' };
    this.symbolsCache = null;      // lista de simboluri pentru autocomplete
    this.triggers = new Map();     // id → intrare condiționată de preț (vezi addTrigger)
    this.leverage = null;          // levierul curent pe simbolul activ (futures)
    this.opChain = Promise.resolve();  // vezi #serial()
    this.fillWaiters = new Map();  // clientOrderId → {resolve,reject,timer}, vezi #waitFill()
  }

  // ── Pornire: time sync → WS-API → market stream → user stream ──
  async start() {
    const ep = endpointsFor(this.s.market, this.s.testnet);
    this.ep = ep;
    this.rest = new BinanceRest({
      base: ep.rest, apiKey: this.s.apiKey,
      apiSecret: this.s.apiSecret, recvWindow: this.s.recvWindow,
    });

    // 1. Sincronizăm ceasul ÎNAINTE de orice request semnat.
    await syncTime(ep.rest, this.s.market);
    // Re-sincronizare la 15 min (drift-ul ceasului local).
    this.timeTimer = setInterval(() => syncTime(ep.rest, this.s.market).catch(() => {}), 15 * 60 * 1000);
    // Ping REST periodic — ține caldă conexiunea folosită de STOP_MARKET/
    // TAKE_PROFIT_MARKET (vezi placeOrder), sub fereastra de 60s din
    // extendRestKeepAlive(), ca un SL/TP rar plasat să nu plătească un
    // TCP+TLS handshake nou chiar în momentul în care contează cel mai mult.
    const pingPath = this.isFutures ? '/fapi/v1/ping' : '/api/v3/ping';
    this.restPingTimer = setInterval(() => this.rest.public(pingPath).catch(() => {}), 45_000);

    // 2. Conexiunea WS-API pentru ordine (persistentă, caldă).
    this.wsApi = new BinanceWsApi({
      url: ep.wsApi, apiKey: this.s.apiKey, apiSecret: this.s.apiSecret,
      recvWindow: this.s.recvWindow,
      onStatus: (st) => this.#status('wsApi', st),
    });
    this.wsApi.connect();

    // 3. Preț live.
    this.marketWs = new MarketStream({
      url: ep.marketWs,
      onTicker: (t) => {
        this.ticker = t;
        this.broadcast({ type: 'ticker', ...t });
        this.#checkTriggers(t);
      },
      onStatus: (st) => this.#status('market', st),
    });
    this.marketWs.connect();

    // 4. Fill-uri / balanță / poziție în timp real.
    this.userWs = new UserStream({
      rest: this.rest, wsBase: ep.userWs, market: this.s.market,
      onEvent: (e) => this.#onUserEvent(e),
      onStatus: (st) => this.#status('user', st),
    });
    this.userWs.connect();

    // 5. Snapshot inițial de cont (balanță + poziții), fără să blocăm pornirea.
    this.refreshAccount().catch((e) => console.error('[account]', e.message));
  }

  stop() {
    clearInterval(this.timeTimer);
    clearInterval(this.restPingTimer);
    for (const w of this.fillWaiters.values()) clearTimeout(w.timer);
    this.fillWaiters.clear();
    this.wsApi?.close();
    this.marketWs?.close();
    this.userWs?.close();
  }

  // Așteaptă evenimentul REAL de fill (user stream) pt. un clientOrderId —
  // order.place pe WS-API răspunde cu status NEW chiar și pt. MARKET (fill-ul
  // vine separat, pe user stream, cu prețul mediu de execuție în `ap`), deci
  // SL automat are nevoie de acest eveniment, nu de răspunsul inițial.
  #waitFill(clientOrderId, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fillWaiters.delete(clientOrderId);
        reject(new Error('Timeout așteptând confirmarea fill-ului (SL automat).'));
      }, timeoutMs);
      this.fillWaiters.set(clientOrderId, { resolve, reject, timer });
    });
  }

  #status(which, st) {
    this.status[which] = st;
    this.broadcast({ type: 'status', status: this.status });
  }

  get isFutures() { return this.s.market === 'futures'; }

  // ── Snapshot cont: balanțe + poziție + ordine deschise ──
  async refreshAccount() {
    if (this.isFutures) {
      const acc = await this.rest.signed('GET', '/fapi/v2/account');
      this.balances = {};
      for (const a of acc.assets) {
        this.balances[a.asset] = { free: parseFloat(a.availableBalance), total: parseFloat(a.walletBalance) };
      }
      if (this.symbol) {
        const p = acc.positions.find((x) => x.symbol === this.symbol);
        this.position = p
          ? { qty: parseFloat(p.positionAmt), entry: parseFloat(p.entryPrice) }
          : { qty: 0, entry: 0 };
      }
    } else {
      const acc = await this.rest.signed('GET', '/api/v3/account');
      this.balances = {};
      for (const b of acc.balances) {
        const free = parseFloat(b.free), locked = parseFloat(b.locked);
        if (free > 0 || locked > 0) this.balances[b.asset] = { free, total: free + locked };
      }
      // Spot n-are noțiune de "poziție": aproximăm cu balanța monedei de bază.
      // Entry-ul îl calculăm local din fill-uri (vezi #onUserEvent).
      if (this.symbol && this.filters[this.symbol]) {
        const base = this.filters[this.symbol].baseAsset;
        const held = this.balances[base]?.total || 0;
        if (Math.abs(held - this.position.qty) > (this.filters[this.symbol].stepSize || 0)) {
          this.position = { qty: held, entry: this.position.entry || this.ticker?.last || 0 };
        }
      }
    }
    await this.refreshOpenOrders();
    this.#pushAccount();
  }

  async refreshOpenOrders() {
    if (!this.symbol) return;
    const path = this.isFutures ? '/fapi/v1/openOrders' : '/api/v3/openOrders';
    const orders = await this.rest.signed('GET', path, { symbol: this.symbol });
    this.openOrders.clear();
    for (const o of orders) this.openOrders.set(String(o.orderId), this.#normOrder(o));
    this.#pushOrders();
  }

  #normOrder(o) {
    return {
      orderId: String(o.orderId),
      clientOrderId: o.clientOrderId || o.c,
      symbol: o.symbol || o.s,
      side: o.side || o.S,
      type: o.type || o.o,
      price: parseFloat(o.price ?? o.p ?? 0),
      avgPrice: parseFloat(o.avgPrice ?? o.ap ?? 0),
      stopPrice: parseFloat(o.stopPrice ?? o.sp ?? 0),
      qty: parseFloat(o.origQty ?? o.q ?? 0),
      filled: parseFloat(o.executedQty ?? o.z ?? 0),
      status: o.status || o.X,
    };
  }

  #pushAccount() {
    this.broadcast({
      type: 'account',
      balances: this.balances,
      position: { symbol: this.symbol, ...this.position },
    });
  }

  #pushOrders() {
    this.broadcast({ type: 'orders', orders: [...this.openOrders.values()] });
  }

  // ── Evenimente din user data stream ──
  #onUserEvent(e) {
    const type = e.e;
    if (this.isFutures) {
      if (type === 'ORDER_TRADE_UPDATE') {
        const o = e.o;
        const ord = this.#normOrder({
          orderId: o.i, clientOrderId: o.c, symbol: o.s, side: o.S, type: o.o,
          price: o.p, avgPrice: o.ap, stopPrice: o.sp, origQty: o.q, executedQty: o.z, status: o.X,
        });
        this.#applyOrderUpdate(ord, parseFloat(o.L), parseFloat(o.l));
      } else if (type === 'ACCOUNT_UPDATE') {
        // Poziția și balanța vin direct de la Binance — sursa de adevăr.
        for (const b of e.a?.B || []) {
          this.balances[b.a] = { free: parseFloat(b.cw ?? b.wb), total: parseFloat(b.wb) };
        }
        for (const p of e.a?.P || []) {
          if (p.s === this.symbol) {
            this.position = { qty: parseFloat(p.pa), entry: parseFloat(p.ep) };
          }
        }
        this.#pushAccount();
      }
    } else {
      if (type === 'executionReport') {
        const ord = this.#normOrder({
          orderId: e.i, clientOrderId: e.c, symbol: e.s, side: e.S, type: e.o,
          price: e.p, stopPrice: e.P, origQty: e.q, executedQty: e.z, status: e.X,
        });
        // Pe spot calculăm entry-ul local din fill-uri (average cost).
        const lastQty = parseFloat(e.l), lastPrice = parseFloat(e.L);
        if (lastQty > 0 && e.s === this.symbol) {
          const dir = e.S === 'BUY' ? 1 : -1;
          const newQty = this.position.qty + dir * lastQty;
          if (dir > 0) {
            // media ponderată doar când adăugăm
            const cost = this.position.entry * this.position.qty + lastPrice * lastQty;
            this.position = { qty: newQty, entry: newQty > 0 ? cost / newQty : 0 };
          } else {
            this.position = { qty: Math.max(newQty, 0), entry: newQty > 1e-12 ? this.position.entry : 0 };
          }
          this.#pushAccount();
        }
        this.#applyOrderUpdate(ord, lastPrice, lastQty);
      } else if (type === 'outboundAccountPosition') {
        for (const b of e.B || []) {
          this.balances[b.a] = { free: parseFloat(b.f), total: parseFloat(b.f) + parseFloat(b.l) };
        }
        this.#pushAccount();
      }
    }
  }

  // Actualizează lista de ordine + notifică UI-ul (fill verde / reject roșu).
  #applyOrderUpdate(ord, lastPrice, lastQty) {
    const done = ['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED'].includes(ord.status);
    if (done) this.openOrders.delete(ord.orderId);
    else this.openOrders.set(ord.orderId, ord);
    this.#pushOrders();
    this.broadcast({
      type: 'orderUpdate',
      order: ord,
      lastPrice, lastQty,
      // UI-ul folosește asta pentru feedback vizual+sonor și pentru a
      // împerechea confirmarea cu ordinul optimist (după clientOrderId).
    });

    // Cineva așteaptă fill-ul ăstuia (SL automat, vezi #waitFill)?
    const waiter = this.fillWaiters.get(ord.clientOrderId);
    if (waiter && done) {
      this.fillWaiters.delete(ord.clientOrderId);
      clearTimeout(waiter.timer);
      if (ord.status === 'FILLED') waiter.resolve(ord);
      else waiter.reject(new Error(`Ordinul de intrare a fost ${ord.status}.`));
    }
  }

  // ── Selectarea simbolului ──
  async setSymbol(symbol) {
    symbol = symbol.toUpperCase();
    this.symbol = symbol;
    this.position = { qty: 0, entry: 0 };
    this.triggers.clear();                // trigger-ele erau pentru alt simbol
    this.#pushTriggers();
    await this.#loadFilters(symbol);      // tick size / step size / min notional
    this.marketWs.setSymbol(symbol);      // resubscribe stream-ul de preț
    await this.refreshAccount();          // poziție + ordine pentru noul simbol

    // Levier automat la MAXIMUL permis contului tău pe perechea asta — la
    // un Size fix în USDT (notional), levier mai mare = marjă (balanță)
    // blocată mai mică pentru aceeași expunere. Nu blocăm schimbarea de
    // simbol dacă asta eșuează (ex. permisiuni limitate pe cont).
    if (this.isFutures) {
      try {
        this.leverage = await this.#maxLeverage(symbol);
        await this.setLeverage(this.leverage);
      } catch (e) {
        console.error('[leverage] auto-max eșuat:', e.message);
      }
    }

    this.broadcast({ type: 'symbol', symbol, filters: this.filters[symbol], leverage: this.leverage });
  }

  // Levierul maxim pe care Binance îl permite CONTULUI TĂU pentru acest
  // simbol (depinde de brackets de risc — poate diferi de 125× "teoretic").
  async #maxLeverage(symbol) {
    const brackets = await this.rest.signed('GET', '/fapi/v1/leverageBracket', { symbol });
    const list = brackets[0]?.brackets || [];
    return list.reduce((max, b) => Math.max(max, b.initialLeverage || 0), 1);
  }

  async #loadFilters(symbol) {
    if (this.filters[symbol]) return;
    const path = this.isFutures ? '/fapi/v1/exchangeInfo' : '/api/v3/exchangeInfo';
    const info = await this.rest.public(path, this.isFutures ? {} : { symbol });
    const si = info.symbols.find((x) => x.symbol === symbol);
    if (!si) throw new Error(`Simbol necunoscut: ${symbol}`);
    const f = {};
    for (const flt of si.filters) {
      if (flt.filterType === 'PRICE_FILTER') f.tickSize = parseFloat(flt.tickSize);
      if (flt.filterType === 'LOT_SIZE') { f.stepSize = parseFloat(flt.stepSize); f.minQty = parseFloat(flt.minQty); }
      if (flt.filterType === 'MIN_NOTIONAL' || flt.filterType === 'NOTIONAL') {
        f.minNotional = parseFloat(flt.minNotional ?? flt.notional ?? 0);
      }
    }
    f.baseAsset = si.baseAsset;
    f.quoteAsset = si.quoteAsset;
    f.pricePrecision = si.pricePrecision ?? this.#precisionOf(f.tickSize);
    f.qtyPrecision = si.quantityPrecision ?? this.#precisionOf(f.stepSize);
    this.filters[symbol] = f;
  }

  #precisionOf(step) {
    if (!step || step >= 1) return 0;
    return Math.round(-Math.log10(step));
  }

  // Lista tuturor simbolurilor (pentru autocomplete). Cache 1h.
  async listSymbols() {
    if (this.symbolsCache && Date.now() - this.symbolsCache.ts < 3600_000) {
      return this.symbolsCache.list;
    }
    const path = this.isFutures ? '/fapi/v1/exchangeInfo' : '/api/v3/exchangeInfo';
    const info = await this.rest.public(path);
    const list = info.symbols
      .filter((s) => s.status === 'TRADING')
      .map((s) => s.symbol);
    this.symbolsCache = { ts: Date.now(), list };
    return list;
  }

  // ── Rotunjiri conform filtrelor Binance (altfel: eroare "LOT_SIZE") ──
  // La INTRARE rotunjim mereu în JOS (floor) — nu depășim niciodată balanța
  // disponibilă cu o cantitate calculată dintr-un Size în USDT.
  roundQty(qty) {
    const f = this.filters[this.symbol];
    const step = f?.stepSize || 0.000001;
    const r = Math.floor(qty / step) * step;
    return parseFloat(r.toFixed(f?.qtyPrecision ?? 6));
  }

  // La ÎNCHIDEREA COMPLETĂ a unei poziții rotunjim la cel mai APROPIAT
  // multiplu, nu în jos: posQty vine deja de la Binance ca multiplu valid
  // de stepSize, iar floor() ar putea tăia un pas întreg din cauza
  // zgomotului de virgulă mobilă (0.0012 stocat ca 0.0011999999999999998),
  // lăsând "praf" nevândut după Close All / Flatten.
  roundQtyNearest(qty) {
    const f = this.filters[this.symbol];
    const step = f?.stepSize || 0.000001;
    const r = Math.round(qty / step) * step;
    return parseFloat(r.toFixed(f?.qtyPrecision ?? 6));
  }

  roundPrice(price) {
    const f = this.filters[this.symbol];
    const tick = f?.tickSize || 0.01;
    const r = Math.round(price / tick) * tick;
    return parseFloat(r.toFixed(f?.pricePrecision ?? 2));
  }

  // ── Verificări de risc înainte de fiecare ordin ──
  #riskCheck(qty, price) {
    const notional = qty * price;
    if (notional > this.s.maxOrderUsd) {
      throw new Error(`Ordin ${notional.toFixed(0)} USDT > limita maxOrderUsd (${this.s.maxOrderUsd}). Modifică în Setări dacă e intenționat.`);
    }
    const posNotional = Math.abs(this.position.qty) * price;
    if (posNotional + notional > this.s.maxPositionUsd) {
      throw new Error(`Poziția ar depăși maxPositionUsd (${this.s.maxPositionUsd} USDT).`);
    }
    const f = this.filters[this.symbol];
    if (f?.minQty && qty < f.minQty) throw new Error(`Cantitate sub minim (${f.minQty}).`);
    if (f?.minNotional && notional < f.minNotional) {
      throw new Error(`Valoare sub minimul notional (${f.minNotional} USDT).`);
    }
  }

  #price() {
    if (!this.ticker) throw new Error('Nu am încă preț live — așteaptă conectarea.');
    return this.ticker;
  }

  #pushTriggers() {
    this.broadcast({ type: 'triggers', triggers: [...this.triggers.values()] });
  }

  // Serializează operațiile care schimbă poziția (buy/sell/scale/close/
  // reverse/stopTp/flatten/trigger). Dacă tragi două butoane foarte rapid
  // (ex. Scale In apoi Close All), a doua AȘTEAPTĂ ca prima să ajungă
  // complet la Binance înainte să citească poziția și să calculeze
  // cantitatea — altfel Close All poate porni înainte ca Scale In să se fi
  // procesat, calculează 100% dintr-o cantitate veche și lasă "praf" nevândut.
  #serial(fn) {
    const run = this.opChain.then(fn, fn);
    this.opChain = run.then(() => {}, () => {});
    return run;
  }

  // ── Intrare condiționată de preț ("stop entry") ──
  // Ex: prețul e la 0.58, vrei să intri abia dacă ajunge la 0.6 — setezi
  // triggerPrice=0.6, iar la fiecare tick de preț verificăm dacă a fost
  // atins; abia atunci trimitem ordinul (MARKET sau LIMIT ± offset).
  // Direcția (sus/jos) se deduce automat din poziția triggerPrice față de
  // prețul curent, ca să meargă la fel pentru breakout LONG cât și pt SHORT.
  addTrigger({ side, qty, triggerPrice, orderType = 'MARKET', offsetTicks = 0, offsetUsd = 0, tif, autoSl, clientOrderId }) {
    if (!this.symbol) throw new Error('Niciun simbol selectat.');
    const last = this.#price().last;
    triggerPrice = this.roundPrice(triggerPrice);
    qty = this.roundQty(qty);
    if (qty <= 0) throw new Error('Cantitate zero după rotunjire.');
    if (triggerPrice <= 0) throw new Error('Preț trigger invalid.');
    const trigger = {
      id: clientOrderId || `trg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      symbol: this.symbol,
      side, qty, triggerPrice, orderType, offsetTicks, offsetUsd, tif, autoSl,
      direction: triggerPrice >= last ? 'up' : 'down',
      createdAt: Date.now(),
    };
    this.triggers.set(trigger.id, trigger);
    this.#pushTriggers();
    return trigger;
  }

  cancelTrigger(id) {
    this.triggers.delete(id);
    this.#pushTriggers();
  }

  // Verificat la fiecare tick de preț (vezi onTicker în start()).
  #checkTriggers(t) {
    if (this.triggers.size === 0) return;
    for (const trig of this.triggers.values()) {
      const hit = trig.direction === 'up' ? t.last >= trig.triggerPrice : t.last <= trig.triggerPrice;
      if (!hit) continue;
      this.triggers.delete(trig.id);   // scoatem imediat — nu tragem de două ori
      this.#pushTriggers();
      this.#fireTrigger(trig).catch((e) => {
        this.broadcast({ type: 'triggerError', trigger: trig, message: e.message });
      });
    }
  }

  async #fireTrigger(trig) {
    const result = trig.orderType === 'LIMIT'
      ? await this.limitOffset(trig.side, trig.qty, {
          offsetTicks: trig.offsetTicks, offsetUsd: trig.offsetUsd, tif: trig.tif || 'GTC',
          clientOrderId: trig.id, autoSl: trig.autoSl,
        })
      : await this.marketOrder(trig.side, trig.qty, { clientOrderId: trig.id, autoSl: trig.autoSl });
    this.broadcast({ type: 'triggerFired', trigger: trig });
    return result;
  }

  // ── Plasare ordine (toate trec prin WS-API) ──
  // clientOrderId vine din UI → permite UI-ul optimist să împerecheze confirmarea.
  async placeOrder({ side, type, qty, price, stopPrice, tif, reduceOnly, clientOrderId, skipRisk }) {
    if (!this.symbol) throw new Error('Niciun simbol selectat.');
    qty = this.roundQty(qty);
    if (qty <= 0) throw new Error('Cantitate zero după rotunjire.');
    const ref = price || this.#price().last;
    if (!skipRisk && !reduceOnly) this.#riskCheck(qty, ref);

    const params = {
      symbol: this.symbol,
      side,
      type,
      quantity: qty,
      newClientOrderId: clientOrderId,
    };
    if (type === 'LIMIT') {
      params.price = this.roundPrice(price);
      params.timeInForce = tif || 'GTC';
    }
    if (type === 'STOP_MARKET' || type === 'TAKE_PROFIT_MARKET') {
      params.stopPrice = this.roundPrice(stopPrice);
    }
    if (type === 'STOP_LOSS' || type === 'TAKE_PROFIT') {
      // variantele spot (devin MARKET când se atinge stopPrice)
      params.stopPrice = this.roundPrice(stopPrice);
    }
    if (this.isFutures && reduceOnly) params.reduceOnly = 'true';

    // Futures: STOP_MARKET/TAKE_PROFIT_MARKET (și celelalte "algo orders") nu
    // sunt acceptate de order.place pe WS-API (eroare -4120 — "use the Algo
    // Order API endpoints instead") — Binance le rutează doar prin REST.
    const isFuturesAlgo = this.isFutures
      && ['STOP', 'STOP_MARKET', 'TAKE_PROFIT', 'TAKE_PROFIT_MARKET', 'TRAILING_STOP_MARKET'].includes(type);
    if (isFuturesAlgo) return this.rest.signed('POST', '/fapi/v1/order', params);

    // ★ Restul ordinelor pleacă pe conexiunea WS deja autentificată — latență minimă.
    return this.wsApi.request('order.place', params);
  }

  // MARKET instant. Metodele publice (marketOrder/limitOffset/closePercent/
  // scale/reverse/stopOrTp/flatten) sunt serializate prin #serial() — cele
  // interne "*Raw" NU se reserializează singure, ca să nu se blocheze
  // reciproc când o metodă publică cheamă alta pe dedesubt (ex. closePercent
  // → #marketOrderRaw, nu → marketOrder).
  marketOrder(side, qty, opts = {}) {
    return this.#serial(() => this.#marketOrderRaw(side, qty, opts));
  }

  async #marketOrderRaw(side, qty, opts = {}) {
    const { autoSl, ...rest } = opts;
    // SL automat — DOAR dacă utilizatorul a bifat explicit căsuța (implicit
    // OFF, niciodată din oficiu) și DOAR pentru o intrare reală (nu pt.
    // reduceOnly, ca să nu se declanșeze la Scale Out / Close, care trec tot
    // pe aici). Înregistrăm AȘTEPTAREA fill-ului ÎNAINTE de a trimite
    // ordinul — fill-ul (pe user stream) și ack-ul order.place (pe altă
    // conexiune WS) NU au ordine garantată între ele; pe Live, unde execuția
    // e aproape instantă, fill-ul poate ajunge ÎNAINTE de ack — dacă am
    // începe să ascultăm abia după await placeOrder(), am rata evenimentul
    // și am aștepta degeaba până la timeout, deși poziția chiar s-a deschis.
    const waitFill = (autoSl && this.isFutures && !rest.reduceOnly && rest.clientOrderId)
      ? this.#waitFill(rest.clientOrderId)
      : null;
    const result = await this.placeOrder({ side, type: 'MARKET', qty, ...rest });
    // Rulează în ACELAȘI lanț serializat, ca o acțiune imediat următoare
    // (ex. Close All) să aștepte și SL-ul automat.
    if (waitFill) {
      await this.#autoSlAfterFill(side, waitFill, autoSl).catch((e) => {
        this.broadcast({ type: 'autoSlError', message: e.message });
      });
    }
    return result;
  }

  async #autoSlAfterFill(entrySide, waitFillPromise, autoSlOpts) {
    const filledOrder = await waitFillPromise;
    await this.#placeAutoSl(entrySide, filledOrder, autoSlOpts);
  }

  async #placeAutoSl(entrySide, filledOrder, { mode, value }) {
    const avgPrice = filledOrder.avgPrice || filledOrder.price;
    const qty = filledOrder.filled;
    if (!avgPrice || !qty) throw new Error('N-am prețul de execuție pentru SL automat.');
    const long = entrySide === 'BUY';
    const f = this.filters[this.symbol];
    let stopPrice;
    if (mode === 'price') {
      stopPrice = this.roundPrice(value);
    } else {
      const delta = mode === 'pct' ? avgPrice * (value / 100) : value * (f?.tickSize || 0);
      stopPrice = long ? avgPrice - delta : avgPrice + delta;
    }
    const side = long ? 'SELL' : 'BUY';
    await this.placeOrder({
      side, qty: this.roundQty(qty), stopPrice, reduceOnly: true, skipRisk: true,
      type: 'STOP_MARKET', clientOrderId: `${filledOrder.clientOrderId || Date.now()}_asl`,
    });
  }

  // LIMIT la prețul curent ± offset (în tick-uri sau dolari)
  limitOffset(side, qty, opts) {
    return this.#serial(() => this.#limitOffsetRaw(side, qty, opts));
  }

  async #limitOffsetRaw(side, qty, { offsetTicks = 0, offsetUsd = 0, tif = 'GTC', autoSl, clientOrderId }) {
    const t = this.#price();
    const f = this.filters[this.symbol];
    // BUY pornește de la ask, SELL de la bid (agresiv dar controlat).
    const base = side === 'BUY' ? t.ask : t.bid;
    const dir = side === 'BUY' ? 1 : -1;
    const offset = offsetUsd + offsetTicks * (f?.tickSize || 0);
    const price = base + dir * offset;
    // Înregistrăm așteptarea ÎNAINTE de a trimite ordinul — un LIMIT
    // agresiv (ex. peste ask la BUY) se poate umple la fel de instant ca un
    // MARKET, deci aceeași cursă fill-vs-ack există și aici.
    const waitFill = (autoSl && this.isFutures && clientOrderId)
      ? this.#waitFill(clientOrderId, 6 * 60 * 60 * 1000)
      : null;
    const result = await this.placeOrder({ side, type: 'LIMIT', qty, price, tif, clientOrderId });
    // Spre deosebire de MARKET, un LIMIT poate sta neumplut minute/ore — NU
    // așteptăm aici (ar bloca toată coada #serial, ex. un Close All ulterior
    // ar aștepta după acest fill nedeterminat). Rulează în fundal, cu un
    // timeout mult mai generos; dacă între timp anulezi ordinul, #waitFill
    // se respinge curat prin evenimentul CANCELED, fără SL rămas agățat.
    if (waitFill) {
      this.#autoSlAfterFill(side, waitFill, autoSl).catch((e) => {
        this.broadcast({ type: 'autoSlError', message: e.message });
      });
    }
    return result;
  }

  // Închide un procent din poziție la market (50% = Sell Half, 100% = Close).
  closePercent(pct, clientOrderId) {
    return this.#serial(() => this.#closePercentRaw(pct, clientOrderId));
  }

  async #closePercentRaw(pct, clientOrderId) {
    if (pct !== 100) {
      // Reîmprospătăm poziția reală de pe cont — vezi nota din #stopOrTpRaw:
      // fără evenimente de user stream, cache-ul local nu se mai actualizează
      // singur după un trade, deci am crede greșit că nu ai poziție.
      await this.refreshAccount().catch(() => {});
      const posQty = this.position.qty;
      if (Math.abs(posQty) < 1e-12) throw new Error('Nu ai poziție deschisă.');
      const qty = this.roundQty(Math.abs(posQty) * (pct / 100));
      if (qty <= 0) throw new Error('Cantitate prea mică de închis.');
      const side = posQty > 0 ? 'SELL' : 'BUY';
      return this.#marketOrderRaw(side, qty, { reduceOnly: true, skipRisk: true, clientOrderId });
    }

    // Închidere COMPLETĂ: repetăm "reîmprospătează poziția reală → închide
    // ce a rămas" de câteva ori, nu o singură dată. Un singur refresh nu
    // ajunge dacă ai dat Scale In / Buy chiar înainte — Binance are un mic
    // decalaj intern între "ordinul e confirmat" și "poziția e vizibilă
    // prin REST", deci primul refresh poate încă arăta poziția veche.
    // Verificăm din nou după FIECARE închidere, până rămâne efectiv 0.
    let result;
    for (let attempt = 0; attempt < 4; attempt++) {
      await this.refreshAccount().catch(() => {});
      const posQty = this.position.qty;
      if (Math.abs(posQty) < 1e-12) {
        if (attempt === 0) throw new Error('Nu ai poziție deschisă.');
        break;
      }
      const qty = this.roundQtyNearest(Math.abs(posQty));
      if (qty <= 0) break;
      const side = posQty > 0 ? 'SELL' : 'BUY';
      result = await this.#marketOrderRaw(side, qty, {
        reduceOnly: true, skipRisk: true,
        clientOrderId: attempt === 0 ? clientOrderId : `${clientOrderId}_r${attempt}`,
      });
    }
    return result;
  }

  // Scale in/out: mărește/reduce poziția cu un procent din mărimea curentă.
  scale(pct, clientOrderId) {
    return this.#serial(() => this.#scaleRaw(pct, clientOrderId));
  }

  async #scaleRaw(pct, clientOrderId) {
    await this.refreshAccount().catch(() => {});
    const posQty = this.position.qty;
    if (Math.abs(posQty) < 1e-12) throw new Error('Nu ai poziție de scalat.');
    const qty = this.roundQty(Math.abs(posQty) * (Math.abs(pct) / 100));
    if (qty <= 0) throw new Error('Cantitate prea mică.');
    const increasing = pct > 0;
    const side = (posQty > 0) === increasing ? 'BUY' : 'SELL';
    return this.#marketOrderRaw(side, qty, {
      reduceOnly: !increasing, skipRisk: false, clientOrderId,
    });
  }

  // Reverse: închide poziția și deschide una egală în direcția opusă.
  reverse(clientOrderId) {
    return this.#serial(() => this.#reverseRaw(clientOrderId));
  }

  async #reverseRaw(clientOrderId) {
    await this.refreshAccount().catch(() => {});
    const posQty = this.position.qty;
    if (Math.abs(posQty) < 1e-12) throw new Error('Nu ai poziție de inversat.');
    const side = posQty > 0 ? 'SELL' : 'BUY';
    if (this.isFutures) {
      // Pe futures un singur ordin de 2× mărimea inversează direct.
      const qty = this.roundQty(Math.abs(posQty) * 2);
      return this.#marketOrderRaw(side, qty, { skipRisk: true, clientOrderId });
    }
    // Pe spot nu există short — doar închidem.
    return this.#closePercentRaw(100, clientOrderId);
  }

  // Stop Loss / Take Profit rapid, la % sau ticks față de entry — sau la un
  // preț exact (price), la fel ca la intrarea condiționată: e tot un
  // "trigger" în sensul cerut, doar că aici Binance îl ține el însuși ca
  // ordin STOP_MARKET/TAKE_PROFIT_MARKET real (mai sigur — se declanșează
  // chiar dacă panelul e oprit, nu depinde de un poll al nostru).
  stopOrTp(kind, opts, clientOrderId) {
    return this.#serial(() => this.#stopOrTpRaw(kind, opts, clientOrderId));
  }

  async #stopOrTpRaw(kind, { pct = 0, ticks = 0, price = null }, clientOrderId) {
    // Reîmprospătăm poziția reală de pe cont înainte de verificare — fără
    // evenimente de user stream (poate lipsi pe unele conturi, vezi §4.2),
    // cache-ul local nu se mai actualizează singur după un trade, deci
    // panelul ar crede greșit că nu ai poziție deschisă deși ai.
    await this.refreshAccount().catch(() => {});
    const posQty = this.position.qty;
    if (Math.abs(posQty) < 1e-12) throw new Error('Nu ai poziție deschisă.');
    const entry = this.position.entry || this.#price().last;
    const f = this.filters[this.symbol];
    const long = posQty > 0;
    let stopPrice;
    if (price != null) {
      stopPrice = this.roundPrice(price);
    } else {
      // SL: sub entry pt long / peste pt short. TP: invers.
      const dir = (kind === 'sl') === long ? -1 : 1;
      const delta = entry * (pct / 100) + ticks * (f?.tickSize || 0);
      stopPrice = entry + dir * delta;
    }
    const side = long ? 'SELL' : 'BUY';
    const qty = this.roundQty(Math.abs(posQty));
    if (this.isFutures) {
      return this.placeOrder({
        side, qty, stopPrice, clientOrderId, reduceOnly: true, skipRisk: true,
        type: kind === 'sl' ? 'STOP_MARKET' : 'TAKE_PROFIT_MARKET',
      });
    }
    return this.placeOrder({
      side, qty, stopPrice, clientOrderId, skipRisk: true,
      type: kind === 'sl' ? 'STOP_LOSS' : 'TAKE_PROFIT',
    });
  }

  // Anulează un ordin individual.
  cancelOrder(orderId) {
    return this.wsApi.request('order.cancel', { symbol: this.symbol, orderId: Number(orderId) });
  }

  // Anulează TOATE ordinele pe simbol — și cele reale de pe Binance, și
  // trigger-ele software (alea nu sunt ordine reale până nu se declanșează,
  // deci allOpenOrders/cancelAll de la Binance nu le "vede" deloc).
  async cancelAll() {
    if (!this.symbol) return;
    if (this.isFutures) {
      // Futures WS-API nu are cancel-all → REST (operațiune rară, ok).
      await this.rest.signed('DELETE', '/fapi/v1/allOpenOrders', { symbol: this.symbol });
    } else {
      await this.wsApi.request('openOrders.cancelAll', { symbol: this.symbol });
    }
    this.openOrders.clear();
    this.#pushOrders();
    this.triggers.clear();
    this.#pushTriggers();
  }

  // ★ KILL / Flatten All: anulează tot + închide poziția, în paralel.
  // Încercăm mereu închiderea (nu doar dacă cache-ul crede că ai poziție —
  // #closePercentRaw(100) își reîmprospătează singur poziția reală înainte
  // de calcul); ignorăm doar eroarea benignă "n-ai poziție" dacă chiar ești flat.
  flatten(clientOrderId) {
    return this.#serial(() => this.#flattenRaw(clientOrderId));
  }

  async #flattenRaw(clientOrderId) {
    const jobs = [
      this.cancelAll().catch((e) => console.error('[flatten/cancel]', e.message)),
      this.#closePercentRaw(100, clientOrderId).catch((e) => {
        if (!/Nu ai poziție/.test(e.message)) console.error('[flatten/close]', e.message);
      }),
    ];
    await Promise.all(jobs);
  }

  // Futures: leverage + margin type.
  async setLeverage(leverage) {
    if (!this.isFutures) throw new Error('Leverage e doar pe Futures.');
    return this.rest.signed('POST', '/fapi/v1/leverage', { symbol: this.symbol, leverage });
  }

  async setMarginType(marginType) {
    if (!this.isFutures) throw new Error('Margin type e doar pe Futures.');
    try {
      return await this.rest.signed('POST', '/fapi/v1/marginType', { symbol: this.symbol, marginType });
    } catch (e) {
      if (e.code === -4046) return { msg: 'Deja setat.' }; // "No need to change margin type"
      throw e;
    }
  }
}
