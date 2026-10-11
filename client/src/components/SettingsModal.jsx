// Setări: chei API (trimise pe WS către backend, salvate criptat acolo),
// market/testnet, limite de risc, favorite, preseturi și REMAPARE HOTKEYS.
import React, { useState } from 'react';
import { DEFAULT_HOTKEYS, ACTION_LABELS, eventToCombo } from '../hotkeys.js';

export default function SettingsModal({ settings, prefs, hotkeys, onSave, onClose }) {
  const [form, setForm] = useState({
    apiKey: '', apiSecret: '',          // goale = păstrează cheile existente
    market: settings?.market || 'futures',
    testnet: settings?.testnet ?? true,
    maxOrderUsd: settings?.maxOrderUsd ?? 1000,
    maxPositionUsd: settings?.maxPositionUsd ?? 5000,
    favorites: (settings?.favorites || []).join(', '),
  });
  const [localPrefs, setLocalPrefs] = useState({
    fixedPresets: prefs.fixedPresets.join(', '),
  });
  const [hk, setHk] = useState({ ...hotkeys });
  const [capturing, setCapturing] = useState(null); // acțiunea pt care înregistrăm o tastă

  const f = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  // Apeși pe câmp → apeși combinația dorită → e capturată.
  const captureKey = (action) => (e) => {
    e.preventDefault();
    const combo = eventToCombo(e);
    if (!combo || ['shift', 'ctrl', 'alt'].includes(combo)) return;
    setHk({ ...hk, [action]: combo });
    setCapturing(null);
    e.target.blur();
  };

  const save = () => {
    onSave({
      patch: {
        ...(form.apiKey ? { apiKey: form.apiKey.trim() } : {}),
        ...(form.apiSecret ? { apiSecret: form.apiSecret.trim() } : {}),
        market: form.market,
        testnet: form.testnet,
        maxOrderUsd: parseFloat(form.maxOrderUsd) || 1000,
        maxPositionUsd: parseFloat(form.maxPositionUsd) || 5000,
        favorites: form.favorites.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
      },
      hotkeys: hk,
      prefs: {
        fixedPresets: localPrefs.fixedPresets.split(',')
          .map((s) => parseFloat(s.trim())).filter((n) => n > 0),
      },
    });
  };

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h2>⚙ Setări</h2>

        <div className="section">Conectare Binance</div>
        <div className="frow">
          <label>API Key {settings?.hasKeys ? `(salvată: ${settings.apiKey})` : ''}</label>
          <input type="password" placeholder={settings?.hasKeys ? 'nemodificat' : 'introdu API key'}
                 value={form.apiKey} onChange={f('apiKey')} />
        </div>
        <div className="frow">
          <label>API Secret</label>
          <input type="password" placeholder={settings?.hasKeys ? 'nemodificat' : 'introdu API secret'}
                 value={form.apiSecret} onChange={f('apiSecret')} />
        </div>
        <div className="frow">
          <label>Piață</label>
          <select value={form.market} onChange={f('market')}>
            <option value="spot">Spot</option>
            <option value="futures">Futures (USDT-M)</option>
          </select>
        </div>
        <div className="frow">
          <label>Mediu</label>
          <select value={String(form.testnet)}
                  onChange={(e) => setForm({ ...form, testnet: e.target.value === 'true' })}>
            <option value="true">Testnet (bani falși)</option>
            <option value="false">⚠ LIVE (bani reali)</option>
          </select>
        </div>

        <div className="section">Risc</div>
        <div className="frow">
          <label>Max USD / ordin</label>
          <input type="number" value={form.maxOrderUsd} onChange={f('maxOrderUsd')} />
        </div>
        <div className="frow">
          <label>Max USD / poziție</label>
          <input type="number" value={form.maxPositionUsd} onChange={f('maxPositionUsd')} />
        </div>

        <div className="section">Simboluri & preseturi</div>
        <div className="frow">
          <label>Favorite (taste 1–9)</label>
          <input value={form.favorites} onChange={f('favorites')}
                 placeholder="BTCUSDT, ETHUSDT, SOLUSDT" />
        </div>
        <div className="frow">
          <label>Preseturi fixe ($)</label>
          <input value={localPrefs.fixedPresets}
                 onChange={(e) => setLocalPrefs({ fixedPresets: e.target.value })}
                 placeholder="100, 250, 500" />
        </div>

        <div className="section">Hotkeys (click pe câmp, apoi apasă tasta)</div>
        {Object.keys(DEFAULT_HOTKEYS).map((action) => (
          <div className="frow" key={action}>
            <label>{ACTION_LABELS[action]}</label>
            <input className="hkinput" readOnly
                   value={capturing === action ? 'apasă o tastă…' : hk[action]}
                   onFocus={() => setCapturing(action)}
                   onBlur={() => setCapturing(null)}
                   onKeyDown={captureKey(action)} />
          </div>
        ))}

        <div className="actions">
          <button className="minibtn" onClick={onClose}>Renunță</button>
          <button className="save" onClick={save}>Salvează & Reconectează</button>
        </div>
      </div>
    </div>
  );
}
