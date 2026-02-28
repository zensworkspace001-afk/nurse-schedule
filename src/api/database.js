// src/api/database.js
import { initializeApp, getApps } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import {
  getFirestore,
  doc, setDoc, getDoc,
  collection, onSnapshot, deleteDoc, getDocs
} from 'firebase/firestore';

// ★ Firebase 設定（從環境變數讀取）
const firebaseConfig = {
  apiKey:            import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket:     import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId:             import.meta.env.VITE_FIREBASE_APP_ID,
};

// ★ 防止 HMR 重複初始化
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];

// ★ 核心修復：db 和 auth 在這裡統一初始化，所有函式都能存取
export const auth = getAuth(app);
const db = getFirestore(app);

// ============================================================
// Settings — 路徑對應規則: NurseApp/Settings
// ============================================================
export const subscribeToSettings = (callback) => {
  const ref = doc(db, 'NurseApp', 'Settings');
  return onSnapshot(ref, (snap) => {
    callback(snap.exists() ? snap.data() : null);
  });
};

export const saveGlobalSettings = async (data) => {
  await setDoc(doc(db, 'NurseApp', 'Settings'), data, { merge: true });
};

// ============================================================
// Staff — 路徑對應規則: NurseApp/Staff
// ============================================================
export const subscribeToStaff = (callback) => {
  const ref = doc(db, 'NurseApp', 'Staff');
  return onSnapshot(ref, (snap) => {
    callback(snap.exists() ? snap.data() : null);
  });
};

export const saveGlobalStaff = async (data) => {
  await setDoc(doc(db, 'NurseApp', 'Staff'), data, { merge: true });
};

// ============================================================
// Monthly Schedule — 路徑對應規則: Schedules/{id}
// ============================================================
export const subscribeToSchedule = (year, month, callback) => {
  const docId = `${year}-${String(month).padStart(2, '0')}`;
  const ref = doc(db, 'Schedules', docId);
  return onSnapshot(ref, (snap) => {
    callback(snap.exists() ? snap.data() : null);
  });
};

export const saveMonthlySchedule = async (year, month, data) => {
  const docId = `${year}-${String(month).padStart(2, '0')}`;
  await setDoc(doc(db, 'Schedules', docId), data, { merge: true });
};

// ★ 員工認領班表（即時寫入 finalizedSchedule）
export const updateStaffSchedule = async (year, month, newFinalizedSchedule) => {
  const docId = `${year}-${String(month).padStart(2, '0')}`;
  await setDoc(
    doc(db, 'Schedules', docId),
    { finalizedSchedule: newFinalizedSchedule },
    { merge: true }
  );
};

// ============================================================
// Archive Reports — 路徑對應規則: archive_reports/{id}
// ============================================================
export const saveArchiveReport = async (year, month, csvContent) => {
  const docId = `${year}-${String(month).padStart(2, '0')}`;
  await setDoc(
    doc(db, 'archive_reports', docId),
    { year, month, csvContent, savedAt: new Date().toISOString() },
    { merge: true }
  );
};

export const subscribeToArchiveReports = (callback) => {
  const ref = collection(db, 'archive_reports');
  return onSnapshot(ref, (snapshot) => {
    const reports = {};
    snapshot.forEach((docSnap) => {
      const data = docSnap.data();
      const key = `${data.year}年${data.month}月`;
      reports[key] = data.csvContent;
    });
    callback(reports);
  });
};

export const clearArchiveReports = async () => {
  const ref = collection(db, 'archive_reports');
  const snapshot = await getDocs(ref);
  await Promise.all(snapshot.docs.map((docSnap) => deleteDoc(docSnap.ref)));
};