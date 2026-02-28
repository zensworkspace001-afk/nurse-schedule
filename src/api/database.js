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