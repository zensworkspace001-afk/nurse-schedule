// api/log-login.js
//
// 統一登入稽核端點：成功與失敗都走這裡（兩個分支以 body.success 切換）
// 分開兩支 API 會超過 Vercel Hobby plan 12 個 function 上限。
//
// POST /api/log-login
//   { success: true }                                   ← 必須 Bearer Firebase token
//   { success: false, attempted_email, error_code }     ← 無 auth；以 IP rate-limit
import admin from 'firebase-admin';
import { checkCsrf } from './_lib/csrf.js';
import { checkRateLimit } from './_lib/rateLimit.js';
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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: '只允許 POST 請求' });

  if (req.body?.healthCheck) {
    return res.status(200).json({ ok: true, service: 'log-login' });
  }

  const csrf = checkCsrf(req);
  if (!csrf.allowed) return res.status(403).json({ error: '禁止：非法來源' });

  const meta = extractClientMeta(req);
  const { success, attempted_email, error_code } = req.body || {};

  if (success === true) {
    // —— 成功登入：必須帶 token ——
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
    const rl = checkRateLimit(`log-login:${actor.uid}`, 10);
    if (!rl.allowed) return res.status(429).json({ error: '請求過於頻繁' });

    await writeAccessLog({
      actor,
      action: 'login',
      target: { kind: 'auth', id: actor.uid },
      fields: [],
      ip: meta.ip, ua: meta.ua,
      extra: null,
    });
    return res.status(200).json({ ok: true });
  }

  // —— 登入失敗：無 auth；以 IP rate-limit 防灌爆 ——
  const rl = checkRateLimit(`log-login-fail:${meta.ip || 'unknown'}`, 10);
  if (!rl.allowed) return res.status(429).json({ error: '請求過於頻繁' });

  const safeEmail = typeof attempted_email === 'string' ? attempted_email.slice(0, 200) : null;
  const safeCode = typeof error_code === 'string' ? error_code.slice(0, 100) : null;

  await writeAccessLog({
    actor: { uid: null, email: null },
    action: 'login-failure',
    target: { kind: 'auth', id: null },
    fields: [],
    ip: meta.ip, ua: meta.ua,
    extra: { attempted_email: safeEmail, error_code: safeCode },
  });
  return res.status(200).json({ ok: true });
}
