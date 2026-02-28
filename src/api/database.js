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
  orderBy
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
// 2. 員工資料
// ============================================================================
export const subscribeToStaff = (callback) => {
  return onSnapshot(doc(db, 'NurseApp', 'Staff'), (snap) => {
    callback(snap.exists() ? snap.data() : null);
  }, (err) => console.error('subscribeToStaff 失敗:', err));
};

export const saveGlobalStaff = async (data) => {
  await setDoc(doc(db, 'NurseApp', 'Staff'), data, { merge: true });
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

export const saveMonthlySchedule = async (year, month, data) => {
  const docId = `${year}_${month}`;
  await setDoc(doc(db, 'Schedules', docId), data, { merge: true });
};

export const updateStaffSchedule = async (year, month, finalizedSchedule) => {
  const docId = `${year}_${month}`;
  await setDoc(doc(db, 'Schedules', docId), { finalizedSchedule }, { merge: true });
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