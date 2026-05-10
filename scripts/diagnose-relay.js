// 診斷腳本：直接讀 Firestore 看任一月份排班接力的實際狀態
// 用法：
//   node --env-file=.env.local scripts/diagnose-relay.js                # 預設 9 月
//   node --env-file=.env.local scripts/diagnose-relay.js 2026 5         # 指定 2026 年 5 月
//   node --env-file=.env.local scripts/diagnose-relay.js 2026 9 N003    # 同時檢查 N003 是否該被排除

import admin from 'firebase-admin';

if (!admin.apps.length) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY;
  if (privateKey) privateKey = privateKey.replace(/^"|"$/g, '').replace(/\\n/g, '\n');
  if (!projectId || !clientEmail || !privateKey) {
    console.error('缺 Firebase 憑證');
    process.exit(1);
  }
  admin.initializeApp({ credential: admin.credential.cert({ projectId, clientEmail, privateKey }) });
}

const db = admin.firestore();

// 命令列：node script.js [year] [month] [staffId]
const argYear = Number(process.argv[2]);
const argMonth = Number(process.argv[3]);
const TARGET_STAFF = (process.argv[4] || 'N001').toUpperCase();
const YEAR = Number.isFinite(argYear) ? argYear : 2026;
const MONTH = Number.isFinite(argMonth) ? argMonth : 9;
const YM = `${YEAR}_${MONTH}`;

const norm = (s) => String(s || '').trim().toUpperCase();
const line = '─'.repeat(60);

async function main() {
  console.log(`🔍 診斷 ${YEAR}/${MONTH} 接力狀態 (${YM})  | 目標檢查員工：${TARGET_STAFF}`);
  console.log(line);

  // 1) SelectionTurn — 誰是現任 active
  const turnSnap = await db.doc(`SelectionTurn/${YM}`).get();
  const turnData = turnSnap.exists ? turnSnap.data() : null;
  console.log('\n[1] SelectionTurn/' + YM + '：');
  if (!turnSnap.exists) {
    console.log('  ❌ doc 不存在');
  } else {
    console.log('  active_staff_id =', JSON.stringify(turnData.active_staff_id));
    console.log('  updatedAt       =', turnData.updatedAt?.toDate?.()?.toISOString() || turnData.updatedAt);
  }

  // 2) SelectionProgress — 黑名單
  const progSnap = await db.doc(`SelectionProgress/${YM}`).get();
  const submittedList = progSnap.exists ? (progSnap.data().submitted_staff || []) : [];
  console.log('\n[2] SelectionProgress/' + YM + '.submitted_staff：');
  console.log('  原始 (' + submittedList.length + ' 筆)：', JSON.stringify(submittedList));
  console.log('  正規化 upper：', JSON.stringify(submittedList.map(norm)));
  console.log('  TARGET_STAFF 在裡面嗎？', submittedList.map(norm).includes(TARGET_STAFF) ? '✅ YES' : '❌ NO');

  // 3) Schedules.finalizedSchedule — 看 TARGET_STAFF 是否真的有 key
  const schedSnap = await db.doc(`Schedules/${YM}`).get();
  const finalized = schedSnap.exists ? (schedSnap.data().finalizedSchedule || {}) : {};
  const allKeys = Object.keys(finalized);
  const dKeys = allKeys.filter(k => k.startsWith('D'));
  const nKeys = allKeys.filter(k => !k.startsWith('D'));
  console.log('\n[3] Schedules/' + YM + '.finalizedSchedule：');
  console.log('  總 key 數：' + allKeys.length + ' (虛擬 D：' + dKeys.length + '、已認領：' + nKeys.length + ')');
  console.log('  已認領 key：', nKeys.join(', '));
  console.log('  TARGET_STAFF 有 key 嗎？', allKeys.map(norm).includes(TARGET_STAFF) ? '✅ YES' : '❌ NO');
  if (allKeys.map(norm).includes(TARGET_STAFF)) {
    const exactKey = allKeys.find(k => norm(k) === TARGET_STAFF);
    console.log('     exact key 寫法：' + JSON.stringify(exactKey));
    console.log('     第 1-5 天的 cell：', JSON.stringify(Object.fromEntries(
      Object.entries(finalized[exactKey] || {}).slice(0, 5)
    )));
  }

  // 4) NurseApp/Staff — TARGET_STAFF 的 staffData 紀錄
  const staffSnap = await db.doc('NurseApp/Staff').get();
  const staffData = staffSnap.exists ? (staffSnap.data().staffData || []) : [];
  const n001 = staffData.find(s => norm(s.staff_id) === TARGET_STAFF);
  console.log('\n[4] NurseApp/Staff.staffData 中 TARGET_STAFF：');
  if (!n001) {
    console.log('  ❌ 找不到 TARGET_STAFF / n001');
  } else {
    console.log('  staff_id   =', JSON.stringify(n001.staff_id), '(' + (n001.staff_id === TARGET_STAFF ? '大寫正確' : '⚠️ 大小寫異常！') + ')');
    console.log('  name       =', n001.name);
    console.log('  is_active  =', n001.is_active);
    console.log('  leave_status =', n001.leave_status);
  }

  // 5) AI_Decision_Logs — 最近 5 筆 9 月接力決策
  const aiLogsSnap = await db.collection('AI_Decision_Logs')
    .orderBy('timestamp', 'desc')
    .limit(10)
    .get();
  console.log('\n[5] AI_Decision_Logs（最近 10 筆）：');
  let nineMonthCount = 0;
  aiLogsSnap.docs.forEach(doc => {
    const d = doc.data();
    const ts = d.timestamp?.toDate?.()?.toISOString?.() || d.timestamp || '?';
    const sel = d.selected_staff || d.selected_staff_id || '?';
    const reason = (d.ai_logic || d.reason || '').slice(0, 60);
    console.log(`  ${ts}  → ${sel}  (${reason}...)`);
    nineMonthCount++;
  });
  if (nineMonthCount === 0) console.log('  (無紀錄)');

  // 6) 推論：模擬 auto-relay.js 的篩選邏輯，看 TARGET_STAFF 應該被排除嗎？
  console.log('\n[6] 模擬 auto-relay 篩選 TARGET_STAFF 是否會被選中：');
  if (n001) {
    const sid = norm(n001.staff_id);
    const submittedUpper = submittedList.map(norm);
    const scheduleKeysUpper = allKeys.map(norm);
    const reasons = [];
    if (sid === 'ADMIN' || sid.startsWith('D')) reasons.push('admin/D-prefix');
    if (n001.is_active === false || String(n001.is_active).toLowerCase() === 'false') reasons.push('已停用');
    if (n001.leave_status === 'OnLeave' || n001.leave_status === 'Maternal') reasons.push('長假/產假');
    if (submittedUpper.includes(sid)) reasons.push('在 submittedList');
    if (scheduleKeysUpper.includes(sid)) reasons.push('已認領班表');
    if (reasons.length === 0) {
      console.log('  ⚠️ TARGET_STAFF 不會被排除 → AI 仍可能選到她');
      console.log('     這就是 bug 來源！');
    } else {
      console.log('  ✅ TARGET_STAFF 應該被排除，原因：' + reasons.join(', '));
      console.log('     若 AI 仍指向 TARGET_STAFF，可能是 SelectionTurn 沒更新 / 前端讀到舊值');
    }
  }

  console.log('\n' + line);
  console.log('診斷完成');
}

main().catch(err => { console.error('❌ 失敗:', err); process.exit(1); });
