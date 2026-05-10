// 列出 Firestore 實際的 top-level collections，跟程式碼用到的清單比對
import admin from 'firebase-admin';

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

const db = admin.firestore();

// 從程式碼掃出來的「正在用」列表
const USED = {
  'NurseApp': ['Settings', 'Staff', 'StaffPublic'],
  'StaffPrivate': '* (one doc per staff_id)',
  'Schedules': '* (one doc per YYYY_M)',
  'SchedulesPublic': '* (one doc per YYYY_M)',
  'SelectionTurn': '* (one doc per YYYY_M + latest)',
  'SelectionProgress': '* (one doc per YYYY_M)',
  'AI_Decision_Logs': '* (一筆對應一次 AI 決策)',
  'access_logs': '* (一筆對應一次敏感資料存取)',
  'archive_reports': '* (一筆對應一份歷史結算)',
  'pending_activation': '* (一筆對應一個未消化的 token hash)',
};

async function main() {
  console.log('🔍 連線 Firestore 並列出實際的 top-level collections...');
  const cols = await db.listCollections();
  const colNames = cols.map(c => c.id).sort();

  console.log('\n══ 實際存在的 collections ══');
  for (const name of colNames) {
    const snap = await db.collection(name).limit(5).get();
    const usedFlag = USED[name] ? '✅' : '⚠️ ';
    const note = USED[name] ? '在用' : '— 未在程式碼中見到，可能是廢棄／舊版';
    console.log(`  ${usedFlag} ${name.padEnd(22)} (${snap.size}+ 筆 sample)  ${note}`);
    // 列出前幾個 doc id 給判斷用
    if (snap.size > 0 && !USED[name]) {
      const ids = snap.docs.map(d => d.id).slice(0, 5);
      console.log(`         ↳ doc IDs (前 5)：${ids.join(', ')}`);
    }
  }

  console.log('\n══ 程式碼有用但 Firestore 沒看到的（可能還沒有資料） ══');
  for (const name of Object.keys(USED)) {
    if (!colNames.includes(name)) {
      console.log(`  📭 ${name.padEnd(22)} — 程式預期會有，但 collection 還是空的`);
    }
  }

  console.log('\n══ 對應 NurseApp 內的 doc 檢查 ══');
  if (colNames.includes('NurseApp')) {
    const nurseAppDocs = await db.collection('NurseApp').get();
    const docIds = nurseAppDocs.docs.map(d => d.id);
    console.log(`  NurseApp/* 實際有的 doc：${docIds.join(', ')}`);
    const expected = ['Settings', 'Staff', 'StaffPublic'];
    const orphaned = docIds.filter(id => !expected.includes(id));
    const missing = expected.filter(id => !docIds.includes(id));
    if (orphaned.length) console.log(`  ⚠️  孤兒 doc（不在預期清單）：${orphaned.join(', ')}`);
    if (missing.length)  console.log(`  📭 預期但缺少的 doc：${missing.join(', ')}`);
    if (!orphaned.length && !missing.length) console.log(`  ✓ 全部對得上`);
  }
}

main().catch(err => { console.error('❌', err); process.exit(1); });
