import React, { useState, useEffect, useRef } from 'react';
import { auth } from '../api/database';
import './StaffManagementPanel.css';

const StaffManagementPanel = ({ staffData, setStaffData }) => {
  const [localStaff, setLocalStaff] = useState([]);
  const [isDirty, setIsDirty] = useState(false);

useEffect(() => {
  // ★ 只在「沒有未儲存的修改」時才接受雲端同步的資料
  setIsDirty(prev => {
    if (!prev) {
      setLocalStaff(staffData); // 沒在編輯中才更新
    }
    return prev; // isDirty 狀態保持不變
  });
}, [staffData]);

  const handleChange = (id, field, value) => {
    setLocalStaff(prev => prev.map(staff => {
      if (staff.staff_id === id) {
        return { ...staff, [field]: value };
      }
      return staff;
    }));
    setIsDirty(true);
  };

// ★★★ 修正 5：修復刪除員工後可能引發的工號衝突 (Auto-Increment Bug) ★★★
  const handleAddStaff = () => {
    // 找出目前最大工號數字再 +1
    const maxNum = localStaff.reduce((max, s) => {
        const num = parseInt(s.staff_id.replace(/\D/g, '')) || 0;
        return Math.max(max, num);
    }, 0);

    // 生成新的不重複工號
    const newId = `N${String(maxNum + 1).padStart(3, '0')}`;

 const newStaff = {
      staff_id: newId, name: '新員工', gender: '女', email: '', level: 'N0', tenure_years: 0,
     leave_status: 'None', is_active: true, special_status: 'Standard',
     is_pregnant_or_nursing: false, can_night_shift: true, accumulated_ot: 0, night_shift_balance: 0,
      annual_leave_used: 0, prevMonthLeave: [false, false, false, false, false, false, false]
    };

    setLocalStaff([...localStaff, newStaff]);
    setIsDirty(true);
  };

  const handleDelete = (id) => {
    if (window.confirm(`確定要刪除員工 ${id} 嗎？`)) {
      setLocalStaff(prev => prev.filter(s => s.staff_id !== id));
      setIsDirty(true);
    }
  };

  // ★★★ 新增：批次匯入 CSV 員工資料 ★★★
  const fileInputRef = useRef(null); // 需要在元件頂部 import { useRef } from 'react'，若已引入則直接加這行

  const handleImportCSV = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const csv = event.target.result;
      const lines = csv.split(/\r\n|\n/); // 支援 Windows/Mac 換行
      const newStaffList = [...localStaff]; // 保留原本已有的員工，把新的加進去
      let importedCount = 0;

      // 從第二行開始讀取 (跳過標題列)
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        const cols = line.split(',');
        if (cols.length >= 2 && cols[0]) {
           // 檢查是否已有相同工號，避免重複
           if (newStaffList.some(s => s.staff_id === cols[0])) continue;

           newStaffList.push({
              staff_id: cols[0],
              name: cols[1],
              level: cols[2] || 'N0',
              tenure_years: Number(cols[3]) || 0,
              is_leader: cols[4] === '是' || cols[4] === 'true',
              leave_status: cols[5] === '' ? 'None' : cols[5],
              is_active: true,
              special_status: cols[6] === 'BiWeekly' ? 'BiWeekly' : 'Standard',
              can_night_shift: cols[7] !== '否' && cols[7] !== 'false',
              accumulated_ot: Number(cols[8]) || 0,
              night_shift_balance: Number(cols[9]) || 0,
              prevMonthLeave: [false, false, false, false, false, false, false]
           });
           importedCount++;
        }
      }

      setLocalStaff(newStaffList);
      setIsDirty(true);
      alert(`✅ 成功匯入 ${importedCount} 筆員工資料！\n請記得點擊「💾 儲存變更」以上傳至雲端。`);

      // 清空 input 讓下次選同一個檔案也能觸發
      if (fileInputRef.current) fileInputRef.current.value = '';
    };
    reader.readAsText(file);
  };

  // ★★★ 修改：呼叫後端 API 進行真實密碼重置 ★★★
  const handleResetPassword = async (id, name) => {
      if (!window.confirm(`確定要將員工「${name} (${id})」的登入密碼強制重置為 123456 嗎？\n\n注意：這將直接修改系統通行驗證碼。`)) {
          return;
      }

      try {
          // 1. 取得管理員自己的 Token
          const token = await auth.currentUser.getIdToken();

          // 2. 呼叫我們自己寫的 Vercel 後端 API
          const response = await fetch('/api/reset-password', {
              method: 'POST',
              headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${token}` // 帶上管理員證明
              },
              body: JSON.stringify({ staffId: id })
          });

          const data = await response.json();

          if (!response.ok) {
              throw new Error(data.error || '重置失敗');
          }



          // 3. API 執行成功後，只需通知使用者即可，前端不保留密碼狀態
alert(`✅ 成功！員工 ${name} 的登入密碼已重置為 123456。`);
      } catch (error) {
          console.error(error);
          alert(`❌ 重置密碼失敗：${error.message}`);
      }
  };

const handleSave = async () => {
    // 1. 更新前端畫面與觸發 Firestore 存檔 (靠 App.jsx 原本的 debounce 寫入)
    setStaffData(localStaff);
    setIsDirty(false);

    // 2. 偷偷在背景呼叫 Vercel API，幫大家建帳號！
    try {
        const response = await fetch('/api/sync-accounts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ staffList: localStaff })
        });

        const data = await response.json();

        if(response.ok) {
            alert(`✅ 員工資料已成功儲存！\n\n🔑 【系統後台報告】\n- 自動開通新帳號：${data.result.successCount} 人\n- 既有帳號已略過：${data.result.existedCount} 人\n- 發生錯誤：${data.result.errorCount} 人`);
        } else {
            alert(`⚠️ 資料已儲存，但建立登入帳號時發生錯誤：${data.error}`);
        }
    } catch (error) {
        console.error("同步帳號失敗", error);
        alert('✅ 員工資料已儲存！\n(但目前無法連線至自動建帳號系統)');
    }
  };

  const columns = [
    { key: 'staff_id', label: '工號', type: 'text', width: '60px', readOnly: true },
    { key: 'name', label: '姓名', type: 'text', width: '80px' },
    { key: 'gender', label: '性別', type: 'select', options: ['女', '男'], width: '60px' }, // 👈 新增這行
    { key: 'email', label: 'Email信箱', type: 'text', width: '160px' , color:'black'}, // 👈 ★★★ 新增這行 ★★★
    { key: 'level', label: '職級', type: 'select', options: ['N0', 'N1', 'N2', 'N3', 'N4'], width: '70px' },
    { key: 'prevMonthLeave', label: '上月連班天數', type: 'streak_display', width: '80px' },
    { key: 'tenure_years', label: '年資', type: 'number', width: '60px' },
    { key: 'is_leader', label: '組長', type: 'checkbox', width: '50px' },
    { key: 'leave_status', label: '狀態', type: 'select', options: ['None', 'Maternal', 'Student', 'OnLeave'], width: '90px' },
    { key: 'is_active', label: '在職', type: 'checkbox', width: '50px' },
    { key: 'special_status', label: '工時', type: 'select', options: ['Standard', 'BiWeekly'], width: '90px' },
    { key: 'is_pregnant_or_nursing', label: '孕/哺乳', type: 'checkbox', width: '60px' },
    { key: 'can_night_shift', label: '夜班', type: 'checkbox', width: '50px' },
    { key: 'annual_leave_used', label: '已休特休', type: 'number', width: '70px',color:'black'},
    { key: 'accumulated_ot', label: '積假', type: 'number', width: '60px' },
    { key: 'night_shift_balance', label: '夜餘', type: 'number', width: '60px' },
  ];

  // Helper: build className string for text/number inputs
  const getInputClassName = (colKey) => {
    const classes = ['staff-mgmt__input'];
    if (colKey === 'name') classes.push('staff-mgmt__input--name');
    if (['name', 'tenure_years', 'accumulated_ot', 'night_shift_balance', 'annual_leave_used'].includes(colKey)) {
      classes.push('staff-mgmt__input--bold');
    } else if (['email'].includes(colKey)) {
      classes.push('staff-mgmt__input--black');
    }
    return classes.join(' ');
  };

  // Helper: get streak severity class
  const getStreakClass = (isWarning, isAlert) => {
    if (isWarning) return 'streak--warning';
    if (isAlert) return 'streak--alert';
    return 'streak--normal';
  };

  return (
    <div className="staff-mgmt">
      <div className="staff-mgmt__header">
        <h2 className="staff-mgmt__title">員工資料管理 ({localStaff.length}人)</h2>
        <div className="staff-mgmt__actions">
          {/* ★ 新增：隱藏的檔案選擇器與匯入按鈕 */}
          <input
            type="file"
            accept=".csv"
            ref={fileInputRef}
            className="staff-mgmt__file-input"
            onChange={handleImportCSV}
          />
          <button onClick={() => fileInputRef.current.click()} className="staff-mgmt__btn staff-mgmt__btn--import">
            📥 匯入 CSV
          </button>

          <button onClick={handleAddStaff} className="staff-mgmt__btn staff-mgmt__btn--add">+ 單筆新增</button>
          <button
            onClick={handleSave}
            disabled={!isDirty}
            className={`staff-mgmt__btn--save ${isDirty ? 'staff-mgmt__btn--save-dirty' : 'staff-mgmt__btn--save-clean'}`}
          >
            {isDirty ? '💾 儲存變更' : '已同步'}
          </button>
        </div>
      </div>

      <div className="staff-mgmt__table-wrapper">
        <table className="staff-mgmt__table">
          <thead className="staff-mgmt__thead">
            <tr>
              {columns.map(col => (
                <th key={col.key} className="staff-mgmt__th" style={{ minWidth: col.width }}>
                  {col.label}
                </th>
              ))}
              <th className="staff-mgmt__th--actions">操作</th>
            </tr>
          </thead>
          <tbody>
            {localStaff.map((staff) => (
              <tr key={staff.staff_id} className={`staff-mgmt__row${!staff.is_active ? ' staff-mgmt__row--inactive' : ''}`}>
                {columns.map(col => (
                  <td key={col.key} className="staff-mgmt__td">
                    {col.readOnly ? (
                      <span className="staff-mgmt__readonly">{staff[col.key]}</span>
                    ) : col.type === 'checkbox' ? (
                      <input type="checkbox" checked={staff[col.key] === true || staff[col.key] === 'True'} onChange={(e) => handleChange(staff.staff_id, col.key, e.target.checked)} className="staff-mgmt__checkbox" />
                    ) : col.type === 'select' ? (
                      <select value={staff[col.key] || ''} onChange={(e) => handleChange(staff.staff_id, col.key, e.target.value)} className="staff-mgmt__select">{col.options.map(opt => <option key={opt} value={opt}>{opt === 'None' ? '--' : opt}</option>)}</select>
                    ) : col.type === 'streak_display' ? (
                      (() => {
                        // prevMonthLeave 按日期順序儲存：idx0=倒數第7天, idx6=最後一天
                        // 從尾端(最後一天)往前數，遇到休假或沒資料就停止
                        const leaves = staff[col.key];
                        // 沒有 prevMonthLeave 資料（未同步）→ 顯示 0
                        if (!leaves || leaves.length === 0) {
                          return <div className="staff-mgmt__streak-empty">—</div>;
                        }
                        let streak = 0;
                        for (let i = 6; i >= 0; i--) {
                          if (leaves[i] !== false) break; // 只有明確 false（上班）才繼續，其餘（true休假/undefined未知）都停止
                          streak++;
                        }
                        const isWarning = streak >= 6;
                        const isAlert = streak >= 5;
                        return (
                          <div className="staff-mgmt__streak-wrap">
                            <div className={`staff-mgmt__streak-badge ${getStreakClass(isWarning, isAlert)}`}>
                              {streak}天
                            </div>
                            {isWarning && <div className="staff-mgmt__streak-limit">⚠️ 達上限</div>}
                          </div>
                        );
                      })()
                    ) : (
                      <input
                        type={col.type}
                        value={Number.isNaN(staff[col.key]) ? '' : (staff[col.key] ?? '')}
                        onChange={(e) => handleChange(staff.staff_id, col.key, col.type === 'number' ? (e.target.value === '' ? '' : parseFloat(e.target.value)) : e.target.value)}
                        className={getInputClassName(col.key)}
                      />
                    )}
                  </td>
                ))}

                {/* ★★★ 這裡是操作欄位 ★★★ */}
                <td className="staff-mgmt__td--actions">
                  {/* 新增：重置密碼按鈕 */}
                  <button onClick={() => handleResetPassword(staff.staff_id, staff.name)} className="staff-mgmt__icon-btn staff-mgmt__icon-btn--reset" title="重置密碼為 1234">🔑</button>
                  {/* 原本：刪除按鈕 */}
                  <button onClick={() => handleDelete(staff.staff_id)} className="staff-mgmt__icon-btn staff-mgmt__icon-btn--delete" title="刪除員工">🗑️</button>
                </td>

              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default StaffManagementPanel;
