// 欄位級加密 (Field-Level Encryption)
//
// 使用 AES-256-GCM (authenticated encryption)，金鑰來自 FIELD_ENC_KEY 環境變數。
// 金鑰必須是 base64 編碼後的 32 bytes (256 bits)。
//
// 產生金鑰指令：
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
//
// Firestore 上的密文格式：{ ct, iv, tag, v, kid? }
//   ct  = base64 ciphertext
//   iv  = base64 12-byte nonce
//   tag = base64 16-byte auth tag
//   v   = schema version (目前為 1)
//   kid = 加密所用金鑰的指紋（sha256 前 8 碼 hex，不洩漏金鑰本身）。2026-10 之前寫入的密文沒有 kid。
//
// 金鑰輪替（2026-06-02 曾經直接換掉 FIELD_ENC_KEY，之前的密文全部解不開 — 不要再這樣換）：
//   FIELD_ENC_KEY            = 目前的金鑰，所有新加密都用它
//   FIELD_ENC_KEYS_PREVIOUS  = 舊金鑰（base64，逗號分隔），只用來解密
// 換金鑰時：把舊的移到 FIELD_ENC_KEYS_PREVIOUS、新的放 FIELD_ENC_KEY；舊密文照樣解得開，
// 之後再重新加密並移除舊金鑰。有 kid 的密文直接挑對應金鑰；沒有 kid 的依序嘗試。

import crypto from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;     // GCM 建議 12 bytes
const TAG_LEN = 16;
const VERSION = 1;

let cachedRing = null;

const fingerprint = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8);

function parseKey(raw, name) {
  const buf = Buffer.from(raw.trim(), 'base64');
  if (buf.length !== 32) {
    throw new Error(`${name} 長度錯誤：必須是 32 bytes (base64 解碼後)，目前 ${buf.length} bytes`);
  }
  return { kid: fingerprint(buf), key: buf };
}

// [目前金鑰, ...舊金鑰]
function getKeyRing() {
  if (cachedRing) return cachedRing;
  const raw = process.env.FIELD_ENC_KEY;
  if (!raw) {
    throw new Error('FIELD_ENC_KEY 環境變數未設定，無法執行欄位加密');
  }
  const ring = [parseKey(raw, 'FIELD_ENC_KEY')];
  for (const old of (process.env.FIELD_ENC_KEYS_PREVIOUS || '').split(',').filter((s) => s.trim())) {
    const k = parseKey(old, 'FIELD_ENC_KEYS_PREVIOUS');
    if (!ring.some((r) => r.kid === k.kid)) ring.push(k);
  }
  cachedRing = ring;
  return ring;
}

// 目前金鑰的指紋 — healthCheck 回傳，用來和離線備份比對「線上的金鑰是不是被換掉了」
export function currentKeyId() {
  return getKeyRing()[0].kid;
}

// 把任意值轉成可加密的字串（保留型別資訊以便還原）
function serialize(plaintext) {
  if (plaintext === null || plaintext === undefined) return JSON.stringify({ t: 'null' });
  if (typeof plaintext === 'number') return JSON.stringify({ t: 'num', v: plaintext });
  if (typeof plaintext === 'boolean') return JSON.stringify({ t: 'bool', v: plaintext });
  if (typeof plaintext === 'string') return JSON.stringify({ t: 'str', v: plaintext });
  return JSON.stringify({ t: 'json', v: plaintext });
}

function deserialize(str) {
  const obj = JSON.parse(str);
  if (obj.t === 'null') return null;
  return obj.v;
}

export function encryptField(plaintext) {
  const { kid, key } = getKeyRing()[0];
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(serialize(plaintext), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    ct: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    v: VERSION,
    kid,
  };
}

export function decryptField(blob) {
  if (!blob || typeof blob !== 'object') {
    throw new Error('密文格式無效：需為物件');
  }
  if (blob.v !== VERSION) {
    throw new Error(`密文版本不相容：期望 v=${VERSION}，實際 v=${blob.v}`);
  }
  const iv = Buffer.from(blob.iv, 'base64');
  const tag = Buffer.from(blob.tag, 'base64');
  const ct = Buffer.from(blob.ct, 'base64');
  if (iv.length !== IV_LEN) throw new Error('IV 長度錯誤');
  if (tag.length !== TAG_LEN) throw new Error('Auth tag 長度錯誤');

  const ring = getKeyRing();
  let candidates = ring;
  if (blob.kid) {
    candidates = ring.filter((k) => k.kid === blob.kid);
    if (!candidates.length) {
      throw new Error(`此資料是用金鑰 ${blob.kid} 加密的，目前環境沒有這把金鑰（目前金鑰 ${ring[0].kid}）`);
    }
  }
  let lastErr;
  for (const { key } of candidates) {
    try {
      const decipher = crypto.createDecipheriv(ALGO, key, iv);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(ct),
        decipher.final(),
      ]).toString('utf8');
      return deserialize(plaintext);
    } catch (err) {
      lastErr = err;   // GCM 驗證失敗 → 換下一把（只有沒 kid 的舊密文會試多把）
    }
  }
  throw lastErr;
}

// 判斷某欄位是否已加密
export function isEncrypted(value) {
  return (
    value &&
    typeof value === 'object' &&
    typeof value.ct === 'string' &&
    typeof value.iv === 'string' &&
    typeof value.tag === 'string' &&
    typeof value.v === 'number'
  );
}
