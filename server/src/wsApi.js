// ═══════════════════════════════════════════════════════════════════
// Conexiunea WS-API Binance — AICI se câștigă latența.
// O singură conexiune WebSocket persistentă, ținută caldă cu ping.
// Fiecare ordin = un frame JSON pe conexiunea deja deschisă (fără
// TCP/TLS handshake per click, cum ar fi la REST).
// Semnăm HMAC fiecare request (funcționează identic pe Spot și Futures).
// ═══════════════════════════════════════════════════════════════════
import WebSocket from 'ws';
import crypto from 'crypto';
import { hmacSign } from './crypto.js';
import { now } from './timeSync.js';
import { NO_COMPRESSION, noDelayOnUpgrade } from './lowLatency.js';

export class BinanceWsApi {
  constructor({ url, apiKey, apiSecret, recvWindow = 3000, onStatus }) {
    this.url = url;
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.recvWindow = recvWindow;
    this.onStatus = onStatus || (() => {});
    this.pending = new Map();   // id → {resolve, reject, timer} pentru request-uri în zbor
    this.ws = null;
    this.closed = false;        // true = închidere intenționată, nu mai reconecta
    this.backoff = 500;         // reconectare cu backoff exponențial (max 10s)
  }

  connect() {
    this.closed = false;
    this.ws = new WebSocket(this.url, NO_COMPRESSION);
    noDelayOnUpgrade(this.ws);

    this.ws.on('open', () => {
      this.backoff = 500;
      this.onStatus('connected');
      // Keep-alive: ping la 30s ca să nu ne taie conexiunea idle
      // și ca socket-ul să rămână "cald" (fără slow-start la primul ordin).
      this.pingTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.ping();
      }, 30_000);
    });

    this.ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.status === 200) entry.resolve(msg.result);
      else {
        const err = new Error(msg.error?.msg || `WS-API status ${msg.status}`);
        err.code = msg.error?.code;
        entry.reject(err);
      }
    });

    const onDown = () => {
      clearInterval(this.pingTimer);
      // Respinge tot ce era în zbor — UI-ul află imediat, nu așteaptă timeout.
      for (const [id, e] of this.pending) {
        clearTimeout(e.timer);
        e.reject(new Error('Conexiunea WS-API a picat'));
        this.pending.delete(id);
      }
      if (!this.closed) {
        this.onStatus('reconnecting');
        setTimeout(() => this.connect(), this.backoff);
        this.backoff = Math.min(this.backoff * 2, 10_000);
      } else {
        this.onStatus('disconnected');
      }
    };
    this.ws.on('close', onDown);
    this.ws.on('error', (e) => { console.error('[ws-api]', e.message); this.ws.close(); });
  }

  close() {
    this.closed = true;
    clearInterval(this.pingTimer);
    this.ws?.close();
  }

  // Request semnat generic. method = "order.place", "order.cancel" etc.
  request(method, params = {}, { signed = true, timeoutMs = 5000 } = {}) {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState !== WebSocket.OPEN) {
        return reject(new Error('WS-API neconectat'));
      }
      const id = crypto.randomUUID();
      let payload = { ...params };
      if (signed) {
        payload.apiKey = this.apiKey;
        payload.timestamp = now();               // timestamp corectat cu offset-ul
        payload.recvWindow = this.recvWindow;    // fereastră mică = protecție
        // Binance cere semnătura peste parametrii sortați alfabetic.
        const qs = Object.keys(payload).sort()
          .map((k) => `${k}=${payload[k]}`).join('&');
        payload.signature = hmacSign(qs, this.apiSecret);
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout WS-API (${method})`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params: payload }));
    });
  }
}
