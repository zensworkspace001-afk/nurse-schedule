// 一次性遷移腳本：把 Firestore 既有明文敏感欄位升級為密文。
//
// 目前處理：
//   - NurseApp/Settings.baseSalary （number → 密文 blob）
//   - NurseApp/Staff.staffData[*].idNumber / bankAccount / phone （string → 密文 blob）
//
// 設計原則：
//   - idempotent：已加密的欄位（具備 ct/iv/tag/v）會被略過。
//   - dry-run：預設只列印不寫入；加 --commit 才真的寫。
//   - 備份：寫入前會先 dump 一份明文到 ./scripts/migration-backup-{timestamp}.json
//
// 執行：
//   node scripts/migrate-encrypt.js              # dry-run
//   node scripts/migrate-encrypt.js --commit     # 真正寫入
//
// 必須的環境變數（與 Vercel 後端共用）：
//   FIELD_ENC_KEY
//   FIREBASE_SERVICE_ACCOUNT  或  (FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY)

import admin from 'firebase-admin';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encryptField, isEncrypted } from '../api/_lib/crypto.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMMIT = process.argv.includes('--commit');

if (!admin.apps.length) {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    let sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, '\n');
    admin.initializeApp({ credential: admin.credential.cert(sa) });
  } else {
    let pk = process.env.FIREBASE_PRIVATE_KEY;
    if (pk) pk = pk.replace(/^"|"$/g, '').replace(/\\n/g, '\n');
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

async function main() {
  console.log(COMMIT ? '🔥 COMMIT 模式：將寫入 Firestore' : '🧪 DRY-RUN 模式：僅檢查不寫入');
  console.log('—'.repeat(60));

  const settingsRef = db.doc('NurseApp/Settings');
  const staffRef = db.doc('NurseApp/Staff');
  const [settingsSnap, staffSnap] = await Promise.all([settingsRef.get(), staffRef.get()]);

  const settingsBefore = settingsSnap.exists ? settingsSnap.data() : null;
  const staffBefore = staffSnap.exists ? staffSnap.data() : null;

  // 備份原始資料
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(__dirname, `migration-backup-${stamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify({ Settings: settingsBefore, Staff: staffBefore }, null, 2));
  console.log(`📦 已備份原始資料到：${backupPath}`);

  // 1) Settings.baseSalary
  let settingsUpdate = null;
  if (settingsBefore && settingsBefore.baseSalary !== undefined) {
    if (isEncrypted(settingsBefore.baseSalary)) {
      console.log('✅ Settings.baseSalary 已是密文，略過');
    } else {
      const blob = encryptField(Number(settingsBefore.baseSalary));
      console.log(`🔒 Settings.baseSalary：${settingsBefore.baseSalary} → 密文`);
      settingsUpdate = { baseSalary: blob };
    }
  } else {
    console.log('ℹ️  Settings.baseSalary 不存在，略過');
  }

  // 2) Staff.staffData[*] 的敏感欄位
  let staffUpdate = null;
  if (staffBefore?.staffData && Array.isArray(staffBefore.staffData)) {
    let touched = 0;
    const newList = staffBefore.staffData.map((staff) => {
      const next = { ...staff };
      ['idNumber', 'bankAccount', 'phone'].forEach((f) => {
        const cur = staff[f];
        if (cur === undefined || cur === null || cur === '') return;
        if (isEncrypted(cur)) return;
        next[f] = encryptField(String(cur));
        touched++;
        console.log(`🔒 Staff[${staff.staff_id}].${f} → 密文`);
      });
      return next;
    });
    if (touched > 0) {
      staffUpdate = { staffData: newList };
      console.log(`📊 共加密 ${touched} 個員工敏感欄位`);
    } else {
      console.log('✅ 員工敏感欄位皆已為密文或無資料，無需動作');
    }
  }

  if (!settingsUpdate && !staffUpdate) {
    console.log('—'.repeat(60));
    console.log('🎉 沒有需要遷移的欄位。');
    return;
  }

  if (!COMMIT) {
    console.log('—'.repeat(60));
    console.log('🧪 DRY-RUN 結束。確認無誤後加上 --commit 重跑以實際寫入。');
    return;
  }

  if (settingsUpdate) {
    await settingsRef.set(settingsUpdate, { merge: true });
    console.log('✍️  Settings 寫入完成');
  }
  if (staffUpdate) {
    await staffRef.set(staffUpdate, { merge: true });
    console.log('✍️  Staff 寫入完成');
  }
  console.log('—'.repeat(60));
  console.log('🎉 遷移完成。如需復原可從備份檔還原。');
}

main().catch((err) => {
  console.error('❌ 遷移失敗:', err);
  process.exit(1);
});
