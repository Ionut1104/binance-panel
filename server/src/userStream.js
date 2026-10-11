// User Data Stream: fill-uri de ordine, schimbări de balanță și poziție,
// push-uite de Binance în timp real. Necesită un listenKey (obținut pe REST)
// care trebuie reînnoit la <60 min. Reconectare + listenKey nou automat.
import WebSocket from 'ws';
import { NO_COMPRESSION, noDelayOnUpgrade } from './lowLatency.js';

export class UserStream {
  constructor({ rest, wsBase, market, onEvent, onStatus }) {
    this.rest = rest;         // instanță BinanceRest (pentru listenKey)
    this.wsBase = wsBase;
    this.market = market;     // 'spot' | 'futures'
    this.onEvent = onEvent;
    this.onStatus = onStatus || (() => {});
    this.ws = null;
    this.closed = false;
    this.backoff = 1000;
  }

  async connect() {
    this.closed = false;
    try {
      // Spot: POST /api/v3/userDataStream ; Futures: POST /fapi/v1/listenKey
      const path = this.market === 'futures' ? '/fapi/v1/listenKey' : '/api/v3/userDataStream';
      const { listenKey } = await this.rest.keyed('POST', path);
      this.listenKey = listenKey;
    } catch (e) {
      console.error('[user] listenKey eșuat:', e.message);
      this.onStatus('reconnecting');
      if (!this.closed) setTimeout(() => this.connect(), 5000);
      return;
    }

    this.ws = new WebSocket(`${this.wsBase}/${this.listenKey}`, NO_COMPRESSION);
    noDelayOnUpgrade(this.ws);

    this.ws.on('open', () => {
      this.backoff = 1000;
      this.onStatus('connected');
      // Reînnoim listenKey la fiecare 30 min (expiră la 60).
      this.keepTimer = setInterval(async () => {
        try {
          const path = this.market === 'futures' ? '/fapi/v1/listenKey' : '/api/v3/userDataStream';
          const params = this.market === 'spot' ? { listenKey: this.listenKey } : {};
          await this.rest.keyed('PUT', path, params);
        } catch (e) { console.error('[user] keepalive eșuat:', e.message); }
      }, 30 * 60 * 1000);
    });

    this.ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      // Trimitem evenimentul brut mai departe; session.js îl interpretează
      // (executionReport / ORDER_TRADE_UPDATE / ACCOUNT_UPDATE / outboundAccountPosition).
      this.onEvent(m.data || m);
    });

    const onDown = () => {
      clearInterval(this.keepTimer);
      if (!this.closed) {
        this.onStatus('reconnecting');
        // La reconectare cerem un listenKey NOU (cel vechi poate fi expirat).
        setTimeout(() => this.connect(), this.backoff);
        this.backoff = Math.min(this.backoff * 2, 15_000);
      } else this.onStatus('disconnected');
    };
    this.ws.on('close', onDown);
    this.ws.on('error', (e) => { console.error('[user]', e.message); this.ws.close(); });
  }

  close() {
    this.closed = true;
    clearInterval(this.keepTimer);
    this.ws?.close();
    // Invalidăm listenKey-ul pe Binance la oprire — altfel rămâne activ
    // (valabil până la 60 min) degeaba, iar POST-ul de la următoarea
    // pornire ar primi înapoi ACELAȘI listenKey (comportamentul documentat
    // Binance: dacă unul e deja activ, returnează același, doar îi extinde
    // valabilitatea) în loc de unul proaspăt.
    if (this.listenKey) {
      const path = this.market === 'futures' ? '/fapi/v1/listenKey' : '/api/v3/userDataStream';
      const params = this.market === 'spot' ? { listenKey: this.listenKey } : {};
      this.rest.keyed('DELETE', path, params).catch(() => {});
    }
  }
}
