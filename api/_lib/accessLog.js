// 敏感欄位存取稽核日誌 (Access Log)
//
// 寫入 Firestore `access_logs` collection，每一筆 doc 記錄一次解密 / 加密 / AI 存取。
// 設計原則：
//   1. fire-and-forget — 寫入失敗不可阻擋業務邏輯（用 .catch 吞掉）
//   2. 不記錄明文 — 只記錄「誰、何時、對誰、什麼欄位、什麼動作」
//   3. 包含 IP / UA — 方便事後鑑識
//
// Doc 結構：
//   {
//     ts: ISO string,
//     actor: { uid, email },
//     action: 'decrypt' | 'encrypt' | 'ai-access',
//     target: { kind: 'staff' | 'settings' | 'archive', id: string|null },
//     fields: ['idNumber', 'bankAccount', ...],
//     ip: string,
//     ua: string,
//     extra: object | null
//   }

import admin from 'firebase-admin';

export async function writeAccessLog({ actor, action, target, fields, ip, ua, extra }) {
  try {
    const db = admin.firestore();
    await db.collection('access_logs').add({
      ts: new Date().toISOString(),
      actor: actor || { uid: null, email: null },
      action: action || 'unknown',
      target: target || { kind: null, id: null },
      fields: Array.isArray(fields) ? fields : [],
      ip: ip || null,
      ua: ua || null,
      extra: extra || null,
    });
  } catch (err) {
    console.error('⚠️ access log 寫入失敗（不阻擋業務）:', err.message);
  }
}

export function extractClientMeta(req) {
  const ua = req.headers['user-agent'] || null;
  const xff = req.headers['x-forwarded-for'];
  const ip = (typeof xff === 'string' ? xff.split(',')[0].trim() : null)
    || req.headers['x-real-ip']
    || req.socket?.remoteAddress
    || null;
  return { ip, ua };
}
