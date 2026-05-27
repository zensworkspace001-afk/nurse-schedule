// 一次性遷移腳本：把 Firestore `access_logs` 複製進 MySQL。
//
// 混合式儲存（polyglot persistence）第一步——把「冷資料 / 不需即時」的稽核日誌
// 搬到 MySQL，班表等熱資料仍留 Firestore。搬完後把 ACCESS_LOG_BACKEND 設成 mysql
// （或先 both 雙寫過渡）即可。
//
// 設計原則：
//   - idempotent-ish：用 Firestore doc id 當去重鍵（extra.firestore_id），可反覆跑不重複塞。
//   - dry-run：預設只列印不寫入；加 --commit 才真的寫。
//   - 自動建表：先跑 CREATE TABLE IF NOT EXISTS（與 sql/access_logs.sql 同步）。
//
// 執行（注意要載入 env，Firebase + MySQL 憑證都靠它）：
//   node --env-file=.env.local scripts/migrate-access-logs-to-mysql.js            # dry-run
//   node --env-file=.env.local scripts/migrate-access-logs-to-mysql.js --commit   # 真正寫入
//
// 需要的環境變數：
//   Firebase：FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY（或 FIREBASE_SERVICE_ACCOUNT）
//   MySQL：   DATABASE_URL  或  MYSQL_HOST/PORT/USER/PASSWORD/DATABASE

import admin from 'firebase-admin';
import mysql from 'mysql2/promise';

const COMMIT = process.argv.includes('--commit');

// ---- Firebase Admin 初始化（與其他遷移腳本一致）----
if (!admin.apps.length) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY;
  if (privateKey) privateKey = privateKey.replace(/^"|"$/g, '').replace(/\\n/g, '\n');

  if (projectId && clientEmail && privateKey) {
    admin.initializeApp({ credential: admin.credential.cert({ projectId, clientEmail, privateKey }) });
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT && process.env.FIREBASE_SERVICE_ACCOUNT.length > 50) {
    let sa;
    try {
      sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } catch (err) {
      console.error('FIREBASE_SERVICE_ACCOUNT 不是合法 JSON：', err.message);
      process.exit(1);
    }
    if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, '\n');
    admin.initializeApp({ credential: admin.credential.cert(sa) });
  } else {
    console.error('找不到 Firebase 憑證。請確認 .env.local 有 FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY。');
    process.exit(1);
  }
}

const db = admin.firestore();

// ---- MySQL 連線 ----
function makeMysqlPool() {
  const url = process.env.DATABASE_URL || process.env.MYSQL_URL;
  if (url) return mysql.createPool(url);
  if (!process.env.MYSQL_HOST) {
    console.error('找不到 MySQL 設定。請設 DATABASE_URL 或 MYSQL_HOST 等 env。');
    process.exit(1);
  }
  return mysql.createPool({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT) || 3306,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    connectionLimit: 3,
    timezone: 'Z',
  });
}

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS access_logs (
    id           BIGINT AUTO_INCREMENT PRIMARY KEY,
    ts           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    actor_uid    VARCHAR(40),
    actor_email  VARCHAR(120),
    action       VARCHAR(30)  NOT NULL,
    target_kind  VARCHAR(30),
    target_id    VARCHAR(64),
    fields       JSON,
    ip           VARCHAR(45),
    ua           VARCHAR(255),
    extra        JSON,
    INDEX idx_ts (ts),
    INDEX idx_actor_uid (actor_uid),
    INDEX idx_action (action)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

async function main() {
  console.log(COMMIT ? '🔥 COMMIT 模式：將寫入 MySQL' : '🧪 DRY-RUN 模式：僅檢查不寫入');
  console.log('—'.repeat(60));

  const snap = await db.collection('access_logs').orderBy('ts', 'asc').get();
  const docs = snap.docs;
  console.log(`Firestore access_logs 共 ${docs.length} 筆`);
  if (docs.length === 0) {
    console.log('沒有資料可搬，結束。');
    return;
  }

  // 預覽前幾筆
  docs.slice(0, 3).forEach((d) => {
    const x = d.data();
    console.log(`  - ${x.ts} | ${x.action} | ${x.actor?.email || x.actor?.uid || '-'}`);
  });
  if (docs.length > 3) console.log(`  ...其餘 ${docs.length - 3} 筆省略`);

  if (!COMMIT) {
    console.log('\n（dry-run）跳過實際寫入。確認無誤後加 --commit 重跑。');
    return;
  }

  const pool = makeMysqlPool();
  await pool.query(CREATE_TABLE);

  // 用 firestore doc id 去重：先撈已存在的，避免重複跑時塞兩次
  const [existingRows] = await pool.query(
    "SELECT JSON_UNQUOTE(JSON_EXTRACT(extra, '$.firestore_id')) AS fid FROM access_logs WHERE JSON_EXTRACT(extra, '$.firestore_id') IS NOT NULL",
  );
  const seen = new Set(existingRows.map((r) => r.fid));

  let written = 0;
  let skipped = 0;
  for (const d of docs) {
    if (seen.has(d.id)) { skipped++; continue; }
    const x = d.data();
    const extra = { ...(x.extra || {}), firestore_id: d.id }; // 標記來源，供去重
    await pool.execute(
      `INSERT INTO access_logs
         (ts, actor_uid, actor_email, action, target_kind, target_id, fields, ip, ua, extra)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        x.ts ? new Date(x.ts) : new Date(),
        x.actor?.uid || null,
        x.actor?.email || null,
        x.action || 'unknown',
        x.target?.kind || null,
        x.target?.id || null,
        JSON.stringify(Array.isArray(x.fields) ? x.fields : []),
        x.ip || null,
        x.ua || null,
        JSON.stringify(extra),
      ],
    );
    written++;
    if (written % 200 === 0) console.log(`  ✅ 已寫入 ${written} 筆…`);
  }

  await pool.end();
  console.log(`\n🎉 完成：新增 ${written} 筆，略過 ${skipped} 筆（已存在）。`);
  console.log('接著把 ACCESS_LOG_BACKEND 設成 mysql（或先 both 雙寫過渡）即可切換。');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ 遷移失敗：', err);
    process.exit(1);
  });
