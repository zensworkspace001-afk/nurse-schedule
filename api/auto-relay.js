import admin from 'firebase-admin';
import { GoogleGenerativeAI } from '@google/generative-ai';

// 1. 初始化 Firebase Admin
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
const db = admin.firestore();

// 輔助函式：發送系統郵件
async function sendSystemEmail(to, subject, html) {
    const baseUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL || 'nurse-schedule-bachelor.vercel.app';
    try {
        await fetch(`https://${baseUrl}/api/sendEmail`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.CRON_SECRET}`
            },
            body: JSON.stringify({ to, subject, html })
        });
    } catch (error) {
        console.error("Email 發送失敗:", error);
    }
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: '只允許 POST 請求' });
    }

    // 安全驗證：必須提供 CRON_SECRET 或有效的 Firebase ID Token (管理員或員工)
    const authHeader = req.headers.authorization;
    let isAuthorized = false;
    
    if (authHeader === `Bearer ${process.env.CRON_SECRET}`) {
        isAuthorized = true;
    } else if (authHeader?.startsWith('Bearer ')) {
        try {
            const token = authHeader.split('Bearer ')[1];
            await admin.auth().verifyIdToken(token);
            isAuthorized = true;
        } catch (e) {
            return res.status(401).json({ error: '未經授權' });
        }
    }

    if (!isAuthorized) {
        return res.status(401).json({ error: '未經授權' });
    }

    const { year, month, currentSchedule, statsData, finishedStaffId } = req.body;
    if (!year || !month) {
        return res.status(400).json({ error: '缺少必要參數 year/month' });
    }

    try {
        console.log(`🤖 [自動接力引擎] 正在處理 ${year}/${month} 的選班決策...`);

        // 0. 如果有指定剛完成的員工，先將其加入黑名單 (SelectionProgress)
        if (finishedStaffId) {
            console.log(`📌 標記員工 ${finishedStaffId} 為已完成選班`);
            const progressRef = db.collection('SelectionProgress').doc(`${year}_${month}`);
            await progressRef.set({
                submitted_staff: admin.firestore.FieldValue.arrayUnion(finishedStaffId)
            }, { merge: true });
        }

        // 1. 讀取最新員工資料
        const staffSnap = await db.collection('NurseApp').doc('Staff').get();
        const staffData = staffSnap.exists ? staffSnap.data().staffData : [];

        // 2. 抓取「已經選過」的黑名單 (SelectionProgress)
        const progressRef = db.collection('SelectionProgress').doc(`${year}_${month}`);
        const progressSnap = await progressRef.get();
        const submittedList = progressSnap.exists ? (progressSnap.data().submitted_staff || []) : [];

        // 3. 篩選出「尚未選班」的活躍員工
        const scheduleKeys = currentSchedule ? Object.keys(currentSchedule) : [];
        const unassignedStaff = staffData.filter(s =>
            (s.is_active === true || String(s.is_active).toLowerCase() === 'true') &&
            s.staff_id &&
            s.staff_id !== 'admin' &&
            !s.staff_id.startsWith('D') &&
            (!s.leave_status || s.leave_status === 'None') &&
            !submittedList.includes(s.staff_id) &&
            !scheduleKeys.includes(s.staff_id)
        );

        // 4. 終止條件：所有人都選完了！
        if (unassignedStaff.length === 0) {
            const adminEmail = staffData.find(s => s.staff_id === 'admin')?.email || 'zensworkspace001@gmail.com';
            await sendSystemEmail(adminEmail, `✅ ${month}月 班表全數認領完畢！`, `<h3>報告護理長：</h3><p>本月所有同仁皆已完成班表選擇，請登入系統進行最終確認與結算。</p>`);
            // 清除 latest 指標
            await db.collection('SelectionTurn').doc('latest').set({
                active_staff_id: null, year, month,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            return res.status(200).json({ message: "所有員工皆已完成選班。" });
        }

        // 5. 準備 AI Prompt (邏輯同步自 App.jsx)
        const scores = statsData ? statsData.map(stat => stat.score || 100) : [];
        const average = scores.length > 0 ? Math.round(scores.reduce((sum, val) => sum + val, 0) / scores.length) : 100;

        let aiPrompt = `【自動接力選班決策】\n團隊歷史平均健康度: ${average}分\n`;
        
        // 讀取管理員設定的特殊指令
        const settingsSnap = await db.collection('NurseApp').doc('Settings').get();
        const priorityConfig = settingsSnap.exists ? settingsSnap.data().priorityConfig : null;
        if (priorityConfig && priorityConfig.relayInstruction) {
            aiPrompt += `[管理員最高指導原則]：${priorityConfig.relayInstruction}\n\n`;
        }

        aiPrompt += `尚未選班之候選人現況：\n`;
        unassignedStaff.forEach(staff => {
            const historyScore = statsData ? (statsData.find(s => s.staff_id === staff.staff_id)?.score || 100) : 100;
            aiPrompt += `- [${staff.staff_id} ${staff.name}] 性別:${staff.gender || '女'} | 職級:${staff.level || 'N0'} | 孕/哺乳:${staff.is_pregnant_or_nursing ? '是' : '否'} | 組長:${staff.is_leader ? '是' : '否'} | 可上夜班:${staff.can_night_shift === false ? '否' : '是'} | 工時制:${staff.special_status} | 年資:${staff.tenure_years || 0}年 | 歷史健康度:${historyScore}分 | 積假餘額:${staff.accumulated_ot || 0} | 夜班結餘:${staff.night_shift_balance || 0}\n`;
        });

        aiPrompt += `\n請根據上述數據與原則，選出「最符合條件、最需要優先選班」的 1 位員工。
⚠️ 【最高系統原則】：若名單中有「孕/哺乳:是」的員工，無論其疲勞度為何，【必須】讓她們絕對優先選班！
請務必只以 JSON 格式回覆：{"selected_staff_id": "N00X", "reason": "你的判斷理由"}`;

        // 6. 呼叫 Gemini（主模型 2.5-pro，失敗時降級至 flash-latest）
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const modelsToTry = ['gemini-2.5-pro', 'gemini-flash-latest'];
        let text;
        for (const modelName of modelsToTry) {
            try {
                const model = genAI.getGenerativeModel({
                    model: modelName,
                    systemInstruction: '你是護理排班系統的 AI 助手。根據提供的員工數據、疲勞度與歷史紀錄，協助進行排班決策。必須回覆有效的 JSON 格式。'
                });
                const resultAI = await model.generateContent(aiPrompt);
                const responseAI = await resultAI.response;
                text = responseAI.text();
                console.log(`✅ 使用模型 ${modelName} 成功`);
                break;
            } catch (aiError) {
                console.warn(`⚠️ 模型 ${modelName} 失敗: ${aiError.message}`);
                if (modelName === modelsToTry[modelsToTry.length - 1]) throw aiError;
            }
        }
        
        // 魯棒性解析
        text = text.replace(/<thought>[\s\S]*?<\/thought>/gi, '').replace(/```json|```/g, '').trim();
        let decision;
        try {
            decision = JSON.parse(text);
        } catch (e) {
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            decision = jsonMatch ? JSON.parse(jsonMatch[0]) : { selected_staff_id: unassignedStaff[0].staff_id, reason: "解析失敗，預設首位。" };
        }

        // 7. 驗證並執行寫入
        const finalStaffId = unassignedStaff.find(s => s.staff_id === decision.selected_staff_id) ? decision.selected_staff_id : unassignedStaff[0].staff_id;
        
        // 更新 SelectionTurn (Admin SDK 繞過 Firestore Rules)
        const turnData = {
            active_staff_id: finalStaffId,
            year, month,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };
        await Promise.all([
            db.collection('SelectionTurn').doc(`${year}_${month}`).set(turnData),
            db.collection('SelectionTurn').doc('latest').set(turnData)
        ]);

        // 寫入 Log
        await db.collection("AI_Decision_Logs").add({
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            year, month, selected_staff: finalStaffId, ai_logic: decision.reason, candidates_data: aiPrompt
        });

        // 8. 發信通知
        const targetStaff = staffData.find(s => s.staff_id === finalStaffId);
        if (targetStaff && targetStaff.email) {
            await sendSystemEmail(
                targetStaff.email, 
                `🌟 ${targetStaff.name} 優先選班通知！現在輪到您了！`, 
                `<h3>親愛的 ${targetStaff.name}：</h3><p>系統已開放您的選班權限！</p><p><strong>🤖 系統判斷讓您先選的理由：</strong><br/>${decision.reason}</p><p>請盡速登入系統完成選班，以利下一位同仁進行，謝謝！</p>`
            );
        }

        return res.status(200).json({ success: true, selected_staff_id: finalStaffId });

    } catch (error) {
        console.error("自動接力失敗:", error);
        return res.status(500).json({ error: error.message });
    }
}
