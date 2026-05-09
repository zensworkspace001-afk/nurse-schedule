// Dev-only 預覽頁面。掛在 /dev/profile-wizard，用 mock props 讓 UI 可以單獨檢視，
// 不需要真的登入 / 進入員工流程。提交按鈕仍會打 /api/complete-profile —
// 沒登入時 token 取不到會直接失敗，錯誤訊息會顯示在紅色橫條上，視覺仍然 OK。
import React from 'react';
import ProfileWizard from '../components/ProfileWizard';

const mockStaffRow = {
  staff_id: 'N001',
  name: '',
  gender: '女',
  tenure_years: 0,
  is_pregnant_or_nursing: false,
  can_night_shift: true,
  profile_completed: false,
};

const mockCurrentUser = {
  id: 'N001',
  name: '預覽模式',
  role: 'staff',
};

export default function ProfileWizardPreview() {
  return <ProfileWizard staffRow={mockStaffRow} currentUser={mockCurrentUser} />;
}
