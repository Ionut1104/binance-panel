// Sincronizare cu ceasul serverului Binance.
// Timestamp-ul din fiecare request semnat trebuie să fie în fereastra recvWindow
// a serverului; dacă ceasul local e decalat, ordinele sunt respinse (-1021).
// Măsurăm offset-ul la pornire și îl re-măsurăm periodic.

let offsetMs = 0;

export async function syncTime(restBase, market) {
  const path = market === 'futures' ? '/fapi/v1/time' : '/api/v3/time';
  // Facem 3 măsurători și o păstrăm pe cea cu round-trip minim (cea mai precisă).
  let best = null;
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    const res = await fetch(restBase + path);
    const t1 = Date.now();
    if (!res.ok) throw new Error(`time sync HTTP ${res.status}`);
    const { serverTime } = await res.json();
    const rtt = t1 - t0;
    // Estimăm că serverTime corespunde mijlocului round-trip-ului.
    const est = serverTime - (t0 + rtt / 2);
    if (!best || rtt < best.rtt) best = { rtt, est };
  }
  offsetMs = Math.round(best.est);
  console.log(`[time] offset față de Binance: ${offsetMs}ms (rtt ${best.rtt}ms)`);
  return offsetMs;
}

// Timestamp corectat, de folosit în TOATE request-urile semnate.
export function now() {
  return Date.now() + offsetMs;
}
