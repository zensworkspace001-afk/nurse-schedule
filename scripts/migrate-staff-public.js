// 一次性遷移腳本：把 NurseApp/Staff 拆出 StaffPublic + StaffPrivate/{staff_id}
//
// 為什麼需要這支：firestore.rules 把 NurseApp/Staff 的讀取收緊到 admin only 之前，
// 必須先把同事用的精簡投影寫到 StaffPublic、把每位員工的私有 row 寫到 StaffPrivate/{id}，
// 否則員工角色會在規則部署後完全看不到任何資料（client SDK 直接被 default-deny）。
//
// 設計原則：
//   - idempotent：可以反覆跑，每次都會用最新的 Staff 內容覆蓋。
//   - dry-run：預設只列印不寫入；加 --commit 才真的寫。
//
// 執行：
//   node scripts/migrate-staff-public.js              # dry-run
//   node scripts/migrate-staff-public.js --commit     # 真正寫入
//
// 必須的環境變數（與 Vercel 後端共用）：
//   FIREBASE_SERVICE_ACCOUNT  或  (FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY)

import admin from 'firebase-admin';

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

// 與 src/api/database.js 的 buildStaffPublicProjection 完全一致
function buildStaffPublic(s) {
  return {
    staff_id: s.staff_id,
    name: s.name,
    level: s.level,
    is_leader: !!s.is_leader,
    is_active: s.is_active !== false,
  };
}

async function main() {
  console.log(COMMIT ? '🔥 COMMIT 模式：將寫入 Firestore' : '🧪 DRY-RUN 模式：僅檢查不寫入');
  console.log('—'.repeat(60));

  const staffSnap = await db.doc('NurseApp/Staff').get();
  if (!staffSnap.exists) {
    console.log('❌ NurseApp/Staff 不存在 — 是否已經遷移過或專案剛起步？');
    process.exit(0);
  }

  const fullStaffData = Array.isArray(staffSnap.data().staffData) ? staffSnap.data().staffData : [];
  if (fullStaffData.length === 0) {
    console.log('⚠️ staffData 為空陣列；仍會建立空的 StaffPublic doc。');
  }

  const publicList = fullStaffData.map(buildStaffPublic);
  console.log(`即將寫入 NurseApp/StaffPublic (${publicList.length} 筆)：`);
  publicList.slice(0, 5).forEach((s) => console.log('  -', s));
  if (publicList.length > 5) console.log(`  ...其餘 ${publicList.length - 5} 筆省略`);

  console.log(`\n即將寫入 NurseApp/StaffPrivate/{staff_id} (${fullStaffData.length} 筆)：`);
  fullStaffData.slice(0, 3).forEach((s) => {
    console.log(`  - ${s.staff_id} (${s.name})`);
  });
  if (fullStaffData.length > 3) console.log(`  ...其餘 ${fullStaffData.length - 3} 筆省略`);

  if (!COMMIT) {
    console.log('\n（dry-run）跳過實際寫入。確認無誤後加 --commit 重跑。');
    return;
  }

  // batch 上限 500，分批
  const CHUNK = 400;
  let written = 0;
  for (let i = 0; i < fullStaffData.length; i += CHUNK) {
    const slice = fullStaffData.slice(i, i + CHUNK);
    const batch = db.batch();
    if (i === 0) {
      // 第一個 batch 順便把 StaffPublic 整個覆蓋寫入
      batch.set(db.doc('NurseApp/StaffPublic'), { staffData: publicList });
    }
    for (const s of slice) {
      if (!s.staff_id) continue;
      batch.set(db.doc(`NurseApp/StaffPrivate/${s.staff_id}`), s);
    }
    await batch.commit();
    written += slice.length;
    console.log(`✅ 已寫入 ${written}/${fullStaffData.length}`);
  }

  console.log('\n🎉 遷移完成。可以安全部署收緊後的 firestore.rules 了。');
}

main().catch((err) => {
  console.error('❌ 遷移失敗：', err);
  process.exit(1);
});
