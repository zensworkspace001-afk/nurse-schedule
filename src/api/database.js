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
  "type": "service_account",
  "project_id": "scheduling-systembachelor",
  "private_key_id": "28ef699b94cdbc12e078ed6237f6cf4c11f7738a",
  "private_key": "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDt7FtLoyLvCBWG\nFwwWflcdZqjjpD0nkYcc3e13zV6xDfKJoWz6jPc9G8tqf7UJJ/nA+FdnWpFanf9i\ncyXRyrBluHs4PtnHcl9ld/wPUuGKsr9iJKlZusYajo7bq+2Ei9jf+PEpwst+gHWe\nhpSm0mnVTYdq2E6WPEwj+tVFOrlcOGBGCEvW8tQaEgD0QyH2TfJA+ROx0/DCQC2J\n4VX3LZAMlMvlCjBxwUsXcB76keNqkRVlTwJomP/RB0vZ4Xxchta6K2cs1kHsMPk8\nBvrnsUE5KdiKN6hNLXVixBIYDGXcyy6Op+VtnG5pPsZFRWWJfCFoJoQ4cl9BhULn\n56h3JwtXAgMBAAECggEAANjSpsb6l/UK6Pj9blN3z7jh7zsfJQKdg2qxodE/PfK2\ndmsp/kBXNvmTQU2zR5UqJfFpLXFPy1p81Y0vlfrnPHPdXtQwDHsDQB/ruH0LV+X0\nzKgkJ2SE62sVGU7k39zRlYaHPgzqXyJpu/oI3tX1hRb4EIpn/GmHI3YNB7VcTvag\nqAQmx8u3ldJ8wTGW6+wrqaTJXfZSUqdBr/dmSR5Gf9qmapo4CiHnLvRvsrAr8Iik\nIT/l5M///ohL0eVt2zpwtBvpiEUPuqq6bjskCgSkWdqeQk+GlJnNkJh+GYSqEbd6\nLzF9EiIX7+QM9mXq9Z3Pgp4HaD6ntBMv/fPrMKk5JQKBgQD7I2oSDQ/yna9wnSN1\nzhEPxz+miRvwNfEw6sIB/pzb53jfn8RMFpZowLWmWj+jDSHFhBs9OQ+m6YSjw4fc\nUuDhqul5Q6DpwEBTbTugnIeGmYBS3/vn6JiEj4LwztnGHNp50fPbnjGsJFtQvjtJ\nPs7627rq5xWQQDrartAl78MJuwKBgQDyh3OLYDgNVa4xcdlttSPF0gC9NVmmmNcd\n9EmEV6JZzgn1plhj6m2VIpXDb2pAeAK4IiG6F2capuPR5xzG7cfUMj57e3w7K/yc\namw/5M4/gtZHFlWMPfmZz5IBj+dA2qnRvPPUrVSELdvUR9tNacNJaXuzyqfPoWWL\n82bMLg5NFQKBgGAKqBrlIe8vvJM9lP0NZFr7YO0oTCXuCyIg9TbcD1LNz9z9dY1/\nqd+/qvhGVUXe1MZ7ggtE0iaL8WzLbx6kF1pWCVmVsmkSW8dL49zFX9Lqyzdmbyi+\nO+2eEH5VLNVl3WtvDmozsl1Zvg4/4d5eBbvL4kzJOObkmV1eMz3+1kDXAoGAer1A\nJYYxd9YnzRAwGIx2qTOpehgY4e4x2A/8cMSk/kv+0Fo6G37VrIcPQhQNssjJn4Ru\niy4y2NMjMuSCtM47tlEjO/z3lz6gnkxhskhKdOvzI5DTBKGMw2HAI5g/UZwYG3RD\n9hsuTaKjwSAIhXoEAhAnMYtbOAIXUSeCm8ynIi0CgYEA8TmfSnfK/kdJ8PlTF76o\nhKO8LUbJNCraSUDCwAPh4dQwhFEgUYzQUnoL8T3amVrBSrBfQL1FNFkcZTVJWBul\nFrJnO0MnVBvft5Mqq7HVTzh5sjVgBF5Bm1DhRCRPHDUB+wiwoKB2nUi0eMN+yy7N\neiHj0KtTyGe0WY78Z3RBt6w=\n-----END PRIVATE KEY-----\n",
  "client_email": "firebase-adminsdk-fbsvc@scheduling-systembachelor.iam.gserviceaccount.com",
  "client_id": "114346109266016277241",
  "auth_uri": "https://accounts.google.com/o/oauth2/auth",
  "token_uri": "https://oauth2.googleapis.com/token",
  "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
  "client_x509_cert_url": "https://www.googleapis.com/robot/v1/metadata/x509/firebase-adminsdk-fbsvc%40scheduling-systembachelor.iam.gserviceaccount.com",
  "universe_domain": "googleapis.com"
};


// 初始化 Firebase (這段之前被你不小心刪掉了！)
const app = initializeApp(firebaseConfig);

// 匯出 auth 與 db 供其他檔案 (如 App.jsx) 使用
export const auth = getAuth(app);
export const db = getFirestore(app);
// ============================================================================
// 1. 全域設定 (Settings) -> 改回 NurseApp/Settings
// ============================================================================
export const subscribeToSettings = (callback) => {
  const docRef = doc(db, 'NurseApp', 'Settings'); // ★ 改這裡
  return onSnapshot(docRef, (docSnap) => {
    if (docSnap.exists()) callback(docSnap.data());
    else callback(null);
  });
};

export const saveGlobalSettings = async (data) => {
  const docRef = doc(db, 'NurseApp', 'Settings'); // ★ 改這裡
  await setDoc(docRef, data, { merge: true });
};

// ============================================================================
// 2. 員工與健康度資料 (Staff & Health Stats) -> 改回 NurseApp/Staff
// ============================================================================
export const subscribeToStaff = (callback) => {
  const docRef = doc(db, 'NurseApp', 'Staff'); // ★ 改這裡
  return onSnapshot(docRef, (docSnap) => {
    if (docSnap.exists()) callback(docSnap.data());
    else callback(null);
  });
};

export const saveGlobalStaff = async (data) => {
  const docRef = doc(db, 'NurseApp', 'Staff'); // ★ 改這裡
  await setDoc(docRef, data, { merge: true });
};

// ============================================================================
// 3. 每月排班表 (Schedules) -> 改回 Schedules
// ============================================================================
export const subscribeToSchedule = (year, month, callback) => {
  const docId = `${year}_${month}`;
  const docRef = doc(db, 'Schedules', docId); // ★ 改這裡
  return onSnapshot(docRef, (docSnap) => {
    if (docSnap.exists()) callback(docSnap.data());
    else callback(null);
  });
};

export const saveMonthlySchedule = async (year, month, data) => {
  const docId = `${year}_${month}`;
  const docRef = doc(db, 'Schedules', docId); // ★ 改這裡
  await setDoc(docRef, data, { merge: true });
};

export const updateStaffSchedule = async (year, month, finalizedSchedule) => {
  const docId = `${year}_${month}`;
  const docRef = doc(db, 'Schedules', docId); // ★ 改這裡
  await setDoc(docRef, { finalizedSchedule }, { merge: true });
};