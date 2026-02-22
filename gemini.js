// 檔案位置： api/gemini.js
import { GoogleGenerativeAI } from '@google/generative-ai';

export default async function handler(req, res) {
  // 確保只接收 POST 請求
  if (req.method !== 'POST') {
    return res.status(405).json({ error: '只允許 POST 請求' });
  }

  try {
    // 🚨 注意這裡！我們讀取的是沒有 VITE_ 開頭的變數，它只存在於伺服器後端，絕對安全！
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: '伺服器未設定 API 金鑰' });
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const { prompt } = req.body;
    const result = await model.generateContent(prompt);
    const text = result.response.text();

    // 將 AI 的回答傳回給前端
    return res.status(200).json({ text: text });

  } catch (error) {
    console.error('Gemini API 發生錯誤:', error);
    return res.status(500).json({ error: error.message || '伺服器內部錯誤' });
  }
}