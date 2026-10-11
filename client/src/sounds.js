// Feedback sonor prin WebAudio — fără fișiere audio, zero dependențe.
// verde/fill = chirp ascendent, roșu/eroare = buzz grav, trimis = tick scurt.
let ctx = null;
function ac() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function tone(freq, dur, type = 'sine', gain = 0.15, slideTo = null) {
  try {
    const a = ac();
    const o = a.createOscillator();
    const g = a.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, a.currentTime);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, a.currentTime + dur);
    g.gain.setValueAtTime(gain, a.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + dur);
    o.connect(g).connect(a.destination);
    o.start();
    o.stop(a.currentTime + dur);
  } catch { /* audio blocat de browser — ignorăm */ }
}

export const sounds = {
  sent: () => tone(880, 0.06, 'square', 0.06),            // click trimis
  fill: () => tone(660, 0.12, 'sine', 0.2, 1320),          // FILL — chirp vesel
  error: () => tone(160, 0.3, 'sawtooth', 0.2, 80),        // eroare — buzz grav
  cancel: () => tone(440, 0.08, 'triangle', 0.1),          // anulare
};
