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

  // PDPA §8 留證欄位 — 前端在勾選同意後一併送來
  // 雖然不是必填（避免擋住老資料），但若有給，要驗格式
  let pdpaConsentedAt = null;
  let pdpaNoticeVersion = null;
  if (body.pdpa_consented_at !== undefined) {
    const v = String(body.pdpa_consented_at).trim();
    if (v && !Number.isNaN(Date.parse(v))) pdpaConsentedAt = v;
  }
  if (body.pdpa_notice_version !== undefined) {
    pdpaNoticeVersion = String(body.pdpa_notice_version).slice(0, 16);
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
      idNumber,
      bankAccount,
      phone,
      pdpa_consented_at: pdpaConsentedAt,
      pdpa_notice_version: pdpaNoticeVersion,
    },
  };
}

// 自助更新模式的驗證 — PII 不在這裡動。所有欄位皆 optional：
//   - undefined → 不改
//   - 有給 → 驗證並覆寫
// 目前 UI 只送 avatar / avatar_thumb，這裡仍保留其它欄位的驗證以便未來擴充。
const AVATAR_MAX_BYTES = 200 * 1024;  // 主圖 200 KB 上限（220x220 webp/jpeg/png 綽綽有餘）
const THUMB_MAX_BYTES  = 30 * 1024;   // 縮圖 30 KB 上限（64x64 webp/jpeg 約 3-5 KB）
const AVATAR_MIME_OK = /^data:image\/(webp|jpeg|png);base64,/i;

function validateAvatarField(value, maxBytes) {
  if (value === '' || value === null) return { ok: true, cleaned: '' };
  if (typeof value !== 'string') return { ok: false, err: '格式錯誤' };
  if (!AVATAR_MIME_OK.test(value)) return { ok: false, err: '格式錯誤（僅接受 PNG / JPEG / WebP data URL）' };
  if (value.length > maxBytes) return { ok: false, err: `檔案過大（限 ${Math.round(maxBytes / 1024)} KB 以內）` };
  return { ok: true, cleaned: value };
}

function validateUpdate(body) {
  const errors = [];
  const cleaned = {};

  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) errors.push('姓名不可為空');
    else if (name.length > 50) errors.push('姓名長度過長');
    else cleaned.name = name;
  }

  if (body.gender !== undefined) {
    const gender = String(body.gender);
    if (gender !== '男' && gender !== '女') errors.push('性別格式錯誤');
    else cleaned.gender = gender;
  }

  if (body.tenure_years !== undefined) {
    const tenure = Number(body.tenure_years);
    if (!Number.isFinite(tenure) || tenure < 0 || tenure > 60) errors.push('年資需為 0–60 之間的整數');
    else cleaned.tenure_years = Math.floor(tenure);
  }

  if (body.is_pregnant_or_nursing !== undefined) {
    cleaned.is_pregnant_or_nursing = Boolean(body.is_pregnant_or_nursing);
  }

  if (body.can_night_shift !== undefined) {
    cleaned.can_night_shift = body.can_night_shift !== false;
  }

  // avatar / avatar_thumb：三種狀態 — undefined（不改）/ ''（移除）/ data URL（更新）
  // 共用 validateAvatarField，只在錯誤訊息加上欄位前綴
  if (body.avatar !== undefined) {
    const r = validateAvatarField(body.avatar, AVATAR_MAX_BYTES);
    if (!r.ok) errors.push('頭貼' + r.err);
    else cleaned.avatar = r.cleaned;
  }
  if (body.avatar_thumb !== undefined) {
    const r = validateAvatarField(body.avatar_thumb, THUMB_MAX_BYTES);
    if (!r.ok) errors.push('頭貼縮圖' + r.err);
    else cleaned.avatar_thumb = r.cleaned;
  }

  return { ok: errors.length === 0, errors, cleaned };
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

      // PDPA §8 留證欄位：若前端有送，寫進去；否則 server 端 fallback 補上提交當下時間
      // 這是給審計查的法定欄位，原則上一定要有，因此即便前端漏送也要兜底
      const serverTime = new Date().toISOString();
      const pdpaConsentedAt = v.cleaned.pdpa_consented_at || serverTime;
      const pdpaNoticeVersion = v.cleaned.pdpa_notice_version || 'v1';

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
        profile_completed_at: serverTime,
        pdpa_consented_at: pdpaConsentedAt,
        pdpa_notice_version: pdpaNoticeVersion,
      };
      changedFields = ['idNumber', 'bankAccount', 'phone', 'pdpa_consent'];
    } else {
      // mode === 'update'：只 patch v.cleaned 裡實際出現的欄位；PII / profile_completed 維持原值
      const current = staffData[idx];
      const next = { ...current };
      const changed = [];

      for (const key of Object.keys(v.cleaned)) {
        const newVal = v.cleaned[key];
        // 頭貼類欄位：'' 視為「移除」，存 null 比空字串更乾淨（if (avatar) 為 false）
        if ((key === 'avatar' || key === 'avatar_thumb') && newVal === '') {
          if (current[key]) {
            next[key] = null;
            changed.push(key);
          }
        } else if (current[key] !== newVal) {
          next[key] = newVal;
          changed.push(key);
        }
      }

      if (changed.length === 0) {
        return res.status(200).json({ ok: true, message: '沒有變更', changed: [] });
      }

      next.profile_updated_at = new Date().toISOString();
      updatedRow = next;
      changedFields = changed;
    }

    staffData[idx] = updatedRow;

    // 三層 doc 同步寫入（與前端 saveGlobalStaff 相同的拆分策略）：
    //   1. NurseApp/Staff       — 完整名單 (admin 用)
    //   2. NurseApp/StaffPublic — 精簡公開投影 (同事看得到的部分)
    //   3. StaffPrivate/{id}    — 該員工自己的完整 row（頂層 collection；2 段路徑才是合法 doc）
    // 與 src/api/database.js / scripts/migrate-staff-public.js / scripts/restore-staff-from-private.js
    // 的 buildStaffPublicProjection 保持一致；avatar_thumb 加入後同事的班表卡片才有頭貼可顯示。
    const publicList = staffData.map((s) => ({
      staff_id: s.staff_id,
      name: s.name,
      level: s.level,
      is_leader: !!s.is_leader,
      is_active: s.is_active !== false,
      avatar_thumb: s.avatar_thumb || null,
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
