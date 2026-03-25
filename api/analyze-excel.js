import { GoogleGenerativeAI } from '@google/generative-ai';
import busboy from 'busboy';
import admin from 'firebase-admin';

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

export const config = {
  api: { bodyParser: false },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: '只允許 POST' });

  // ★★★ 資安守衛：驗證 Firebase Token ★★★
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未經授權：缺少登入憑證' });
  }
  try {
    const token = authHeader.split('Bearer ')[1];
    await admin.auth().verifyIdToken(token);
  } catch (err) {
    console.warn('⚠️ 攔截到未經授權的 Excel 分析請求');
    return res.status(401).json({ error: '未經授權：登入憑證無效或已過期' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("❌ 找不到 GEMINI_API_KEY");
    return res.status(500).json({ error: '伺服器未設定 API 金鑰' });
  }

  // ★ 核心修復：用 Promise 包住整個 busboy，讓 async/await 可以正確等待
  const parseForm = () => new Promise((resolve, reject) => {
    const bb = busboy({ headers: req.headers });
    let fileContent = '';
    let userPrompt = '';

    bb.on('file', (name, file) => {
      file.on('data', (data) => { fileContent += data.toString(); });
      file.on('error', reject);
    });

    bb.on('field', (name, val) => {
      if (name === 'prompt') userPrompt = val;
    });

    bb.on('finish', () => resolve({ fileContent, userPrompt }));
    bb.on('error', reject);

    req.pipe(bb);
  });

  try {
    // ★ 現在可以正確 await，錯誤也能被 catch 接住
    const { fileContent, userPrompt } = await parseForm();

    // (DEV) console.log("📂 收到內容長度:", fileContent.length);
    // (DEV) console.log("💬 使用者問題:", userPrompt);

    if (!fileContent) {
      return res.status(400).json({ error: '未收到報表內容' });
    }
    if (!userPrompt) {
      return res.status(400).json({ error: '未收到問題' });
    }

    const genAI = new GoogleGenerativeAI(apiKey);

    // ★ 修正模型名稱：新版 SDK 統一用 gemini-1.5-flash（舊名已棄用）
    //    若仍然失敗可改為 'gemini-pro'
    const model = genAI.getGenerativeModel({ model: 'gemini-flash-latest' });

    const finalPrompt = `
你是一個護理排班分析專家。以下是護理排班結算報表資料：

${fileContent}

使用者問題：${userPrompt}

請根據報表資料，用繁體中文詳細回答。如果資料不足以回答，請明確說明。
    `.trim();

    const result = await model.generateContent(finalPrompt);
    const text = result.response.text();

    return res.status(200).json({ text });

  } catch (err) {
    // ★ 現在所有錯誤都能在這裡被接住並印出
    console.error("❌ analyze-excel 完整錯誤:", err);
    return res.status(500).json({
      error: '伺服器錯誤'
    });
  }
}