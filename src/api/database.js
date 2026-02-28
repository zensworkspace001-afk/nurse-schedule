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
// Settings（班別選項、優先設定、發布日期）
// ============================================================
export const subscribeToSettings = (callback) => {
  const ref = doc(db, 'global', 'settings');
  return onSnapshot(ref, (snap) => {
    callback(snap.exists() ? snap.data() : null);
  });
};

export const saveGlobalSettings = async (data) => {
  await setDoc(doc(db, 'global', 'settings'), data, { merge: true });
};

// ============================================================
// Staff（員工資料、健康度歷史）
// ============================================================
export const subscribeToStaff = (callback) => {
  const ref = doc(db, 'global', 'staff');
  return onSnapshot(ref, (snap) => {
    callback(snap.exists() ? snap.data() : null);
  });
};

export const saveGlobalStaff = async (data) => {
  await setDoc(doc(db, 'global', 'staff'), data, { merge: true });
};

// ============================================================
// Monthly Schedule（每月草稿 + 發布班表）
// ============================================================
export const subscribeToSchedule = (year, month, callback) => {
  const docId = `${year}-${String(month).padStart(2, '0')}`;
  const ref = doc(db, 'schedules', docId);
  return onSnapshot(ref, (snap) => {
    callback(snap.exists() ? snap.data() : null);
  });
};

export const saveMonthlySchedule = async (year, month, data) => {
  const docId = `${year}-${String(month).padStart(2, '0')}`;
  await setDoc(doc(db, 'schedules', docId), data, { merge: true });
};

// ★ 員工認領班表（即時寫入 finalizedSchedule）
export const updateStaffSchedule = async (year, month, newFinalizedSchedule) => {
  const docId = `${year}-${String(month).padStart(2, '0')}`;
  await setDoc(
    doc(db, 'schedules', docId),
    { finalizedSchedule: newFinalizedSchedule },
    { merge: true }
  );
};

// ============================================================
// Archive Reports（封存歷史班表 CSV）
// ★ 核心修復：原本 db 未定義，現在統一從上面取得
// ============================================================

/**
 * 儲存封存報表到 Firebase
 * @param {number} year
 * @param {number} month
 * @param {string} csvContent - CSV 字串內容
 */
export const saveArchiveReport = async (year, month, csvContent) => {
  const docId = `${year}-${String(month).padStart(2, '0')}`;
  await setDoc(
    doc(db, 'archiveReports', docId),
    {
      year,
      month,
      csvContent,
      savedAt: new Date().toISOString(),
    },
    { merge: true }
  );
};

/**
 * 即時監聽所有封存報表
 * @param {function} callback - 回傳 { [monthKey]: csvContent } 格式
 */
export const subscribeToArchiveReports = (callback) => {
  const ref = collection(db, 'archiveReports');
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

/**
 * 清除所有封存報表
 */
export const clearArchiveReports = async () => {
  const ref = collection(db, 'archiveReports');
  const snapshot = await getDocs(ref);
  const deletes = snapshot.docs.map((docSnap) => deleteDoc(docSnap.ref));
  await Promise.all(deletes);
};