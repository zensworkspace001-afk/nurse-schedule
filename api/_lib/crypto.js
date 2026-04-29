// 欄位級加密 (Field-Level Encryption)
//
// 使用 AES-256-GCM (authenticated encryption)，金鑰來自 FIELD_ENC_KEY 環境變數。
// 金鑰必須是 base64 編碼後的 32 bytes (256 bits)。
//
// 產生金鑰指令：
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
//
// Firestore 上的密文格式：{ ct, iv, tag, v }
//   ct  = base64 ciphertext
//   iv  = base64 12-byte nonce
//   tag = base64 16-byte auth tag
//   v   = schema version (目前為 1)，方便日後換金鑰或演算法時識別

import crypto from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;     // GCM 建議 12 bytes
const TAG_LEN = 16;
const VERSION = 1;

let cachedKey = null;

function getKey() {
  if (cachedKey) return cachedKey;
  const raw = process.env.FIELD_ENC_KEY;
  if (!raw) {
    throw new Error('FIELD_ENC_KEY 環境變數未設定，無法執行欄位加密');
  }
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) {
    throw new Error(`FIELD_ENC_KEY 長度錯誤：必須是 32 bytes (base64 解碼後)，目前 ${buf.length} bytes`);
  }
  cachedKey = buf;
  return buf;
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
  const key = getKey();
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
  };
}

export function decryptField(blob) {
  if (!blob || typeof blob !== 'object') {
    throw new Error('密文格式無效：需為物件');
  }
  if (blob.v !== VERSION) {
    throw new Error(`密文版本不相容：期望 v=${VERSION}，實際 v=${blob.v}`);
  }
  const key = getKey();
  const iv = Buffer.from(blob.iv, 'base64');
  const tag = Buffer.from(blob.tag, 'base64');
  const ct = Buffer.from(blob.ct, 'base64');
  if (iv.length !== IV_LEN) throw new Error('IV 長度錯誤');
  if (tag.length !== TAG_LEN) throw new Error('Auth tag 長度錯誤');

  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ct),
    decipher.final(),
  ]).toString('utf8');
  return deserialize(plaintext);
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
