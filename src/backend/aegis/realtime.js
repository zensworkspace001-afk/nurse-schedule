// SignalR：取代 Firebase onSnapshot。整個 App 共用一條連線（登入後才連），斷線自動重連。
import { HubConnectionBuilder, HubConnectionState, LogLevel } from '@microsoft/signalr';
import { getToken, onSession, hasSession } from './http';

let conn = null;
let starting = null;
const months = new Map();      // `${y}_${m}` → 訂閱數（重連後要重新加入群組）
const reconnectHandlers = new Set();

function build() {
  conn = new HubConnectionBuilder()
    .withUrl('/hubs/schedule', { accessTokenFactory: async () => (await getToken()) || '' })
    .withAutomaticReconnect([0, 2000, 5000, 10000, 30000])
    .configureLogging(LogLevel.Warning)
    .build();
  conn.onreconnected(async () => {
    for (const key of months.keys()) {
      const [y, m] = key.split('_').map(Number);
      await conn.invoke('SubscribeMonth', y, m).catch(() => {});
    }
    for (const h of reconnectHandlers) h();   // 斷線期間可能漏推 → 各訂閱自己重抓一次
  });
  return conn;
}

export async function ensureConnected() {
  if (!hasSession()) return null;
  if (!conn) build();
  if (conn.state === HubConnectionState.Connected) return conn;
  if (!starting) starting = conn.start().catch((e) => { console.warn('即時連線失敗，稍後自動重試：', e.message); }).finally(() => { starting = null; });
  await starting;
  return conn.state === HubConnectionState.Connected ? conn : null;
}

// 註冊事件；回傳取消函式。連線還沒建立也可以先註冊（連上後就會收到）
export function on(event, handler) {
  if (!conn) build();
  conn.on(event, handler);
  ensureConnected();
  return () => conn?.off(event, handler);
}

export function onReconnected(fn) { reconnectHandlers.add(fn); return () => reconnectHandlers.delete(fn); }

export async function subscribeMonth(y, m) {
  const key = `${y}_${m}`;
  months.set(key, (months.get(key) || 0) + 1);
  const c = await ensureConnected();
  await c?.invoke('SubscribeMonth', y, m).catch(() => {});
  return async () => {
    const n = (months.get(key) || 1) - 1;
    if (n > 0) { months.set(key, n); return; }
    months.delete(key);
    await conn?.invoke('UnsubscribeMonth', y, m).catch(() => {});
  };
}

// 登出 → 斷線（換人登入時用新 token 重連）
onSession((user) => {
  if (!user && conn) { conn.stop().catch(() => {}); conn = null; months.clear(); }
});
