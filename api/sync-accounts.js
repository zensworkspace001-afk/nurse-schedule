// api/sync-accounts.js
//
// 管理員批次同步員工帳號：
//   1. 為每位新員工在 Firebase Auth 建立帳號
//      - 使用 crypto 隨機 36 字密碼（員工永遠不會看到 / 用到）
//      - disabled: true → Firebase 會直接拒絕登入，員工必須先點啟用信
//   2. 產生一次性啟用 token，寫入 pending_activation/{tokenHash}
//   3. 透過 /api/sendEmail（Resend）寄啟用信，包含
//      https://<host>/activate?token=<plainToken> 連結
//
// 安全層：CSRF + 管理員 Bearer + 失敗 fallback
import crypto from 'node:crypto';
import admin from 'firebase-admin';
import { checkCsrf } from './_lib/csrf.js';
import { issueToken, revokeTokensForUid } from './_lib/activationToken.js';

if (!admin.apps.length) {
  let serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
  }
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

function getActivationBaseUrl(req) {
  // 1) 明確指定（建議在 Vercel env 設 ACTIVATION_BASE_URL=https://nurse-schedule-bachelor.vercel.app）
  if (process.env.ACTIVATION_BASE_URL) return process.env.ACTIVATION_BASE_URL.replace(/\/+$/, '');
  // 2) Vercel 內建：VERCEL_PROJECT_PRODUCTION_URL 不含 protocol
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  // 3) Fallback：Origin header（dev 時是 http://localhost:5173）
  const origin = req.headers.origin || req.headers.referer;
  if (origin) return origin.replace(/\/+$/, '');
  return 'https://nurse-schedule-bachelor.vercel.app';
}

async function sendActivationEmail(baseUrl, { email, name, plainToken }) {
  const link = `${baseUrl}/activate?token=${plainToken}`;
  const subject = '【護理排班系統】請啟用您的帳號';
  const html = `
    <h2>您好 ${escapeHtml(name)}：</h2>
    <p>管理員已為您建立護理排班系統帳號。請點擊以下連結設定您的登入密碼以啟用帳號：</p>
    <p><a href="${link}" style="display:inline-block;padding:10px 20px;background:#0066cc;color:#fff;text-decoration:none;border-radius:4px;">點我啟用帳號並設定密碼</a></p>
    <p>或複製以下網址至瀏覽器開啟：<br/><code>${link}</code></p>
    <hr/>
    <p style="color:#888;font-size:12px;">此連結 24 小時內有效，僅可使用一次。<br/>若您未申請此帳號，請忽略此信。</p>
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

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: '只允許 POST 請求' });

  if (req.body?.healthCheck) {
    try {
      await admin.auth().listUsers(1);
      return res.status(200).json({ ok: true, service: 'sync-accounts' });
    } catch (err) {
      return res.status(503).json({ ok: false, service: 'sync-accounts', error: err.message });
    }
  }

  const csrf = checkCsrf(req);
  if (!csrf.allowed) {
    return res.status(403).json({ error: '禁止：非法來源' });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未經授權：缺少登入憑證' });
  }
  try {
    const token = authHeader.split('Bearer ')[1];
    const decodedToken = await admin.auth().verifyIdToken(token);
    if (decodedToken.email !== 'admin@hospital.com') {
      return res.status(403).json({ error: '權限不足：只有管理員能執行此操作' });
    }
  } catch {
    console.warn('攔截到未經授權的帳號同步請求');
    return res.status(401).json({ error: '未經授權：登入憑證無效或已過期' });
  }

  try {
    const { staffList } = req.body;
    if (!Array.isArray(staffList)) {
      return res.status(400).json({ error: '無效的名單格式' });
    }

    const baseUrl = getActivationBaseUrl(req);

    let invitedCount = 0;     // 新建帳號 + 寄出啟用信
    let existedCount = 0;     // 帳號已存在（已啟用過或先前邀請過尚未過期）
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
        // 之前若有殘留 token 一併清除
        await revokeTokensForUid(staffId);
        const plainToken = await issueToken({
          uid: staffId,
          email: staff.email,
          purpose: 'activation',
        });
        await sendActivationEmail(baseUrl, {
          email: staff.email,
          name: staff.name,
          plainToken,
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
    console.error('API 崩潰:', error);
    return res.status(500).json({ error: '伺服器發生錯誤' });
  }
}
