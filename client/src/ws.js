// Conexiunea WebSocket a UI-ului către backend, cu:
//  - reconectare automată (backoff exponențial)
//  - request/response prin reqId (Promise per acțiune)
//  - abonare la evenimente push (ticker, account, orders, orderUpdate...)
let ws = null;
let reqId = 1;
const pending = new Map();      // reqId → {resolve, reject}
const listeners = new Set();    // callback-uri pentru mesaje push
let statusCb = () => {};
let backoff = 500;

export function onMessage(cb) { listeners.add(cb); return () => listeners.delete(cb); }
export function onConnState(cb) { statusCb = cb; }

export function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const token = localStorage.getItem('panelToken') || '';
  ws = new WebSocket(`${proto}://${location.host}/ws${token ? '?token=' + token : ''}`);

  ws.onopen = () => { backoff = 500; statusCb('connected'); };

  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    // Răspuns la o cerere a noastră?
    if ((m.type === 'ack' || m.type === 'err') && pending.has(m.reqId)) {
      const p = pending.get(m.reqId);
      pending.delete(m.reqId);
      m.type === 'ack' ? p.resolve(m.result) : p.reject(m);
      return;
    }
    // Altfel e un push de la server → notificăm toate componentele abonate.
    for (const cb of listeners) cb(m);
  };

  ws.onclose = () => {
    statusCb('reconnecting');
    for (const [, p] of pending) p.reject({ message: 'Conexiune pierdută cu backend-ul' });
    pending.clear();
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 8000);
  };
  ws.onerror = () => ws.close();
}

// Trimite o acțiune și întoarce un Promise cu rezultatul.
export function send(type, payload = {}) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return reject({ message: 'Neconectat la backend' });
    }
    const id = reqId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ type, reqId: id, ...payload }));
    // Timeout de siguranță — nu lăsăm promisiuni agățate.
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject({ message: `Timeout: ${type}` }); }
    }, 10_000);
  });
}

// ID unic de ordin generat de client → cheia UI-ului optimist.
export function newClientOrderId() {
  return 'pnl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
