// 一次性救援腳本：從 StaffPrivate/* 重建 NurseApp/Staff + StaffPublic
//
// 觸發場景：App.jsx 的 auto-save engine 早期版本沒對 staffData 加「不寫空」guard，
// admin 登入後 subscribeToStaff 的 snapshot 晚於 2s timeout 時，會把 [] 寫進雲端，
// 把 NurseApp/Staff.staffData 與 NurseApp/StaffPublic.staffData 都清空。
// StaffPrivate/{id} 因為 saveGlobalStaff 的 for loop 不會跑空陣列所以倖存。
//
// 這個 script：
//   1. 讀 StaffPrivate collection 所有 doc → 重建 staffData 陣列
//   2. 用 saveGlobalStaff 同款邏輯寫回 Staff + StaffPublic
//   3. 不動 StaffPrivate（它本來就是源頭）
//
// 執行：
//   node --env-file=.env.local scripts/restore-staff-from-private.js          # dry-run
//   node --env-file=.env.local scripts/restore-staff-from-private.js --commit # 實際寫回

import admin from 'firebase-admin';

const COMMIT = process.argv.includes('--commit');

if (!admin.apps.length) {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      let sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, '\n');
      admin.initializeApp({ credential: admin.credential.cert(sa) });
    } catch (err) {
      console.warn(`⚠️  FIREBASE_SERVICE_ACCOUNT 解析失敗（${err.message}），改用三件組`);
    }
  }
  if (!admin.apps.length) {
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

function buildStaffPublicProjection(fullList) {
  return fullList.map((s) => ({
    staff_id: s.staff_id,
    name: s.name,
    level: s.level,
    is_leader: !!s.is_leader,
    is_active: s.is_active !== false,
  }));
}

async function main() {
  console.log(COMMIT ? '🔥 COMMIT 模式：將實際寫回雲端' : '🧪 DRY-RUN 模式：僅檢查不寫入');
  console.log('—'.repeat(60));

  // 1. 讀 StaffPrivate collection
  const privColl = await db.collection('StaffPrivate').get();
  console.log(`📁 StaffPrivate 共 ${privColl.size} 筆 doc`);

  if (privColl.size === 0) {
    console.error('❌ StaffPrivate 也是空的，無法還原。請改從其他備份來源恢復。');
    process.exit(1);
  }

  // 2. 整理成 staffData 陣列（依 staff_id 排序，讓順序可預期）
  const staffData = privColl.docs
    .map(d => d.data())
    .filter(s => s && s.staff_id)
    .sort((a, b) => String(a.staff_id).localeCompare(String(b.staff_id)));

  console.log(`📊 重建後 staffData 共 ${staffData.length} 筆`);
  console.log('   前 5 筆：', staffData.slice(0, 5).map(s => `${s.staff_id}(${s.name || '?'})`).join(', '));

  // 3. 看一下 Staff doc 上有沒有其他要保留的欄位（如 healthStats）
  const staffSnap = await db.doc('NurseApp/Staff').get();
  const existing = staffSnap.exists ? staffSnap.data() : {};
  const healthStats = existing.healthStats || [];
  console.log(`📊 既有 healthStats 保留 ${healthStats.length} 筆`);

  // 4. 建 public projection
  const publicList = buildStaffPublicProjection(staffData);
  console.log(`📊 StaffPublic 投影共 ${publicList.length} 筆`);

  console.log('—'.repeat(60));

  if (!COMMIT) {
    console.log('🧪 DRY-RUN 結束。加 --commit 才會真的寫回。');
    return;
  }

  // 5. 寫回 — 用 batch 確保原子性（同款於 src/api/database.js saveGlobalStaff）
  const batch = db.batch();
  batch.set(db.doc('NurseApp/Staff'), { staffData, healthStats }, { merge: true });
  batch.set(db.doc('NurseApp/StaffPublic'), { staffData: publicList }, { merge: false });
  await batch.commit();

  console.log('✅ 還原完成：');
  console.log(`   - NurseApp/Staff.staffData: ${staffData.length} 筆`);
  console.log(`   - NurseApp/StaffPublic.staffData: ${publicList.length} 筆`);
  console.log(`   - StaffPrivate/* 未動`);
  console.log('');
  console.log('🛡️  記得確認 App.jsx 的 auto-save guard 已部署，否則 admin 一登入又會被清空。');
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('💥 致命錯誤:', err);
    process.exit(1);
  });
