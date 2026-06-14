// api/claim-schedule.js
//
// 員工從虛擬空缺（如 D003）認領一份整月班次 pattern。
//
// POST /api/claim-schedule  (Bearer Firebase ID token — staff 自己)
//   Body: { year, month, virtualSlotId }
//
// 流程：
//   1. 驗 token → actor.uid 即為員工的 staff_id（sync-accounts.js 把 uid 設為 staff_id）。
//   2. 用 Firestore transaction 讀寫 Schedules/{year_month}：
//        - 讀 finalizedSchedule
//        - 確認 virtualSlotId 仍存在（防搶單）
//        - 確認 actor.uid 還沒在 finalizedSchedule 裡（防重複認領）
//        - 把 virtualSlotId 那筆資料搬到 actor.uid 鍵下
//        - 刪除 virtualSlotId 鍵
//   3. transaction 是原子的 — 兩個員工同時搶同一格時，後到那位會看到「搶走了」錯誤。
//
// 為什麼要走後端：firestore.rules 只能允許「diff 限定在 finalizedSchedule 欄位」，
// 無法阻止惡意員工把其他人的 cell 一起改掉（垂直越權）。把這段邏輯搬到後端 + 收緊
// rules 成 admin only，員工只能透過此端點操作自己的 cell。

import admin from 'firebase-admin';
import { checkCsrf } from './_lib/csrf.js';
import { checkRateLimit } from './_lib/rateLimit.js';

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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: '只允許 POST 請求' });

  if (req.body?.healthCheck) {
    try {
      await admin.firestore().doc('NurseApp/Settings').get();
      return res.status(200).json({ ok: true, service: 'claim-schedule' });
    } catch (err) {
      return res.status(503).json({ ok: false, service: 'claim-schedule', error: err.message });
    }
  }

  const csrf = checkCsrf(req);
  if (!csrf.allowed) return res.status(403).json({ error: '禁止：非法來源' });

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未經授權：缺少登入憑證' });
  }

  let actor;
  try {
    const token = authHeader.split('Bearer ')[1];
    const decoded = await admin.auth().verifyIdToken(token);
    // 從 email 反推 staff_id，避免 Firebase Auth 自動產生的 UID（如舊資料 67Volw5UJwexeLXPBd1nj…）
    // 變成 schedule key。loginEmail 在 sync 時固定為 ${staff_id.toLowerCase()}@hospital.com。
    const email = decoded.email || '';
    const m = email.match(/^([^@]+)@hospital\.com$/i);
    const staffId = m ? m[1].toUpperCase() : decoded.uid;
    actor = { uid: staffId, email, firebaseUid: decoded.uid };
  } catch {
    return res.status(401).json({ error: '未經授權：登入憑證無效或已過期' });
  }

  // admin 不該透過此端點認領（admin 沒有自己的班次格子；要排程改其他人的班走 StaffManagementPanel）
  if (actor.email === 'admin@hospital.com') {
    return res.status(403).json({ error: '管理員請使用排班工作桌' });
  }

  const rl = checkRateLimit(`claim:${actor.uid}`, 20);
  if (!rl.allowed) return res.status(429).json({ error: '請求過於頻繁，請稍候再試' });

  const { year, month, virtualSlotId } = req.body || {};
  if (!year || !month || !virtualSlotId) {
    return res.status(400).json({ error: '缺少必要參數 year / month / virtualSlotId' });
  }
  // 防呆：virtualSlotId 必須是 D 開頭虛擬鍵（避免員工誤把同事 N00X 鍵當作 virtualSlotId）
  if (!String(virtualSlotId).startsWith('D')) {
    return res.status(400).json({ error: 'virtualSlotId 必須是虛擬空缺鍵（D 開頭）' });
  }

  const docId = `${year}_${month}`;
  const scheduleRef = admin.firestore().doc(`Schedules/${docId}`);
  // 員工自己的私有資料（含 is_pregnant_or_nursing / leave_status）。
  // doc id 即 staff_id（actor.uid 已從 email 反推成大寫 staff_id）。
  const staffPrivateRef = admin.firestore().doc(`StaffPrivate/${actor.uid}`);

  try {
    const result = await admin.firestore().runTransaction(async (tx) => {
      // Firestore transaction 要求「所有讀取必須在任何寫入之前」，故兩個 get 都放最前面。
      const snap = await tx.get(scheduleRef);
      const staffSnap = await tx.get(staffPrivateRef);
      if (!snap.exists) throw new HttpError(404, '找不到該月份的班表');
      const data = snap.data();
      const finalized = data.finalizedSchedule || {};

      if (!finalized[virtualSlotId]) {
        throw new HttpError(409, '此班表已被別人選走，請選擇其他班表');
      }
      if (finalized[actor.uid]) {
        throw new HttpError(409, '您本月已認領過班表，無法重複認領');
      }

      const claimedPattern = finalized[virtualSlotId];

      // ★ 母性保護 / 實習生限制（後端硬擋，與前端 StaffDashboard.checkCompliance 一致）：
      //   匿名虛擬 slot 任何人都能認領，前端只在 UI 層擋孕婦/實習生選含 E/N 的班表；
      //   繞過 UI 直接打這個端點仍可能違反勞基法 §49（孕婦/哺乳禁夜班）。這裡用後端
      //   權威資料（StaffPrivate）再擋一次。讀不到資料（舊帳號無 StaffPrivate）則放行，
      //   避免誤鎖；前端仍有 UI 防護兜底。
      const staff = staffSnap.exists ? staffSnap.data() : null;
      if (staff) {
        const p = staff.is_pregnant_or_nursing;
        const isPregnant = p === true || p === 'True' || p === 'true';
        const isStudent = staff.leave_status === 'Student';
        if ((isPregnant || isStudent) && patternHasNightShift(claimedPattern)) {
          const who = isPregnant ? '母性保護（孕期/哺乳）' : '實習生';
          throw new HttpError(403, `${who}限制：此班表含小夜(E)/大夜(N)，依勞基法不得認領，請選擇純白班的班表`);
        }
      }

      // 用 dot-path 同時刪除 virtualSlotId 並新增 actor.uid，保持原子性。
      tx.update(scheduleRef, {
        [`finalizedSchedule.${virtualSlotId}`]: admin.firestore.FieldValue.delete(),
        [`finalizedSchedule.${actor.uid}`]: claimedPattern,
      });

      // 給 caller 算後的快照（用於前端 optimistic UI 同步）
      const updated = { ...finalized };
      delete updated[virtualSlotId];
      updated[actor.uid] = claimedPattern;

      // 連動寫遮罩過的公開版 SchedulesPublic（同事看不到請假類型）
      const masked = buildSchedulePublicMasked(updated);
      const publicRef = admin.firestore().doc(`SchedulesPublic/${docId}`);
      tx.set(publicRef, { finalizedSchedule: masked });

      return updated;
    });

    return res.status(200).json({
      ok: true,
      message: '認領成功',
      finalizedSchedule: result,
      claimedBy: actor.uid,
    });
  } catch (err) {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error('claim-schedule 失敗:', err);
    return res.status(500).json({ error: '伺服器處理失敗，請稍後再試' });
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// 整月 pattern 是否含小夜(E)/大夜(N)。cell 可能是字串或 {type} 物件，兩者都處理。
function patternHasNightShift(pattern) {
  if (!pattern || typeof pattern !== 'object') return false;
  for (const cell of Object.values(pattern)) {
    const type = (cell && typeof cell === 'object') ? cell.type : cell;
    if (type === 'E' || type === 'N') return true;
  }
  return false;
}

// 與 src/api/database.js 的 buildSchedulePublicProjection 行為一致：
// 把 事假/病假/特休 cell 一律遮成 OFF，保護同事的醫療隱私。
const SENSITIVE_LEAVE_TYPES = new Set(['事假', '病假', '特休']);
function sanitizeCell(cell) {
  if (cell == null) return cell;
  if (typeof cell === 'string') return SENSITIVE_LEAVE_TYPES.has(cell) ? 'OFF' : cell;
  if (typeof cell === 'object' && SENSITIVE_LEAVE_TYPES.has(cell.type)) {
    return { ...cell, type: 'OFF' };
  }
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
