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
 *
 * 規則：
 *   1. 有 Origin / Referer → 必須在 ALLOWED_ORIGINS 白名單內
 *   2. 沒有 Origin / Referer → 必須帶 Authorization: Bearer ${CRON_SECRET}
 *      （這是 cron job 與內部 server-to-server 呼叫的合法路徑）
 *      否則拒絕。原本「沒 Origin 直接放行」會讓任何 curl/Postman 繞過 CSRF；
 *      改成這樣後縱深防禦才實際有效。
 *
 * @param {object} req - Vercel request object
 * @returns {{ allowed: boolean, origin: string }}
 */
export function checkCsrf(req) {
  const origin = req.headers.origin || req.headers.referer;

  if (origin) {
    const normalizedOrigin = origin.replace(/\/+$/, '');
    const isAllowed = ALLOWED_ORIGINS.some(allowed => normalizedOrigin === allowed);
    return { allowed: isAllowed, origin };
  }

  // 沒 Origin → 必須是 cron / server-to-server 呼叫，需提供 CRON_SECRET 才放行
  const auth = req.headers.authorization;
  if (auth === `Bearer ${process.env.CRON_SECRET}`) {
    return { allowed: true, origin: 'cron' };
  }

  return { allowed: false, origin: 'unknown' };
}
