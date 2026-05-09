import admin from 'firebase-admin';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { writeAccessLog, extractClientMeta } from './_lib/accessLog.js';

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
    let actor = { uid: 'cron', email: null }; // CRON 觸發時用 'cron' 做為 actor

    if (authHeader === `Bearer ${process.env.CRON_SECRET}`) {
        isAuthorized = true;
    } else if (authHeader?.startsWith('Bearer ')) {
        try {
            const token = authHeader.split('Bearer ')[1];
            const decoded = await admin.auth().verifyIdToken(token);
            actor = { uid: decoded.uid, email: decoded.email || null };
            isAuthorized = true;
        } catch {
            return res.status(401).json({ error: '未經授權' });
        }
    }

    if (!isAuthorized) {
        return res.status(401).json({ error: '未經授權' });
    }

    const { year, month, currentSchedule, statsData, finishedStaffId, resetRelay } = req.body;
    if (!year || !month) {
        return res.status(400).json({ error: '缺少必要參數 year/month' });
    }

    try {
        console.log(`🤖 [自動接力引擎] 正在處理 ${year}/${month} 的選班決策...`);

        // 0-a. 若為全新發布 (resetRelay)，先清除舊的進度與輪次資料
        if (resetRelay) {
            console.log(`🔄 重置接力狀態：清除 SelectionProgress 與 SelectionTurn`);
            await Promise.all([
                db.collection('SelectionProgress').doc(`${year}_${month}`).delete().catch(() => {}),
                db.collection('SelectionTurn').doc(`${year}_${month}`).delete().catch(() => {}),
                db.collection('SelectionTurn').doc('latest').delete().catch(() => {})
            ]);
        }

        // 0-b. 如果有指定剛完成的員工，先將其加入黑名單 (SelectionProgress)
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
        let submittedList = progressSnap.exists ? (progressSnap.data().submitted_staff || []) : [];

        // 2-a. 🧹 自我修復：如果 submittedList 裡有人已不在班表中（被管理員拔除釋出），
        //      把它們從黑名單移除，讓 AI 有機會重新輪到他們
        const scheduleKeys = currentSchedule ? Object.keys(currentSchedule) : [];
        const ghosts = submittedList.filter(sid => !scheduleKeys.includes(sid));
        if (ghosts.length > 0) {
            console.log(`🧹 清除 ${ghosts.length} 位幽靈員工（已從班表拔除但仍在黑名單）: ${ghosts.join(', ')}`);
            await progressRef.set({
                submitted_staff: admin.firestore.FieldValue.arrayRemove(...ghosts)
            }, { merge: true });
            submittedList = submittedList.filter(sid => !ghosts.includes(sid));
        }

        // 3. 篩選出「尚未選班」的活躍員工
        //    - is_active: 只排除明確為 false 的 (undefined/null 當作在職)
        //    - leave_status: 只排除真正在休假的 (OnLeave / Maternal)，Student 仍可選班
        const remainingDSlots = scheduleKeys.filter(k => typeof k === 'string' && k.startsWith('D'));
        const excludedReasons = [];
        const isOnLeave = (ls) => ls === 'OnLeave' || ls === 'Maternal';
        const unassignedStaff = staffData.filter(s => {
            if (!s.staff_id || s.staff_id === 'admin' || s.staff_id.startsWith('D')) return false;
            if (s.is_active === false || String(s.is_active).toLowerCase() === 'false') { excludedReasons.push(`${s.staff_id}=已停用`); return false; }
            if (isOnLeave(s.leave_status)) { excludedReasons.push(`${s.staff_id}=休假中(${s.leave_status})`); return false; }
            if (submittedList.includes(s.staff_id)) return false;
            if (scheduleKeys.includes(s.staff_id)) return false;
            return true;
        });

        // 4. 終止條件：所有人都選完了！
        if (unassignedStaff.length === 0) {
            const adminEmail = staffData.find(s => s.staff_id === 'admin')?.email || 'zensworkspace001@gmail.com';
            // 清除 latest 指標
            await db.collection('SelectionTurn').doc('latest').set({
                active_staff_id: null, year, month,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });

            // 🚨 若仍有未認領的 D* 空缺班表，代表「名額多於可選人數」或「有員工被排除卻還有空班」
            if (remainingDSlots.length > 0) {
                // 🩺 診斷資訊：把 staffData 的所有狀態列出來，方便護理長一眼看懂為什麼少人
                const totalEntries = staffData.length;
                const adminCount = staffData.filter(s => s.staff_id === 'admin').length;
                const eligibleStaff = staffData.filter(s => {
                    if (!s.staff_id || s.staff_id === 'admin' || s.staff_id.startsWith('D')) return false;
                    if (s.is_active === false || String(s.is_active).toLowerCase() === 'false') return false;
                    if (isOnLeave(s.leave_status)) return false;
                    return true;
                });
                const studentCount = eligibleStaff.filter(s => s.leave_status === 'Student').length;
                const submittedCount = submittedList.length;

                // 分析剩餘 D 空班的主要班別 (D/E/N)，判斷是否因為實習生不能選 E/N 造成卡關
                const slotBreakdown = { D: 0, E: 0, N: 0, 其他: 0 };
                const slotDetails = [];
                remainingDSlots.forEach(slotId => {
                    const slotData = currentSchedule[slotId] || {};
                    const counts = { D: 0, E: 0, N: 0 };
                    Object.values(slotData).forEach(cell => {
                        const type = (cell && typeof cell === 'object') ? cell.type : cell;
                        if (type === 'D' || type === 'E' || type === 'N') counts[type]++;
                    });
                    let mainShift = 'D';
                    if (counts.E > counts.D && counts.E > counts.N) mainShift = 'E';
                    if (counts.N > counts.D && counts.N > counts.E) mainShift = 'N';
                    if (counts.D === 0 && counts.E === 0 && counts.N === 0) mainShift = '其他';
                    slotBreakdown[mainShift]++;
                    slotDetails.push(`${slotId} (主:${mainShift})`);
                });

                const reasonHtml = excludedReasons.length > 0
                    ? `<p><strong>被排除的員工：</strong><br/>${excludedReasons.join('<br/>')}</p>`
                    : '';

                const studentHint = (studentCount > 0 && (slotBreakdown.E > 0 || slotBreakdown.N > 0))
                    ? `<p style="color:#b84a00;"><strong>🔎 卡關提示：</strong>目前有 <strong>${studentCount}</strong> 位實習生不可選 E/小夜 或 N/大夜班，但剩餘空班中有 <strong>${slotBreakdown.E}</strong> 班小夜、<strong>${slotBreakdown.N}</strong> 班大夜，可能因此無人可認領。</p>`
                    : '';

                await sendSystemEmail(
                    adminEmail,
                    `⚠️ ${month}月 接力結束但仍有 ${remainingDSlots.length} 個空班未認領`,
                    `<h3>報告護理長：</h3>
                     <p>本月接力選班已結束，但仍有 <strong>${remainingDSlots.length}</strong> 個空班未被認領：</p>
                     <p>${slotDetails.join('、')}</p>
                     <hr/>
                     <p><strong>📊 人數盤點：</strong></p>
                     <ul>
                       <li>員工資料庫總筆數：<strong>${totalEntries}</strong> 筆（含 admin ${adminCount} 筆）</li>
                       <li>可選班員工數：<strong>${eligibleStaff.length}</strong> 位（其中實習生 ${studentCount} 位）</li>
                       <li>已完成選班：<strong>${submittedCount}</strong> 位</li>
                       <li>剩餘空班：<strong>${remainingDSlots.length}</strong> 班（主白班 ${slotBreakdown.D}、小夜 ${slotBreakdown.E}、大夜 ${slotBreakdown.N}）</li>
                     </ul>
                     ${studentHint}
                     <p>請登入系統手動指派或調整排班設定。</p>
                     ${reasonHtml}`
                );
                return res.status(200).json({
                    message: "接力結束，但仍有空班未認領。",
                    unfilledSlots: remainingDSlots,
                    excludedReasons,
                    diagnostics: { totalEntries, adminCount, eligibleCount: eligibleStaff.length, studentCount, submittedCount, slotBreakdown }
                });
            }

            await sendSystemEmail(adminEmail, `✅ ${month}月 班表全數認領完畢！`, `<h3>報告護理長：</h3><p>本月所有同仁皆已完成班表選擇，請登入系統進行最終確認與結算。</p>`);
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

        // ★ 個資法 §8 跨境傳輸保護：送至 Google Gemini 的 prompt 不含員工姓名（只送內部工號 staff_id）。
        //   工號搭配特種個資（孕/哺乳）對 Google 而言是不可去識別化的內部代號，
        //   降低跨境傳輸的個人識別風險。每次發送另寫一筆 access_logs 留稽核軌跡。
        aiPrompt += `尚未選班之候選人現況：\n`;
        unassignedStaff.forEach(staff => {
            const historyScore = statsData ? (statsData.find(s => s.staff_id === staff.staff_id)?.score || 100) : 100;
            aiPrompt += `- [${staff.staff_id}] 性別:${staff.gender || '女'} | 職級:${staff.level || 'N0'} | 孕/哺乳:${staff.is_pregnant_or_nursing ? '是' : '否'} | 組長:${staff.is_leader ? '是' : '否'} | 可上夜班:${staff.can_night_shift === false ? '否' : '是'} | 工時制:${staff.special_status} | 年資:${staff.tenure_years || 0}年 | 歷史健康度:${historyScore}分 | 積假餘額:${staff.accumulated_ot || 0} | 夜班結餘:${staff.night_shift_balance || 0}\n`;
        });

        aiPrompt += `\n請根據上述數據與原則，選出「最符合條件、最需要優先選班」的 1 位員工。
⚠️ 【最高系統原則】：若名單中有「孕/哺乳:是」的員工，無論其疲勞度為何，【必須】讓她們絕對優先選班！
請務必只以 JSON 格式回覆：{"selected_staff_id": "N00X", "reason": "你的判斷理由"}`;

        // 寫稽核：記錄這次有哪些員工的哪些欄位送給了 Gemini，方便事後追溯
        const meta = extractClientMeta(req);
        await writeAccessLog({
            actor,
            action: 'ai-access',
            target: { kind: 'staff', id: null },
            fields: ['staff_id', 'gender', 'level', 'is_pregnant_or_nursing', 'is_leader', 'can_night_shift', 'special_status', 'tenure_years', 'health_score', 'accumulated_ot', 'night_shift_balance'],
            ip: meta.ip, ua: meta.ua,
            extra: {
                source: 'auto-relay',
                purpose: 'agentic-turn-decision',
                vendor: 'google-gemini',
                model: 'gemini-2.5-pro|gemini-flash-latest',
                staff_count: unassignedStaff.length,
                year, month,
                anonymization: 'name-stripped; staff_id retained as internal pseudonym',
            },
        });

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
        } catch {
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            decision = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
        }
        if (!decision || !decision.selected_staff_id) {
            decision = { selected_staff_id: unassignedStaff[0].staff_id, reason: "AI 回應解析失敗，預設首位。" };
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
