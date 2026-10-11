// Afișaj live: poziție (size, entry, PnL în $ și %), balanță, ultimul preț.
// PnL-ul se recalculează la FIECARE tick de preț — fără refresh.
import React from 'react';
import { fmt, fmtPx, fmtQty, pnlClass } from '../util.js';

export default function PositionCard({ position, balances, ticker, filters, settings }) {
  const qty = position?.qty || 0;
  const entry = position?.entry || 0;
  const last = ticker?.last || 0;
  const hasPos = Math.abs(qty) > 1e-12;

  // PnL nerealizat: (preț − entry) × qty (qty negativ pt short → semnul iese corect)
  const pnl = hasPos && entry ? (last - entry) * qty : 0;
  const pnlPct = hasPos && entry ? ((last - entry) / entry) * 100 * Math.sign(qty) : 0;
  const notional = Math.abs(qty) * last;

  const quote = filters?.quoteAsset || 'USDT';
  const bal = balances?.[quote];

  return (
    <div className="card poscard">
      <table>
        <tbody>
          <tr>
            <td>Poziție</td>
            <td className="big">
              {hasPos ? (
                <>
                  <span className={qty > 0 ? 'side-long' : 'side-short'}>
                    {qty > 0 ? 'LONG' : 'SHORT'}
                  </span>{' '}
                  {fmtQty(Math.abs(qty), filters)}
                </>
              ) : 'FLAT'}
            </td>
          </tr>
          <tr><td>Valoare</td><td>{hasPos ? `${fmt(notional)} ${quote}` : '—'}</td></tr>
          <tr><td>Entry</td><td>{hasPos ? fmtPx(entry, filters) : '—'}</td></tr>
          <tr>
            <td>PnL</td>
            <td className={`big ${pnlClass(pnl)}`}>
              {hasPos ? `${pnl >= 0 ? '+' : ''}${fmt(pnl)} $ (${pnlPct >= 0 ? '+' : ''}${fmt(pnlPct)}%)` : '—'}
            </td>
          </tr>
          <tr>
            <td>Balanță {quote}</td>
            <td>{bal ? `${fmt(bal.free)} liber / ${fmt(bal.total)} total` : '—'}</td>
          </tr>
          <tr>
            <td>Bid / Ask</td>
            <td>
              <span className="pos">{fmtPx(ticker?.bid, filters)}</span>
              {' / '}
              <span className="neg">{fmtPx(ticker?.ask, filters)}</span>
            </td>
          </tr>
          <tr>
            <td>Limite risc</td>
            <td style={{ fontSize: 11, color: 'var(--muted)' }}>
              max {settings?.maxOrderUsd} $/ordin · max {settings?.maxPositionUsd} $/poziție
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
