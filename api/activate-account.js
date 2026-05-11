// api/activate-account.js
//
// 公開端點（無需 Firebase 登入），由「token 本身」擔任授權。
//
// POST /api/activate-account
//   Body: { token: string, newPassword: string }
//
// 動作：
//   1. 驗 token（未過期、未使用）。
//   2. 檢查密碼強度。
//   3. 透過 Firebase Admin SDK 設定該 uid 的密碼。
//      - purpose === 'activation': 同時 disabled: false 開通帳號
//      - purpose === 'reset':       只改密碼，不動 disabled。
//   4. 刪除 token doc（一次性）。
//
// 防濫用：CSRF + IP rate limit (5 req/min/IP)。失敗不洩漏 token 是否存在。
import admin from 'firebase-admin';
import { checkCsrf } from './_lib/csrf.js';
import { checkRateLimit } from './_lib/rateLimit.js';
import {
  verifyToken,
  consumeToken,
  validatePasswordStrength,
} from './_lib/activationToken.js';

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

  // 3. 套用變更
  try {
    const updates = { password: newPassword };
    if (tokenData.purpose === 'activation') {
      updates.disabled = false;
    }
    await admin.auth().updateUser(tokenData.uid, updates);
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
