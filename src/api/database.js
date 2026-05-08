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
  return onSnapshot(doc(db, 'NurseApp', 'Settings'), (snap) => {
    callback(snap.exists() ? snap.data() : null);
  }, (err) => console.error('subscribeToSettings 失敗:', err));
};

export const saveGlobalSettings = async (data) => {
  await setDoc(doc(db, 'NurseApp', 'Settings'), data, { merge: true });
};

// ============================================================================
// 2. 員工資料 — 三層拆分以符合個資法
// ============================================================================
//
// NurseApp/Staff              — 完整資料（admin only read）
// NurseApp/StaffPublic        — 同事看的最小投影 {staff_id, name, level, is_leader, is_active}
// NurseApp/StaffPrivate/{id}  — 員工自己的完整 row（id 對應的 staff 才能讀）
//
// 為什麼要這樣切：原本的 NurseApp/Staff 規則是 isAuthenticated 可讀，
// 任何登入者都能透過 client SDK 撈到全院的姓名/email/性別/是否懷孕/年資/累積加班…
// 違反 PDPA §6（特種個資 — 醫療/健康 — 包含懷孕、產假狀態）。
// 拆成三個 doc 後：管理員仍從 Staff 讀完整；員工角色只讀同事的精簡 + 自己的私有。

// 公開投影 — 同事間能看到的最小欄位集合，不含任何 PII / 健康 / 財務暗示資料
export const buildStaffPublicProjection = (fullStaffData = []) => {
  return fullStaffData.map((s) => ({
    staff_id: s.staff_id,
    name: s.name,
    level: s.level,
    is_leader: !!s.is_leader,
    is_active: s.is_active !== false, // 缺值預設 true
  }));
};

// 管理員：訂閱完整 Staff doc（規則限定 admin）
export const subscribeToStaff = (callback) => {
  return onSnapshot(doc(db, 'NurseApp', 'Staff'), (snap) => {
    callback(snap.exists() ? snap.data() : null);
  }, (err) => console.error('subscribeToStaff 失敗:', err));
};

// 員工：訂閱同事用的精簡公開投影
export const subscribeToStaffPublic = (callback) => {
  return onSnapshot(doc(db, 'NurseApp', 'StaffPublic'), (snap) => {
    callback(snap.exists() ? snap.data() : null);
  }, (err) => console.error('subscribeToStaffPublic 失敗:', err));
};

// 員工：訂閱自己的完整 row（規則限定 staff_id 對應或 admin）
export const subscribeToMyStaffPrivate = (staffId, callback) => {
  if (!staffId) return () => {};
  return onSnapshot(doc(db, 'NurseApp', 'StaffPrivate', String(staffId)), (snap) => {
    callback(snap.exists() ? snap.data() : null);
  }, (err) => console.error('subscribeToMyStaffPrivate 失敗:', err));
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
  // 3. 每位員工的私有 row（覆蓋寫入）
  for (const s of fullList) {
    if (!s.staff_id) continue;
    batch.set(doc(db, 'NurseApp', 'StaffPrivate', String(s.staff_id)), s);
  }
  await batch.commit();
};

// ============================================================================
// 3. 每月班表 — 路徑改為 2 段 Schedules/{year_month}
// ============================================================================
export const subscribeToSchedule = (year, month, callback) => {
  if (!year || !month) return () => {};
  const docId = `${year}_${month}`;
  return onSnapshot(doc(db, 'Schedules', docId), (snap) => {
    callback(snap.exists() ? snap.data() : null);
  }, (err) => console.error('subscribeToSchedule 失敗:', err));
};

// ★ 核心修復 1：改用 updateDoc，真正做到「刪除被拔除的班表」
export const saveMonthlySchedule = async (year, month, data) => {
  const docId = `${year}_${month}`;
  const docRef = doc(db, 'Schedules', docId);
  try {
    await updateDoc(docRef, data); // 強制依照傳入的資料完全覆蓋欄位
  } catch (error) {
    if (error.code === 'not-found') {
      await setDoc(docRef, data); // 若該月班表尚未建立，則初始化
    } else {
      throw error;
    }
  }
};

// ★ 核心修復 2：改用 updateDoc，真正做到「員工認領覆蓋空缺，絕不疊加」
export const updateStaffSchedule = async (year, month, finalizedSchedule) => {
  const docId = `${year}_${month}`;
  const docRef = doc(db, 'Schedules', docId);
  try {
    await updateDoc(docRef, { finalizedSchedule }); 
  } catch (error) {
    if (error.code === 'not-found') {
      await setDoc(docRef, { finalizedSchedule });
    } else {
      throw error;
    }
  }
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
  return onSnapshot(collection(db, 'archive_reports'), (snapshot) => {
    const reports = {};
    snapshot.forEach(d => { reports[d.id] = d.data(); });
    callback(reports);
  }, (err) => console.error('subscribeToArchiveReports 失敗:', err));
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