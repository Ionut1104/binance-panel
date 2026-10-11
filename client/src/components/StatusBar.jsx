// Indicatorii de conexiune (UI↔backend, WS-API ordine, preț, user stream)
// + badge Testnet/Live + Spot/Futures. Verde = conectat, galben = reconectare.
import React from 'react';

const LABELS = { ui: 'UI', wsApi: 'Ordine', market: 'Preț', user: 'Cont' };

export default function StatusBar({ uiConn, status, settings, onOpenSettings }) {
  const all = { ui: uiConn, ...status };
  return (
    <div className="status">
      <span className={`badge ${settings?.testnet ? 'testnet' : 'live'}`}>
        {settings?.testnet ? 'TESTNET' : 'LIVE'}
      </span>
      <span className="badge market">{settings?.market === 'futures' ? 'FUTURES' : 'SPOT'}</span>
      {Object.entries(all).map(([k, v]) => (
        <span key={k} className="lbl">
          <span className={`dot ${v || 'disconnected'}`} />
          {LABELS[k]}
        </span>
      ))}
      <button className="minibtn" onClick={onOpenSettings}>⚙ Setări</button>
    </div>
  );
}
