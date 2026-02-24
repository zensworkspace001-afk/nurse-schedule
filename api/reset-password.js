import admin from 'firebase-admin';

// 終極防呆：確保正確處理換行符號與不小心多加的雙引號
let formatPrivateKey = process.env.FIREBASE_PRIVATE_KEY;
if (formatPrivateKey) {
    // 1. 移除字串頭尾不小心帶入的雙引號
    formatPrivateKey = formatPrivateKey.replace(/^"|"$/g, '');
    // 2. 將字串中的 \n 轉換為真實的換行符號
    formatPrivateKey = formatPrivateKey.replace(/\\n/g, '\n');
}

// 1. 初始化 Firebase Admin (確保只初始化一次)
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: formatPrivateKey, // 使用處理過後的金鑰
    }),
  });
}

// ... 下面的 export default async function handler(req, res) 保持原樣不變 ...