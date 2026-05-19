// api/complete-profile.js
//
// 員工個人資料端點（兩種模式，由 body.mode 切換；預設首登流程）。
//
// 模式 1：mode 省略或 'first'  — 首次啟用後完善個資（PII 必填、會加密）
//   Body: { name, gender, tenure_years, is_pregnant_or_nursing, can_night_shift,
//           idNumber, bankAccount, phone }
//   行為：驗 token → 驗欄位 → 加密 PII → 寫三層 doc，profile_completed=true → 寫 access_logs(encrypt)
//
// 模式 2：mode === 'update'  — 已啟用後自助更新基本資料 + 頭貼（不動 PII）
//   Body: { mode:'update', name, gender, tenure_years, is_pregnant_or_nursing,
//           can_night_shift, avatar? }
//     - avatar 為 data URL（image/webp|jpeg|png，base64 編碼，前端壓到 200x200 ~10-30 KB）
//     - 空字串 ''      → 移除頭貼
//     - undefined      → 不改頭貼
//   行為：驗 token → 驗欄位（不要求 PII）→ 寫三層 doc，profile_completed 維持原值
//        → 寫 access_logs(update-profile)，包含被改動的欄位名清單
//
// 共同：員工只能改自己（actor.uid === staff_id）；admin 不可走此端點。
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

// 後端銀行代碼白名單 — 與 src/constants/banks.js 同步
// 任何新增銀行請兩邊都更新。Set 提供 O(1) lookup。
const TAIWAN_BANK_CODES = new Set([
  '700', '004', '005', '006', '007', '008', '009', '011', '012', '013',
  '016', '017', '050', '052', '053', '081', '102', '103', '108', '147',
  '803', '805', '806', '807', '808', '809', '810', '812', '816', '822',
]);

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

  // 銀行帳號必須是 "###-##########" 格式，且 ### 在白名單內
  const bankAccount = String(body.bankAccount ?? '').trim();
  if (!bankAccount) errors.push('銀行帳號不可為空');
  const bankMatch = bankAccount.match(/^(\d{3})-(\d{6,16})$/);
  if (!bankMatch) {
    errors.push('銀行帳號格式錯誤（需為「銀行三碼-帳號」如 008-1234567890）');
  } else if (!TAIWAN_BANK_CODES.has(bankMatch[1])) {
    errors.push(`銀行代碼 ${bankMatch[1]} 不在合法清單內`);
  }

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

// 自助更新模式的驗證 — PII 不在這裡動，只驗基本資料 + 頭貼
const AVATAR_MAX_BYTES = 120 * 1024; // 120 KB 上限，足夠 200x200 webp/jpeg
const AVATAR_MIME_OK = /^data:image\/(webp|jpeg|png);base64,/i;

function validateUpdate(body) {
  const errors = [];
  const name = String(body.name ?? '').trim();
  if (!name) errors.push('姓名不可為空');
  if (name.length > 50) errors.push('姓名長度過長');

  const gender = String(body.gender ?? '');
  if (gender !== '男' && gender !== '女') errors.push('性別格式錯誤');

  const tenure = Number(body.tenure_years);
  if (!Number.isFinite(tenure) || tenure < 0 || tenure > 60) errors.push('年資需為 0–60 之間的整數');

  // avatar：三種狀態 — undefined（不改）/ ''（移除）/ data URL（更新）
  let avatar = body.avatar;
  if (avatar !== undefined && avatar !== '' && avatar !== null) {
    if (typeof avatar !== 'string') {
      errors.push('頭貼格式錯誤');
    } else if (!AVATAR_MIME_OK.test(avatar)) {
      errors.push('頭貼格式錯誤（僅接受 PNG / JPEG / WebP data URL）');
    } else if (avatar.length > AVATAR_MAX_BYTES) {
      errors.push(`頭貼檔案過大（限 ${Math.round(AVATAR_MAX_BYTES / 1024)} KB 以內）`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    cleaned: {
      name,
      gender,
      tenure_years: Math.floor(tenure),
      is_pregnant_or_nursing: Boolean(body.is_pregnant_or_nursing),
      can_night_shift: body.can_night_shift !== false,
      avatar,
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
    // 從 email 反推 staff_id（同 claim-schedule.js 邏輯，避免 Firebase 自動 UID 污染資料）
    const email = decoded.email || '';
    const m = email.match(/^([^@]+)@hospital\.com$/i);
    const staffId = m ? m[1].toUpperCase() : decoded.uid;
    actor = { uid: staffId, email, firebaseUid: decoded.uid };
  } catch {
    return res.status(401).json({ error: '未經授權：登入憑證無效或已過期' });
  }

  // admin 不應透過此端點寫入（admin 自己沒有 staffData 列）
  if (actor.email === 'admin@hospital.com') {
    return res.status(403).json({ error: '管理員請使用員工管理頁面' });
  }

  const mode = req.body?.mode === 'update' ? 'update' : 'first';

  const rl = checkRateLimit(`complete-profile:${actor.uid}:${mode}`, 10);
  if (!rl.allowed) return res.status(429).json({ error: '請求過於頻繁，請稍候再試' });

  const v = mode === 'update' ? validateUpdate(req.body || {}) : validate(req.body || {});
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

    let updatedRow;
    let changedFields;

    if (mode === 'first') {
      // 加密 PII（伺服器端做，不再透過 secure-field 多繞一圈）
      const encrypted = {
        idNumber: encryptField(v.cleaned.idNumber),
        bankAccount: encryptField(v.cleaned.bankAccount),
        phone: encryptField(v.cleaned.phone),
      };

      updatedRow = {
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
      changedFields = ['idNumber', 'bankAccount', 'phone'];
    } else {
      // mode === 'update'：保留 PII / profile_completed 等不動，只覆寫基本資料
      // 與（如有提供）頭貼
      const current = staffData[idx];
      const changed = [];
      if (current.name !== v.cleaned.name) changed.push('name');
      if (current.gender !== v.cleaned.gender) changed.push('gender');
      if (current.tenure_years !== v.cleaned.tenure_years) changed.push('tenure_years');
      if (!!current.is_pregnant_or_nursing !== v.cleaned.is_pregnant_or_nursing) changed.push('is_pregnant_or_nursing');
      if ((current.can_night_shift !== false) !== v.cleaned.can_night_shift) changed.push('can_night_shift');

      const next = {
        ...current,
        name: v.cleaned.name,
        gender: v.cleaned.gender,
        tenure_years: v.cleaned.tenure_years,
        is_pregnant_or_nursing: v.cleaned.is_pregnant_or_nursing,
        can_night_shift: v.cleaned.can_night_shift,
      };

      if (v.cleaned.avatar !== undefined) {
        if (v.cleaned.avatar === '' || v.cleaned.avatar === null) {
          // 移除頭貼
          if (current.avatar) {
            next.avatar = null;
            changed.push('avatar');
          }
        } else {
          // 更新頭貼
          if (current.avatar !== v.cleaned.avatar) {
            next.avatar = v.cleaned.avatar;
            changed.push('avatar');
          }
        }
      }

      next.profile_updated_at = new Date().toISOString();
      updatedRow = next;
      changedFields = changed;

      if (changed.length === 0) {
        return res.status(200).json({ ok: true, message: '沒有變更', changed: [] });
      }
    }

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

    // 寫稽核（must await — Vercel serverless 在 res.json 後會凍結 lambda）
    await writeAccessLog({
      actor,
      action: mode === 'first' ? 'encrypt' : 'update-profile',
      target: { kind: 'staff', id: actor.uid },
      fields: changedFields,
      ip: meta.ip, ua: meta.ua,
      extra: { source: 'complete-profile', mode },
    });

    return res.status(200).json({
      ok: true,
      message: mode === 'first' ? '個人資料儲存成功' : '更新成功',
      changed: changedFields,
    });
  } catch (err) {
    console.error('complete-profile 失敗:', err);
    return res.status(500).json({ error: '伺服器處理失敗，請稍後再試' });
  }
}
