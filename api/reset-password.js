import admin from 'firebase-admin';

// 1. 終極防呆：確保正確處理換行符號與不小心多加的雙引號
let formatPrivateKey = process.env.FIREBASE_PRIVATE_KEY;
if (formatPrivateKey) {
    // 移除字串頭尾不小心帶入的雙引號
    formatPrivateKey = formatPrivateKey.replace(/^"|"$/g, '');
    // 將字串中的 \n 轉換為真實的換行符號
    formatPrivateKey = formatPrivateKey.replace(/\\n/g, '\n');
}

// 2. 初始化 Firebase Admin (確保只初始化一次)
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: formatPrivateKey, 
    }),
  });
}

// 3. ★★★ 這裡就是 Vercel 剛剛找不到的 Export 函式！ ★★★
export default async function handler(req, res) {
  // 限制只接受 POST 請求
  if (req.method !== 'POST') {
    return res.status(405).json({ error: '只允許 POST 請求' });
  }

  // 檢查請求是否帶有通行證 (Token)
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未經授權：缺少登入憑證' });
  }

  try {
    const token = authHeader.split('Bearer ')[1];
    
    // 驗證這張 Token 的真實性
    const decodedToken = await admin.auth().verifyIdToken(token);

    // 【核心資安防護】確認呼叫這支 API 的人，真的是管理員！
    if (decodedToken.email !== 'admin@hospital.com') {
       return res.status(403).json({ error: '權限不足：只有管理員能執行此操作' });
    }

    // 取得要重置的員工 ID (例如 N001)
    const { staffId } = req.body;
    if (!staffId) return res.status(400).json({ error: '缺少員工 ID' });

    // 拼湊出該員工的 Firebase Email 帳號
    const targetEmail = `${staffId.toLowerCase()}@hospital.com`;

    // 透過 Email 找到該員工的 Firebase UID
    const userRecord = await admin.auth().getUserByEmail(targetEmail);

    // 將密碼強制重置為 123456
    await admin.auth().updateUser(userRecord.uid, {
      password: '123456' 
    });

    return res.status(200).json({ message: `成功將 ${staffId} 密碼重置為 123456` });

  } catch (error) {
    console.error('重置密碼失敗:', error);
    // 如果找不到該使用者
    if (error.code === 'auth/user-not-found') {
        return res.status(404).json({ error: '在驗證庫中找不到該員工，可能尚未啟用帳號。' });
    }
    return res.status(500).json({ error: error.message });
  }
}