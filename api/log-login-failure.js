// api/log-login-failure.js
//
// 記錄登入失敗到 access_logs，協助偵測暴力破解 / 帳號探測。
// LoginPanel 在 signInWithEmailAndPassword 拋錯時 fire-and-forget 呼叫，不阻擋使用者體驗。
//
// POST /api/log-login-failure   (無需 Bearer — 因為登入本來就失敗了)
//   Body: { attempted_email?: string, error_code?: string }
//
// 安全：
//   - 無授權路徑 → 必須以 IP 嚴格 rate limit（10/min/IP）避免攻擊者灌爆 access_logs。
//   - attempted_email 限制長度上限 200，error_code 限制 100，避免異常 payload。
//   - actor.uid 與 actor.email 寫成 null（因為登入根本沒成功，沒有合法 actor）。
//
// 對 admin 的 AccessLogPanel：行動類型為 'login-failure'，可篩選查看。
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
    return res.status(200).json({ ok: true, service: 'log-login-failure' });
  }

  const csrf = checkCsrf(req);
  if (!csrf.allowed) return res.status(403).json({ error: '禁止：非法來源' });

  const meta = extractClientMeta(req);

  // 嚴格 IP rate limit — 同一 IP 每分鐘最多 10 筆失敗紀錄
  const rl = checkRateLimit(`log-login-fail:${meta.ip || 'unknown'}`, 10);
  if (!rl.allowed) return res.status(429).json({ error: '請求過於頻繁' });

  const { attempted_email, error_code } = req.body || {};
  const safeEmail = typeof attempted_email === 'string' ? attempted_email.slice(0, 200) : null;
  const safeCode = typeof error_code === 'string' ? error_code.slice(0, 100) : null;

  await writeAccessLog({
    actor: { uid: null, email: null },
    action: 'login-failure',
    target: { kind: 'auth', id: null },
    fields: [],
    ip: meta.ip, ua: meta.ua,
    extra: {
      attempted_email: safeEmail,
      error_code: safeCode,
    },
  });

  return res.status(200).json({ ok: true });
}
