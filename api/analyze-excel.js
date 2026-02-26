import { GoogleGenerativeAI } from '@google/generative-ai';
import busboy from 'busboy';

export const config = {
  api: { bodyParser: false },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: '只允許 POST' });

  // 🕵️ 日誌 1：檢查 API Key
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("❌ 錯誤：找不到 GEMINI_API_KEY 環境變數");
    return res.status(500).json({ error: '伺服器未設定 API 金鑰' });
  }

  try {
    const bb = busboy({ headers: req.headers });
    let fileContent = '';
    let userPrompt = '';

    bb.on('file', (name, file) => {
      file.on('data', (data) => { fileContent += data.toString(); });
    });

    bb.on('field', (name, val) => {
      if (name === 'prompt') userPrompt = val;
    });

    bb.on('finish', async () => {
      try {
        console.log("📂 收到報表內容長度:", fileContent.length);
        console.log("💬 使用者問題:", userPrompt);

        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

        const finalPrompt = `
          以下是護理排班結算報表：
          ${fileContent}
          
          問題：${userPrompt}
          請根據報表回答。
        `;

        const result = await model.generateContent(finalPrompt);
        const text = result.response.text();
        res.status(200).json({ text });
      } catch (aiErr) {
        console.error("❌ AI 運算階段噴錯:", aiErr);
        res.status(500).json({ error: 'AI 運算失敗: ' + aiErr.message });
      }
    });

    req.pipe(bb);

  } catch (globalErr) {
    console.error("❌ API 解析階段噴錯:", globalErr);
    res.status(500).json({ error: '伺服器內部錯誤' });
  }
}