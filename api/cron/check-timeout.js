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

        // ==========================================
        // ★ 個資法保留期限掃除：access_logs + AI_Decision_Logs + archive_reports + pending_activation
        //    每天執行一次，把過期紀錄刪掉。（檔名沿用 check-timeout：vercel.json 的 cron 路徑與前端健康檢查都指向它）
        // ==========================================
        await runRetentionSweep();
        // 認領流程（輪流選班 / 逾時強制交棒）已移除：班表改由 CP-SAT 直接指派，這支 cron 只剩保留期限掃除
        return res.status(200).json({ success: true, message: '保留期限掃除完成' });

    } catch (error) {
        console.error("巡邏機器人發生錯誤:", error);
        return res.status(500).json({ error: '巡邏機器人發生錯誤' });
    }
}

// ============================================================================
// 個資法保留期限掃除
// ----------------------------------------------------------------------------
// access_logs：保留 ACCESS_LOG_RETENTION_DAYS 天（預設 180 天 ≈ 半年）。
//              PDPA §19 / §27 要求個資「在達成目的後應主動刪除」。
//              審計追溯通常半年至一年足夠，避免無限增長。
//
// AI_Decision_Logs：保留 AI_DECISION_LOG_RETENTION_DAYS 天（預設 180 天）。
//                    每筆 doc 的 candidates_data 內含 "孕/哺乳:是" 等 §6 特種個資的
//                    明文 prompt，雖然 admin-only 讀，仍應主動清除（§11/§27）。
//
// archive_reports：保留 ARCHIVE_REPORT_RETENTION_DAYS 天（預設 2555 天 ≈ 7 年）。
//                   含結算 CSV 與 schedule_backup（事假/病假/特休 明文），同時受
//                   勞基法 §30 工時紀錄保留 5 年、商業會計法 7 年、醫療法 §70
//                   病歷 7 年等規範影響。Doc id 格式 "YYYY_M"，按年月判斷。
//
// pending_activation：token TTL 24 小時，但未消化的 doc 會殘留。安全網設 7 天，
//                     超過就清掉（即使 token 已逾期也可能還在）。
//
// 使用 batched delete（每批最多 400，避免 Firestore 500 上限）。
// 失敗只 log，不擋主流程（巡邏機器人是 cron 觸發，沒有使用者在等）。
// ============================================================================
async function runRetentionSweep() {
    const ACCESS_LOG_DAYS = Number(process.env.ACCESS_LOG_RETENTION_DAYS) || 180;
    const AI_LOG_DAYS = Number(process.env.AI_DECISION_LOG_RETENTION_DAYS) || 180;
    const ARCHIVE_DAYS = Number(process.env.ARCHIVE_REPORT_RETENTION_DAYS) || 2555; // 7 年
    const ACCESS_LOG_CUTOFF = new Date(Date.now() - ACCESS_LOG_DAYS * 86400000).toISOString();
    const AI_LOG_CUTOFF = admin.firestore.Timestamp.fromMillis(Date.now() - AI_LOG_DAYS * 86400000);
    const PENDING_TOKEN_CUTOFF = admin.firestore.Timestamp.fromMillis(Date.now() - 7 * 86400000);
    const archiveCutoffDate = new Date(Date.now() - ARCHIVE_DAYS * 86400000);
    const ARCHIVE_CUTOFF_YM = archiveCutoffDate.getFullYear() * 100 + (archiveCutoffDate.getMonth() + 1);

    try {
        // access_logs 用 ts (ISO string) 索引
        const oldLogs = await db.collection('access_logs')
            .where('ts', '<', ACCESS_LOG_CUTOFF)
            .limit(400)
            .get();
        if (!oldLogs.empty) {
            const batch = db.batch();
            oldLogs.docs.forEach(d => batch.delete(d.ref));
            await batch.commit();
            console.log(`🗑 retention: 已刪除 ${oldLogs.size} 筆超過 ${ACCESS_LOG_DAYS} 天的 access_logs`);
        }
    } catch (err) {
        console.warn('access_logs retention sweep 失敗:', err.message);
    }

    try {
        // AI_Decision_Logs 用 timestamp (Firestore Timestamp via serverTimestamp) 索引
        const oldAiLogs = await db.collection('AI_Decision_Logs')
            .where('timestamp', '<', AI_LOG_CUTOFF)
            .limit(400)
            .get();
        if (!oldAiLogs.empty) {
            const batch = db.batch();
            oldAiLogs.docs.forEach(d => batch.delete(d.ref));
            await batch.commit();
            console.log(`🗑 retention: 已刪除 ${oldAiLogs.size} 筆超過 ${AI_LOG_DAYS} 天的 AI_Decision_Logs`);
        }
    } catch (err) {
        console.warn('AI_Decision_Logs retention sweep 失敗:', err.message);
    }

    try {
        // archive_reports 用 doc id (YYYY_M) 判斷，不依賴可能被覆寫的 timestamp 欄位。
        // 整體 collection 規模小（每月 1 筆 ≈ 一年 12 筆），全部讀進來再 in-memory 篩。
        const archives = await db.collection('archive_reports').get();
        const expired = archives.docs.filter(d => {
            const m = d.id.match(/^(\d{4})_(\d{1,2})$/);
            if (!m) return false;
            const ym = Number(m[1]) * 100 + Number(m[2]);
            return ym < ARCHIVE_CUTOFF_YM;
        });
        if (expired.length > 0) {
            const batch = db.batch();
            expired.slice(0, 400).forEach(d => batch.delete(d.ref));
            await batch.commit();
            console.log(`🗑 retention: 已刪除 ${Math.min(expired.length, 400)} 筆超過 ${ARCHIVE_DAYS} 天的 archive_reports`);
        }
    } catch (err) {
        console.warn('archive_reports retention sweep 失敗:', err.message);
    }

    try {
        // pending_activation 用 createdAt (Firestore Timestamp) 索引
        const oldTokens = await db.collection('pending_activation')
            .where('createdAt', '<', PENDING_TOKEN_CUTOFF)
            .limit(400)
            .get();
        if (!oldTokens.empty) {
            const batch = db.batch();
            oldTokens.docs.forEach(d => batch.delete(d.ref));
            await batch.commit();
            console.log(`🗑 retention: 已刪除 ${oldTokens.size} 筆超過 7 天的 pending_activation token`);
        }
    } catch (err) {
        console.warn('pending_activation retention sweep 失敗:', err.message);
    }
}