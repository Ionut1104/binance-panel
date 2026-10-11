// Grid-ul de butoane de execuție — inima panelului.
// Fiecare buton afișează hotkey-ul lui. Toate acțiunile trec prin act().
import React from 'react';
import { comboLabel } from '../hotkeys.js';

export default function TradePanel({
  prefs, setPrefs, hotkeys, act, isFutures, leverage, setLeverage, marginType, setMarginType,
  ticker, filters, onSetTrigger,
  triggerPrice, setTriggerPrice, triggerType, setTriggerType,
}) {
  const hk = (name) => <span className="hk">{comboLabel(hotkeys[name])}</span>;
  const upd = (patch) => setPrefs((p) => ({ ...p, ...patch }));

  // Execuție pe mousedown, nu pe click (= mouseup): ordinul pleacă la
  // APĂSAREA butonului, nu la eliberare — se câștigă durata unui click uman
  // (~60-100ms) la fiecare execuție. Butoanele rămân fără onClick, ca să nu
  // tragă ordinul de două ori.
  const fire = (fn) => (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    fn();
  };

  // ── Intrare condiționată de preț: setezi un preț țintă, ordinul pleacă
  // abia când prețul live îl atinge (util pt. intrare pe breakout, ex:
  // preț acum 0.58, vrei să intri doar dacă ajunge la 0.6). Starea
  // (triggerPrice/Type) e ridicată în App, ca hotkey-urile Ctrl+B/Ctrl+S
  // să poată trage aceleași butoane fără mouse. ──
  const fireTrigger = (side) => {
    if (!triggerPrice) return;
    onSetTrigger(side, triggerPrice, triggerType);
    setTriggerPrice('');
  };

  // Tab (sau click) în câmpul de preț, dacă e gol → îl umple cu prețul
  // curent, ca să pornești de acolo în loc să-l bați manual.
  const fillCurrentPrice = () => {
    if (triggerPrice || !ticker) return;
    const p = filters?.pricePrecision != null ? ticker.last.toFixed(filters.pricePrecision) : ticker.last;
    setTriggerPrice(String(p));
  };

  return (
    <div className="card tradepanel">
      {/* ── Size: USDT sau cantitate + preseturi ── */}
      <div className="row">
        <label>Size</label>
        <input type="number" min="0" step="any" value={prefs.sizeValue}
               onChange={(e) => upd({ sizeValue: parseFloat(e.target.value) || 0 })} />
        <button className="minibtn"
                onClick={() => upd({ sizeMode: prefs.sizeMode === 'usd' ? 'qty' : 'usd' })}>
          {prefs.sizeMode === 'usd' ? 'USDT ⇄' : 'QTY ⇄'}
        </button>
        <span className="presets">
          {[25, 50, 100].map((p) => (
            <button key={p} onClick={() => act('sizePctBalance', { pct: p })}>{p}%</button>
          ))}
          {prefs.fixedPresets.map((v) => (
            <button key={v} onClick={() => upd({ sizeMode: 'usd', sizeValue: v })}>${v}</button>
          ))}
        </span>
      </div>

      {/* ── Parametri: offset limit, scale %, close %, confirmare ── */}
      <div className="row">
        <label>Limit ±</label>
        <input type="number" step="any" style={{ width: 70 }} value={prefs.offsetValue}
               onChange={(e) => upd({ offsetValue: parseFloat(e.target.value) || 0 })} />
        <select value={prefs.offsetMode} onChange={(e) => upd({ offsetMode: e.target.value })}
                style={{ width: 75 }}>
          <option value="ticks">ticks</option>
          <option value="usd">$</option>
        </select>
        <label>Scale %</label>
        <input type="number" style={{ width: 60 }} value={prefs.scalePct}
               onChange={(e) => upd({ scalePct: parseFloat(e.target.value) || 0 })} />
        <label>Close %</label>
        <input type="number" style={{ width: 60 }} value={prefs.closePct}
               onChange={(e) => upd({ closePct: parseFloat(e.target.value) || 0 })} />
        <label className="switch">
          <input type="checkbox" checked={prefs.confirm}
                 onChange={(e) => upd({ confirm: e.target.checked })} />
          Confirmare
        </label>
      </div>

      {/* ── SL și TP — valori SEPARATE, fiecare cu %/ticks/preț exact ── */}
      <div className="row">
        <label>SL</label>
        <input type="number" step="any" style={{ width: 60 }} value={prefs.slValue}
               onChange={(e) => upd({ slValue: parseFloat(e.target.value) || 0 })} />
        <select value={prefs.slMode} onChange={(e) => upd({ slMode: e.target.value })}
                style={{ width: 75 }}>
          <option value="pct">%</option>
          <option value="ticks">ticks</option>
          <option value="price">preț</option>
        </select>
        <label>TP</label>
        <input type="number" step="any" style={{ width: 60 }} value={prefs.tpValue}
               onChange={(e) => upd({ tpValue: parseFloat(e.target.value) || 0 })} />
        <select value={prefs.tpMode} onChange={(e) => upd({ tpMode: e.target.value })}
                style={{ width: 75 }}>
          <option value="pct">%</option>
          <option value="ticks">ticks</option>
          <option value="price">preț</option>
        </select>
        {/* Implicit OFF — se activează DOAR dacă bifezi tu explicit.
            Când e bifat, orice intrare (MKT, LMT ±, sau trigger) primește
            automat un Stop Loss calculat din câmpul SL de mai sus, pe
            prețul REAL de execuție (nu pe cel presupus la trimitere). */}
        <label className="switch">
          <input type="checkbox" checked={prefs.autoSl}
                 onChange={(e) => upd({ autoSl: e.target.checked })} />
          SL automat la intrare
        </label>
      </div>

      {/* ── Futures: leverage + margin mode ── */}
      {isFutures && (
        <div className="row">
          <label>Leverage</label>
          <select value={leverage} onChange={(e) => setLeverage(parseInt(e.target.value))}
                  style={{ width: 70 }}>
            {/* Mereu include levierul curent al contului (ex. 150×) — altfel
                <select> nu îl găsește în listă și afișează prima opțiune (1×). */}
            {[...new Set([1, 2, 3, 5, 10, 20, 25, 50, 75, 100, 125, leverage])]
              .filter(Boolean).sort((a, b) => a - b).map((l) => (
                <option key={l} value={l}>{l}×</option>
              ))}
          </select>
          <label>Margin</label>
          <select value={marginType} onChange={(e) => setMarginType(e.target.value)}
                  style={{ width: 100 }}>
            <option value="ISOLATED">Isolated</option>
            <option value="CROSSED">Cross</option>
          </select>
        </div>
      )}

      {/* ── Intrare condiționată de preț: "cumpără/vinde doar dacă ajunge la X" ── */}
      <div className="row">
        <label>Intrare la preț</label>
        <input type="number" step="any" style={{ width: 90 }}
               placeholder={ticker
                 ? (filters?.pricePrecision != null ? ticker.last.toFixed(filters.pricePrecision) : String(ticker.last))
                 : 'preț'}
               value={triggerPrice}
               onFocus={fillCurrentPrice}
               onChange={(e) => setTriggerPrice(e.target.value)} />
        <select value={triggerType} onChange={(e) => setTriggerType(e.target.value)} style={{ width: 75 }}>
          <option value="MARKET">MKT</option>
          <option value="LIMIT">LMT ±</option>
        </select>
        <button className="btn buy" style={{ padding: '4px 10px' }}
                disabled={!triggerPrice} onMouseDown={fire(() => fireTrigger('BUY'))}>
          BUY @ trigger {hk('buyTrigger')}
        </button>
        <button className="btn sell" style={{ padding: '4px 10px' }}
                disabled={!triggerPrice} onMouseDown={fire(() => fireTrigger('SELL'))}>
          SELL @ trigger {hk('sellTrigger')}
        </button>
      </div>

      {/* ── Grid-ul de execuție ── */}
      <div className="grid">
        <button className="btn buy" onMouseDown={fire(() => act('buyMarket'))}>
          BUY MKT {hk('buyMarket')}
        </button>
        <button className="btn sell" onMouseDown={fire(() => act('sellMarket'))}>
          SELL MKT {hk('sellMarket')}
        </button>
        <button className="btn buy" onMouseDown={fire(() => act('buyLimit'))}>
          BUY LMT ± {hk('buyLimit')}
        </button>
        <button className="btn sell" onMouseDown={fire(() => act('sellLimit'))}>
          SELL LMT ± {hk('sellLimit')}
        </button>
        <button className="btn neutral" onMouseDown={fire(() => act('sellHalf'))}>
          SELL {prefs.closePct}% {hk('sellHalf')}
        </button>
        <button className="btn neutral" onMouseDown={fire(() => act('closeAll'))}>
          CLOSE ALL {hk('closeAll')}
        </button>
        <button className="btn neutral" onMouseDown={fire(() => act('scaleIn'))}>
          SCALE IN +{prefs.scalePct}% {hk('scaleIn')}
        </button>
        <button className="btn neutral" onMouseDown={fire(() => act('scaleOut'))}>
          SCALE OUT −{prefs.scalePct}% {hk('scaleOut')}
        </button>
        <button className="btn warn" onMouseDown={fire(() => act('stopLoss'))}>
          STOP LOSS {hk('stopLoss')}
        </button>
        <button className="btn warn" onMouseDown={fire(() => act('takeProfit'))}>
          TAKE PROFIT {hk('takeProfit')}
        </button>
        <button className="btn neutral" onMouseDown={fire(() => act('reverse'))}>
          REVERSE {hk('reverse')}
        </button>
        <button className="btn neutral" onMouseDown={fire(() => act('cancelAll'))}>
          CANCEL ALL {hk('cancelAll')}
        </button>
        {/* ★ Butonul mare roșu — închide tot, anulează tot, instant */}
        <button className="btn kill" onMouseDown={fire(() => act('flatten'))}>
          ⛔ KILL / FLATTEN ALL {hk('flatten')}
        </button>
      </div>
    </div>
  );
}
