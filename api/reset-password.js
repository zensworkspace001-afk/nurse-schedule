// api/reset-password.js
//
// 管理員觸發「寄送密碼重設信」。
//
// 行為：
//   1. 驗證呼叫者是 admin。
//   2. 找到目標員工的 Firebase Auth 帳號與 staffData 上的 email。
//   3. 撤銷該員工先前未使用的 token，重新產一張 purpose='reset' 的 token。
//   4. 透過 /api/sendEmail 寄重設信，連結指向 /activate?token=...（活化頁同時處理 reset）。
//   5. 員工點連結 → /api/activate-account 驗 token 後設定新密碼。
//
// 與舊版差異：不再硬寫 123456。新流程下密碼僅存於使用者腦中，admin 與後端皆無法回讀。
import admin from 'firebase-admin';
import { checkCsrf } from './_lib/csrf.js';
import { issueToken, revokeTokensForUid } from './_lib/activationToken.js';

let formatPrivateKey = process.env.FIREBASE_PRIVATE_KEY;
if (formatPrivateKey) {
  formatPrivateKey = formatPrivateKey.replace(/^"|"$/g, '');
  formatPrivateKey = formatPrivateKey.replace(/\\n/g, '\n');
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: formatPrivateKey,
    }),
  });
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

async function sendResetEmail(baseUrl, { email, name, plainToken }) {
  const link = `${baseUrl}/activate?token=${plainToken}`;
  const subject = '【護理排班系統】密碼重設請求';
  const html = `
    <h2>您好 ${escapeHtml(name)}：</h2>
    <p>管理員已為您觸發密碼重設。請點擊以下連結設定新的登入密碼：</p>
    <p><a href="${link}" style="display:inline-block;padding:10px 20px;background:#0066cc;color:#fff;text-decoration:none;border-radius:4px;">點我重設密碼</a></p>
    <p>或複製以下網址至瀏覽器開啟：<br/><code>${link}</code></p>
    <hr/>
    <p style="color:#888;font-size:12px;">此連結 24 小時內有效，僅可使用一次。<br/>若您未請求此操作，請忽略此信並聯絡管理員。</p>
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
      return res.status(200).json({ ok: true, service: 'reset-password' });
    } catch (err) {
      return res.status(503).json({ ok: false, service: 'reset-password', error: err.message });
    }
  }

  const csrf = checkCsrf(req);
  if (!csrf.allowed) return res.status(403).json({ error: '禁止：非法來源' });

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

    const { staffId } = req.body;
    if (!staffId) return res.status(400).json({ error: '缺少員工 ID' });

    const targetEmail = `${staffId.toLowerCase()}@hospital.com`;
    const userRecord = await admin.auth().getUserByEmail(targetEmail);

    // 從 NurseApp/Staff 撈出真正的員工 email（用於寄信）與姓名
    const staffSnap = await admin.firestore().doc('NurseApp/Staff').get();
    const staffData = staffSnap.exists ? (staffSnap.data().staffData || []) : [];
    const staffRow = staffData.find(s => String(s.staff_id).toLowerCase() === staffId.toLowerCase());
    if (!staffRow || !staffRow.email) {
      return res.status(400).json({ error: '該員工尚未設定 Email，無法寄送重設信' });
    }

    await revokeTokensForUid(userRecord.uid);
    const plainToken = await issueToken({
      uid: userRecord.uid,
      email: staffRow.email,
      purpose: 'reset',
    });

    const baseUrl = getBaseUrl(req);
    await sendResetEmail(baseUrl, {
      email: staffRow.email,
      name: staffRow.name || staffId,
      plainToken,
    });

    return res.status(200).json({
      message: `已寄送密碼重設信至 ${staffRow.email}`,
      email: staffRow.email,
    });
  } catch (error) {
    console.error('寄送密碼重設信失敗:', error);
    if (error.code === 'auth/user-not-found') {
      return res.status(404).json({ error: '在驗證庫中找不到該員工，可能尚未啟用帳號。' });
    }
    return res.status(500).json({ error: '伺服器內部錯誤' });
  }
}
