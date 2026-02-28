import { initializeApp } from "firebase/app";
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

// ★★★ 請將以下設定替換為你自己的真實 Firebase Config ★★★
const firebaseConfig = {
  apiKey:            import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket:     import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId:             import.meta.env.VITE_FIREBASE_APP_ID,
};

// 初始化 Firebase (這段之前被你不小心刪掉了！)
const app = initializeApp(firebaseConfig);

// 匯出 auth 與 db 供其他檔案 (如 App.jsx) 使用
export const auth = getAuth(app);
export const db = getFirestore(app);

// ============================================================================
// 1. 全域設定 (Settings) -> 使用 NurseApp 資料夾
// ============================================================================
export const subscribeToSettings = (callback) => {
  const docRef = doc(db, 'NurseApp', 'Settings');
  return onSnapshot(docRef, (docSnap) => {
    if (docSnap.exists()) callback(docSnap.data());
    else callback(null);
  });
};

export const saveGlobalSettings = async (data) => {
  const docRef = doc(db, 'NurseApp', 'Settings');
  await setDoc(docRef, data, { merge: true });
};

// ============================================================================
// 2. 員工與健康度資料 (Staff & Health Stats) -> 使用 NurseApp 資料夾
// ============================================================================
export const subscribeToStaff = (callback) => {
  const docRef = doc(db, 'NurseApp', 'Staff');
  return onSnapshot(docRef, (docSnap) => {
    if (docSnap.exists()) callback(docSnap.data());
    else callback(null);
  });
};

export const saveGlobalStaff = async (data) => {
  const docRef = doc(db, 'NurseApp', 'Staff');
  await setDoc(docRef, data, { merge: true });
};

// ============================================================================
// 3. 每月排班表 (Schedules)
// ============================================================================
export const subscribeToSchedule = (year, month, callback) => {
  const docId = `${year}_${month}`;
  const docRef = doc(db, 'Schedules', docId);
  return onSnapshot(docRef, (docSnap) => {
    if (docSnap.exists()) callback(docSnap.data());
    else callback(null);
  });
};

export const saveMonthlySchedule = async (year, month, data) => {
  const docId = `${year}_${month}`;
  const docRef = doc(db, 'Schedules', docId);
  await setDoc(docRef, data, { merge: true });
};

export const updateStaffSchedule = async (year, month, finalizedSchedule) => {
  const docId = `${year}_${month}`;
  const docRef = doc(db, 'Schedules', docId);
  await setDoc(docRef, { finalizedSchedule }, { merge: true });
};

// ============================================================================
// 4. 跨月大數據報表封存 (Archive Reports)
// ============================================================================
export const saveArchiveReport = async (year, month, csvData) => {
  const docId = `${year}_${month}`;
  const docRef = doc(db, 'archive_reports', docId);
  await setDoc(docRef, { 
    csv: csvData,
    timestamp: new Date().toISOString()
  }, { merge: true });
};

export const subscribeToArchiveReports = (callback) => {
  const colRef = collection(db, 'archive_reports');
  return onSnapshot(colRef, (snapshot) => {
    const reports = {};
    snapshot.forEach(doc => {
      reports[doc.id] = doc.data().csv; 
    });
    callback(reports);
  });
};

export const clearArchiveReports = async () => {
  const colRef = collection(db, 'archive_reports');
  const snapshot = await getDocs(colRef);
  const deletePromises = [];
  snapshot.forEach(document => {
    deletePromises.push(deleteDoc(doc(db, 'archive_reports', document.id)));
  });
  await Promise.all(deletePromises);
};

// ============================================================================
// 5. 班表安全備份 (統一歸檔至 archive_reports/YYYY_M)
// ============================================================================
export const backupScheduleToArchive = async (year, month, schedule, note) => {
  const docId = `${year}_${month}`; 
  const docRef = doc(db, 'archive_reports', docId);
  await setDoc(docRef, {
    year,
    month,
    schedule_backup: schedule,
    backedUpAt: new Date().toISOString(),
    note
  }, { merge: true });
};

// ============================================================================
// 6. 讀取雲端班表備份 (Read Backups)
// ============================================================================
export const fetchScheduleBackups = async () => {
  try {
    const q = query(collection(db, 'ScheduleBackups'), orderBy('backedUpAt', 'desc'));
    const snapshot = await getDocs(q);
    const backups = [];
    snapshot.forEach(doc => {
      backups.push({ id: doc.id, ...doc.data() });
    });
    return backups;
  } catch (error) {
    console.error("讀取備份失敗:", error);
    throw error;
  }
};