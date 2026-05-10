// 直接 call live /api/auto-relay 測試現在的行為
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
const YM = '2026_9';
const HOST = 'nurse-schedule-bachelor.vercel.app';

async function main() {
  // 取最新 finalizedSchedule
  const snap = await db.doc(`Schedules/${YM}`).get();
  const currentSchedule = snap.exists ? (snap.data().finalizedSchedule || {}) : {};

  console.log('🚀 觸發 /api/auto-relay 用 9 月最新 schedule...');
  console.log('   傳入的 currentSchedule keys：', Object.keys(currentSchedule).join(', '));

  const res = await fetch(`https://${HOST}/api/auto-relay`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.CRON_SECRET}`,
    },
    body: JSON.stringify({
      year: 2026,
      month: 9,
      currentSchedule,
      // 不帶 finishedStaffId — 測試目前狀態下應該選誰
    }),
  });

  const text = await res.text();
  console.log('\n📡 回應 status：', res.status);
  console.log('📡 回應 body：');
  try { console.log(JSON.stringify(JSON.parse(text), null, 2)); }
  catch { console.log(text); }

  // 重新讀 SelectionTurn 看有沒有真的被寫入
  const newTurn = await db.doc(`SelectionTurn/${YM}`).get();
  if (newTurn.exists) {
    const d = newTurn.data();
    console.log('\n✓ SelectionTurn 寫入後狀態：');
    console.log('  active_staff_id =', d.active_staff_id);
    console.log('  updatedAt       =', d.updatedAt?.toDate?.()?.toISOString());
  }
}

main().catch(err => { console.error('❌', err); process.exit(1); });
