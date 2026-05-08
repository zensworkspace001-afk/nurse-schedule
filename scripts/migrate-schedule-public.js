// 一次性遷移腳本：把所有現有的 Schedules/{ym} 投影出遮罩過的 SchedulesPublic/{ym}
//
// 為什麼需要：firestore.rules 把 Schedules 收緊到 admin only 之前，必須先把員工
// 看得到的「遮罩版」班表寫到 SchedulesPublic，否則員工角色會在規則部署後完全
// 看不到任何班表（client SDK 會被 default-deny）。
//
// 遮罩規則：cell 內 事假/病假/特休 一律換成 OFF（同事看到的是「那天他休假」）。
//
// 執行：
//   node --env-file=.env.local scripts/migrate-schedule-public.js          # dry-run
//   node --env-file=.env.local scripts/migrate-schedule-public.js --commit # 真正寫入

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
    console.error('找不到 Firebase 憑證，請確認 .env.local 有 FIREBASE_PROJECT_ID / CLIENT_EMAIL / PRIVATE_KEY');
    process.exit(1);
  }
}

const db = admin.firestore();

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

async function main() {
  console.log(COMMIT ? '🔥 COMMIT 模式：將寫入 Firestore' : '🧪 DRY-RUN 模式：僅檢查不寫入');
  console.log('—'.repeat(60));

  const snap = await db.collection('Schedules').get();
  if (snap.empty) {
    console.log('Schedules collection 空，無需遷移。');
    return;
  }

  let totalMasked = 0;
  let docsCount = 0;
  for (const doc of snap.docs) {
    const data = doc.data();
    const finalized = data.finalizedSchedule || {};
    const masked = buildSchedulePublicMasked(finalized);
    docsCount++;

    // 數一下這份 doc 內被遮掉幾個 cell
    let cellsMasked = 0;
    for (const [staffId, dayCells] of Object.entries(finalized)) {
      if (!dayCells || typeof dayCells !== 'object') continue;
      for (const cell of Object.values(dayCells)) {
        const t = typeof cell === 'string' ? cell : cell?.type;
        if (SENSITIVE.has(t)) cellsMasked++;
      }
    }
    totalMasked += cellsMasked;
    console.log(`  ${doc.id}: ${Object.keys(finalized).length} 列員工 / ${cellsMasked} 個請假 cell 被遮罩`);

    if (COMMIT) {
      await db.doc(`SchedulesPublic/${doc.id}`).set({ finalizedSchedule: masked });
    }
  }

  console.log('—'.repeat(60));
  console.log(`處理 ${docsCount} 份月班表，共 ${totalMasked} 個請假 cell 被遮罩。`);
  if (!COMMIT) console.log('（dry-run）跳過實際寫入。確認無誤後加 --commit 重跑。');
  else console.log('🎉 遷移完成。可以安全部署收緊後的 firestore.rules 了。');
}

main().catch((err) => {
  console.error('❌ 遷移失敗：', err);
  process.exit(1);
});
