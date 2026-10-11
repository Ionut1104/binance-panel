// Formatări mici, refolosite peste tot.
export const fmt = (n, d = 2) =>
  n === null || n === undefined || Number.isNaN(n) ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

export const fmtPx = (n, filters) => fmt(n, filters?.pricePrecision ?? 2);
export const fmtQty = (n, filters) => fmt(n, filters?.qtyPrecision ?? 4);

// Culoare PnL: verde / roșu / gri.
export const pnlClass = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
