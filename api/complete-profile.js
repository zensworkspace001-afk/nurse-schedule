// api/complete-profile.js
//
// 員工首次啟用後，自填個人資料的端點。
//
// POST /api/complete-profile  (Bearer Firebase ID token — staff 自己)
//   Body:
//     {
//       name, gender, tenure_years,
//       is_pregnant_or_nursing, can_night_shift,
//       idNumber, bankAccount, phone,           // 明文進來，伺服器立刻加密
//     }
//
// 流程：
//   1. 驗 token，actor.uid 必須對應 staffData[*].staff_id（員工只能改自己）
//   2. 驗欄位（基本格式 + 範圍）
//   3. 將 PII 用 api/_lib/crypto.js 直接加密成 {ct, iv, tag, v} blob
//   4. 透過 Admin SDK 更新 NurseApp/Staff.staffData 該員工那一列
//      - profile_completed: true
//   5. 為每個加密欄位寫一筆 access_logs (action='encrypt')
//
// 不開放 admin 用此端點（admin 改員工資料走 StaffManagementPanel + secure-field）。
import admin from 'firebase-admin';
import { checkCsrf } from './_lib/csrf.js';
import { checkRateLimit } from './_lib/rateLimit.js';
import { encryptField } from './_lib/crypto.js';
import { writeAccessLog, extractClientMeta } from './_lib/accessLog.js';

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

function validate(body) {
  const errors = [];
  const name = String(body.name ?? '').trim();
  if (!name) errors.push('姓名不可為空');
  if (name.length > 50) errors.push('姓名長度過長');

  const gender = String(body.gender ?? '');
  if (gender !== '男' && gender !== '女') errors.push('性別格式錯誤');

  const tenure = Number(body.tenure_years);
  if (!Number.isFinite(tenure) || tenure < 0 || tenure > 60) errors.push('年資需為 0–60 之間的整數');

  const idNumber = String(body.idNumber ?? '').trim();
  if (!idNumber) errors.push('身分證 / 居留證號不可為空');
  if (idNumber.length < 4 || idNumber.length > 20) errors.push('身分證號長度異常');

  const bankAccount = String(body.bankAccount ?? '').trim();
  if (!bankAccount) errors.push('銀行帳號不可為空');
  if (!/^[0-9-]{6,30}$/.test(bankAccount)) errors.push('銀行帳號僅限數字與連字號（6–30 碼）');

  const phone = String(body.phone ?? '').trim();
  if (!phone) errors.push('手機號碼不可為空');
  if (!/^09\d{8}$/.test(phone)) errors.push('手機需為 09 開頭共 10 碼');

  return {
    ok: errors.length === 0,
    errors,
    cleaned: {
      name,
      gender,
      tenure_years: Math.floor(tenure),
      is_pregnant_or_nursing: Boolean(body.is_pregnant_or_nursing),
      can_night_shift: body.can_night_shift !== false,
      idNumber,
      bankAccount,
      phone,
    },
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: '只允許 POST 請求' });

  if (req.body?.healthCheck) {
    try {
      await admin.auth().listUsers(1);
      return res.status(200).json({ ok: true, service: 'complete-profile' });
    } catch (err) {
      return res.status(503).json({ ok: false, service: 'complete-profile', error: err.message });
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
    actor = { uid: decoded.uid, email: decoded.email || null };
  } catch {
    return res.status(401).json({ error: '未經授權：登入憑證無效或已過期' });
  }

  // admin 不應透過此端點寫入（admin 自己沒有 staffData 列）
  if (actor.email === 'admin@hospital.com') {
    return res.status(403).json({ error: '管理員請使用員工管理頁面' });
  }

  const rl = checkRateLimit(`complete-profile:${actor.uid}`, 10);
  if (!rl.allowed) return res.status(429).json({ error: '請求過於頻繁，請稍候再試' });

  const v = validate(req.body || {});
  if (!v.ok) return res.status(400).json({ error: v.errors.join('；') });

  const meta = extractClientMeta(req);
  const staffRef = admin.firestore().doc('NurseApp/Staff');

  try {
    const snap = await staffRef.get();
    if (!snap.exists) return res.status(500).json({ error: '員工資料表不存在' });
    const data = snap.data();
    const staffData = Array.isArray(data.staffData) ? [...data.staffData] : [];

    // actor.uid 是 staff_id（sync-accounts.js 把 Firebase uid 綁成 staff_id）
    const idx = staffData.findIndex(
      (s) => String(s.staff_id).toLowerCase() === String(actor.uid).toLowerCase(),
    );
    if (idx === -1) {
      return res.status(404).json({ error: '找不到您的員工資料，請聯絡管理員' });
    }

    // 加密 PII（伺服器端做，不再透過 secure-field 多繞一圈）
    const encrypted = {
      idNumber: encryptField(v.cleaned.idNumber),
      bankAccount: encryptField(v.cleaned.bankAccount),
      phone: encryptField(v.cleaned.phone),
    };

    const updatedRow = {
      ...staffData[idx],
      name: v.cleaned.name,
      gender: v.cleaned.gender,
      tenure_years: v.cleaned.tenure_years,
      is_pregnant_or_nursing: v.cleaned.is_pregnant_or_nursing,
      can_night_shift: v.cleaned.can_night_shift,
      idNumber: encrypted.idNumber,
      bankAccount: encrypted.bankAccount,
      phone: encrypted.phone,
      profile_completed: true,
      profile_completed_at: new Date().toISOString(),
    };
    staffData[idx] = updatedRow;

    // 三層 doc 同步寫入（與前端 saveGlobalStaff 相同的拆分策略）：
    //   1. NurseApp/Staff       — 完整名單 (admin 用)
    //   2. NurseApp/StaffPublic — 精簡公開投影 (同事看得到的部分)
    //   3. StaffPrivate/{id}    — 該員工自己的完整 row（頂層 collection；2 段路徑才是合法 doc）
    const publicList = staffData.map((s) => ({
      staff_id: s.staff_id,
      name: s.name,
      level: s.level,
      is_leader: !!s.is_leader,
      is_active: s.is_active !== false,
    }));

    const batch = admin.firestore().batch();
    batch.update(staffRef, { staffData });
    batch.set(admin.firestore().doc('NurseApp/StaffPublic'), { staffData: publicList });
    batch.set(
      admin.firestore().doc(`StaffPrivate/${updatedRow.staff_id}`),
      updatedRow,
    );
    await batch.commit();

    // 為每個加密欄位寫 access_logs（fire-and-forget；存取 log 失敗不該擋使用者）
    writeAccessLog({
      actor, action: 'encrypt',
      target: { kind: 'staff', id: actor.uid },
      fields: ['idNumber', 'bankAccount', 'phone'],
      ip: meta.ip, ua: meta.ua,
      extra: { source: 'complete-profile' },
    });

    return res.status(200).json({ ok: true, message: '個人資料儲存成功' });
  } catch (err) {
    console.error('complete-profile 失敗:', err);
    return res.status(500).json({ error: '伺服器處理失敗，請稍後再試' });
  }
}
