// MySQL 連線池（serverless 友善）
//
// 混合式儲存（polyglot persistence）的關聯式那一半。目前只有「冷資料 / 不需即時」
// 的 access_logs 走這裡；班表 / 選班輪次 / 員工等「熱資料」仍留在 Firestore。
//
// 設計重點：
//   1. 單例 pool —— Vercel serverless 同一個容器會重用模組，pool 跨 invocation 共用，
//      避免每次請求都重新握手。connectionLimit 刻意設小（serverless 同時實例多，
//      連線數要省，否則容易打爆 MySQL 的 max_connections）。
//   2. 惰性連線 —— getPool() 只有在真的要用 MySQL 時才被呼叫（ACCESS_LOG_BACKEND
//      含 mysql）。env 未設 MySQL 時整支檔案不會被 import，更不會連線。
//   3. 連線設定來源：優先 DATABASE_URL（單一連線字串，PlanetScale / Railway 常見），
//      否則組合 MYSQL_HOST / PORT / USER / PASSWORD / DATABASE。
//
// 需要的 env（設在 Vercel，或本地 .env.local）：
//   DATABASE_URL=mysql://user:pass@host:3306/dbname        ← 二擇一
//   或
//   MYSQL_HOST / MYSQL_PORT / MYSQL_USER / MYSQL_PASSWORD / MYSQL_DATABASE
//
// TLS（雲端 MySQL 幾乎都強制）：
//   本機 MySQL（Laragon 等）不支援也不需要 TLS；雲端（PlanetScale / Aiven / Railway /
//   TiDB Cloud / RDS…）走的是公開網際網路，必須加密。所以這裡預設「自動判斷」：
//   主機是 localhost/127.0.0.1 → 不加密；遠端 → 加密且驗證憑證。可用 env 覆寫：
//     MYSQL_SSL=(unset)            自動（本機關、遠端開並驗證）
//     MYSQL_SSL=true|require|strict  強制加密 + 驗證憑證（公開 CA 的雲端可直接用）
//     MYSQL_SSL=relaxed|no-verify    加密但不驗憑證（自簽 / 測試用）
//     MYSQL_SSL=false|off|disable    不加密
//     MYSQL_SSL_CA=<PEM 內文>        自訂 CA（AWS RDS 這類非公開 CA；隱含 verify）
import mysql from 'mysql2/promise';

let pool = null;

// 依 env + 主機位置決定 mysql2 的 ssl 選項。回傳 undefined = 不設 ssl（交給連線字串自己決定）。
function resolveSsl(host) {
  const ca = process.env.MYSQL_SSL_CA ? process.env.MYSQL_SSL_CA.replace(/\\n/g, '\n') : null;
  const mode = (process.env.MYSQL_SSL || '').trim().toLowerCase();

  if (['false', 'off', 'disable', 'disabled', '0', 'no'].includes(mode)) return undefined;
  if (['relaxed', 'no-verify', 'skip-verify', 'allow'].includes(mode)) {
    return { rejectUnauthorized: false, ...(ca ? { ca } : {}) };
  }
  if (['true', 'require', 'required', 'strict', 'verify', 'on', '1', 'yes'].includes(mode)) {
    return { rejectUnauthorized: true, ...(ca ? { ca } : {}) };
  }
  // 未明確設定 → 自動：有自訂 CA 一律加密；否則本機關、遠端開並驗證
  if (ca) return { rejectUnauthorized: true, ca };
  const isLocal = !host || ['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(host);
  return isLocal ? undefined : { rejectUnauthorized: true };
}

export function getPool() {
  if (pool) return pool;

  // serverless 友善的共用池設定（兩種連線來源都套用）
  const base = {
    connectionLimit: Number(process.env.MYSQL_POOL_SIZE) || 3,
    // JSON 欄位由 mysql2 自動 parse；timezone 用 UTC 避免本地時區干擾
    timezone: 'Z',
    enableKeepAlive: true,
  };

  const url = process.env.DATABASE_URL || process.env.MYSQL_URL;
  if (url) {
    let host = null;
    try { host = new URL(url).hostname; } catch { /* 非標準字串就交給 mysql2 自己 parse */ }
    const ssl = resolveSsl(host);
    // mysql2 支援 { uri, ...額外選項 }：先 parse 連線字串，再合併下列選項（ssl 為加法疊上）
    pool = mysql.createPool({ uri: url, ...base, ...(ssl ? { ssl } : {}) });
  } else {
    if (!process.env.MYSQL_HOST) {
      throw new Error('MySQL 未設定：請設 DATABASE_URL 或 MYSQL_HOST 等 env');
    }
    const ssl = resolveSsl(process.env.MYSQL_HOST);
    pool = mysql.createPool({
      host: process.env.MYSQL_HOST,
      port: Number(process.env.MYSQL_PORT) || 3306,
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD,
      database: process.env.MYSQL_DATABASE,
      ...base,
      ...(ssl ? { ssl } : {}),
    });
  }
  return pool;
}

// JSON 欄位容錯解析：mysql2 對 JSON 型別會自動 parse 成物件，
// 但若欄位是字串或 driver 行為不同，這裡再保底一次。
export function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
