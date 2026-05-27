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
import mysql from 'mysql2/promise';

let pool = null;

export function getPool() {
  if (pool) return pool;

  const url = process.env.DATABASE_URL || process.env.MYSQL_URL;
  if (url) {
    pool = mysql.createPool(url);
  } else {
    if (!process.env.MYSQL_HOST) {
      throw new Error('MySQL 未設定：請設 DATABASE_URL 或 MYSQL_HOST 等 env');
    }
    pool = mysql.createPool({
      host: process.env.MYSQL_HOST,
      port: Number(process.env.MYSQL_PORT) || 3306,
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD,
      database: process.env.MYSQL_DATABASE,
      connectionLimit: Number(process.env.MYSQL_POOL_SIZE) || 3,
      // JSON 欄位由 mysql2 自動 parse；timezone 用 UTC 避免本地時區干擾
      timezone: 'Z',
      enableKeepAlive: true,
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
