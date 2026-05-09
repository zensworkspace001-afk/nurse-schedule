// 統一加密 / 解密端點
//
// POST /api/secure-field
//   Body 格式（依 action 不同）：
//     { action: 'encrypt',       payload: any,        target?: { kind, id }, fields?: [...] }
//     { action: 'decrypt',       payload: blob,       target?: { kind, id }, fields?: [...] }
//     { action: 'batchDecrypt',  payload: blob[],     target?: { kind, id }, fields?: [...] }
//     { action: 'logAiAccess',   target: {kind, id},  fields: [...],         extra?: object }
//
// 權限規則：
//   - admin@hospital.com：所有 action / 所有 target
//   - 員工本人：只能對自己的 staff 資料執行 decrypt / batchDecrypt
//   - encrypt：admin only（員工不需主動加密；UI 寫入時才走 encrypt）
//
// 安全層：CSRF (Origin) + Bearer token 驗證 + Rate limit + Audit log

import admin from 'firebase-admin';
import { checkCsrf } from './_lib/csrf.js';
import { checkRateLimit } from './_lib/rateLimit.js';
import { encryptField, decryptField, isEncrypted } from './_lib/crypto.js';
import { writeAccessLog, extractClientMeta } from './_lib/accessLog.js';

const ADMIN_EMAIL = 'admin@hospital.com';

// 沿用既有的 Firebase Admin 初始化模式（雙路徑：SERVICE_ACCOUNT 或 PROJECT_ID 三件組）
if (!admin.apps.length) {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    let sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, '\n');
    admin.initializeApp({ credential: admin.credential.cert(sa) });
  } else {
    let pk = process.env.FIREBASE_PRIVATE_KEY;
    if (pk) {
      pk = pk.replace(/^"|"$/g, '').replace(/\\n/g, '\n');
    }
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: pk,
      }),
    });
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: '只允許 POST 請求' });
  }

  // 健康檢查
  if (req.body?.healthCheck) {
    try {
      // 試解一筆「現場加密的測試值」確認金鑰存在且可用
      const probe = encryptField('healthcheck');
      const back = decryptField(probe);
      const ok = back === 'healthcheck';
      return res.status(ok ? 200 : 503).json({ ok, service: 'secure-field' });
    } catch (err) {
      return res.status(503).json({ ok: false, service: 'secure-field', error: err.message });
    }
  }

  const csrf = checkCsrf(req);
  if (!csrf.allowed) {
    return res.status(403).json({ error: '禁止：非法來源' });
  }

  // 驗證 Firebase token
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

  // Rate limit：每分鐘 60 次（解密熱點，但管理員批量解時要夠用）
  const rl = checkRateLimit(actor.uid, 60);
  if (!rl.allowed) {
    return res.status(429).json({
      error: '請求過於頻繁，請稍候再試',
      retryAfterMs: rl.retryAfterMs,
    });
  }

  const { action, payload, target, fields, extra } = req.body || {};
  const isAdmin = actor.email === ADMIN_EMAIL;
  const meta = extractClientMeta(req);

  try {
    switch (action) {
      case 'encrypt': {
        if (!isAdmin) {
          return res.status(403).json({ error: '權限不足：只有管理員能執行加密' });
        }
        const blob = encryptField(payload);
        // 必須 await：Vercel serverless 在 res.json() 之後可能凍結 lambda，
        // 沒 await 的 writeAccessLog 經常導致 access_logs 寫入未完成。
        await writeAccessLog({
          actor, action: 'encrypt',
          target: target || { kind: null, id: null },
          fields: fields || [],
          ip: meta.ip, ua: meta.ua, extra: null,
        });
        return res.status(200).json({ blob });
      }

      case 'decrypt': {
        if (!isEncrypted(payload)) {
          return res.status(400).json({ error: '無效的密文格式' });
        }
        if (!isAdmin && !canStaffAccessTarget(actor, target)) {
          return res.status(403).json({ error: '權限不足：無法解密此目標' });
        }
        const value = decryptField(payload);
        await writeAccessLog({
          actor, action: 'decrypt',
          target: target || { kind: null, id: null },
          fields: fields || [],
          ip: meta.ip, ua: meta.ua, extra: null,
        });
        return res.status(200).json({ value });
      }

      case 'batchDecrypt': {
        if (!Array.isArray(payload)) {
          return res.status(400).json({ error: '批次解密需要陣列 payload' });
        }
        if (!isAdmin && !canStaffAccessTarget(actor, target)) {
          return res.status(403).json({ error: '權限不足：無法批次解密此目標' });
        }
        const values = payload.map((blob, idx) => {
          if (!isEncrypted(blob)) return { idx, error: '非密文格式' };
          try {
            return { idx, value: decryptField(blob) };
          } catch (err) {
            return { idx, error: err.message };
          }
        });
        await writeAccessLog({
          actor, action: 'decrypt',
          target: target || { kind: null, id: null },
          fields: fields || [],
          ip: meta.ip, ua: meta.ua,
          extra: { batchSize: payload.length },
        });
        return res.status(200).json({ values });
      }

      case 'logAiAccess': {
        // 前端在把敏感資料送給 Gemini 之前呼叫此 action 留痕
        if (!isAdmin) {
          return res.status(403).json({ error: '權限不足' });
        }
        await writeAccessLog({
          actor, action: 'ai-access',
          target: target || { kind: null, id: null },
          fields: fields || [],
          ip: meta.ip, ua: meta.ua,
          extra: extra || null,
        });
        return res.status(200).json({ ok: true });
      }

      default:
        return res.status(400).json({ error: `未知的 action：${action}` });
    }
  } catch (err) {
    console.error('secure-field 失敗:', err);
    return res.status(500).json({ error: err.message || '伺服器錯誤' });
  }
}

// 員工 staff 自己解自己 → target.kind === 'staff' && target.id === actor.uid
function canStaffAccessTarget(actor, target) {
  if (!target) return false;
  if (target.kind !== 'staff') return false;
  if (!target.id) return false;
  // Firebase UID 在 sync-accounts.js 是用 staff_id（如 'N001'）綁定的
  return String(target.id).toLowerCase() === String(actor.uid).toLowerCase();
}
