// Hotkey-uri configurabile. Maparea implicită de mai jos se salvează în
// localStorage și se poate edita din Setări. Tastele 1–9 sunt rezervate
// pentru favorite (schimbare instant de simbol).
export const DEFAULT_HOTKEYS = {
  buyMarket: 'b',
  sellMarket: 's',
  buyLimit: 'shift+b',     // limit la ask − offset
  sellLimit: 'shift+s',    // limit la bid + offset
  buyTrigger: 'ctrl+b',    // intrare condiționată de preț (vezi §4.1 README)
  sellTrigger: 'ctrl+s',
  sellHalf: 'h',
  closeAll: 'c',
  scaleIn: 'i',
  scaleOut: 'o',
  reverse: 'r',
  cancelAll: 'x',
  stopLoss: 'l',
  takeProfit: 't',
  flatten: 'k',            // ★ KILL
  focusSearch: 'q',
};

export const ACTION_LABELS = {
  buyMarket: 'BUY Market', sellMarket: 'SELL Market',
  buyLimit: 'BUY Limit ±', sellLimit: 'SELL Limit ±',
  buyTrigger: 'BUY @ trigger', sellTrigger: 'SELL @ trigger',
  sellHalf: 'Sell % (customizabil)', closeAll: 'Close All',
  scaleIn: 'Scale In', scaleOut: 'Scale Out',
  reverse: 'Reverse', cancelAll: 'Cancel All',
  stopLoss: 'Stop Loss', takeProfit: 'Take Profit',
  flatten: 'KILL / Flatten', focusSearch: 'Căutare simbol',
};

export function loadHotkeys() {
  try {
    return { ...DEFAULT_HOTKEYS, ...JSON.parse(localStorage.getItem('hotkeys') || '{}') };
  } catch { return { ...DEFAULT_HOTKEYS }; }
}

export function saveHotkeys(map) {
  localStorage.setItem('hotkeys', JSON.stringify(map));
}

// Transformă un KeyboardEvent în string tip "shift+b" pentru comparare.
export function eventToCombo(e) {
  const parts = [];
  if (e.ctrlKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  const k = e.key.toLowerCase();
  if (!['shift', 'control', 'alt', 'meta'].includes(k)) parts.push(k);
  return parts.join('+');
}

// Afișare prietenoasă pe butoane: "shift+b" → "⇧B"
export function comboLabel(combo) {
  if (!combo) return '';
  return combo.replace('ctrl+', '⌃').replace('alt+', '⌥').replace('shift+', '⇧').toUpperCase();
}
