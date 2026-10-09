// 地端 Aegis.Api 的 HTTP 層（axios）：
//   - 帶 JWT（存在記憶體，不放 localStorage — XSS 拿不到）
//   - 401 時用 HttpOnly refresh cookie 換一次新 token 再重試（同時多個請求只換一次）
//   - 錯誤統一成 Error（message = 伺服器的 error / detail；status / code / data 掛在上面），與 Firebase 版相同
import axios from 'axios';

let accessToken = null;
let accessExpiresAt = 0;
let refreshing = null;
const listeners = new Set();   // 登入身分變更（登入 / 換 token / 登出）

export const http = axios.create({ baseURL: '', withCredentials: true });

export function setSession(data) {
  accessToken = data?.accessToken || null;
  accessExpiresAt = data?.expiresAt ? Date.parse(data.expiresAt) : 0;
  for (const l of listeners) l(data?.user || null);
}
export const onSession = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const hasSession = () => !!accessToken;

// 用 refresh cookie 換新 token；失敗回 null（= 沒有登入）
export function refreshSession() {
  if (!refreshing) {
    refreshing = axios.post('/api/auth/refresh', null, { withCredentials: true })
      .then((r) => { const s = r.status === 204 ? null : r.data; setSession(s); return s; })   // 204 = 沒有登入
      .catch(() => { setSession(null); return null; })
      .finally(() => { refreshing = null; });
  }
  return refreshing;
}

// 快過期（< 60 秒）就先換
export async function getToken() {
  if (accessToken && accessExpiresAt - Date.now() > 60_000) return accessToken;
  if (!accessToken) return null;
  const s = await refreshSession();
  return s?.accessToken || null;
}

http.interceptors.request.use(async (cfg) => {
  if (!cfg.url.startsWith('/api/auth/')) {
    const t = await getToken();
    if (t) cfg.headers.Authorization = `Bearer ${t}`;
  }
  return cfg;
});

http.interceptors.response.use((r) => r, async (error) => {
  const cfg = error.config;
  if (error.response?.status === 401 && cfg && !cfg._retried && !cfg.url.startsWith('/api/auth/')) {
    cfg._retried = true;
    const s = await refreshSession();
    if (s?.accessToken) {
      cfg.headers.Authorization = `Bearer ${s.accessToken}`;
      return http(cfg);
    }
  }
  throw toError(error);
});

export function toError(error) {
  if (!error.response) {
    const e = new Error('無法連線到伺服器，請稍後再試');
    e.network = true;
    return e;
  }
  const data = error.response.data || {};
  const e = new Error(data.error || data.detail || `伺服器回應 ${error.response.status}`);
  e.status = error.response.status;
  e.code = data.code;
  e.data = data;
  return e;
}
