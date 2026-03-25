// CSRF 防護：驗證請求來源
// Bearer token 不會被瀏覽器自動附帶 (不像 cookie)，所以 CSRF 風險較低
// 但仍加上 Origin 檢查作為縱深防禦

const ALLOWED_ORIGINS = [
  'https://nurse-schedule-bachelor.vercel.app',
  'http://localhost:5173',  // 本地開發
  'http://localhost:3000',
];

/**
 * 驗證請求來源是否合法
 * @param {object} req - Vercel request object
 * @returns {{ allowed: boolean, origin: string }}
 */
export function checkCsrf(req) {
  // Cron 或伺服器對伺服器呼叫沒有 Origin header，允許通過
  const origin = req.headers.origin || req.headers.referer;
  if (!origin) return { allowed: true, origin: 'server-to-server' };

  const isAllowed = ALLOWED_ORIGINS.some(allowed => origin.startsWith(allowed));
  return { allowed: isAllowed, origin };
}
