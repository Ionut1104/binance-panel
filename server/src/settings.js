// Persistența setărilor: chei API (criptate) + preferințe (market, testnet, limite risc).
// Totul stă local în server/data/settings.enc.json — NIMIC hardcodat.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { encryptJson, decryptJson } from './crypto.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'settings.enc.json');

const DEFAULTS = {
  apiKey: '',
  apiSecret: '',
  market: 'futures',       // 'spot' | 'futures'
  testnet: true,           // pornim pe testnet, cu bani falși
  recvWindow: 3000,        // mic → respinge ordine "vechi" (protecție latență)
  maxOrderUsd: 1000,       // mărimea maximă a UNUI ordin (protecție fat-finger)
  maxPositionUsd: 5000,    // expunerea maximă totală pe simbol
  favorites: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
};

let cache = null;

export function loadSettings() {
  if (cache) return cache;
  const secret = process.env.PANEL_SECRET;
  if (!secret) throw new Error('PANEL_SECRET lipsește din .env');
  if (!fs.existsSync(FILE)) {
    cache = { ...DEFAULTS };
    return cache;
  }
  try {
    const payload = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    cache = { ...DEFAULTS, ...decryptJson(payload, secret) };
  } catch (e) {
    // Secret greșit sau fișier corupt → nu crăpa, pornește cu default-uri.
    console.error('[settings] Nu pot decripta settings.enc.json:', e.message);
    cache = { ...DEFAULTS };
  }
  return cache;
}

export function saveSettings(patch) {
  const secret = process.env.PANEL_SECRET;
  cache = { ...loadSettings(), ...patch };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Scriere atomică (temp + rename) ca să nu corupem fișierul la crash.
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(encryptJson(cache, secret)));
  fs.renameSync(tmp, FILE);
  return cache;
}

// Versiune "sigură" pentru UI: nu trimitem niciodată secretul înapoi în browser.
export function publicSettings() {
  const s = loadSettings();
  return {
    ...s,
    apiSecret: undefined,
    apiKey: s.apiKey ? s.apiKey.slice(0, 4) + '...' + s.apiKey.slice(-4) : '',
    hasKeys: Boolean(s.apiKey && s.apiSecret),
  };
}
