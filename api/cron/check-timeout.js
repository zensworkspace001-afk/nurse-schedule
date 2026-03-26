import admin from 'firebase-admin';

// 1. 初始化 Firebase Admin (讓後端有最高權限讀寫資料庫)
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}
const db = admin.firestore();

export default async function handler(req, res) {
    // ★ 健康檢查：實際測試 Firestore 連線
    if (req.query?.healthCheck === 'true') {
        try {
            await db.collection('NurseApp').doc('Settings').get();
            return res.status(200).json({ ok: true, service: 'cron/check-timeout' });
        } catch (err) {
            return res.status(503).json({ ok: false, service: 'cron/check-timeout', error: err.message });
        }
    }

    // 2. 安全鎖：確保是 Vercel 的 Cron 系統來敲門，不是駭客亂點
    if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        console.log("🤖 [巡邏機器人] 啟動巡邏...");
        
        // 動態取得當前年月（Vercel Cron 每日執行）
        const now = new Date();
        const currentYear = now.getFullYear();
        const currentMonth = now.getMonth() + 1;
        
        // 3. 去雷達 (SelectionTurn) 看現在輪到誰
        const turnRef = db.collection('SelectionTurn').doc(`${currentYear}_${currentMonth}`);
        const turnSnap = await turnRef.get();
        
        if (!turnSnap.exists || !turnSnap.data().active_staff_id) {
            return res.status(200).json({ message: "目前無人排隊，引擎待機中。" });
        }

        const turnData = turnSnap.data();
        const activeStaffId = turnData.active_staff_id;
        
        // 4. 計算卡住的時間 (有沒有超過 24 小時？)
        const lastUpdated = turnData.updatedAt.toDate();
        const hoursDiff = (new Date() - lastUpdated) / (1000 * 60 * 60);

        if (hoursDiff < 24) {
            return res.status(200).json({ message: `目前輪到 ${activeStaffId}，才過了 ${hoursDiff.toFixed(1)} 小時，繼續等待。` });
        }

        console.log(`🚨 警告：${activeStaffId} 已逾時 ${hoursDiff.toFixed(1)} 小時！執行強制跳過...`);

        // ==========================================
        // ★ 5. 觸發 Agentic 動作：剝奪權力並交棒！
        // ==========================================
        
        // A. 將逾時者打入冷宮 (加入已送出清單)
        const progressRef = db.collection('SelectionProgress').doc(`${currentYear}_${currentMonth}`);
        await progressRef.set({
            submitted_staff: admin.firestore.FieldValue.arrayUnion(activeStaffId)
        }, { merge: true });

        // B. 清空雷達
        await turnRef.set({ active_staff_id: null, updatedAt: admin.firestore.FieldValue.serverTimestamp() });

        // C. 呼叫你原本寫好的 Gemini 邏輯去選下一個人 (如果你的 Gemini 邏輯有寫成獨立的後端 API 的話，可以直接 fetch)
        // 這裡為了簡化，我們先通知管理員，並讓後台準備啟動下一輪
        
        // 假設你有內部 API 可以直接呼叫發信
        const adminEmail = "zensworkspace001@gmail.com"; // 替換成護理長信箱
        const baseUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL || 'nurse-schedule-bachelor.vercel.app';
        const mailRes = await fetch(`https://${baseUrl}/api/sendEmail`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.CRON_SECRET}`
            },
            body: JSON.stringify({ 
                to: adminEmail, 
                subject: `🚨 AI 系統回報：已強制跳過逾時員工 ${activeStaffId}`, 
                html: `<p>護理長您好：</p><p>員工 <b>${activeStaffId}</b> 已經超過 24 小時未選班。<br/>系統已自動將其跳過，請您登入系統點擊「啟動接力」將發球權交給下一位同仁。</p>` 
            })
        });

        return res.status(200).json({ 
            success: true, 
            message: `已成功跳過 ${activeStaffId} 並通知管理員。` 
        });

    } catch (error) {
        console.error("巡邏機器人發生錯誤:", error);
        return res.status(500).json({ error: '巡邏機器人發生錯誤' });
    }
}