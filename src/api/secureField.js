// 客戶端：呼叫 /api/secure-field 的薄封裝
//
// 用法：
//   const num = await decryptField(blob, { kind: 'settings', id: null }, ['baseSalary']);
//   const blob = await encryptFieldRemote(40000, { kind: 'settings', id: null }, ['baseSalary']);
//   const list = await batchDecryptFields([blobA, blobB], { kind: 'staff', id: 'N001' }, ['idNumber','bankAccount']);
//
// `target` / `fields` 純粹用於稽核日誌，前端必須老老實實傳，不會影響加解密本身。

import { auth } from './database';

async function call(body) {
  const user = auth.currentUser;
  if (!user) throw new Error('未登入');
  const token = await user.getIdToken();
  const res = await fetch('/api/secure-field', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `secure-field 呼叫失敗 (${res.status})`);
  }
  return data;
}

export async function encryptFieldRemote(plaintext, target, fields) {
  const { blob } = await call({ action: 'encrypt', payload: plaintext, target, fields });
  return blob;
}

export async function decryptField(blob, target, fields) {
  const { value } = await call({ action: 'decrypt', payload: blob, target, fields });
  return value;
}

export async function batchDecryptFields(blobs, target, fields) {
  const { values } = await call({ action: 'batchDecrypt', payload: blobs, target, fields });
  return values; // [{ idx, value } | { idx, error }]
}

export async function logAiAccess(target, fields, extra) {
  return call({ action: 'logAiAccess', target, fields, extra });
}

// 判斷一個值是不是密文 blob（前端輕量檢查）
export function isEncryptedBlob(v) {
  return (
    v && typeof v === 'object' &&
    typeof v.ct === 'string' && typeof v.iv === 'string' &&
    typeof v.tag === 'string' && typeof v.v === 'number'
  );
}
