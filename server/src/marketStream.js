// Stream public de piață: bookTicker = best bid/ask, actualizat la fiecare
// schimbare de top-of-book. Reconectare automată + resubscribe la schimbarea
// simbolului (fără să recreăm conexiunea).
import WebSocket from 'ws';
import { NO_COMPRESSION, noDelayOnUpgrade } from './lowLatency.js';

export class MarketStream {
  constructor({ url, onTicker, onStatus }) {
    this.url = url;
    this.onTicker = onTicker;
    this.onStatus = onStatus || (() => {});
    this.symbol = null;
    this.ws = null;
    this.closed = false;
    this.backoff = 500;
    this.subId = 1;
  }

  connect() {
    this.closed = false;
    this.ws = new WebSocket(this.url, NO_COMPRESSION);
    noDelayOnUpgrade(this.ws);

    this.ws.on('open', () => {
      this.backoff = 500;
      this.onStatus('connected');
      // Dacă aveam deja un simbol selectat, ne reabonăm după reconectare.
      if (this.symbol) this.#subscribe(this.symbol);
      this.pingTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.ping();
      }, 60_000);
    });

    this.ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      // bookTicker: { s: simbol, b: bid, a: ask } (spot n-are event type "e")
      const d = m.data || m;
      if (d.b !== undefined && d.a !== undefined && d.s) {
        this.onTicker({
          symbol: d.s,
          bid: parseFloat(d.b),
          ask: parseFloat(d.a),
          last: (parseFloat(d.b) + parseFloat(d.a)) / 2, // mid-price ca "ultim preț"
          ts: Date.now(),
        });
      }
    });

    const onDown = () => {
      clearInterval(this.pingTimer);
      if (!this.closed) {
        this.onStatus('reconnecting');
        setTimeout(() => this.connect(), this.backoff);
        this.backoff = Math.min(this.backoff * 2, 10_000);
      } else this.onStatus('disconnected');
    };
    this.ws.on('close', onDown);
    this.ws.on('error', (e) => { console.error('[market]', e.message); this.ws.close(); });
  }

  // Schimbarea simbolului: UNSUBSCRIBE de la vechiul stream, SUBSCRIBE la noul.
  setSymbol(symbol) {
    const old = this.symbol;
    this.symbol = symbol;
    if (this.ws?.readyState !== WebSocket.OPEN) return; // se abonează la open
    if (old && old !== symbol) {
      this.ws.send(JSON.stringify({
        method: 'UNSUBSCRIBE',
        params: [`${old.toLowerCase()}@bookTicker`],
        id: this.subId++,
      }));
    }
    this.#subscribe(symbol);
  }

  #subscribe(symbol) {
    this.ws.send(JSON.stringify({
      method: 'SUBSCRIBE',
      params: [`${symbol.toLowerCase()}@bookTicker`],
      id: this.subId++,
    }));
  }

  close() {
    this.closed = true;
    clearInterval(this.pingTimer);
    this.ws?.close();
  }
}
