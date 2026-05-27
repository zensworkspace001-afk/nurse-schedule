// api/admin-user.js
//
// 管理員的「員工帳號管理」統一端點。原本拆成兩個檔案（sync-accounts、reset-password），
// 但 Vercel Hobby plan 上限 12 個 serverless function，合併以節省 quota。
//
// POST /api/admin-user   (Bearer Firebase token — 必須是 admin@hospital.com)
//
//   { action: 'sync',         staffList: [...] }   ← 批次建立帳號 + 寄啟用信
//   { action: 'reset',        staffId: 'N001' }    ← 寄送密碼重設信給該員工
//   { action: 'delete-staff', staffId: 'N001' }    ← 永久離職：歸檔頭貼到 ex_staff/{id}、
//                                                     從 NurseApp/Staff + StaffPublic 移除、
//                                                     刪除 StaffPrivate/{id}、停用 Auth、寫稽核
//   { action: 'list-access-logs', limit, actionFilter, actorFilter }  ← 讀稽核日誌
//                                                     （後端依 ACCESS_LOG_BACKEND 讀 Firestore 或 MySQL）
//
// 全部 action 都需要 admin 權限。共用 issueToken / revokeTokensForUid / sendActivationLink。
import crypto from 'node:crypto';
import admin from 'firebase-admin';
import { checkCsrf } from './_lib/csrf.js';
import { issueToken, revokeTokensForUid } from './_lib/activationToken.js';
import { writeAccessLog, readAccessLogs, extractClientMeta } from './_lib/accessLog.js';

if (!admin.apps.length) {
  let serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (serviceAccount) {
    serviceAccount = JSON.parse(serviceAccount);
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  } else {
    let pk = process.env.FIREBASE_PRIVATE_KEY;
    if (pk) pk = pk.replace(/^"|"$/g, '').replace(/\\n/g, '\n');
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: pk,
      }),
    });
  }
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function getBaseUrl(req) {
  if (process.env.ACTIVATION_BASE_URL) return process.env.ACTIVATION_BASE_URL.replace(/\/+$/, '');
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  const origin = req.headers.origin || req.headers.referer;
  if (origin) return origin.replace(/\/+$/, '');
  return 'https://nurse-schedule-bachelor.vercel.app';
}

async function sendActivationLink(baseUrl, { email, name, plainToken, isReset }) {
  const link = `${baseUrl}/activate?token=${plainToken}`;
  const subject = isReset ? '【護理排班系統】密碼重設請求' : '【護理排班系統】請啟用您的帳號';
  const intro = isReset
    ? '管理員已為您觸發密碼重設。請點擊以下連結設定新的登入密碼：'
    : '管理員已為您建立護理排班系統帳號。請點擊以下連結設定您的登入密碼以啟用帳號：';
  const buttonText = isReset ? '點我重設密碼' : '點我啟用帳號並設定密碼';
  // TTL 與 activationToken.js 同步取自 env（預設 2 小時）
  const ttlHours = Number(process.env.ACTIVATION_TOKEN_TTL_HOURS) || 2;
  const html = `
    <h2>您好 ${escapeHtml(name)}：</h2>
    <p>${intro}</p>
    <p><a href="${link}" style="display:inline-block;padding:10px 20px;background:#0066cc;color:#fff;text-decoration:none;border-radius:4px;">${buttonText}</a></p>
    <p>或複製以下網址至瀏覽器開啟：<br/><code>${link}</code></p>
    <hr/>
    <p style="color:#888;font-size:12px;">此連結 ${ttlHours} 小時內有效，僅可使用一次。<br/>若您未請求此操作，請忽略此信。</p>
  `;
  const r = await fetch(`${baseUrl}/api/sendEmail`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.CRON_SECRET}`,
    },
    body: JSON.stringify({ to: email, subject, html }),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error || `寄信回應 ${r.status}`);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: '只允許 POST 請求' });

  if (req.body?.healthCheck) {
    try {
      await admin.auth().listUsers(1);
      return res.status(200).json({ ok: true, service: 'admin-user' });
    } catch (err) {
      return res.status(503).json({ ok: false, service: 'admin-user', error: err.message });
    }
  }

  const csrf = checkCsrf(req);
  if (!csrf.allowed) return res.status(403).json({ error: '禁止：非法來源' });

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未經授權：缺少登入憑證' });
  }
  let decodedToken;
  try {
    const token = authHeader.split('Bearer ')[1];
    decodedToken = await admin.auth().verifyIdToken(token);
    if (decodedToken.email !== 'admin@hospital.com') {
      return res.status(403).json({ error: '權限不足：只有管理員能執行此操作' });
    }
  } catch {
    return res.status(401).json({ error: '未經授權：登入憑證無效或已過期' });
  }

  const { action } = req.body || {};
  const baseUrl = getBaseUrl(req);

  // —— sync：批次建立 Firebase Auth 帳號 + 寄啟用信 ——
  if (action === 'sync') {
    try {
      const { staffList } = req.body;
      if (!Array.isArray(staffList)) {
        return res.status(400).json({ error: '無效的名單格式' });
      }

      let invitedCount = 0;
      let existedCount = 0;
      let errorCount = 0;
      const errors = [];

      for (const staff of staffList) {
        const staffId = staff.staff_id;
        if (!staffId || staffId === 'admin') continue;
        if (!staff.email) {
          errorCount++;
          errors.push(`${staffId}: 缺少 email，無法寄送啟用信`);
          continue;
        }

        const loginEmail = `${staffId.toLowerCase()}@hospital.com`;
        const randomPassword = crypto.randomBytes(24).toString('base64');

        try {
          await admin.auth().createUser({
            uid: staffId,
            email: loginEmail,
            password: randomPassword,
            displayName: staff.name,
            disabled: true, // 必須點啟用信才能登入
          });
          await revokeTokensForUid(staffId);
          const plainToken = await issueToken({
            uid: staffId, email: staff.email, purpose: 'activation',
          });
          await sendActivationLink(baseUrl, {
            email: staff.email, name: staff.name, plainToken, isReset: false,
          });
          invitedCount++;
        } catch (authError) {
          if (
            authError.code === 'auth/email-already-exists' ||
            authError.code === 'auth/uid-already-exists'
          ) {
            existedCount++;
          } else {
            errorCount++;
            errors.push(`${staffId}: ${authError.message}`);
            console.error(`建立 ${staffId} 帳號失敗:`, authError);
          }
        }
      }

      return res.status(200).json({
        message: '帳號同步作業完成',
        result: { invitedCount, existedCount, errorCount, errors },
      });
    } catch (error) {
      console.error('sync 失敗:', error);
      return res.status(500).json({ error: '伺服器發生錯誤' });
    }
  }

  // —— reset：寄送密碼重設信 ——
  if (action === 'reset') {
    try {
      const { staffId } = req.body;
      if (!staffId) return res.status(400).json({ error: '缺少員工 ID' });

      const targetEmail = `${staffId.toLowerCase()}@hospital.com`;
      const userRecord = await admin.auth().getUserByEmail(targetEmail);

      const staffSnap = await admin.firestore().doc('NurseApp/Staff').get();
      const staffData = staffSnap.exists ? (staffSnap.data().staffData || []) : [];
      const staffRow = staffData.find(s => String(s.staff_id).toLowerCase() === staffId.toLowerCase());
      if (!staffRow || !staffRow.email) {
        return res.status(400).json({ error: '該員工尚未設定 Email，無法寄送重設信' });
      }

      await revokeTokensForUid(userRecord.uid);
      const plainToken = await issueToken({
        uid: userRecord.uid, email: staffRow.email, purpose: 'reset',
      });
      await sendActivationLink(baseUrl, {
        email: staffRow.email, name: staffRow.name || staffId, plainToken, isReset: true,
      });

      return res.status(200).json({
        message: `已寄送密碼重設信至 ${staffRow.email}`,
        email: staffRow.email,
      });
    } catch (error) {
      console.error('reset 失敗:', error);
      if (error.code === 'auth/user-not-found') {
        return res.status(404).json({ error: '在驗證庫中找不到該員工，可能尚未啟用帳號。' });
      }
      return res.status(500).json({ error: '伺服器內部錯誤' });
    }
  }

  // —— delete-staff：永久離職歸檔 ——
  // 行為：
  //   1. 在 transaction 內讀 NurseApp/Staff，找到該員工
  //   2. 寫一份 snapshot 進 ex_staff/{staffId}（含頭貼、姓名、刪除時間、操作者）
  //      註：加密 PII（idNumber / bankAccount / phone）刻意不複製過去 —— 那些
  //          原本就是密文 blob，留存=PDPA 上要繼續維護金鑰；離職應一併銷毀
  //   3. 把該員工從 staffData 陣列剔除，更新 NurseApp/Staff
  //   4. 重算 StaffPublic 投影並覆寫
  //   5. 刪除 StaffPrivate/{staffId}（員工原本可讀自己那份）
  //   6. （transaction 外）停用 Firebase Auth 帳號 — 防止離職員工再登入
  //   7. （transaction 外）寫 access_logs，action='delete-staff'
  //
  // 為什麼用 transaction：避免兩個 admin 同時刪不同員工時 staffData 互相覆寫。
  if (action === 'delete-staff') {
    try {
      const { staffId } = req.body;
      if (!staffId) return res.status(400).json({ error: '缺少員工 ID' });
      if (String(staffId).toLowerCase() === 'admin') {
        return res.status(400).json({ error: '不可刪除 admin' });
      }

      const meta = extractClientMeta(req);
      const db = admin.firestore();
      const staffRef = db.doc('NurseApp/Staff');
      const publicRef = db.doc('NurseApp/StaffPublic');
      const exRef = db.doc(`ex_staff/${staffId}`);
      const privateRef = db.doc(`StaffPrivate/${staffId}`);

      const result = await db.runTransaction(async (tx) => {
        const snap = await tx.get(staffRef);
        if (!snap.exists) throw new Error('NurseApp/Staff 不存在');
        const data = snap.data();
        const list = Array.isArray(data.staffData) ? data.staffData : [];
        const idx = list.findIndex(
          (s) => String(s.staff_id).toLowerCase() === String(staffId).toLowerCase(),
        );
        if (idx === -1) return { notFound: true };

        const row = list[idx];

        // 1. 歸檔到 ex_staff —— 只保留識別欄位 + 頭貼，不複製加密 PII
        const archive = {
          staff_id: row.staff_id,
          name: row.name || null,
          email: row.email || null,
          level: row.level || null,
          tenure_years: typeof row.tenure_years === 'number' ? row.tenure_years : null,
          avatar: row.avatar || null,
          avatar_thumb: row.avatar_thumb || null,
          had_avatar: !!row.avatar,
          deleted_at: new Date().toISOString(),
          deleted_by: { uid: decodedToken.uid, email: decodedToken.email },
        };
        tx.set(exRef, archive);

        // 2. 從 staffData 移除
        const nextList = list.filter((_, i) => i !== idx);
        tx.update(staffRef, { staffData: nextList });

        // 3. 重算 StaffPublic 投影（與 src/api/database.js 的 buildStaffPublicProjection 同步）
        const publicList = nextList.map((s) => ({
          staff_id: s.staff_id,
          name: s.name,
          level: s.level,
          is_leader: !!s.is_leader,
          is_active: s.is_active !== false,
          avatar_thumb: s.avatar_thumb || null,
        }));
        tx.set(publicRef, { staffData: publicList });

        // 4. 刪除 StaffPrivate
        tx.delete(privateRef);

        return { notFound: false, archive, removedName: row.name };
      });

      if (result.notFound) {
        return res.status(404).json({ error: `找不到員工 ${staffId}` });
      }

      // 5. 停用 Firebase Auth 帳號（transaction 外）— 失敗不擋業務，僅記 log
      let authDisabled = false;
      try {
        await admin.auth().updateUser(staffId, { disabled: true });
        await revokeTokensForUid(staffId);
        authDisabled = true;
      } catch (authErr) {
        if (authErr.code !== 'auth/user-not-found') {
          console.warn(`delete-staff: 停用 Auth 帳號失敗 (${staffId}):`, authErr.message);
        }
      }

      // 6. 稽核
      await writeAccessLog({
        actor: { uid: decodedToken.uid, email: decodedToken.email },
        action: 'delete-staff',
        target: { kind: 'staff', id: staffId },
        fields: ['avatar', 'avatar_thumb', 'name', 'email', 'level', 'tenure_years'],
        ip: meta.ip, ua: meta.ua,
        extra: {
          had_avatar: result.archive.had_avatar,
          archived_to: `ex_staff/${staffId}`,
          auth_disabled: authDisabled,
        },
      });

      return res.status(200).json({
        message: `員工 ${result.removedName || staffId} 已永久離職歸檔`,
        archived_to: `ex_staff/${staffId}`,
        had_avatar: result.archive.had_avatar,
        auth_disabled: authDisabled,
      });
    } catch (error) {
      console.error('delete-staff 失敗:', error);
      return res.status(500).json({ error: error.message || '伺服器內部錯誤' });
    }
  }

  // —— list-access-logs：讀取稽核日誌 ——
  // 取代 AccessLogPanel 原本直接 onSnapshot Firestore 的做法。改走後端後：
  //   1. 可讀 MySQL（混合式儲存把 access_logs 搬去 MySQL 時）；後端用 ACCESS_LOG_BACKEND 決定來源
  //   2. 不必為了讀取多開一支 serverless function（Vercel Hobby 12 支上限已滿）
  // 失去即時更新（改為拉取 + 手動 refresh），但稽核日誌本就不需要即時。
  if (action === 'list-access-logs') {
    try {
      const { limit, actionFilter, actorFilter } = req.body;
      const logs = await readAccessLogs({
        limit: limit || 200,
        action: actionFilter || null,
        actor: actorFilter || null,
      });
      return res.status(200).json({ logs });
    } catch (error) {
      console.error('list-access-logs 失敗:', error);
      return res.status(500).json({ error: error.message || '讀取稽核日誌失敗' });
    }
  }

  return res.status(400).json({ error: `未知的 action：${action}（支援：sync / reset / delete-staff / list-access-logs）` });
}
