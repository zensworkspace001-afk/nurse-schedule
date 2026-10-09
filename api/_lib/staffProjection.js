// StaffPublic 投影的唯一定義 — 前端 (src/api/database.js)、後端 (api/complete-profile.js、
// api/admin-user.js) 與維運腳本 (scripts/migrate-staff-public.js、scripts/restore-staff-from-private.js)
// 全部 import 這一份。同事間能看到的最小欄位集合，不含任何 PII / 健康 / 財務暗示資料。
// 要新增或移除公開欄位只改這裡；scripts/check-projection-single-source.js 在 CI 擋住重新複製一份。
//
// avatar_thumb 是 64x64 縮圖；不放 220x220 主圖是因為 Firestore 單 doc 1 MiB 上限。
// 純函式、零依賴：瀏覽器 (Vite) 與 Node (Vercel / scripts) 都能直接 import。

export function toStaffPublic(s) {
  return {
    staff_id: s.staff_id,
    name: s.name,
    level: s.level,
    is_leader: !!s.is_leader,
    is_active: s.is_active !== false, // 缺值預設 true
    avatar_thumb: s.avatar_thumb || null,
  };
}

export function buildStaffPublicProjection(fullStaffData = []) {
  return fullStaffData.map(toStaffPublic);
}
