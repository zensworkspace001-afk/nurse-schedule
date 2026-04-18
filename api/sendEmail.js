// 檔案位置：api/sendEmail.js
import { Resend } from 'resend';
import admin from 'firebase-admin';
import { sanitizeHtml } from './_lib/sanitize.js';
import { checkRateLimit } from './_lib/rateLimit.js';
import { checkCsrf } from './_lib/csrf.js';

// 初始化 Firebase Admin (確保只初始化一次)
if (!admin.apps.length) {
  let privateKey = process.env.FIREBASE_PRIVATE_KEY;
  if (privateKey) {
    privateKey = privateKey.replace(/^"|"$/g, '');
    privateKey = privateKey.replace(/\\n/g, '\n');
  }
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: privateKey,
    }),
  });
}

// 初始化 Resend (它會自動去抓你的環境變數)
const resend = new Resend(process.env.RESEND_API_KEY);

export default async function handler(req, res) {
    // 限制只能用 POST 方法呼叫
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    // ★ 健康檢查：實際測試 Resend API 連線
    if (req.body?.healthCheck) {
        try {
            await resend.apiKeys.list();
            return res.status(200).json({ ok: true, service: 'sendEmail' });
        } catch (err) {
            return res.status(503).json({ ok: false, service: 'sendEmail', error: err.message });
        }
    }

    // ★ CSRF 防護
    const csrf = checkCsrf(req);
    if (!csrf.allowed) {
        return res.status(403).json({ error: '禁止：非法來源' });
    }

    // ★★★ 資安守衛：雙軌驗證 (Firebase Token 或 Cron Secret) ★★★
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: '未經授權：缺少登入憑證' });
    }

    const token = authHeader.split('Bearer ')[1];
    // 管道 1：Cron 內部呼叫使用 CRON_SECRET
    const isCronCall = token === process.env.CRON_SECRET;
    if (!isCronCall) {
        // 管道 2：前端使用者必須持有合法的 Firebase Token
        var decodedToken;
        try {
            decodedToken = await admin.auth().verifyIdToken(token);
        } catch (err) {
            console.warn('⚠️ 攔截到未經授權的寄信請求');
            return res.status(401).json({ error: '未經授權：登入憑證無效或已過期' });
        }
    }

    // ★ Rate Limiting：每人每分鐘最多 5 封信
    const uid = isCronCall ? 'cron' : decodedToken.uid;
    const rateCheck = checkRateLimit(`email:${uid}`, 5);
    if (!rateCheck.allowed) {
        return res.status(429).json({ error: '請求過於頻繁，請稍後再試' });
    }

    // 從前端傳來的資料中解構出 收件人、主旨、信件內容
    const { to, subject, html } = req.body;

    // ★ HTML 清理：移除 script、事件屬性等危險內容
    const safeHtml = sanitizeHtml(html);

    try {
        const data = await resend.emails.send({
            from: '護理排班系統 <onboarding@resend.dev>', // Resend 免費方案預設寄件地址
            to: [to],
            subject: subject,
            html: safeHtml
        });

        // 成功寄出，回傳給前端
        res.status(200).json({ success: true, data });
    } catch (error) {
        console.error("寄信發生錯誤:", error);
        res.status(500).json({ success: false, error: '寄信失敗' });
    }
}