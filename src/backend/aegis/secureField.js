// 地端版加密欄位：與 src/backend/firebase/secureField.js 同簽章、同回傳
import { http } from './http';

const OLD_KEY = /unable to authenticate data|Unsupported state|目前環境沒有這把金鑰/i;

async function call(path, body) {
  try {
    return (await http.post(`/api/secure-field/${path}`, body)).data;
  } catch (e) {
    if (OLD_KEY.test(e.message)) throw new Error('這筆資料是用舊的加密金鑰存的，已無法解密，請重新輸入');
    throw e;
  }
}

export async function encryptFieldRemote(plaintext, target, fields) {
  return (await call('encrypt', { payload: plaintext, target, fields })).blob;
}
export async function decryptField(blob, target, fields) {
  return (await call('decrypt', { payload: blob, target, fields })).value;
}
export async function batchDecryptFields(blobs, target, fields) {
  return (await call('batch-decrypt', { payload: blobs, target, fields })).values;   // [{ idx, value } | { idx, error }]
}
export async function logAiAccess() { return { ok: true }; }   // 地端沒有 AI（決策 3A）
export async function logRelock(target, fields, extra) { return call('relock', { target, fields, extra }); }

export function isEncryptedBlob(v) {
  return v && typeof v === 'object' && typeof v.ct === 'string' && typeof v.iv === 'string' &&
    typeof v.tag === 'string' && typeof v.v === 'number';
}
