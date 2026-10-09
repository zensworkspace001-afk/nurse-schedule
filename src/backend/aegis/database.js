// 地端版資料讀寫：與 src/backend/firebase/database.js 同名、同簽章、回傳同形狀。
//   subscribeToX(callback) = 立刻 GET 一次（= onSnapshot 的第一發）＋ 收到對應 SignalR 事件時重抓
//   saveX(...)             = PUT 並帶 If-Match（ETag）；別人先改過 → 409 → 依決策 2A：載入最新版、提示使用者、不再重試
import { http } from './http';
import { on, onReconnected, subscribeMonth } from './realtime';
import { reportFirestoreError, reportFirestoreHealthy } from '../../api/connectionStatus';

const etags = new Map();       // 資源 key → 最近一次 GET / PUT 的 ETag
const reloaders = new Map();   // 資源 key → Set(重抓並交給訂閱者的函式)

function reportError(err, source) {
  const code = err.network ? 'unavailable' : err.status === 401 ? 'unauthenticated' : err.status === 403 ? 'permission-denied' : 'unknown';
  reportFirestoreError({ code, message: err.message }, source);
}

async function getDoc(key, url) {
  const r = await http.get(url);
  if (r.headers.etag) etags.set(key, r.headers.etag);
  return r.data ?? null;
}

// 文件訂閱：GET + 事件觸發重抓（重抓才拿得到新 ETag）；filter 決定哪些事件跟這份文件有關
function subscribeDoc(key, url, events, callback, filter = () => true) {
  let alive = true;
  const load = () => getDoc(key, url)
    .then((d) => { if (alive) { callback(d); reportFirestoreHealthy(key); } })
    .catch((e) => { if (alive) reportError(e, key); });
  if (!reloaders.has(key)) reloaders.set(key, new Set());
  reloaders.get(key).add(load);
  load();
  const offs = events.map((ev) => on(ev, (...args) => { if (filter(...args)) load(); }));
  const offR = onReconnected(load);
  return () => { alive = false; reloaders.get(key)?.delete(load); offs.forEach((f) => f()); offR(); };
}

// 事件直接帶資料、不需要 ETag 的（同事名單、公開班表、自己的資料、預假人數）
function subscribePush(key, url, event, callback, pick) {
  let alive = true;
  const load = () => http.get(url).then((r) => { if (alive) { callback(r.data ?? null); reportFirestoreHealthy(key); } })
    .catch((e) => { if (alive) reportError(e, key); });
  load();
  const off = on(event, (...args) => { const v = pick(...args); if (alive && v !== undefined) callback(v); });
  const offR = onReconnected(load);
  return () => { alive = false; off(); offR(); };
}

async function putDoc(key, url, body, method = 'put') {
  const headers = etags.has(key) ? { 'If-Match': etags.get(key) } : {};
  try {
    const r = await http.request({ method, url, data: body, headers });
    if (r.headers.etag) etags.set(key, r.headers.etag);
    return r.data;
  } catch (e) {
    if (e.status !== 409) throw e;
    // 決策 2A：別人先改過 → 載入最新版給畫面、提示一次、不讓自動存檔無限重試
    etags.delete(key);
    await Promise.all([...(reloaders.get(key) || [])].map((f) => f()));
    window.alert('資料已被其他人更新，已載入最新版本。\n您剛才的修改沒有存入，請確認後再改一次。');
    return null;
  }
}

// ———————————— 設定 / 公告 ————————————
export const subscribeToSettings = (cb) => subscribeDoc('settings', '/api/settings', ['SettingsChanged'], cb);
export const saveGlobalSettings = (data) => putDoc('settings', '/api/settings', data);

// 公告：登入頁（未登入）也要讀 → 只 GET 一次；登入後再跟著推送更新
export const subscribeToAnnouncement = (cb) => {
  let alive = true;
  http.get('/api/announcement').then((r) => alive && cb(r.data ?? null)).catch(() => alive && cb(null));
  const off = on('AnnouncementChanged', (a) => alive && cb(a ?? null));
  return () => { alive = false; off(); };
};
export const saveAnnouncement = ({ text, kind, updatedBy }) =>
  http.put('/api/announcement', { text: String(text || '').slice(0, 500), kind, updatedByName: updatedBy?.name || null });
export const clearAnnouncement = () => http.delete('/api/announcement');

// ———————————— 員工 ————————————
export const subscribeToStaff = (cb) => subscribeDoc('staff', '/api/staff', ['StaffChanged'], cb);
export const subscribeToStaffPublic = (cb) => subscribePush('staffPublic', '/api/staff/public', 'StaffPublicChanged', cb, (d) => d);
export const subscribeToMyStaffPrivate = (staffId, cb) => {
  if (!staffId) return () => {};
  return subscribePush('me', '/api/me', 'MyProfileChanged', cb, (row) => row);
};
export const saveGlobalStaff = (data) => putDoc('staff', '/api/staff', data);

// ———————————— 班表 ————————————
const ym = (y, m) => `${y}_${m}`;
export const subscribeToSchedule = (year, month, cb) => {
  if (!year || !month) return () => {};
  return subscribeDoc(`schedule:${ym(year, month)}`, `/api/schedules/${year}/${month}`, ['ScheduleChanged'], cb,
                      (y, m) => y === year && m === month);
};
export const subscribeToSchedulePublic = (year, month, cb) => {
  if (!year || !month) return () => {};
  let leave = null;
  subscribeMonth(year, month).then((f) => { leave = f; });
  const off = subscribePush(`schedulePublic:${ym(year, month)}`, `/api/schedules/${year}/${month}/public`, 'SchedulePublicChanged', cb,
                            (y, m, doc) => (y === year && m === month ? doc : undefined));
  return () => { off(); leave?.(); };
};
export const saveMonthlySchedule = (year, month, data) => putDoc(`schedule:${ym(year, month)}`, `/api/schedules/${year}/${month}`, data);
export const updateStaffSchedule = (year, month, finalizedSchedule) =>
  putDoc(`schedule:${ym(year, month)}`, `/api/schedules/${year}/${month}`, { finalizedSchedule });

// ———————————— 歷史封存 ————————————
export const subscribeToArchiveReports = (cb) => subscribeDoc('archives', '/api/archives', ['ArchivesChanged'], cb);
export const saveArchiveReport = (year, month, csv) => http.post(`/api/archives/${year}/${month}`, { csv });
export const backupScheduleToArchive = (year, month, schedule, note) =>
  http.post(`/api/archives/${year}/${month}`, { schedule_backup: schedule, note });
export const clearArchiveReports = () => http.delete('/api/archives');
export const fetchScheduleBackups = async () => {
  try {
    const all = (await http.get('/api/archives')).data || {};
    return Object.entries(all).map(([id, d]) => ({ id, ...d }))
      .sort((a, b) => String(b.backedUpAt || '').localeCompare(String(a.backedUpAt || '')));
  } catch (error) {
    console.error('讀取備份失敗:', error);
    return [];
  }
};

// ———————————— 預假 ————————————
export const saveLeaveWishSettings = (leaveWish) => http.put('/api/leave-wishes/window', leaveWish);
export const subscribeToLeaveWishCounts = (year, month, cb) =>
  subscribePush(`lwCounts:${ym(year, month)}`, `/api/leave-wishes/${year}/${month}/counts`, 'LeaveWishCountsChanged', cb,
                (y, m, c) => (y === year && m === month ? c : undefined));
export const subscribeToMyLeaveWish = (year, month, staffId, cb) =>
  subscribePush(`lwMine:${ym(year, month)}`, `/api/leave-wishes/${year}/${month}/mine`, 'MyLeaveWishChanged', cb,
                (y, m, e) => (y === year && m === month ? e : undefined));
export const subscribeToLeaveWishEntries = (year, month, cb) =>
  subscribePush(`lwEntries:${ym(year, month)}`, `/api/leave-wishes/${year}/${month}/entries`, 'LeaveWishEntriesChanged', cb,
                (y, m, e) => (y === year && m === month ? e : undefined));
