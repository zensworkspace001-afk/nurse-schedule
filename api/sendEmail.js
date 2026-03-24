// 檔案位置：api/sendEmail.js
import { Resend } from 'resend';

// 初始化 Resend (它會自動去抓你的環境變數)
const resend = new Resend(process.env.RESEND_API_KEY);

export default async function handler(req, res) {
    // 限制只能用 POST 方法呼叫
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    // 從前端傳來的資料中解構出 收件人、主旨、信件內容
    const { to, subject, html } = req.body;

    try {
        const data = await resend.emails.send({
            from: '護理排班系統 <onboarding@resend.dev>', // Resend 免費方案預設寄件地址
            to: [to],
            subject: subject,
            html: html
        });

        // 成功寄出，回傳給前端
        res.status(200).json({ success: true, data });
    } catch (error) {
        console.error("寄信發生錯誤:", error);
        res.status(500).json({ success: false, error: error.message });
    }
}