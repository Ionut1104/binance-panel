// Helper REST — folosit pentru operațiuni care nu sunt pe WS-API:
// listenKey, leverage, margin type, exchangeInfo, poziții inițiale, și
// ordinele STOP_MARKET/TAKE_PROFIT_MARKET pe futures (WS-API le respinge cu
// -4120, vezi placeOrder în session.js). Restul ordinelor merg pe WS-API
// (wsApi.js) pentru latență minimă.
import { hmacSign } from './crypto.js';
import { now } from './timeSync.js';

export class BinanceRest {
  constructor({ base, apiKey, apiSecret, recvWindow = 3000 }) {
    this.base = base;
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.recvWindow = recvWindow;
  }

  // Request public (fără semnătură) — ex. exchangeInfo.
  async public(path, params = {}) {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`${this.base}${path}${qs ? '?' + qs : ''}`);
    return this.#handle(res);
  }

  // Request semnat (HMAC) — ex. leverage, positionRisk.
  async signed(method, path, params = {}) {
    const all = { ...params, timestamp: now(), recvWindow: this.recvWindow };
    const qs = new URLSearchParams(all).toString();
    const sig = hmacSign(qs, this.apiSecret);
    const url = `${this.base}${path}?${qs}&signature=${sig}`;
    const res = await fetch(url, { method, headers: { 'X-MBX-APIKEY': this.apiKey } });
    return this.#handle(res);
  }

  // Request doar cu API key, fără semnătură — ex. listenKey.
  async keyed(method, path, params = {}) {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`${this.base}${path}${qs ? '?' + qs : ''}`, {
      method,
      headers: { 'X-MBX-APIKEY': this.apiKey },
    });
    return this.#handle(res);
  }

  async #handle(res) {
    const text = await res.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    if (!res.ok) {
      // Binance răspunde cu { code, msg } — propagăm mesajul lizibil spre UI.
      const err = new Error(body.msg || `HTTP ${res.status}`);
      err.code = body.code;
      throw err;
    }
    return body;
  }
}
