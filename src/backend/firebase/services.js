// Firebase / Vercel 後端（現行正式環境）的服務函式。
// 這些原本散在各元件裡的 Firebase Auth 呼叫與 fetch('/api/…')，集中到這裡；行為與搬移前完全相同。
// 地端版（src/backend/aegis/）提供同名、同簽章、回傳同形狀的實作。
import {
  signInWithEmailAndPassword, setPersistence, browserLocalPersistence, browserSessionPersistence,
  signOut as fbSignOut, onAuthStateChanged as fbOnAuthStateChanged, EmailAuthProvider, reauthenticateWithCredential, updatePassword,
} from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from './database';
import { buildUserPayload } from './currentUser';
import { isSuperAdminClaims } from '../../../shared/policy.js';

export const BACKEND = 'firebase';

// 呼叫 Vercel /api/*：帶 Firebase ID token；失敗時丟出帶伺服器訊息的 Error（err.status = HTTP 狀態）
async function call(url, body, { withAuth = true, method = 'POST' } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (withAuth) {
    const token = await auth.currentUser?.getIdToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || data.detail || `伺服器回應 ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// —— 登入 ——
export const authApi = {
  // 工號 → Firebase email（${staff_id}@hospital.com，見 CLAUDE.md）；成功 / 失敗都寫登入稽核（fire-and-forget）
  async signIn(loginId, password, rememberMe) {
    const email = `${String(loginId).trim().toLowerCase()}@hospital.com`;
    try {
      await setPersistence(auth, rememberMe ? browserLocalPersistence : browserSessionPersistence);
      await signInWithEmailAndPassword(auth, email, password);
    } catch (err) {
      fetch('/api/log-login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: false, attempted_email: email, error_code: err.code || 'unknown' }),
      }).catch(() => {});
      throw err;   // err.code（auth/invalid-credential 等）由 LoginPanel 轉成訊息
    }
    try {
      const token = await auth.currentUser?.getIdToken();
      if (token) {
        fetch('/api/log-login', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ success: true }),
        }).catch(() => {});
      }
    } catch { /* 寫稽核失敗不影響登入 */ }
    return buildUserPayload(auth.currentUser);
  },
  signOut: () => fbSignOut(auth),
  // 開機還原持久化的 session：callback(currentUser payload | null)
  onAuthStateChanged: (cb) => fbOnAuthStateChanged(auth, async (u) => cb(u ? await buildUserPayload(u) : null)),
  getIdToken: async () => (auth.currentUser ? auth.currentUser.getIdToken() : null),
  isSignedIn: () => !!auth.currentUser,
  isSuperAdmin: () => isSuperAdminClaims({ email: auth.currentUser?.email }),
  // 自己改密碼（需要目前密碼）：Firebase 要求先 reauthenticate
  async changePassword(currentPassword, newPassword) {
    const user = auth.currentUser;
    if (!user) throw new Error('登入逾期，請重新登入');
    await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, currentPassword));
    await updatePassword(user, newPassword);
  },
};

// —— 帳號管理（/api/admin-user）與啟用 / 重設（/api/activate-account）——
export const accounts = {
  sync: (staffList) => call('/api/admin-user', { action: 'sync', staffList }),
  resetLink: (staffId) => call('/api/admin-user', { action: 'reset', staffId }),
  offboard: (staffId) => call('/api/admin-user', { action: 'delete-staff', staffId }),
  setAdmin: (staffId, admin) => call('/api/admin-user', { action: 'set-admin', staffId, admin }),
  activate: (token, newPassword) => call('/api/activate-account', { token, newPassword }, { withAuth: false }),
  requestReset: (staffId, email) => call('/api/activate-account', { action: 'request-reset', staffId, email }, { withAuth: false }),
  verifyResetOtp: (staffId, code, newPassword) =>
    call('/api/activate-account', { action: 'verify-reset-otp', staffId, code, newPassword }, { withAuth: false }),
};

// —— 個人資料（/api/complete-profile）——
export const profile = {
  completeFirst: (body) => call('/api/complete-profile', body),
  update: (body) => call('/api/complete-profile', { ...body, mode: 'update' }),
  consent: (version) => call('/api/complete-profile', { mode: 'consent', pdpa_notice_version: version }),
  changePasswordForced: (newPassword) => call('/api/complete-profile', { mode: 'change-password', newPassword }),
};

// —— 稽核 ——
export const audit = {
  list: ({ limit }) => call('/api/admin-user', { action: 'list-access-logs', limit }),
  // admin 訂閱全院員工資料時留痕（地端版由伺服器在 GET /api/staff 時自動記錄）
  logAdminRead: (extra) => call('/api/secure-field', {
    action: 'logAdminRead', target: { kind: 'staff-collection', id: 'NurseApp/Staff' },
    fields: ['staffData(full)', 'healthStats'], extra,
  }),
  logAiAccess: (target, fields, extra) => call('/api/secure-field', { action: 'logAiAccess', target, fields, extra }),
};

// —— AI（Gemini）——
export const ai = {
  chat: (prompt) => call('/api/gemini', { prompt }),
  async analyzeExcel(formData) {
    const token = await auth.currentUser?.getIdToken();
    const res = await fetch('/api/analyze-excel', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: formData });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '伺服器分析失敗');
    return data;
  },
};

// —— 單次讀取（手動「同步最新雲端班表」）——
export async function getScheduleOnce(year, month) {
  const snap = await getDoc(doc(db, 'Schedules', `${year}_${month}`));
  return snap.exists() ? snap.data() : null;
}

// —— 國定假日（外部 CDN；地端版改讀本機檔）——
export const calendar = {
  holidaysUrl: (year) => `https://cdn.jsdelivr.net/gh/ruyut/TaiwanCalendar/data/${year}.json`,
};

// —— 這個後端有哪些功能（地端版由伺服器回報）——
const ALL_ON = { selfServiceReset: true, ai: true, weather: true, autoSettleTest: true };
export const features = {
  initial: ALL_ON,              // 同步初值：現行正式環境全部功能都有，畫面不會閃
  load: async () => ALL_ON,
};

// —— 系統狀態燈：要檢查的端點（App 的健康檢查面板）——
export const health = {
  endpoints: (year) => [
    { key: 'firestore', label: 'Firebase', desc: 'Firestore 資料庫連線', check: async () => {
      const snap = await getDoc(doc(db, 'NurseApp', 'Settings'));
      return snap.exists() ? null : '無資料';
    } },
    { key: 'gemini', label: 'Gemini AI', desc: 'AI 排班與對話引擎', url: '/api/gemini', method: 'POST' },
    { key: 'analyzeExcel', label: 'Excel 分析', desc: 'CSV/Excel Gemini Flash 分析', url: '/api/analyze-excel', method: 'POST' },
    { key: 'sendEmail', label: 'Email 服務', desc: 'Resend 電子郵件發送', url: '/api/sendEmail', method: 'POST' },
    { key: 'adminUser', label: '帳號管理', desc: '批次同步建帳號 / 寄啟用信 / 寄密碼重設信', url: '/api/admin-user', method: 'POST' },
    { key: 'activateAccount', label: '帳號啟用', desc: '一次性 token 啟用 / 重設密碼', url: '/api/activate-account', method: 'POST' },
    { key: 'logLogin', label: '登入紀錄', desc: '記錄成功 / 失敗登入到稽核日誌', url: '/api/log-login', method: 'POST' },
    { key: 'autoSettle', label: '自動結算', desc: '月薪結算引擎', url: '/api/auto-settle?healthCheck=true', method: 'GET' },
    { key: 'cronTimeout', label: '每日排程', desc: '每日清理過期個資（稽核日誌、封存報表等保存期限）', url: '/api/cron/check-timeout?healthCheck=true', method: 'GET' },
    { key: 'calendar', label: '國定假日', desc: '台灣國定假日 API', url: calendar.holidaysUrl(year), method: 'GET' },
  ],
};

// —— 開發者時光機（呼叫 auto-settle；地端版沒有這支，按鈕會隱藏）——
export async function testAutoSettle(targetDate) {
  const url = targetDate ? `/api/auto-settle?targetDate=${targetDate}` : '/api/auto-settle?force=true';
  const token = await auth.currentUser?.getIdToken();
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}
