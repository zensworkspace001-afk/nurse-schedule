import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import {
  getFirestore,
  doc,
  setDoc,
  onSnapshot,
  collection,
  getDocs,
  deleteDoc,
  query,
  orderBy,
  updateDoc,
  writeBatch,
} from "firebase/firestore";
import { reportFirestoreError, reportFirestoreHealthy } from './connectionStatus';

// 包裝 onSnapshot data callback：第一次成功就回報 healthy（讓 banner 自動消失）
function wrapDataCb(source, cb) {
  let reportedHealthy = false;
  return (snap) => {
    if (!reportedHealthy) {
      reportedHealthy = true;
      reportFirestoreHealthy(source);
    }
    cb(snap);
  };
}
function wrapErrorCb(source) {
  return (err) => {
    console.error(`${source} 失敗:`, err);
    reportFirestoreError(err, source);
  };
}

const firebaseConfig = {
  apiKey:            import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket:     import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId:             import.meta.env.VITE_FIREBASE_APP_ID,
};

// ★ 核心修復：防止重複初始化造成 INTERNAL ASSERTION FAILED
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

export const auth = getAuth(app);
export const db   = getFirestore(app);

// ============================================================================
// 1. 全域設定
// ============================================================================
export const subscribeToSettings = (callback) => {
  return onSnapshot(
    doc(db, 'NurseApp', 'Settings'),
    wrapDataCb('subscribeToSettings', (snap) => {
      callback(snap.exists() ? snap.data() : null);
    }),
    wrapErrorCb('subscribeToSettings'),
  );
};

export const saveGlobalSettings = async (data) => {
  await setDoc(doc(db, 'NurseApp', 'Settings'), data, { merge: true });
};

// ============================================================================
// 系統公告 — NurseApp/Announcement
// ----------------------------------------------------------------------------
// 單條全域公告。所有 authed user 可讀，admin 可寫。
// 結構：{ text, kind: 'info'|'warning'|'urgent', active, updatedAt, updatedBy }
// active=false 視為已清除（前端不顯示 banner）。
// updatedAt 用來搭配 sessionStorage 判斷「使用者上次 dismiss 的是不是同一條」。
// ============================================================================
export const subscribeToAnnouncement = (callback) => {
  return onSnapshot(
    doc(db, 'NurseApp', 'Announcement'),
    wrapDataCb('subscribeToAnnouncement', (snap) => {
      callback(snap.exists() ? snap.data() : null);
    }),
    wrapErrorCb('subscribeToAnnouncement'),
  );
};

export const saveAnnouncement = async ({ text, kind, updatedBy }) => {
  await setDoc(doc(db, 'NurseApp', 'Announcement'), {
    text: String(text || '').slice(0, 500), // 上限 500 字防 abuse
    kind: ['info', 'warning', 'urgent'].includes(kind) ? kind : 'info',
    active: true,
    updatedAt: new Date().toISOString(),
    updatedBy: updatedBy || null,
  });
};

export const clearAnnouncement = async () => {
  await setDoc(doc(db, 'NurseApp', 'Announcement'), {
    active: false,
    updatedAt: new Date().toISOString(),
  }, { merge: true });
};

// ============================================================================
// 2. 員工資料 — 三層拆分以符合個資法
// ============================================================================
//
// NurseApp/Staff              — 完整資料（admin only read）
// NurseApp/StaffPublic        — 同事看的最小投影 {staff_id, name, level, is_leader, is_active}
// StaffPrivate/{id}           — 員工自己的完整 row（頂層 collection；id 對應的 staff 或 admin 才能讀）
//                                (路徑必須是 2 段才是合法 Firestore doc，不能放在 NurseApp/StaffPrivate/{id})
//
// 為什麼要這樣切：原本的 NurseApp/Staff 規則是 isAuthenticated 可讀，
// 任何登入者都能透過 client SDK 撈到全院的姓名/email/性別/是否懷孕/年資/累積加班…
// 違反 PDPA §6（特種個資 — 醫療/健康 — 包含懷孕、產假狀態）。
// 拆成三個 doc 後：管理員仍從 Staff 讀完整；員工角色只讀同事的精簡 + 自己的私有。

// 公開投影 — 同事間能看到的最小欄位集合，不含任何 PII / 健康 / 財務暗示資料
// avatar_thumb 是 64x64 縮圖（員工在 AvatarEditModal 上傳時同步生成），用於班表卡片
// 顯示同事頭貼；不放主圖 220x220 是因為 Firestore 單 doc 1 MiB 上限 — 100 人 × 25 KB 會爆。
export const buildStaffPublicProjection = (fullStaffData = []) => {
  return fullStaffData.map((s) => ({
    staff_id: s.staff_id,
    name: s.name,
    level: s.level,
    is_leader: !!s.is_leader,
    is_active: s.is_active !== false, // 缺值預設 true
    avatar_thumb: s.avatar_thumb || null,
  }));
};

// 管理員：訂閱完整 Staff doc（規則限定 admin）
export const subscribeToStaff = (callback) => {
  return onSnapshot(
    doc(db, 'NurseApp', 'Staff'),
    wrapDataCb('subscribeToStaff', (snap) => {
      callback(snap.exists() ? snap.data() : null);
    }),
    wrapErrorCb('subscribeToStaff'),
  );
};

// 員工：訂閱同事用的精簡公開投影
export const subscribeToStaffPublic = (callback) => {
  return onSnapshot(
    doc(db, 'NurseApp', 'StaffPublic'),
    wrapDataCb('subscribeToStaffPublic', (snap) => {
      callback(snap.exists() ? snap.data() : null);
    }),
    wrapErrorCb('subscribeToStaffPublic'),
  );
};

// 員工：訂閱自己的完整 row（規則限定 staff_id 對應或 admin）
// 路徑採頂層 collection StaffPrivate/{staffId}（2 段才是合法 doc 路徑）
export const subscribeToMyStaffPrivate = (staffId, callback) => {
  if (!staffId) return () => {};
  return onSnapshot(
    doc(db, 'StaffPrivate', String(staffId)),
    wrapDataCb('subscribeToMyStaffPrivate', (snap) => {
      callback(snap.exists() ? snap.data() : null);
    }),
    wrapErrorCb('subscribeToMyStaffPrivate'),
  );
};

// 管理員寫 staff 資料 — 自動同步到三個 doc，使用 batch write 確保原子性
//
// data 形狀同舊版：{ staffData: [...], healthStats?: [...] }
// 為了向下相容，若 data 沒有 staffData（例如只更新 healthStats）就只 merge 進 Staff。
export const saveGlobalStaff = async (data) => {
  if (!data || !data.staffData) {
    // 沒帶完整名單 → 只 merge 給 Staff（healthStats 等次要欄位的局部更新）
    await setDoc(doc(db, 'NurseApp', 'Staff'), data, { merge: true });
    return;
  }

  const fullList = data.staffData;
  const publicList = buildStaffPublicProjection(fullList);

  const batch = writeBatch(db);
  // 1. 完整資料
  batch.set(doc(db, 'NurseApp', 'Staff'), data, { merge: true });
  // 2. 精簡公開投影
  batch.set(doc(db, 'NurseApp', 'StaffPublic'), { staffData: publicList }, { merge: false });
  // 3. 每位員工的私有 row（覆蓋寫入；StaffPrivate 為頂層 collection）
  for (const s of fullList) {
    if (!s.staff_id) continue;
    batch.set(doc(db, 'StaffPrivate', String(s.staff_id)), s);
  }
  await batch.commit();
};

// ============================================================================
// 3. 每月班表 — 雙 doc 拆分以遮罩同事的請假紀錄
// ============================================================================
//
// Schedules/{year_month}        — 完整版本（admin only read），含 事假/病假/特休
// SchedulesPublic/{year_month}  — 員工同事看的版本，事假/病假/特休 一律遮成 OFF
//
// 為什麼要拆：原本的 Schedules 規則開放給所有登入者讀，員工 A 可以看到員工 B 的
// 病假/事假/特休 cell —— 這在 PDPA §6 是特種個資（醫療/健康）外洩。班表的 cell
// 內容是 string 或 { type: '事假', ...metadata }，遮罩函式只動 type 欄位，不改其他。

const SENSITIVE_LEAVE_TYPES = new Set(['事假', '病假', '特休']);

function sanitizeCell(cell) {
  if (cell == null) return cell;
  if (typeof cell === 'string') {
    return SENSITIVE_LEAVE_TYPES.has(cell) ? 'OFF' : cell;
  }
  if (typeof cell === 'object' && SENSITIVE_LEAVE_TYPES.has(cell.type)) {
    // 保留其他 metadata（例如時數），只遮 type
    return { ...cell, type: 'OFF' };
  }
  return cell;
}

// 把 finalizedSchedule (map of staff_id → {day: cell}) 整個跑一遍遮罩
export const buildSchedulePublicProjection = (finalizedSchedule) => {
  if (!finalizedSchedule || typeof finalizedSchedule !== 'object') return {};
  const out = {};
  for (const [key, dayCells] of Object.entries(finalizedSchedule)) {
    if (!dayCells || typeof dayCells !== 'object') continue;
    const sanitized = {};
    for (const [day, cell] of Object.entries(dayCells)) {
      sanitized[day] = sanitizeCell(cell);
    }
    out[key] = sanitized;
  }
  return out;
};

// 管理員 / 後端：訂閱完整 Schedules doc（含 schedule 草稿 + finalizedSchedule）
export const subscribeToSchedule = (year, month, callback) => {
  if (!year || !month) return () => {};
  const docId = `${year}_${month}`;
  return onSnapshot(
    doc(db, 'Schedules', docId),
    wrapDataCb('subscribeToSchedule', (snap) => {
      callback(snap.exists() ? snap.data() : null);
    }),
    wrapErrorCb('subscribeToSchedule'),
  );
};

// 員工：訂閱遮罩過的 SchedulesPublic（只含 finalizedSchedule，且不含請假類型）
export const subscribeToSchedulePublic = (year, month, callback) => {
  if (!year || !month) return () => {};
  const docId = `${year}_${month}`;
  return onSnapshot(
    doc(db, 'SchedulesPublic', docId),
    wrapDataCb('subscribeToSchedulePublic', (snap) => {
      callback(snap.exists() ? snap.data() : null);
    }),
    wrapErrorCb('subscribeToSchedulePublic'),
  );
};

// 管理員寫整份班表（schedule + finalizedSchedule）— 自動 batch 同步到 SchedulesPublic
export const saveMonthlySchedule = async (year, month, data) => {
  const docId = `${year}_${month}`;
  const ref = doc(db, 'Schedules', docId);
  const publicRef = doc(db, 'SchedulesPublic', docId);

  // 先 try updateDoc（保留現有欄位）；若 doc 不存在就 setDoc 初始化。
  try {
    await updateDoc(ref, data);
  } catch (error) {
    if (error.code === 'not-found') {
      await setDoc(ref, data);
    } else {
      throw error;
    }
  }

  // SchedulesPublic 部分：只有當 data 含 finalizedSchedule 時才需要更新公開版
  if (data && data.finalizedSchedule !== undefined) {
    const masked = buildSchedulePublicProjection(data.finalizedSchedule);
    await setDoc(publicRef, { finalizedSchedule: masked }, { merge: false });
  }
};

// 認領 / 取消認領時的快速路徑：只動 finalizedSchedule，連動寫公開版
export const updateStaffSchedule = async (year, month, finalizedSchedule) => {
  const docId = `${year}_${month}`;
  const ref = doc(db, 'Schedules', docId);
  const publicRef = doc(db, 'SchedulesPublic', docId);
  const masked = buildSchedulePublicProjection(finalizedSchedule);

  try {
    await updateDoc(ref, { finalizedSchedule });
  } catch (error) {
    if (error.code === 'not-found') {
      await setDoc(ref, { finalizedSchedule });
    } else {
      throw error;
    }
  }
  await setDoc(publicRef, { finalizedSchedule: masked }, { merge: false });
};

// ============================================================================
// 4. 跨月封存報表
// ============================================================================
export const saveArchiveReport = async (year, month, csvData) => {
  const docId = `${year}_${month}`;
  await setDoc(doc(db, 'archive_reports', docId), {
    csv: csvData, year, month,
    timestamp: new Date().toISOString()
  }, { merge: true });
};

export const subscribeToArchiveReports = (callback) => {
  return onSnapshot(
    collection(db, 'archive_reports'),
    wrapDataCb('subscribeToArchiveReports', (snapshot) => {
      const reports = {};
      snapshot.forEach(d => { reports[d.id] = d.data(); });
      callback(reports);
    }),
    wrapErrorCb('subscribeToArchiveReports'),
  );
};

export const clearArchiveReports = async () => {
  const snapshot = await getDocs(collection(db, 'archive_reports'));
  await Promise.all(snapshot.docs.map(d => deleteDoc(d.ref)));
};

// ============================================================================
// 5. 班表安全備份
// ============================================================================
export const backupScheduleToArchive = async (year, month, schedule, note) => {
  const docId = `${year}_${month}`;
  await setDoc(doc(db, 'archive_reports', docId), {
    year, month,
    schedule_backup: schedule,
    backedUpAt: new Date().toISOString(),
    note
  }, { merge: true });
};

// ============================================================================
// 6. 讀取備份列表
// ============================================================================
export const fetchScheduleBackups = async () => {
  try {
    const snapshot = await getDocs(
      query(collection(db, 'archive_reports'), orderBy('backedUpAt', 'desc'))
    );
    return snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (error) {
    console.error('讀取備份失敗:', error);
    return [];
  }
};