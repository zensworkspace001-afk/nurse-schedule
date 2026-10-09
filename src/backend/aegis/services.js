// 地端版服務函式：與 src/backend/firebase/services.js 同名、同簽章、回傳同形狀
import { http, setSession, refreshSession, getToken, hasSession, onSession } from './http';

export const BACKEND = 'aegis';

let current = null;   // 伺服器回的使用者 { uid, login, staffId, role, superAdmin, mustChangePassword }
onSession((u) => { current = u; });

// 轉成 App 用的 currentUser（與 Firebase 版 buildUserPayload 相同形狀）
function toPayload(u) {
  if (!u) return null;
  if (u.superAdmin) return { id: 'ADMIN', name: '管理人員', role: 'admin', isSuperAdmin: true };
  const id = String(u.staffId || u.login || '').toUpperCase();
  if (u.role === 'admin') return { id, name: `${id}（管理員）`, role: 'admin', isSuperAdmin: false };
  return { id, name: '載入中...', role: 'staff', rule: 'Standard' };
}

function authError(e) {
  const err = new Error(e.message);
  const byStatus = { 429: 'auth/too-many-requests', 401: 'auth/invalid-credential' };
  err.code = e.code || byStatus[e.status] || (e.network ? 'auth/network-request-failed' : 'unknown');
  return err;
}

export const authApi = {
  // 登入稽核由伺服器寫（成功 / 失敗都記），前端不用再呼叫
  async signIn(loginId, password, rememberMe) {
    try {
      const r = await http.post('/api/auth/login', { loginId: String(loginId).trim(), password, rememberMe });
      setSession(r.data);
      return toPayload(r.data.user);
    } catch (e) { throw authError(e); }
  },
  async signOut() {
    await http.post('/api/auth/logout').catch(() => {});
    setSession(null);
  },
  // 開機時用 HttpOnly refresh cookie 還原登入；只回報一次（App 也只認第一發）
  onAuthStateChanged(cb) {
    let alive = true;
    refreshSession().then((s) => { if (alive) cb(toPayload(s?.user)); });
    return () => { alive = false; };
  },
  getIdToken: () => getToken(),
  isSignedIn: () => hasSession(),
  isSuperAdmin: () => !!current?.superAdmin,
  async changePassword(currentPassword, newPassword) {
    try {
      await http.post('/api/auth/change-password', { currentPassword, newPassword });
    } catch (e) {
      const err = new Error(e.message);
      err.code = e.code || (e.status === 400 ? 'auth/weak-password' : 'unknown');   // 目前密碼錯 → 伺服器回 auth/wrong-password
      throw err;
    }
  },
};

const data = async (p) => (await p).data;

export const accounts = {
  // 員工名單剛存檔時，自動存檔有 2 秒延遲：伺服器回報「還沒進資料庫」的人，等一下再同步一次（最多約 15 秒）
  async sync(staffList) {
    const ids = (staffList || []).map((s) => s.staff_id).filter(Boolean);
    let res;
    for (let i = 0; i < 6; i++) {
      res = await data(http.post('/api/staff/accounts/sync', { staffIds: ids }));
      if (!res.pending?.length) break;
      await new Promise((r) => setTimeout(r, 2500));
    }
    return res;
  },
  resetLink: (staffId) => data(http.post(`/api/staff/${encodeURIComponent(staffId)}/reset-link`)),
  offboard: (staffId) => data(http.delete(`/api/staff/${encodeURIComponent(staffId)}`)),
  setAdmin: (staffId, admin) => data(http.put(`/api/staff/${encodeURIComponent(staffId)}/admin`, { admin })),
  activate: (token, newPassword) => data(http.post('/api/auth/activate', { token, newPassword })),
  // 自助重設要院內 SMTP；沒有設定時登入頁不會顯示「忘記密碼」（features.selfServiceReset = false）
  requestReset: () => Promise.reject(new Error('自助重設密碼未啟用，請聯絡管理員重設')),
  verifyResetOtp: () => Promise.reject(new Error('自助重設密碼未啟用，請聯絡管理員重設')),
};

export const profile = {
  completeFirst: (body) => data(http.post('/api/me/profile', body)),
  update: (body) => data(http.patch('/api/me/profile', body)),
  consent: (version) => data(http.post('/api/me/consent', { pdpaNoticeVersion: version })),
  changePasswordForced: (newPassword) => data(http.post('/api/auth/change-password', { newPassword })),
};

export const audit = {
  list: ({ limit }) => data(http.get('/api/audit-logs', { params: { limit } })),
  logAdminRead: async () => ({ ok: true }),   // 伺服器在 GET /api/staff 時自動記錄
  logAiAccess: async () => ({ ok: true }),    // 地端沒有 AI
};

const aiDisabled = () => Promise.reject(new Error('AI 功能未啟用（未設定語言模型）'));
export const ai = { chat: aiDisabled, analyzeExcel: aiDisabled };

export async function getScheduleOnce(year, month) {
  return (await http.get(`/api/schedules/${year}/${month}`)).data ?? null;
}

// 國定假日：隔離網路沒有 CDN → 讀前端同網域的靜態檔（部署時放進 /holidays/{year}.json，見 aegis/README.md）
export const calendar = { holidaysUrl: (year) => `/holidays/${year}.json` };

const ALL_OFF = { selfServiceReset: false, ai: false, weather: false, autoSettleTest: false };
export const features = {
  initial: ALL_OFF,
  load: async () => ({ ...ALL_OFF, ...(await http.get('/api/features')).data }),
};

export const health = {
  endpoints: (year) => [
    { key: 'database', label: '資料庫', desc: 'Aegis API 與 SQL Server 連線', check: async () => { await http.get('/api/settings'); return null; } },
    { key: 'api', label: 'Aegis API', desc: '地端後端服務', url: '/health', method: 'GET' },
    { key: 'calendar', label: '國定假日', desc: '本機國定假日資料檔', url: calendar.holidaysUrl(year), method: 'GET' },
  ],
};

export async function testAutoSettle() {
  return { ok: false, data: { error: '地端版沒有自動結算（結算請用「結算並封存至歷史區」）' } };
}
