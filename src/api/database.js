// ============================================================================
// api/database.js
// ============================================================================
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { 
  getFirestore, 
  doc, 
  setDoc, 
  onSnapshot, 
  collection, 
  getDocs, 
  deleteDoc 
} from "firebase/firestore";

// ★ Firebase 設定（從環境變數讀取）
const firebaseConfig = {
  apiKey:            import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket:     import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId:             import.meta.env.VITE_FIREBASE_APP_ID,
};

// 初始化 Firebase
const app = initializeApp(firebaseConfig);

// 匯出 auth 與 db 供其他檔案 (如 App.jsx) 使用
export const auth = getAuth(app);
export const db = getFirestore(app);

// ============================================================================
// 1. 全域設定 (Settings)
// ============================================================================
export const subscribeToSettings = (callback) => {
  const docRef = doc(db, 'system', 'settings');
  return onSnapshot(docRef, (docSnap) => {
    if (docSnap.exists()) {
      callback(docSnap.data());
    } else {
      callback(null);
    }
  });
};

export const saveGlobalSettings = async (data) => {
  const docRef = doc(db, 'system', 'settings');
  await setDoc(docRef, data, { merge: true });
};

// ============================================================================
// 2. 員工與健康度資料 (Staff & Health Stats)
// ============================================================================
export const subscribeToStaff = (callback) => {
  const docRef = doc(db, 'system', 'staff');
  return onSnapshot(docRef, (docSnap) => {
    if (docSnap.exists()) {
      callback(docSnap.data());
    } else {
      callback(null);
    }
  });
};

export const saveGlobalStaff = async (data) => {
  const docRef = doc(db, 'system', 'staff');
  await setDoc(docRef, data, { merge: true });
};

// ============================================================================
// 3. 每月排班表 (Schedules)
// ============================================================================
export const subscribeToSchedule = (year, month, callback) => {
  const docId = `${year}_${month}`;
  const docRef = doc(db, 'monthly_schedules', docId);
  
  return onSnapshot(docRef, (docSnap) => {
    if (docSnap.exists()) {
      callback(docSnap.data());
    } else {
      callback(null);
    }
  });
};

export const saveMonthlySchedule = async (year, month, data) => {
  const docId = `${year}_${month}`;
  const docRef = doc(db, 'monthly_schedules', docId);
  // 使用 merge: true 避免意外洗掉未修改的欄位
  await setDoc(docRef, data, { merge: true });
};

// 專門用於員工端認領後，僅更新 finalizedSchedule 的輕量級方法
export const updateStaffSchedule = async (year, month, finalizedSchedule) => {
  const docId = `${year}_${month}`;
  const docRef = doc(db, 'monthly_schedules', docId);
  await setDoc(docRef, { finalizedSchedule }, { merge: true });
};

// ============================================================================
// 4. 跨月大數據報表封存 (Archive Reports)
// ============================================================================

// 儲存單月結算的 CSV 報表
export const saveArchiveReport = async (year, month, csvData) => {
  const docId = `${year}_${month}`;
  const docRef = doc(db, 'archive_reports', docId);
  await setDoc(docRef, { 
    csv: csvData,
    timestamp: new Date().toISOString()
  }, { merge: true });
};

// 訂閱雲端所有的結算報表 (供 AI 跨月分析使用)
export const subscribeToArchiveReports = (callback) => {
  const colRef = collection(db, 'archive_reports');
  
  return onSnapshot(colRef, (snapshot) => {
    const reports = {};
    snapshot.forEach(doc => {
      // 將 doc.id (例如: "2026_2") 對應到其 CSV 內容
      reports[doc.id] = doc.data().csv; 
    });
    callback(reports);
  });
};

// 清空所有雲端報表歷史記憶
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
  // 讓檔名強制變成 "2026_1", "2026_2" 這種格式
  const docId = `${year}_${month}`; 
  const docRef = doc(db, 'archive_reports', docId);
  
  // 使用 merge: true 確保它只會新增 schedule_backup 欄位，
  // 不會洗掉你在結算面板匯出的 csv 報表資料！
  await setDoc(docRef, {
    year,
    month,
    schedule_backup: schedule,
    backedUpAt: new Date().toISOString(),
    note
  }, { merge: true });
};