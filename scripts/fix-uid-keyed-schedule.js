// 一次性修復：把 Schedules/{ym}.finalizedSchedule 裡用 Firebase Auth 自動 UID 當 key 的 row
// 重新對應到真正的 staff_id（從 Auth 使用者的 email 反推）。
//
// 為什麼會有這種爛資料：在 admin-user.js 強制 uid:staff_id 之前建立的 Auth 使用者
// 帶有 Firebase 自動產生的 28 字 UID。當他們認領班表時 schedule key 就被寫成那個 UID
// 而非 N001 / N002。前端用 staffData.find(s.staff_id === key) 找不到，畫面上那一列
// 的姓名與工號都顯示為長串 UID 字串。
//
// 此 script 會：
//   1. 列出 Schedules collection 內每份月班表的 finalizedSchedule keys
//   2. 把不符合 ^[A-Z]\d{3}$ 形式的 key 視為「異常 key」
//   3. 對每個異常 key 用 Firebase Auth 查使用者 email，從 email 反推 staff_id
//   4. 把資料搬到正確 key、刪除舊 key（含 SchedulesPublic 的鏡像）
//
// 執行：
//   node --env-file=.env.local scripts/fix-uid-keyed-schedule.js          # dry-run
//   node --env-file=.env.local scripts/fix-uid-keyed-schedule.js --commit # 真正寫入

import admin from 'firebase-admin';

const COMMIT = process.argv.includes('--commit');

if (!admin.apps.length) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY;
  if (privateKey) privateKey = privateKey.replace(/^"|"$/g, '').replace(/\\n/g, '\n');

  if (projectId && clientEmail && privateKey) {
    admin.initializeApp({ credential: admin.credential.cert({ projectId, clientEmail, privateKey }) });
  } else {
    console.error('找不到 Firebase 憑證');
    process.exit(1);
  }
}

const db = admin.firestore();
const auth = admin.auth();

// 正常的 staff_id 是 N001/D001 等形式（一個英文字母 + 3 數字）。其他都當作待修正 key。
const VALID_KEY = /^[A-Z]\d{3}$/i;

// 與 src/api/database.js 的遮罩函式一致
const SENSITIVE = new Set(['事假', '病假', '特休']);
function sanitizeCell(cell) {
  if (cell == null) return cell;
  if (typeof cell === 'string') return SENSITIVE.has(cell) ? 'OFF' : cell;
  if (typeof cell === 'object' && SENSITIVE.has(cell.type)) return { ...cell, type: 'OFF' };
  return cell;
}
function buildSchedulePublicMasked(finalized) {
  if (!finalized || typeof finalized !== 'object') return {};
  const out = {};
  for (const [key, dayCells] of Object.entries(finalized)) {
    if (!dayCells || typeof dayCells !== 'object') continue;
    const sanitized = {};
    for (const [day, cell] of Object.entries(dayCells)) sanitized[day] = sanitizeCell(cell);
    out[key] = sanitized;
  }
  return out;
}

async function resolveStaffIdFromUid(uid) {
  try {
    const user = await auth.getUser(uid);
    const email = user.email || '';
    const m = email.match(/^([^@]+)@hospital\.com$/i);
    return m ? m[1].toUpperCase() : null;
  } catch {
    return null;
  }
}

async function main() {
  console.log(COMMIT ? '🔥 COMMIT 模式：將寫入 Firestore' : '🧪 DRY-RUN 模式：僅檢查不寫入');
  console.log('—'.repeat(60));

  const snap = await db.collection('Schedules').get();
  if (snap.empty) {
    console.log('Schedules collection 空，無需修復。');
    return;
  }

  let totalFixed = 0;

  for (const doc of snap.docs) {
    const data = doc.data();
    const finalized = data.finalizedSchedule || {};
    const badKeys = Object.keys(finalized).filter(k => !VALID_KEY.test(k));
    if (badKeys.length === 0) continue;

    console.log(`\n[${doc.id}] 發現 ${badKeys.length} 個異常 key：`);
    const renames = []; // [{ oldKey, newKey, payload }]
    for (const badKey of badKeys) {
      const staffId = await resolveStaffIdFromUid(badKey);
      if (!staffId) {
        console.log(`  ❌ ${badKey} → 無法從 Auth 反查 email，留待手動處理`);
        continue;
      }
      if (finalized[staffId]) {
        console.log(`  ⚠️ ${badKey} → ${staffId}（但 ${staffId} 已存在，不覆蓋；建議手動合併）`);
        continue;
      }
      console.log(`  ✅ ${badKey} → ${staffId}`);
      renames.push({ oldKey: badKey, newKey: staffId, payload: finalized[badKey] });
    }

    if (renames.length === 0) continue;

    if (COMMIT) {
      // 用 dot-path delete 舊 key、set 新 key（一個 update 完成所有 rename）
      const updates = {};
      for (const { oldKey, newKey, payload } of renames) {
        updates[`finalizedSchedule.${oldKey}`] = admin.firestore.FieldValue.delete();
        updates[`finalizedSchedule.${newKey}`] = payload;
      }
      await doc.ref.update(updates);

      // 同步重建 SchedulesPublic
      const updated = { ...finalized };
      for (const { oldKey, newKey, payload } of renames) {
        delete updated[oldKey];
        updated[newKey] = payload;
      }
      const masked = buildSchedulePublicMasked(updated);
      await db.doc(`SchedulesPublic/${doc.id}`).set({ finalizedSchedule: masked });

      totalFixed += renames.length;
      console.log(`  ✓ 已寫入 ${renames.length} 個 rename`);
    }
  }

  console.log('—'.repeat(60));
  if (COMMIT) console.log(`🎉 修復完成，共 rename ${totalFixed} 個 key。`);
  else console.log('（dry-run）跳過實際寫入。確認無誤後加 --commit 重跑。');
}

main().catch(err => { console.error('❌ 失敗：', err); process.exit(1); });
