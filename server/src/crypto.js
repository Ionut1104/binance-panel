// Criptare/decriptare AES-256-GCM pentru cheile API salvate pe disc.
// Cheia de criptare e derivată (scrypt) din PANEL_SECRET (variabilă de mediu),
// deci fișierul settings.enc.json e inutil fără secretul tău.
import crypto from 'crypto';

const ALG = 'aes-256-gcm';

function deriveKey(secret, salt) {
  // scrypt = derivare lentă intenționat → brute-force scump
  return crypto.scryptSync(secret, salt, 32);
}

export function encryptJson(obj, secret) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12); // IV unic per criptare (obligatoriu la GCM)
  const key = deriveKey(secret, salt);
  const cipher = crypto.createCipheriv(ALG, key, iv);
  const plaintext = Buffer.from(JSON.stringify(obj), 'utf8');
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag(); // tag de autentificare — detectează orice alterare
  return {
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: enc.toString('base64'),
  };
}

export function decryptJson(payload, secret) {
  const salt = Buffer.from(payload.salt, 'base64');
  const iv = Buffer.from(payload.iv, 'base64');
  const tag = Buffer.from(payload.tag, 'base64');
  const data = Buffer.from(payload.data, 'base64');
  const key = deriveKey(secret, salt);
  const decipher = crypto.createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(dec.toString('utf8'));
}

// Semnătura HMAC-SHA256 cerută de Binance pentru request-uri private.
export function hmacSign(queryString, apiSecret) {
  return crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
}
