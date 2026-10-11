// Ordinele deschise, cu Cancel individual. Ordinele "optimiste" (trimise,
// neconfirmate încă) apar semi-transparente până vine confirmarea reală.
import React from 'react';
import { fmtPx, fmtQty } from '../util.js';

export default function OrdersTable({ orders, pendingOrders, triggers = [], onCancelTrigger, filters, onCancel }) {
  return (
    <div className="card orders">
      <h3>Ordine deschise ({orders.length}{triggers.length ? ` + ${triggers.length} trigger` : ''})</h3>
      <div className="tbl">
        <table>
          <thead>
            <tr><th>Side</th><th>Tip</th><th>Preț</th><th>Stop</th><th>Qty</th><th>Fill</th><th></th></tr>
          </thead>
          <tbody>
            {/* Intrări condiționate — încă neatinse, așteaptă prețul trigger */}
            {triggers.map((t) => (
              <tr key={t.id} className="trigger-row">
                <td className={t.side === 'BUY' ? 'pos' : 'neg'}>{t.side}</td>
                <td>⏳ {t.orderType === 'LIMIT' ? 'LMT' : 'MKT'} @ trigger</td>
                <td>{fmtPx(t.triggerPrice, filters)}</td>
                <td>{t.direction === 'up' ? '↑' : '↓'}</td>
                <td>{fmtQty(t.qty, filters)}</td>
                <td>—</td>
                <td><button className="cancel" onClick={() => onCancelTrigger(t.id)}>✕</button></td>
              </tr>
            ))}
            {/* Ordine optimiste — încă în zbor spre Binance */}
            {pendingOrders.map((o) => (
              <tr key={o.clientOrderId} className="pending-row">
                <td className={o.side === 'BUY' ? 'pos' : 'neg'}>{o.side}</td>
                <td>{o.type}</td>
                <td>{o.price ? fmtPx(o.price, filters) : 'MKT'}</td>
                <td>—</td>
                <td>{fmtQty(o.qty, filters)}</td>
                <td>…</td>
                <td></td>
              </tr>
            ))}
            {orders.map((o) => (
              <tr key={o.orderId}>
                <td className={o.side === 'BUY' ? 'pos' : 'neg'}>{o.side}</td>
                <td>{o.type}</td>
                <td>{o.price ? fmtPx(o.price, filters) : 'MKT'}</td>
                <td>{o.stopPrice ? fmtPx(o.stopPrice, filters) : '—'}</td>
                <td>{fmtQty(o.qty, filters)}</td>
                <td>{fmtQty(o.filled, filters)}</td>
                <td><button className="cancel" onClick={() => onCancel(o.orderId)}>✕</button></td>
              </tr>
            ))}
            {orders.length === 0 && pendingOrders.length === 0 && triggers.length === 0 && (
              <tr><td colSpan="7" style={{ color: 'var(--muted)' }}>Niciun ordin deschis</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
