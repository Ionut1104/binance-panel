// ═══════════════════════════════════════════════════════════════════
// App — leagă totul: starea live, acțiunile de trading cu UI optimist,
// hotkey-urile globale și layout-ul pe un singur ecran.
// ═══════════════════════════════════════════════════════════════════
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { onMessage, onConnState, send, newClientOrderId } from './ws.js';
import { loadHotkeys, saveHotkeys, eventToCombo } from './hotkeys.js';
import { sounds } from './sounds.js';
import StatusBar from './components/StatusBar.jsx';
import SymbolBar from './components/SymbolBar.jsx';
import TradePanel from './components/TradePanel.jsx';
import PositionCard from './components/PositionCard.jsx';
import OrdersTable from './components/OrdersTable.jsx';
import SettingsModal from './components/SettingsModal.jsx';
import Toasts from './components/Toasts.jsx';

// Preferințe locale de UI (size, offseturi...) — persistă în localStorage.
function loadPrefs() {
  const def = {
    sizeMode: 'usd', sizeValue: 100, fixedPresets: [100, 250, 500],
    offsetMode: 'ticks', offsetValue: 5, scalePct: 50, closePct: 50,
    slMode: 'pct', slValue: 0.5, tpMode: 'pct', tpValue: 1,
    autoSl: false,   // NICIODATĂ automat decât dacă bifezi explicit tu
    confirm: false,
  };
  try { return { ...def, ...JSON.parse(localStorage.getItem('prefs') || '{}') }; }
  catch { return def; }
}

let toastId = 1;

export default function App() {
  const [uiConn, setUiConn] = useState('reconnecting');
  const [status, setStatus] = useState({});
  const [settings, setSettings] = useState(null);
  const [symbol, setSymbol] = useState(null);
  const [filters, setFilters] = useState(null);
  const [ticker, setTicker] = useState(null);
  const [balances, setBalances] = useState({});
  const [position, setPosition] = useState({ qty: 0, entry: 0 });
  const [orders, setOrders] = useState([]);
  const [pendingOrders, setPendingOrders] = useState([]);
  const [triggers, setTriggers] = useState([]);
  const [symbols, setSymbols] = useState([]);
  const [toasts, setToasts] = useState([]);
  const [showSettings, setShowSettings] = useState(false);
  const [prefs, setPrefsState] = useState(loadPrefs);
  const [hotkeys, setHotkeys] = useState(loadHotkeys);
  const [leverage, setLeverageState] = useState(10);
  const [marginType, setMarginTypeState] = useState('ISOLATED');
  const [triggerPrice, setTriggerPrice] = useState('');
  const [triggerType, setTriggerType] = useState('MARKET');
  const searchRef = useRef(null);

  const setPrefs = useCallback((updater) => {
    setPrefsState((p) => {
      const next = typeof updater === 'function' ? updater(p) : updater;
      localStorage.setItem('prefs', JSON.stringify(next));
      return next;
    });
  }, []);

  // Refs ca handler-ele (hotkeys, mesaje) să vadă mereu valorile curente.
  const ref = useRef({});
  ref.current = { symbol, filters, ticker, balances, position, prefs, settings, orders, leverage, triggerPrice, triggerType };

  const toast = useCallback((kind, text, sub) => {
    const id = toastId++;
    setToasts((t) => [...t.slice(-4), { id, kind, text, sub }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);

  // ── Mesajele push de la backend ──
  useEffect(() => {
    onConnState(setUiConn);
    return onMessage((m) => {
      switch (m.type) {
        case 'status': setStatus(m.status); break;
        case 'settings':
          setSettings(m.settings);
          // După (re)conectare cerem lista de simboluri + selectăm primul favorit.
          if (m.settings.hasKeys) {
            send('symbols.list').then(setSymbols).catch(() => {});
            const fav = m.settings.favorites?.[0];
            if (fav && !ref.current.symbol) send('symbol.set', { symbol: fav }).catch(() => {});
          }
          break;
        case 'symbol':
          setSymbol(m.symbol); setFilters(m.filters); setPendingOrders([]); setTriggers([]);
          // Levier auto-maxim setat de backend la schimbarea perechii (vezi session.js).
          if (m.leverage && m.leverage !== ref.current.leverage) {
            setLeverageState(m.leverage);
            toast('ok', `⚡ Levier auto: ${m.leverage}×`, m.symbol);
          }
          break;
        case 'ticker': if (m.symbol === ref.current.symbol) setTicker(m); break;
        case 'account': setBalances(m.balances); setPosition(m.position); break;
        case 'orders': setOrders(m.orders); break;
        case 'triggers': setTriggers(m.triggers); break;
        case 'triggerFired':
          sounds.sent();
          toast('info', `⚡ Trigger atins: ${m.trigger.side} @ ${m.trigger.triggerPrice}`, m.trigger.symbol);
          break;
        case 'triggerError':
          sounds.error();
          toast('error', `✗ Trigger ${m.trigger.side} respins`, m.message);
          break;
        case 'autoSlError':
          sounds.error();
          toast('error', '✗ SL automat eșuat', m.message);
          break;
        case 'orderUpdate': {
          // Confirmarea reală a unui ordin — împerechem cu cel optimist.
          setPendingOrders((p) => p.filter((x) => x.clientOrderId !== m.order.clientOrderId));
          if (m.order.status === 'FILLED') {
            sounds.fill();
            toast('fill', `✓ FILL ${m.order.side} ${m.lastQty || m.order.filled} @ ${m.lastPrice || ''}`,
              m.order.symbol);
          } else if (m.order.status === 'REJECTED' || m.order.status === 'EXPIRED') {
            sounds.error();
            toast('error', `✗ ${m.order.status} ${m.order.side} ${m.order.type}`, m.order.symbol);
          } else if (m.order.status === 'CANCELED') {
            sounds.cancel();
          }
          break;
        }
      }
    });
  }, [toast]);

  // ── Calculul cantității din setarea de size ──
  const computeQty = useCallback(() => {
    const { prefs, ticker } = ref.current;
    if (!ticker) throw new Error('Aștept prețul live…');
    if (prefs.sizeMode === 'qty') return prefs.sizeValue;
    return prefs.sizeValue / ticker.last; // USDT → cantitate la prețul curent
  }, []);

  // ── Intrare condiționată de preț: "cumpără/vinde doar când ajunge la X" ──
  const placeTrigger = useCallback((side, triggerPrice, orderType) => {
    const { prefs } = ref.current;
    try {
      const price = parseFloat(triggerPrice);
      if (!price || price <= 0) throw new Error('Preț trigger invalid.');
      const qty = computeQty();
      const offsetTicks = prefs.offsetMode === 'ticks' ? prefs.offsetValue : 0;
      const offsetUsd = prefs.offsetMode === 'usd' ? prefs.offsetValue : 0;
      const autoSl = prefs.autoSl ? { mode: prefs.slMode, value: prefs.slValue } : undefined;
      const clientOrderId = newClientOrderId();
      send('trigger.place', { side, qty, triggerPrice: price, orderType, offsetTicks, offsetUsd, autoSl, clientOrderId })
        .then(() => toast('ok', `⏳ Trigger setat: ${side} @ ${price}`, ref.current.symbol))
        .catch((e) => { sounds.error(); toast('error', '✗ Trigger eșuat', e.message); });
    } catch (e) {
      toast('error', '✗ Eroare', e.message);
    }
  }, [computeQty, toast]);

  // ── Dispatcher-ul central de acțiuni (butoane ȘI hotkeys) ──
  const act = useCallback(async (name, extra = {}) => {
    const { prefs, position, balances, filters, ticker, settings } = ref.current;
    try {
      // Preset % din balanță → doar setează size-ul, nu execută.
      if (name === 'sizePctBalance') {
        const quote = filters?.quoteAsset || 'USDT';
        const free = balances?.[quote]?.free || 0;
        setPrefs((p) => ({ ...p, sizeMode: 'usd', sizeValue: Math.floor(free * extra.pct) / 100 }));
        return;
      }
      if (name === 'focusSearch') { searchRef.current?.focus(); return; }
      if (name === 'buyTrigger' || name === 'sellTrigger') {
        const { triggerPrice, triggerType } = ref.current;
        if (!triggerPrice) return;
        placeTrigger(name === 'buyTrigger' ? 'BUY' : 'SELL', triggerPrice, triggerType);
        setTriggerPrice('');
        return;
      }

      // Confirmarea opțională (toggle) — nimic blocant dacă e oprită.
      const descr = {
        buyMarket: 'BUY MARKET', sellMarket: 'SELL MARKET',
        buyLimit: 'BUY LIMIT', sellLimit: 'SELL LIMIT',
        sellHalf: `SELL ${prefs.closePct}%`, closeAll: 'CLOSE ALL', reverse: 'REVERSE',
        scaleIn: 'SCALE IN', scaleOut: 'SCALE OUT', flatten: 'KILL / FLATTEN',
        stopLoss: 'STOP LOSS', takeProfit: 'TAKE PROFIT', cancelAll: 'CANCEL ALL',
      }[name] || name;
      if (prefs.confirm && !window.confirm(`Confirmi: ${descr} pe ${ref.current.symbol}?`)) return;

      const clientOrderId = newClientOrderId();
      const offsetTicks = prefs.offsetMode === 'ticks' ? prefs.offsetValue : 0;
      const offsetUsd = prefs.offsetMode === 'usd' ? prefs.offsetValue : 0;
      // SL și TP au acum valori SEPARATE (înainte era un singur câmp comun).
      const slParams = prefs.slMode === 'pct' ? { pct: prefs.slValue, ticks: 0 }
        : prefs.slMode === 'ticks' ? { pct: 0, ticks: prefs.slValue }
        : { pct: 0, ticks: 0, price: prefs.slValue };
      const tpParams = prefs.tpMode === 'pct' ? { pct: prefs.tpValue, ticks: 0 }
        : prefs.tpMode === 'ticks' ? { pct: 0, ticks: prefs.tpValue }
        : { pct: 0, ticks: 0, price: prefs.tpValue };

      // Construim promisiunea + starea optimistă pentru fiecare acțiune.
      let promise, optimistic = null;
      switch (name) {
        case 'buyMarket': case 'sellMarket': {
          const side = name === 'buyMarket' ? 'BUY' : 'SELL';
          const qty = computeQty();
          optimistic = { clientOrderId, side, type: 'MARKET', qty };
          // SL automat DOAR dacă ai bifat explicit căsuța din panel.
          const autoSl = prefs.autoSl ? { mode: prefs.slMode, value: prefs.slValue } : undefined;
          promise = send('order.market', { side, qty, clientOrderId, autoSl });
          break;
        }
        case 'buyLimit': case 'sellLimit': {
          const side = name === 'buyLimit' ? 'BUY' : 'SELL';
          const qty = computeQty();
          const base = side === 'BUY' ? ticker?.ask : ticker?.bid;
          optimistic = { clientOrderId, side, type: 'LIMIT', qty, price: base };
          const autoSl = prefs.autoSl ? { mode: prefs.slMode, value: prefs.slValue } : undefined;
          promise = send('order.limitOffset', { side, qty, offsetTicks, offsetUsd, clientOrderId, autoSl });
          break;
        }
        case 'sellHalf':
          promise = send('position.closePct', { pct: prefs.closePct, clientOrderId }); break;
        case 'closeAll':
          promise = send('position.closePct', { pct: 100, clientOrderId }); break;
        case 'scaleIn':
          promise = send('position.scale', { pct: prefs.scalePct, clientOrderId }); break;
        case 'scaleOut':
          promise = send('position.scale', { pct: -prefs.scalePct, clientOrderId }); break;
        case 'reverse':
          promise = send('position.reverse', { clientOrderId }); break;
        case 'stopLoss':
          promise = send('position.stopTp', { kind: 'sl', ...slParams, clientOrderId }); break;
        case 'takeProfit':
          promise = send('position.stopTp', { kind: 'tp', ...tpParams, clientOrderId }); break;
        case 'cancelAll':
          promise = send('order.cancelAll'); break;
        case 'flatten':
          promise = send('flatten', { clientOrderId }); break;
        default: return;
      }

      // ★ UI OPTIMIST: afișăm INSTANT acțiunea, ordinul zboară în paralel.
      sounds.sent();
      toast('info', `→ ${descr}`, ref.current.symbol);
      if (optimistic) setPendingOrders((p) => [...p, optimistic]);

      // Confirmarea/eroarea reală actualizează UI-ul când sosește.
      promise
        .then(() => {
          if (name === 'cancelAll') { sounds.cancel(); toast('ok', '✓ Ordine anulate'); }
          if (name === 'flatten') toast('ok', '✓ FLATTEN trimis');
        })
        .catch((e) => {
          // Eroare de la Binance (fonduri, minim, market închis...) — vizibilă, nu în consolă.
          sounds.error();
          if (optimistic) setPendingOrders((p) => p.filter((x) => x.clientOrderId !== clientOrderId));
          toast('error', `✗ ${descr} respins`, e.message + (e.code ? ` (cod ${e.code})` : ''));
        });
    } catch (e) {
      sounds.error();
      toast('error', '✗ Eroare', e.message);
    }
  }, [computeQty, setPrefs, toast, placeTrigger]);

  // ── Hotkeys globale ──
  useEffect(() => {
    const h = (e) => {
      // Nu interceptăm tastele simple când scrii într-un input (ex. "b" ar
      // trage BUY MARKET din greșeală) — dar combinațiile cu Ctrl/Alt (ex.
      // Ctrl+B pt. trigger) nu apar niciodată în text tastat normal, deci le
      // lăsăm să treacă și din câmpul de preț (Tab acolo → completează
      // prețul curent → Ctrl+B/Ctrl+S fără să dai click în altă parte).
      const tag = document.activeElement?.tagName;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) && !e.ctrlKey && !e.altKey) return;
      const combo = eventToCombo(e);
      // 1–9 → favorite (schimbare instant de simbol)
      if (/^[1-9]$/.test(combo)) {
        const fav = ref.current.settings?.favorites?.[parseInt(combo) - 1];
        if (fav) { e.preventDefault(); selectSymbol(fav); }
        return;
      }
      const action = Object.entries(hotkeys).find(([, c]) => c === combo)?.[0];
      if (action) { e.preventDefault(); act(action); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [hotkeys, act]);

  // ── Schimbarea simbolului (search sau favorite) ──
  const selectSymbol = useCallback((s) => {
    setTicker(null);
    send('symbol.set', { symbol: s })
      .catch((e) => toast('error', '✗ Simbol', e.message));
  }, [toast]);

  const cancelOrder = useCallback((orderId) => {
    send('order.cancel', { orderId })
      .then(() => sounds.cancel())
      .catch((e) => { sounds.error(); toast('error', '✗ Cancel eșuat', e.message); });
  }, [toast]);

  const cancelTrigger = useCallback((id) => {
    send('trigger.cancel', { id })
      .catch((e) => toast('error', '✗ Cancel trigger eșuat', e.message));
  }, [toast]);

  const setLeverage = useCallback((l) => {
    setLeverageState(l);
    send('futures.leverage', { leverage: l })
      .then(() => toast('ok', `Leverage ${l}×`))
      .catch((e) => toast('error', '✗ Leverage', e.message));
  }, [toast]);

  const setMarginType = useCallback((mt) => {
    setMarginTypeState(mt);
    send('futures.marginType', { marginType: mt })
      .then(() => toast('ok', `Margin: ${mt}`))
      .catch((e) => toast('error', '✗ Margin type', e.message));
  }, [toast]);

  const saveAll = useCallback(({ patch, hotkeys: hk, prefs: pf }) => {
    setHotkeys(hk); saveHotkeys(hk);
    if (pf.fixedPresets?.length) setPrefs((p) => ({ ...p, fixedPresets: pf.fixedPresets }));
    send('settings.save', { patch })
      .then(() => { toast('ok', '✓ Setări salvate — reconectez'); setShowSettings(false); })
      .catch((e) => toast('error', '✗ Salvare eșuată', e.message));
  }, [setPrefs, toast]);

  const isFutures = settings?.market === 'futures';

  return (
    <div className="app">
      <div className="card topbar">
        <SymbolBar symbols={symbols} symbol={symbol}
                   favorites={settings?.favorites || []}
                   onSelect={selectSymbol} searchRef={searchRef} />
        <div className="price">
          {ticker ? ticker.last.toLocaleString('en-US', {
            minimumFractionDigits: filters?.pricePrecision ?? 2,
            maximumFractionDigits: filters?.pricePrecision ?? 2,
          }) : '—'}
          <span className="ba">{symbol || 'niciun simbol'}</span>
        </div>
        <StatusBar uiConn={uiConn} status={status} settings={settings}
                   onOpenSettings={() => setShowSettings(true)} />
      </div>

      <TradePanel prefs={prefs} setPrefs={setPrefs} hotkeys={hotkeys} act={act}
                  isFutures={isFutures}
                  leverage={leverage} setLeverage={setLeverage}
                  marginType={marginType} setMarginType={setMarginType}
                  ticker={ticker} filters={filters} onSetTrigger={placeTrigger}
                  triggerPrice={triggerPrice} setTriggerPrice={setTriggerPrice}
                  triggerType={triggerType} setTriggerType={setTriggerType} />

      <PositionCard position={position} balances={balances} ticker={ticker}
                    filters={filters} settings={settings} />

      <OrdersTable orders={orders} pendingOrders={pendingOrders}
                   triggers={triggers} onCancelTrigger={cancelTrigger}
                   filters={filters} onCancel={cancelOrder} />

      {showSettings && (
        <SettingsModal settings={settings} prefs={prefs} hotkeys={hotkeys}
                       onSave={saveAll} onClose={() => setShowSettings(false)} />
      )}
      {!settings?.hasKeys && settings && !showSettings && (
        <div className="overlay">
          <div className="modal" style={{ textAlign: 'center' }}>
            <h2>Bine ai venit 👋</h2>
            <p style={{ margin: '10px 0', color: 'var(--muted)' }}>
              Introdu cheile API Binance (Testnet recomandat la început) ca să pornim.
            </p>
            <button className="save" onClick={() => setShowSettings(true)}>Deschide Setările</button>
          </div>
        </div>
      )}
      <Toasts toasts={toasts} />
    </div>
  );
}
