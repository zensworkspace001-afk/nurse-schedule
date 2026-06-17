// api/activate-account.js
//
// 公開端點（無需 Firebase 登入）。三種用途，由 body.action 區分：
//
//   (A) 無 action — 連結式啟用 / 重設（token 本身擔任授權）
//       Body: { token, newPassword }
//       1. 驗 token（未過期、未使用）→ 2. 檢查密碼強度 → 3. Admin SDK 設密碼
//          （activation 另開通 disabled:false；reset 只改密碼）→ 4. 刪 token（一次性）。
//
//   (B) action:'request-reset' — 員工自助「忘記密碼」第一步
//       Body: { action:'request-reset', staffId, email }
//       核對 工號 + 註冊信箱皆相符（防列舉/防濫發）→ 產 6 位 OTP → 寄到該員工信箱。
//       一律回傳同一句通用訊息，不洩漏工號/信箱是否存在。
//
//   (C) action:'verify-reset-otp' — 忘記密碼第二步
//       Body: { action:'verify-reset-otp', staffId, code }
//       驗 OTP → 產暫時密碼、設為該帳號密碼、撤銷舊 session、標記 must_change_password
//       → 回傳暫時密碼（顯示於畫面）。使用者用暫時密碼登入後會被強制改密。
//
// 防濫用：CSRF + IP rate limit。(A)(C) 失敗不洩漏 token/帳號是否存在。
import admin from 'firebase-admin';
import { checkCsrf } from './_lib/csrf.js';
import { checkRateLimit } from './_lib/rateLimit.js';
import {
  verifyToken,
  consumeToken,
  validatePasswordStrength,
} from './_lib/activationToken.js';
import {
  issueResetOtp,
  verifyResetOtp,
  consumeResetOtp,
  generateTempPassword,
  otpTtlMinutes,
} from './_lib/resetOtp.js';
import { assertPasswordNotReused, recordPassword } from './_lib/passwordHistory.js';

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function getBaseUrl(req) {
  if (process.env.ACTIVATION_BASE_URL) return process.env.ACTIVATION_BASE_URL.replace(/\/+$/, '');
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  const origin = req.headers.origin || req.headers.referer;
  if (origin) return origin.replace(/\/+$/, '');
  return 'https://nurse-schedule-bachelor.vercel.app';
}

async function sendOtpEmail(baseUrl, { email, name, code }) {
  const subject = '【護理排班系統】密碼重設驗證碼';
  const html = `
    <h2>您好 ${escapeHtml(name)}：</h2>
    <p>您正在重設護理排班系統的登入密碼。請於頁面輸入以下 6 位驗證碼：</p>
    <p style="font-size:30px;letter-spacing:8px;font-weight:700;color:#0066cc;margin:16px 0;">${escapeHtml(code)}</p>
    <hr/>
    <p style="color:#888;font-size:12px;">驗證碼 ${otpTtlMinutes} 分鐘內有效，僅可使用一次。<br/>若您並未申請密碼重設，請忽略此信並儘速聯絡管理員。</p>
  `;
  const r = await fetch(`${baseUrl}/api/sendEmail`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.CRON_SECRET}`,
    },
    body: JSON.stringify({ to: email, subject, html }),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error || `寄信回應 ${r.status}`);
  }
}

// 標記該員工 must_change_password=true（暫時密碼登入後強制改密）。
// 用 transaction 寫 NurseApp/Staff 陣列 + StaffPrivate/{id}，避免並發重設互相覆寫。
// StaffPublic 投影不含此欄位、也未動到投影欄位，故不需重建。
async function setMustChangePassword(staffId) {
  const db = admin.firestore();
  const staffRef = db.doc('NurseApp/Staff');
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(staffRef);
    if (!snap.exists) return;
    const data = snap.data();
    const list = Array.isArray(data.staffData) ? data.staffData : [];
    const idx = list.findIndex(
      (s) => String(s.staff_id).toLowerCase() === String(staffId).toLowerCase(),
    );
    if (idx === -1) return;
    const row = { ...list[idx], must_change_password: true };
    const next = [...list];
    next[idx] = row;
    tx.update(staffRef, { staffData: next });
    tx.set(db.doc(`StaffPrivate/${row.staff_id}`), row);
  });
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

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  return (typeof xff === 'string' ? xff.split(',')[0].trim() : null)
    || req.headers['x-real-ip']
    || req.socket?.remoteAddress
    || 'unknown';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: '只允許 POST 請求' });

  if (req.body?.healthCheck) {
    try {
      await admin.auth().listUsers(1);
      return res.status(200).json({ ok: true, service: 'activate-account' });
    } catch (err) {
      return res.status(503).json({ ok: false, service: 'activate-account', error: err.message });
    }
  }

  const csrf = checkCsrf(req);
  if (!csrf.allowed) return res.status(403).json({ error: '禁止：非法來源' });

  const ip = clientIp(req);
  const action = req.body?.action;

  // —— (B) 忘記密碼：申請驗證碼 ——
  if (action === 'request-reset') {
    const rl = checkRateLimit(`reset-req:${ip}`, 5);
    if (!rl.allowed) return res.status(429).json({ error: '請求過於頻繁，請稍候再試' });

    const staffId = String(req.body?.staffId || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    // 不論工號/信箱對不對都回同一句，避免帳號列舉
    const GENERIC = { ok: true, message: '若您輸入的工號與信箱正確，驗證碼已寄出，請至信箱查收。' };
    if (!staffId || !email) return res.status(400).json({ error: '請輸入工號與註冊信箱' });

    try {
      const staffSnap = await admin.firestore().doc('NurseApp/Staff').get();
      const list = staffSnap.exists ? (staffSnap.data().staffData || []) : [];
      const row = list.find((s) => String(s.staff_id).toLowerCase() === staffId.toLowerCase());
      // 工號不存在 / 沒登記信箱 / 信箱不符 → 一律通用回覆
      if (!row || !row.email || String(row.email).trim().toLowerCase() !== email) {
        return res.status(200).json(GENERIC);
      }

      const loginEmail = `${staffId.toLowerCase()}@hospital.com`;
      let userRecord;
      try {
        userRecord = await admin.auth().getUserByEmail(loginEmail);
      } catch {
        return res.status(200).json(GENERIC); // 帳號尚未啟用 → 通用回覆
      }
      if (userRecord.disabled) return res.status(200).json(GENERIC); // 停用/離職 → 通用回覆

      const code = await issueResetOtp({ uid: userRecord.uid, staffId, email: row.email });
      await sendOtpEmail(getBaseUrl(req), { email: row.email, name: row.name || staffId, code });
      return res.status(200).json(GENERIC);
    } catch (err) {
      console.error('request-reset 失敗:', err);
      // 仍回通用訊息（不洩漏內部狀態）；寄信失敗時使用者收不到信會自行重試
      return res.status(200).json(GENERIC);
    }
  }

  // —— (C) 忘記密碼：驗證碼換暫時密碼 ——
  if (action === 'verify-reset-otp') {
    const rl = checkRateLimit(`reset-otp:${ip}`, 10);
    if (!rl.allowed) return res.status(429).json({ error: '請求過於頻繁，請稍候再試' });

    const staffId = String(req.body?.staffId || '').trim();
    const code = String(req.body?.code || '').trim();
    if (!staffId || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: '請輸入 6 位數字驗證碼' });
    }

    let otp;
    try {
      otp = await verifyResetOtp(staffId, code);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const tempPassword = generateTempPassword();
    try {
      await admin.auth().updateUser(otp.uid, { password: tempPassword });
      // 撤銷舊 session：重設密碼的意義就是讓先前所有訪問權作廢
      await admin.auth().revokeRefreshTokens(otp.uid);
      await setMustChangePassword(staffId);
    } catch (err) {
      console.error('verify-reset-otp 設定暫時密碼失敗:', err);
      return res.status(500).json({ error: '伺服器處理失敗，請稍後再試' });
    }
    await consumeResetOtp(staffId); // 一次性

    return res.status(200).json({
      ok: true,
      tempPassword,
      message: '驗證成功，請用下方暫時密碼登入後立即修改。',
    });
  }

  // —— (A) 連結式啟用 / 重設（原流程）——
  const rl = checkRateLimit(`activate:${ip}`, 5);
  if (!rl.allowed) {
    return res.status(429).json({ error: '請求過於頻繁，請稍候再試' });
  }

  const { token, newPassword } = req.body || {};

  // 1. 密碼強度先檢（避免無效請求也消耗一次 token 查詢）
  const pwCheck = validatePasswordStrength(newPassword);
  if (!pwCheck.ok) return res.status(400).json({ error: pwCheck.reason });

  // 2. 驗 token（不限定 purpose，回傳後再判斷分支）
  let tokenData;
  try {
    tokenData = await verifyToken(token);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  // 2.5 禁止改回先前使用過的密碼（reset 才檢查；activation 首設無歷史，仍會在下方記錄）
  try {
    await assertPasswordNotReused(tokenData.uid, newPassword);
  } catch (err) {
    if (err.code === 'password-reused') return res.status(400).json({ error: err.message });
    throw err;
  }

  // 3. 套用變更
  try {
    const updates = { password: newPassword };
    if (tokenData.purpose === 'activation') {
      updates.disabled = false;
    }
    await admin.auth().updateUser(tokenData.uid, updates);
    await recordPassword(tokenData.uid, newPassword);
    // 撤銷該 uid 既有的所有 refresh token — 防止攻擊者拿到舊 session（XSS / 共用電腦）
    // 繼續用到 ID token 過期（1h）。reset 流程的意義就是「之前的訪問權都作廢」。
    await admin.auth().revokeRefreshTokens(tokenData.uid);
  } catch (err) {
    console.error('啟用 / 重設失敗:', err);
    if (err.code === 'auth/user-not-found') {
      // token 對應的帳號被刪了 → 把孤兒 token 一併清掉
      await consumeToken(tokenData.tokenHash);
      return res.status(400).json({ error: '帳號不存在，請聯絡管理員' });
    }
    return res.status(500).json({ error: '伺服器處理失敗，請稍後再試' });
  }

  // 4. 一次性消化
  await consumeToken(tokenData.tokenHash);

  return res.status(200).json({
    ok: true,
    purpose: tokenData.purpose,
    message: tokenData.purpose === 'activation' ? '帳號啟用成功' : '密碼已重設',
  });
}
