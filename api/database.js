// src/api/database.js
import { initializeApp } from "firebase/app";
import { getFirestore, doc, setDoc, onSnapshot, updateDoc } from "firebase/firestore";
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