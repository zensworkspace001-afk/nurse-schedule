// 一次性遷移：把 Firebase Auth 端 UID 與 staff_id 不一致的帳號重建
//
// 背景：
//   舊版 admin-user.js (sync-accounts.js) 用 createUser 沒指定 uid，
//   Firebase 會自動產生 28 字隨機 UID（如 67Volw5UJwexeLXPBd1nj...）。
//   新版固定 uid: staff_id（如 N001）。Firestore rules 對 StaffPrivate/{id}
//   要求 request.auth.uid == staffId 才能讀 — 舊帳號因此永遠拿不到自己的私有資料，
//   console 會狂噴 "Missing or insufficient permissions"。
//
// Firebase Auth 不允許修改 uid，唯一路徑是「刪舊建新」：
//   1. 比對每位員工 email 對應的 Auth 帳號，找出 uid != staff_id 的「歪斜」帳號
//   2. 刪掉舊帳號（Firebase Auth）→ Firestore 資料不動（StaffPrivate/{staff_id}
//      用 staff_id 當 key，與 Auth UID 無關）
//   3. 用 uid: staff_id 建新帳號（disabled: true + 隨機 throwaway 密碼）
//   4. 撤銷舊 activation token，發新的，寄啟用信讓員工自行設定密碼
//
// 風險：被重建的員工會被踢出登入，必須重新從 email 啟用。先確認你能接受這代價再 --commit。
//
// 執行：
//   node --env-file=.env.local scripts/migrate-realign-auth-uid.js          # dry-run
//   node --env-file=.env.local scripts/migrate-realign-auth-uid.js --commit # 實際執行
//   --skip-email                                                            # 不寄啟用信（自行通知員工）
//
// 必須環境變數：
//   FIREBASE_SERVICE_ACCOUNT 或 (FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY)
//   CRON_SECRET            （--skip-email=false 時呼叫 /api/sendEmail 需要）
//   VERCEL_PROJECT_PRODUCTION_URL  或 ACTIVATION_BASE_URL  （生啟用信連結用）

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import admin from 'firebase-admin';
import {
  issueToken,
  revokeTokensForUid,
} from '../api/_lib/activationToken.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMMIT = process.argv.includes('--commit');
const SKIP_EMAIL = process.argv.includes('--skip-email');

if (!admin.apps.length) {
  // 先嘗試 FIREBASE_SERVICE_ACCOUNT（單一 JSON blob），失敗就 fallback 到三件組。
  // 失敗常見原因：.env.local 把多行 JSON 直接貼進去，但 Node 的 --env-file 不支援跨行值。
  let usedServiceAccount = false;
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      let sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, '\n');
      admin.initializeApp({ credential: admin.credential.cert(sa) });
      usedServiceAccount = true;
    } catch (err) {
      console.warn(`⚠️  FIREBASE_SERVICE_ACCOUNT 解析失敗（${err.message}），改用 PROJECT_ID/CLIENT_EMAIL/PRIVATE_KEY 三件組`);
    }
  }
  if (!usedServiceAccount) {
    let pk = process.env.FIREBASE_PRIVATE_KEY;
    if (pk) pk = pk.replace(/^"|"$/g, '').replace(/\\n/g, '\n');
    if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_CLIENT_EMAIL || !pk) {
      console.error('❌ 找不到 Firebase 憑證 — 請設定 FIREBASE_SERVICE_ACCOUNT 或 PROJECT_ID/CLIENT_EMAIL/PRIVATE_KEY');
      process.exit(1);
    }
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: pk,
      }),
    });
  }
}

const db = admin.firestore();
const auth = admin.auth();

function getBaseUrl() {
  if (process.env.ACTIVATION_BASE_URL) return process.env.ACTIVATION_BASE_URL.replace(/\/+$/, '');
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return 'https://nurse-schedule-bachelor.vercel.app';
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function sendActivationLink(baseUrl, { email, name, plainToken }) {
  const link = `${baseUrl}/activate?token=${plainToken}`;
  const ttlHours = Number(process.env.ACTIVATION_TOKEN_TTL_HOURS) || 2;
  const html = `
    <h2>您好 ${escapeHtml(name)}：</h2>
    <p>系統管理員已為您升級護理排班系統的登入帳號（提升安全性）。<br/>
    為了保留您的存取權限，請點擊以下連結重新設定登入密碼：</p>
    <p><a href="${link}" style="display:inline-block;padding:10px 20px;background:#0066cc;color:#fff;text-decoration:none;border-radius:4px;">點我重設密碼並登入</a></p>
    <p>或複製以下網址至瀏覽器開啟：<br/><code>${link}</code></p>
    <hr/>
    <p style="color:#888;font-size:12px;">此連結 ${ttlHours} 小時內有效，僅可使用一次。<br/>若您未請求此操作，請忽略此信。</p>
  `;
  const r = await fetch(`${baseUrl}/api/sendEmail`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.CRON_SECRET}`,
    },
    body: JSON.stringify({
      to: email,
      subject: '【護理排班系統】帳號升級通知 — 請重新設定登入密碼',
      html,
    }),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error || `寄信回應 ${r.status}`);
  }
}

async function main() {
  console.log(COMMIT ? '🔥 COMMIT 模式：將實際刪除並重建 Auth 帳號' : '🧪 DRY-RUN 模式：僅檢查不寫入');
  console.log(SKIP_EMAIL ? '✉️  --skip-email：不會寄啟用信（請自行通知員工）' : '✉️  將寄啟用信給每位被重建的員工');
  console.log('—'.repeat(60));

  // 1. 讀員工名單
  const staffSnap = await db.doc('NurseApp/Staff').get();
  if (!staffSnap.exists) {
    console.error('❌ 找不到 NurseApp/Staff doc');
    process.exit(1);
  }
  const staffData = staffSnap.data().staffData || [];
  console.log(`📋 員工資料共 ${staffData.length} 筆`);

  // 2. 比對每位員工的 Auth UID 是否已對齊 staff_id
  const misaligned = [];
  const missing = [];
  const aligned = [];

  for (const staff of staffData) {
    const staffId = staff.staff_id;
    if (!staffId || staffId === 'admin') continue;

    const loginEmail = `${staffId.toLowerCase()}@hospital.com`;
    try {
      const userRecord = await auth.getUserByEmail(loginEmail);
      if (userRecord.uid === staffId) {
        aligned.push({ staffId, uid: userRecord.uid });
      } else {
        misaligned.push({
          staffId,
          oldUid: userRecord.uid,
          loginEmail,
          name: staff.name || staffId,
          notifyEmail: staff.email || null,
          disabled: userRecord.disabled,
        });
      }
    } catch (err) {
      if (err.code === 'auth/user-not-found') {
        missing.push({ staffId, loginEmail, name: staff.name || staffId });
      } else {
        console.error(`⚠️ 查詢 ${staffId} 失敗:`, err.message);
      }
    }
  }

  console.log(`✅ 已對齊：${aligned.length} 位`);
  console.log(`🚫 未建立 Auth 帳號：${missing.length} 位（這些員工從未啟用過）`);
  console.log(`⚠️  歪斜需要重建：${misaligned.length} 位`);
  console.log('—'.repeat(60));

  if (misaligned.length === 0) {
    console.log('🎉 沒有需要修正的帳號，結束。');
    return;
  }

  // 3. 備份歪斜清單
  const backupPath = path.join(__dirname, `migration-realign-backup-${Date.now()}.json`);
  fs.writeFileSync(backupPath, JSON.stringify({ misaligned, aligned, missing }, null, 2), 'utf8');
  console.log(`💾 已備份至：${backupPath}`);
  console.log('—'.repeat(60));

  misaligned.forEach((row, i) => {
    console.log(`${i + 1}. ${row.staffId} (${row.name})`);
    console.log(`   舊 UID: ${row.oldUid}`);
    console.log(`   email:  ${row.loginEmail}`);
    console.log(`   notify: ${row.notifyEmail || '⚠️  staffData 內沒設定 email — 無法寄啟用信'}`);
  });
  console.log('—'.repeat(60));

  if (!COMMIT) {
    console.log('🧪 DRY-RUN 結束。再加 --commit 才會真的執行。');
    return;
  }

  // 4. 實際執行：每位員工刪舊建新
  const baseUrl = getBaseUrl();
  let successCount = 0;
  let failCount = 0;
  const failures = [];

  for (const row of misaligned) {
    try {
      console.log(`🔄 處理 ${row.staffId}...`);

      // a. 刪舊 Auth 帳號
      await auth.deleteUser(row.oldUid);
      console.log(`   ✅ 刪除舊 UID ${row.oldUid}`);

      // b. 建新 Auth 帳號（uid = staff_id, disabled）
      const randomPassword = crypto.randomBytes(24).toString('base64');
      await auth.createUser({
        uid: row.staffId,
        email: row.loginEmail,
        password: randomPassword,
        displayName: row.name,
        disabled: true,
      });
      console.log(`   ✅ 建立新 UID ${row.staffId} (disabled)`);

      // c. 清掉舊 activation token（如果還有殘留）
      await revokeTokensForUid(row.oldUid);
      await revokeTokensForUid(row.staffId);

      // d. 發新 activation token + 寄信
      if (!SKIP_EMAIL && row.notifyEmail) {
        const plainToken = await issueToken({
          uid: row.staffId,
          email: row.notifyEmail,
          purpose: 'activation',
        });
        await sendActivationLink(baseUrl, {
          email: row.notifyEmail,
          name: row.name,
          plainToken,
        });
        console.log(`   ✅ 已寄啟用信至 ${row.notifyEmail}`);
      } else if (SKIP_EMAIL) {
        const plainToken = await issueToken({
          uid: row.staffId,
          email: row.notifyEmail || row.loginEmail,
          purpose: 'activation',
        });
        console.log(`   📝 token (請手動轉交給員工): ${plainToken}`);
      } else {
        console.log(`   ⚠️  跳過寄信 — staffData.email 未設定`);
      }

      successCount++;
    } catch (err) {
      console.error(`   ❌ ${row.staffId} 失敗:`, err.message);
      failures.push({ staffId: row.staffId, error: err.message });
      failCount++;
    }
  }

  console.log('—'.repeat(60));
  console.log(`✅ 成功重建：${successCount} 位`);
  console.log(`❌ 失敗：${failCount} 位`);
  if (failures.length) {
    console.log('失敗清單：');
    failures.forEach(f => console.log(`  - ${f.staffId}: ${f.error}`));
  }
  console.log(`💾 完整備份在：${backupPath}（如需 rollback 請手動處理 Firebase Auth）`);
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('💥 致命錯誤:', err);
    process.exit(1);
  });
