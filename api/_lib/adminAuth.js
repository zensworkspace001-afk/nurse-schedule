// 後端的管理員判斷 — 包一層 shared/policy.js，讓各 API 不必知道 claim 的細節。
export { isAdminClaims as isAdminToken, isSuperAdminClaims as isSuperAdminToken, SUPER_ADMIN_EMAIL } from '../../shared/policy.js';
