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

        // C. 呼叫自動接力引擎，選出下一位
        const baseUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL || 'nurse-schedule-bachelor.vercel.app';
        
        // 抓取目前班表與統計數據 (為了給 AI 決策)
        const scheduleSnap = await db.collection('Schedules').doc(`${currentYear}_${currentMonth}`).get();
        const currentSchedule = scheduleSnap.exists ? (scheduleSnap.data().finalizedSchedule || {}) : {};
        
        // 這裡我們不帶 statsData，讓 API 自己去算或使用預設 (或者我們也可以從 NurseApp/Staff 抓)
        
        const relayRes = await fetch(`https://${baseUrl}/api/auto-relay`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.CRON_SECRET}`
            },
            body: JSON.stringify({ 
                year: currentYear, 
                month: currentMonth, 
                currentSchedule 
            })
        });

        const relayData = await relayRes.json();

        // D. 通知管理員已強制跳過
        const adminEmail = "zensworkspace001@gmail.com"; 
        await fetch(`https://${baseUrl}/api/sendEmail`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.CRON_SECRET}`
            },
            body: JSON.stringify({ 
                to: adminEmail, 
                subject: `🚨 AI 系統回報：已強制跳過逾時員工 ${activeStaffId}`, 
                html: `<p>護理長您好：</p><p>員工 <b>${activeStaffId}</b> 已經超過 24 小時未選班。<br/>系統已自動將其跳過，並已自動啟動 AI 接力將發球權交給下一位同仁：<b>${relayData.selected_staff_id || '尋找中'}</b>。</p>` 
            })
        });

        return res.status(200).json({ 
            success: true, 
            message: `已成功跳過 ${activeStaffId} 並自動交棒給 ${relayData.selected_staff_id}。` 
        });

    } catch (error) {
        console.error("巡邏機器人發生錯誤:", error);
        return res.status(500).json({ error: '巡邏機器人發生錯誤' });
    }
}