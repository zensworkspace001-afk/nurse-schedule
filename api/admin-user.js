// api/admin-user.js
//
// 管理員的「員工帳號管理」統一端點。原本拆成兩個檔案（sync-accounts、reset-password），
// 但 Vercel Hobby plan 上限 12 個 serverless function，合併以節省 quota。
//
// POST /api/admin-user   (Bearer Firebase token — 必須是 admin@hospital.com)
//
//   { action: 'sync',  staffList: [...] }   ← 批次建立帳號 + 寄啟用信
//   { action: 'reset', staffId: 'N001' }    ← 寄送密碼重設信給該員工
//
// 兩個 action 都需要 admin 權限。共用 issueToken / revokeTokensForUid / sendActivationLink。
import crypto from 'node:crypto';
import admin from 'firebase-admin';
import { checkCsrf } from './_lib/csrf.js';
import { issueToken, revokeTokensForUid } from './_lib/activationToken.js';

if (!admin.apps.length) {
  let serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (serviceAccount) {
    serviceAccount = JSON.parse(serviceAccount);
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
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

async function sendActivationLink(baseUrl, { email, name, plainToken, isReset }) {
  const link = `${baseUrl}/activate?token=${plainToken}`;
  const subject = isReset ? '【護理排班系統】密碼重設請求' : '【護理排班系統】請啟用您的帳號';
  const intro = isReset
    ? '管理員已為您觸發密碼重設。請點擊以下連結設定新的登入密碼：'
    : '管理員已為您建立護理排班系統帳號。請點擊以下連結設定您的登入密碼以啟用帳號：';
  const buttonText = isReset ? '點我重設密碼' : '點我啟用帳號並設定密碼';
  // TTL 與 activationToken.js 同步取自 env（預設 2 小時）
  const ttlHours = Number(process.env.ACTIVATION_TOKEN_TTL_HOURS) || 2;
  const html = `
    <h2>您好 ${escapeHtml(name)}：</h2>
    <p>${intro}</p>
    <p><a href="${link}" style="display:inline-block;padding:10px 20px;background:#0066cc;color:#fff;text-decoration:none;border-radius:4px;">${buttonText}</a></p>
    <p>或複製以下網址至瀏覽器開啟：<br/><code>${link}</code></p>
    <hr/>
    <p style="color:#888;font-size:12px;">此連結 ${ttlHours} 小時內有效，僅可使用一次。<br/>若您未請求此操作，請忽略此信。</p>
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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: '只允許 POST 請求' });

  if (req.body?.healthCheck) {
    try {
      await admin.auth().listUsers(1);
      return res.status(200).json({ ok: true, service: 'admin-user' });
    } catch (err) {
      return res.status(503).json({ ok: false, service: 'admin-user', error: err.message });
    }
  }

  const csrf = checkCsrf(req);
  if (!csrf.allowed) return res.status(403).json({ error: '禁止：非法來源' });

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未經授權：缺少登入憑證' });
  }
  let decodedToken;
  try {
    const token = authHeader.split('Bearer ')[1];
    decodedToken = await admin.auth().verifyIdToken(token);
    if (decodedToken.email !== 'admin@hospital.com') {
      return res.status(403).json({ error: '權限不足：只有管理員能執行此操作' });
    }
  } catch {
    return res.status(401).json({ error: '未經授權：登入憑證無效或已過期' });
  }

  const { action } = req.body || {};
  const baseUrl = getBaseUrl(req);

  // —— sync：批次建立 Firebase Auth 帳號 + 寄啟用信 ——
  if (action === 'sync') {
    try {
      const { staffList } = req.body;
      if (!Array.isArray(staffList)) {
        return res.status(400).json({ error: '無效的名單格式' });
      }

      let invitedCount = 0;
      let existedCount = 0;
      let errorCount = 0;
      const errors = [];

      for (const staff of staffList) {
        const staffId = staff.staff_id;
        if (!staffId || staffId === 'admin') continue;
        if (!staff.email) {
          errorCount++;
          errors.push(`${staffId}: 缺少 email，無法寄送啟用信`);
          continue;
        }

        const loginEmail = `${staffId.toLowerCase()}@hospital.com`;
        const randomPassword = crypto.randomBytes(24).toString('base64');

        try {
          await admin.auth().createUser({
            uid: staffId,
            email: loginEmail,
            password: randomPassword,
            displayName: staff.name,
            disabled: true, // 必須點啟用信才能登入
          });
          await revokeTokensForUid(staffId);
          const plainToken = await issueToken({
            uid: staffId, email: staff.email, purpose: 'activation',
          });
          await sendActivationLink(baseUrl, {
            email: staff.email, name: staff.name, plainToken, isReset: false,
          });
          invitedCount++;
        } catch (authError) {
          if (
            authError.code === 'auth/email-already-exists' ||
            authError.code === 'auth/uid-already-exists'
          ) {
            existedCount++;
          } else {
            errorCount++;
            errors.push(`${staffId}: ${authError.message}`);
            console.error(`建立 ${staffId} 帳號失敗:`, authError);
          }
        }
      }

      return res.status(200).json({
        message: '帳號同步作業完成',
        result: { invitedCount, existedCount, errorCount, errors },
      });
    } catch (error) {
      console.error('sync 失敗:', error);
      return res.status(500).json({ error: '伺服器發生錯誤' });
    }
  }

  // —— reset：寄送密碼重設信 ——
  if (action === 'reset') {
    try {
      const { staffId } = req.body;
      if (!staffId) return res.status(400).json({ error: '缺少員工 ID' });

      const targetEmail = `${staffId.toLowerCase()}@hospital.com`;
      const userRecord = await admin.auth().getUserByEmail(targetEmail);

      const staffSnap = await admin.firestore().doc('NurseApp/Staff').get();
      const staffData = staffSnap.exists ? (staffSnap.data().staffData || []) : [];
      const staffRow = staffData.find(s => String(s.staff_id).toLowerCase() === staffId.toLowerCase());
      if (!staffRow || !staffRow.email) {
        return res.status(400).json({ error: '該員工尚未設定 Email，無法寄送重設信' });
      }

      await revokeTokensForUid(userRecord.uid);
      const plainToken = await issueToken({
        uid: userRecord.uid, email: staffRow.email, purpose: 'reset',
      });
      await sendActivationLink(baseUrl, {
        email: staffRow.email, name: staffRow.name || staffId, plainToken, isReset: true,
      });

      return res.status(200).json({
        message: `已寄送密碼重設信至 ${staffRow.email}`,
        email: staffRow.email,
      });
    } catch (error) {
      console.error('reset 失敗:', error);
      if (error.code === 'auth/user-not-found') {
        return res.status(404).json({ error: '在驗證庫中找不到該員工，可能尚未啟用帳號。' });
      }
      return res.status(500).json({ error: '伺服器內部錯誤' });
    }
  }

  return res.status(400).json({ error: `未知的 action：${action}（支援：sync / reset）` });
}
