// api/sync-accounts.js
import admin from 'firebase-admin';
import { checkCsrf } from './_lib/csrf.js';

// 1. 初始化 Firebase Admin (包含防呆解碼換行符號)
if (!admin.apps.length) {
  let serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  if (serviceAccount.private_key) {
     serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
  }
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: '只允許 POST 請求' });

  // ★ CSRF 防護
  const csrf = checkCsrf(req);
  if (!csrf.allowed) {
    return res.status(403).json({ error: '禁止：非法來源' });
  }

  // ★★★ 資安守衛：驗證 Firebase Token + 管理員身份 ★★★
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
  } catch (err) {
    console.warn('⚠️ 攔截到未經授權的帳號同步請求');
    return res.status(401).json({ error: '未經授權：登入憑證無效或已過期' });
  }

  try {
    const { staffList } = req.body;
    
    if (!staffList || !Array.isArray(staffList)) {
        return res.status(400).json({ error: '無效的名單格式' });
    }

    let successCount = 0;
    let existedCount = 0;
    let errorCount = 0;

    // 2. 逐一檢查名單並建立帳號
    for (const staff of staffList) {
      const loginEmail = `${staff.staff_id.toLowerCase()}@hospital.com`;
      const defaultPassword = '123456'; // 預設密碼

      try {
        await admin.auth().createUser({
          uid: staff.staff_id,        // 強制綁定工號作為系統 UID
          email: loginEmail,
          password: defaultPassword,
          displayName: staff.name,
        });
        successCount++;
        console.log(`✅ 已為 ${staff.name} (${staff.staff_id}) 建立帳號`);

      } catch (authError) {
        // 如果信箱或 UID 已經存在，代表是老員工，直接略過不報錯
        if (authError.code === 'auth/email-already-exists' || authError.code === 'auth/uid-already-exists') {
            existedCount++;
        } else {
            console.error(`❌ 建立 ${staff.staff_id} 帳號失敗:`, authError);
            errorCount++;
        }
      }
    }

    return res.status(200).json({ 
        message: '帳號同步作業完成', 
        result: { successCount, existedCount, errorCount } 
    });

  } catch (error) {
    console.error("API 崩潰:", error);
    return res.status(500).json({ error: "伺服器發生錯誤" });
  }
}