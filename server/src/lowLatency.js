// Reglaje de latență, aplicate identic pe toate conexiunile WS (către Binance
// și către browser): fără compresie (perMessageDeflate adaugă CPU/latență
// pentru câștig zero pe frame-uri JSON mici) + TCP_NODELAY (dezactivează
// Nagle's algorithm, care altfel poate întârzia trimiterea unui pachet mic
// până la ~40ms așteptând să se umple bufferul).
import { Agent, setGlobalDispatcher } from 'undici';

export const NO_COMPRESSION = { perMessageDeflate: false };

// fetch() global (folosit de rest.js) ține conexiunile calde doar ~4s
// implicit — peste asta, orice ordin rar (STOP_MARKET/TAKE_PROFIT_MARKET,
// vezi placeOrder) plătește un TCP+TLS handshake nou (~2-3 RTT în plus,
// poate 500ms+) ÎNAINTE să pornească măcar spre Binance. Extindem fereastra
// la 60s + ținem conexiunea caldă cu un ping periodic (session.js), ca un
// SL/TP să nu fie penalizat exact când contează cel mai mult.
export function extendRestKeepAlive() {
  setGlobalDispatcher(new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 60_000 }));
}

// Pentru conexiuni WS unde NOI suntem clientul (wsApi/market/user stream):
// `ws` expune socket-ul brut abia la evenimentul 'upgrade'.
export function noDelayOnUpgrade(ws) {
  ws.on('upgrade', (res) => res.socket?.setNoDelay(true));
}

// Pentru conexiuni unde NOI suntem serverul (browserul se conectează la noi).
export function noDelayOnSocket(socket) {
  socket?.setNoDelay(true);
}
