import { GoogleGenerativeAI } from '@google/generative-ai';
import busboy from 'busboy';

// 🛑 重要：關閉 Vercel 預設的 body parser，因為我們要處理檔案流 (FormData)
export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  // 1. 只允許 POST 請求
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // 2. 從環境變數讀取 Gemini API KEY (請確保 Vercel 後端有設定此變數)
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: '伺服器未設定 GEMINI_API_KEY' });
  }

  try {
    const bb = busboy({ headers: req.headers });
    let fileContent = '';
    let userPrompt = '';

    // 解析檔案內容 (CSV)
    bb.on('file', (name, file, info) => {
      file.on('data', (data) => {
        fileContent += data.toString();
      });
    });

    // 解析文字欄位 (提問內容)
    bb.on('field', (name, val) => {
      if (name === 'prompt') userPrompt = val;
    });

    // 當解析完成時，呼叫 Gemini
    bb.on('finish', async () => {
      if (!fileContent) return res.status(400).json({ error: '找不到報表內容' });

      try {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

        const finalPrompt = `
          你是一位專業的醫院護理行政數據分析師。
          以下是系統匯出的「跨月份護理人員薪資與排班結算報表」：
          
          --- CSV 數據開始 ---
          ${fileContent}
          --- CSV 數據結束 ---

          請根據以上數據，精準回答使用者的問題：
          「${userPrompt}」

          回答規範：
          1. 請直接給出分析結果，條理分明。
          2. 若涉及金額運算，請務必核對準確。
          3. 若數據中找不到相關資訊，請誠實告知。
        `;

        const result = await model.generateContent(finalPrompt);
        const responseText = result.response.text();

        res.status(200).json({ text: responseText });
      } catch (aiError) {
        console.error("Gemini 運算失敗:", aiError);
        res.status(500).json({ error: 'AI 運算失敗: ' + aiError.message });
      }
    });

    req.pipe(bb);

  } catch (error) {
    console.error('API 錯誤:', error);
    res.status(500).json({ error: '伺服器發生未預期錯誤' });
  }
}