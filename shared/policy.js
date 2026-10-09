// 身分與法遵政策的唯一定義 — 前端、Vercel API、維運腳本共用（排班引擎 cpsat_service.py 與
// firestore.rules 無法 import，各自寫了相同的判斷，改這裡時要一起改）。
// 純常數 / 純函式、零依賴，瀏覽器與 Node 都能 import。

// 超級管理員：固定帳號，不能被撤銷（避免把所有管理員都撤掉後沒人進得去），
// 也是唯一能授予 / 撤銷其他人管理員權限的帳號。
export const SUPER_ADMIN_EMAIL = 'admin@hospital.com';

// 管理員 = 超級管理員，或 Firebase Auth custom claim admin === true 的員工帳號（由超級管理員在
// 員工管理授予，admin-user action 'set-admin'）。claims 是 verifyIdToken 的結果或
// getIdTokenResult().claims；兩者都帶 email 與自訂 claim。
export function isAdminClaims(claims) {
  if (!claims) return false;
  return isSuperAdminClaims(claims) || claims.admin === true;
}

export function isSuperAdminClaims(claims) {
  return String(claims?.email || '').toLowerCase() === SUPER_ADMIN_EMAIL;
}

// 個資法 §8 告知文案版本。改了 PrivacyNoticePage 的內容就把它往上加（v1 → v2），
// 所有員工下次登入都必須重新閱讀並同意；後端只接受目前版本的同意。
export const PDPA_NOTICE_VERSION = 'v1';
// 該版本的生效日（顯示在告知頁底部）；升版時一起改
export const PDPA_NOTICE_EFFECTIVE_DATE = '2026-05-19';
