import { isAdminClaims } from '../../../shared/policy.js';

// Firebase Auth 使用者 → App 的 currentUser。LoginPanel（表單登入）與 App（重新整理後還原 session）
// 共用，兩邊形狀必須一致。管理員身分看 ID token 的 claims（shared/policy.js），不再只看帳號名稱：
//   - admin@hospital.com          → 超級管理員
//   - 員工帳號 + claim admin:true → 管理員（被授權的護理長），仍保留自己的工號
export async function buildUserPayload(user) {
  const localPart = (user.email || '').split('@')[0].toLowerCase();
  if (localPart === 'admin') {
    return { id: 'ADMIN', name: '管理人員', role: 'admin', isSuperAdmin: true };
  }
  let claims = {};
  try {
    claims = (await user.getIdTokenResult()).claims || {};
  } catch { /* 取不到 claims 就當一般員工 — 後端與規則仍會各自驗證 */ }
  if (isAdminClaims(claims)) {
    return { id: localPart.toUpperCase(), name: `${localPart.toUpperCase()}（管理員）`, role: 'admin', isSuperAdmin: false };
  }
  return { id: localPart.toUpperCase(), name: '載入中...', role: 'staff', rule: 'Standard' };
}
