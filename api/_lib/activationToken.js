// 一次性帳號啟用 / 密碼重設 Token 工具
//
// 設計原則：
//   1. 明文 token 只在「URL 連結」與「使用者點擊後」流通；Firestore 端只存 sha256 雜湊。
//      → 即使 Firestore 外洩，攻擊者也無法直接拿到 token 啟用帳號。
//   2. 一次性使用：成功消化後立即刪除 doc。
//   3. 24 小時逾期：超過即無效，使用者需請管理員重新發送。
//   4. 雙用途：purpose = 'activation' | 'reset'，使用 token 時須比對。
//
// Doc 結構：pending_activation/{tokenHash}
//   {
//     uid: string,          // Firebase Auth UID = staff_id
//     email: string,        // 寄信地址（為了讓 reset 信能再次寄出）
//     purpose: 'activation' | 'reset',
//     expiresAt: Timestamp, // Firestore Timestamp
//     createdAt: Timestamp,
//   }

import crypto from 'node:crypto';
import admin from 'firebase-admin';

const TTL_MS = 24 * 60 * 60 * 1000; // 24 小時

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function generatePlainToken() {
  return crypto.randomBytes(32).toString('hex'); // 64 chars
}

export function hashToken(plainToken) {
  return sha256Hex(plainToken);
}

// 為指定 uid 建立 token 並寫入 Firestore；回傳明文 token（呼叫端用來組信件連結）
export async function issueToken({ uid, email, purpose }) {
  if (!uid || !email) throw new Error('issueToken 需要 uid 與 email');
  if (purpose !== 'activation' && purpose !== 'reset') {
    throw new Error(`unknown token purpose: ${purpose}`);
  }
  const plain = generatePlainToken();
  const tokenHash = hashToken(plain);
  const now = admin.firestore.Timestamp.now();
  const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + TTL_MS);

  await admin.firestore()
    .collection('pending_activation')
    .doc(tokenHash)
    .set({ uid, email, purpose, createdAt: now, expiresAt });

  return plain;
}

// 同一個 uid 的舊 token 全部清掉（避免堆積、攻擊者拿到舊 token 仍可用）
export async function revokeTokensForUid(uid) {
  if (!uid) return;
  const snap = await admin.firestore()
    .collection('pending_activation')
    .where('uid', '==', uid)
    .get();
  if (snap.empty) return;
  const batch = admin.firestore().batch();
  snap.docs.forEach(d => batch.delete(d.ref));
  await batch.commit();
}

// 驗證明文 token：通過則回傳 doc data；通不過則 throw 並附上原因
export async function verifyToken(plainToken, expectedPurpose) {
  if (!plainToken || typeof plainToken !== 'string') {
    throw new Error('啟用連結無效');
  }
  const tokenHash = hashToken(plainToken);
  const ref = admin.firestore().collection('pending_activation').doc(tokenHash);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('啟用連結無效或已被使用');
  const data = snap.data();
  if (expectedPurpose && data.purpose !== expectedPurpose) {
    throw new Error('啟用連結用途不符');
  }
  const expiresAtMs = data.expiresAt?.toMillis?.() ?? 0;
  if (Date.now() > expiresAtMs) {
    await ref.delete().catch(() => {});
    throw new Error('啟用連結已逾期，請聯絡管理員重新發送');
  }
  return { ...data, tokenHash, ref };
}

// 消費（成功完成動作後刪除 doc，達成一次性效果）
export async function consumeToken(tokenHash) {
  await admin.firestore()
    .collection('pending_activation')
    .doc(tokenHash)
    .delete()
    .catch(() => {});
}

// 密碼強度檢查（與前端原本的規則一致：>=6 碼，需含英文與數字）
export function validatePasswordStrength(pw) {
  if (typeof pw !== 'string') return { ok: false, reason: '密碼格式錯誤' };
  if (pw === '123456') return { ok: false, reason: '密碼不可使用預設值' };
  if (pw.length < 6) return { ok: false, reason: '密碼至少 6 碼' };
  const strong = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d!@#$%^&*()_+\-=]{6,}$/;
  if (!strong.test(pw)) return { ok: false, reason: '密碼必須同時包含英文與數字' };
  return { ok: true };
}
