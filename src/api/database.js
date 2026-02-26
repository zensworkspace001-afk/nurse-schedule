import { initializeApp } from "firebase/app";
import { getFirestore, doc, setDoc, onSnapshot, collection, getDocs, deleteDoc } from "firebase/firestore";
import { getAuth } from "firebase/auth";

// 1. Firebase 初始化設定 (集中管理)
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
export const auth = getAuth(app); // 匯出 auth 給 App.jsx 的登入功能使用

// ==========================================
// 讀取 API (Read / Subscribe)
// ==========================================

export const subscribeToSettings = (onDataReceived) => {
  return onSnapshot(doc(db, "NurseApp", "Settings"), (docSnap) => {
    onDataReceived(docSnap.exists() ? docSnap.data() : null);
  });
};

export const subscribeToStaff = (onDataReceived) => {
  return onSnapshot(doc(db, "NurseApp", "Staff"), (docSnap) => {
    onDataReceived(docSnap.exists() ? docSnap.data() : null);
  });
};

export const subscribeToSchedule = (year, month, onDataReceived) => {
  const scheduleDocId = `${year}-${month}`;
  return onSnapshot(doc(db, "Schedules", scheduleDocId), (docSnap) => {
    onDataReceived(docSnap.exists() ? docSnap.data() : null);
  });
};

// ==========================================
// 寫入 API (Write / Update)
// ==========================================

export const saveGlobalSettings = async (settingsData) => {
  await setDoc(doc(db, "NurseApp", "Settings"), settingsData);
};

export const saveGlobalStaff = async (staffData) => {
  await setDoc(doc(db, "NurseApp", "Staff"), staffData);
};

export const saveMonthlySchedule = async (year, month, scheduleData) => {
  const scheduleDocId = `${year}-${month}`;
  await setDoc(doc(db, "Schedules", scheduleDocId), scheduleData);
};

export const updateStaffSchedule = async (year, month, finalizedSchedule) => {
  const scheduleDocId = `${year}-${month}`;
  await updateDoc(doc(db, "Schedules", scheduleDocId), { finalizedSchedule });
};

// 1. 上傳單月報表至雲端 Firestore
export const saveArchiveReport = async (year, month, csvData) => {
    // 存入 'archive_reports' 集合中，文件 ID 命名為 "2026_3"
    const docRef = doc(db, 'archive_reports', `${year}_${month}`);
    await setDoc(docRef, { csv: csvData, timestamp: Date.now() });
};

// 2. 自動監聽雲端上的所有報表 (使用 onSnapshot 達到即時同步)
export const subscribeToArchiveReports = (callback) => {
    const colRef = collection(db, 'archive_reports');
    
    return onSnapshot(colRef, (snapshot) => {
        const formatted = {};
        snapshot.forEach((docSnap) => {
            const data = docSnap.data();
            const [y, m] = docSnap.id.split('_'); // 把 "2026_3" 拆回年跟月
            formatted[`${y}年${m}月`] = data.csv;
        });
        callback(formatted);
    });
};

// 3. 清空雲端的報表記憶庫
export const clearArchiveReports = async () => {
    const colRef = collection(db, 'archive_reports');
    const snapshot = await getDocs(colRef);
    
    // Firestore 不能直接刪除整個 Collection，必須把裡面的 Document 抓出來逐一刪除
    const deletePromises = [];
    snapshot.forEach((docSnap) => {
        deletePromises.push(deleteDoc(docSnap.ref));
    });
    
    // 等待所有報表文件都刪除完畢
    await Promise.all(deletePromises);
};