// 檔案位置： api/gemini.js
const { GoogleGenerativeAI } = require('@google/generative-ai');

module.exports = async function handler(req, res) {
  // 1. 確保只接收 POST 請求
  if (req.method !== 'POST') {
    return res.status(405).json({ error: '只允許 POST 請求' });
  }

  try {
    // 2. 讀取 Vercel 後台的環境變數 (不可加 VITE_)
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error("找不到 API 金鑰");
      return res.status(500).json({ error: '伺服器未設定 API 金鑰' });
    }

    // 3. 呼叫 Gemini AI
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-pro-latest" });

    const { prompt } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: '缺少 prompt 參數' });
    }

    const result = await model.generateContent(prompt);
    const text = result.response.text();

    // 4. 成功回傳結果給前端
    return res.status(200).json({ text: text });

  } catch (error) {
    // 將詳細錯誤印在 Vercel 後台日誌中
    console.error('Gemini API 發生錯誤:', error);
    return res.status(500).json({ error: error.message || '伺服器內部錯誤' });
  }
};