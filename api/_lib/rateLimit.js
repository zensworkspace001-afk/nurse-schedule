// 簡易記憶體 Rate Limiter（適用 Vercel Serverless）
// 注意：Vercel 每個 function instance 有獨立記憶體，重啟後歸零
// 對於更嚴格的場景應改用 Redis (Upstash) 等外部存儲

const windowMs = 60 * 1000; // 1 分鐘窗口
const store = new Map(); // key: userId, value: { count, resetTime }

// 定期清理過期條目，防止記憶體洩漏
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of store) {
    if (now > val.resetTime) store.delete(key);
  }
}, 5 * 60 * 1000);

/**
 * @param {string} userId - 使用者唯一識別 (Firebase UID 或 IP)
 * @param {number} maxRequests - 窗口內最大請求數
 * @returns {{ allowed: boolean, remaining: number, retryAfterMs: number }}
 */
export function checkRateLimit(userId, maxRequests) {
  const now = Date.now();
  const record = store.get(userId);

  if (!record || now > record.resetTime) {
    store.set(userId, { count: 1, resetTime: now + windowMs });
    return { allowed: true, remaining: maxRequests - 1, retryAfterMs: 0 };
  }

  if (record.count >= maxRequests) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterMs: record.resetTime - now,
    };
  }

  record.count++;
  return { allowed: true, remaining: maxRequests - record.count, retryAfterMs: 0 };
}
