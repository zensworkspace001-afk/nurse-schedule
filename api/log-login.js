// api/log-login.js
//
// 記錄成功登入到 access_logs。
// LoginPanel 在 signInWithEmailAndPassword 成功後 fire-and-forget 呼叫。
//
// POST /api/log-login   (Bearer Firebase ID token)
//   Body: 無
//
// 安全：
//   - 必須 token 驗證通過 — 只有真的拿到合法 token 的使用者才能寫成功登入紀錄。
//   - rate limit per uid（10/min；正常每分鐘最多登入幾次）。
//
// 不擋業務流程：寫稽核失敗就只回 500，前端應 fire-and-forget。
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

  const meta = extractClientMeta(req);
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
