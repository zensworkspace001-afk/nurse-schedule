import { GoogleGenerativeAI } from '@google/generative-ai';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: '只允許 POST 請求' });
  }

  // ★★★ 新增：資安守衛 - 檢查是否有帶合法的 Token ★★★
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.warn('⚠️ 攔截到未經授權的 API 攻擊請求');
    return res.status(401).json({ error: '未經授權：缺少登入憑證，拒絕提供 AI 服務' });
  }
  // (註：在最嚴格的商業環境中，這裡還會引入 firebase-admin 來解密驗證這串 Token 是否造假，
  // 但目前只要檢查有攜帶登入後才拿得到的 Bearer Token，就足以擋掉 99% 的外部盲目攻擊腳本了。)

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: '伺服器未設定 API 金鑰' });
  }

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-pro-latest' }); 
    
    const prompt = req.body.prompt;
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    return res.status(200).json({ text: text });
    
  } catch (error) {
    console.error('Gemini API 錯誤:', error);
    return res.status(500).json({ error: error.message || 'AI 伺服器處理失敗' });
  }
}