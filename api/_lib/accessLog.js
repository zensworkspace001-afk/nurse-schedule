// 敏感欄位存取稽核日誌 (Access Log)
//
// 混合式儲存（polyglot persistence）：可寫 Firestore、MySQL，或兩者（過渡期雙寫）。
// 由 env `ACCESS_LOG_BACKEND` 決定，未設時 = 'firestore'（維持原本行為，部署零風險）：
//   firestore  → 只寫/讀 Firestore（預設）
//   mysql      → 只寫/讀 MySQL
//   both       → 兩邊都寫（雙寫過渡期）；讀取以 MySQL 為主
//
// 設計原則（不因換後端而改變）：
//   1. fire-and-forget — 寫入失敗不可阻擋業務邏輯（每個後端各自 try/catch 吞掉）
//   2. 不記錄明文 — 只記錄「誰、何時、對誰、什麼欄位、什麼動作」
//   3. 包含 IP / UA — 方便事後鑑識
//   4. writeAccessLog 簽名不變 —— 十多支呼叫者一行都不用改
//
// Firestore doc / 回傳給前端的形狀：
//   { ts, actor:{uid,email}, action, target:{kind,id}, fields:[], ip, ua, extra }
import admin from 'firebase-admin';

const BACKEND = (process.env.ACCESS_LOG_BACKEND || 'firestore').toLowerCase();
const USE_MYSQL = BACKEND === 'mysql' || BACKEND === 'both';
const USE_FIRESTORE = BACKEND === 'firestore' || BACKEND === 'both';

export async function writeAccessLog(entry) {
  const tasks = [];
  if (USE_FIRESTORE) tasks.push(writeFirestore(entry));
  if (USE_MYSQL) tasks.push(writeMysql(entry));
  // 各後端內部已自行 try/catch，這裡 allSettled 再保底一層，確保絕不 throw 給業務邏輯
  await Promise.allSettled(tasks);
}

async function writeFirestore({ actor, action, target, fields, ip, ua, extra }) {
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
    console.error('⚠️ access log (firestore) 寫入失敗（不阻擋業務）:', err.message);
  }
}

async function writeMysql({ actor, action, target, fields, ip, ua, extra }) {
  try {
    const { getPool } = await import('./mysql.js'); // 惰性載入：只有要用 MySQL 才連線
    const pool = getPool();
    await pool.execute(
      `INSERT INTO access_logs
         (ts, actor_uid, actor_email, action, target_kind, target_id, fields, ip, ua, extra)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        new Date(),
        actor?.uid || null,
        actor?.email || null,
        action || 'unknown',
        target?.kind || null,
        target?.id || null,
        JSON.stringify(Array.isArray(fields) ? fields : []),
        ip || null,
        ua || null,
        extra ? JSON.stringify(extra) : null,
      ],
    );
  } catch (err) {
    console.error('⚠️ access log (mysql) 寫入失敗（不阻擋業務）:', err.message);
  }
}

// 讀取稽核日誌（給 admin-user.js 的 list-access-logs action 用）。
// 'both' 時以 MySQL 為主（資料較完整、查詢較強）。
export async function readAccessLogs({ limit = 200, action = null, actor = null } = {}) {
  if (USE_MYSQL) return readMysql({ limit, action, actor });
  return readFirestore({ limit, action, actor });
}

async function readMysql({ limit, action, actor }) {
  const { getPool, parseJson } = await import('./mysql.js');
  const pool = getPool();

  const where = [];
  const params = [];
  if (action && action !== 'all') {
    where.push('action = ?');
    params.push(action);
  }
  if (actor) {
    where.push('(actor_email LIKE ? OR actor_uid LIKE ?)');
    params.push(`%${actor}%`, `%${actor}%`);
  }

  // LIMIT 用驗證過的整數直接內插 —— mysql2 prepared statement 對 `LIMIT ?` 支援不穩，
  // 且這裡已 clamp 成安全整數，無注入風險。
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 2000);
  const sql = `
    SELECT id, ts, actor_uid, actor_email, action, target_kind, target_id, fields, ip, ua, extra
      FROM access_logs
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY ts DESC
     LIMIT ${safeLimit}`;

  const [rows] = await pool.query(sql, params);
  // 轉回前端期望的巢狀形狀，與 Firestore 版一致
  return rows.map((r) => ({
    id: String(r.id),
    ts: r.ts instanceof Date ? r.ts.toISOString() : r.ts,
    actor: { uid: r.actor_uid, email: r.actor_email },
    action: r.action,
    target: { kind: r.target_kind, id: r.target_id },
    fields: parseJson(r.fields, []),
    ip: r.ip,
    ua: r.ua,
    extra: parseJson(r.extra, null),
  }));
}

async function readFirestore({ limit, action, actor }) {
  const db = admin.firestore();
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 2000);
  const snap = await db.collection('access_logs')
    .orderBy('ts', 'desc')
    .limit(safeLimit)
    .get();
  let rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  // action / actor 篩選在記憶體做（與原本前端 onSnapshot 後的篩選行為一致）
  if (action && action !== 'all') {
    rows = rows.filter((r) => r.action === action);
  }
  if (actor) {
    const q = actor.toLowerCase();
    rows = rows.filter((r) =>
      (r.actor?.email || '').toLowerCase().includes(q) ||
      (r.actor?.uid || '').toLowerCase().includes(q));
  }
  return rows;
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
