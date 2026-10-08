// 本月是否為「直接指派」（CP-SAT 以真實工號排好，不開放認領）。
// 發布時前端把 assignMode 寫進 NurseApp/Settings.publishedDate；
// auto-relay / cron/check-timeout / claim-schedule 以伺服器端讀到的值為準，不信任前端傳入。
// 對應前端 src/constants.js isDirectAssigned。
export async function isDirectAssignedMonth(db, year, month) {
  const snap = await db.collection('NurseApp').doc('Settings').get();
  const pub = snap.exists ? snap.data().publishedDate : null;
  return pub?.assignMode === 'direct'
    && Number(pub.year) === Number(year)
    && Number(pub.month) === Number(month);
}
