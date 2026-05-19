import React, { useState, useEffect, useRef } from 'react';
import { Search, X, Download, Plus, Save, KeyRound, Trash2, AlertTriangle } from 'lucide-react';
import { auth } from '../api/database';
import EncryptedField from './EncryptedField';
import './StaffManagementPanel.css';

const StaffManagementPanel = ({ staffData, setStaffData }) => {
  const [localStaff, setLocalStaff] = useState([]);
  const [isDirty, setIsDirty] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterStatus, setFilterStatus] = useState('all'); // all | active | inactive

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
      annual_leave_used: 0, prevMonthLeave: [false, false, false, false, false, false, false],
      // 敏感欄位（加密前為 ''；寫入後為 {ct, iv, tag, v} 密文 blob）
      idNumber: '', bankAccount: '', phone: '',
      // false ⇒ 員工首次登入會被導向 ProfileWizard 自填這些欄位
      profile_completed: false,
    };

    setLocalStaff([...localStaff, newStaff]);
    setIsDirty(true);
  };

  // 刪除員工 = 永久離職歸檔。走後端 /api/admin-user action='delete-staff'：
  //   - 頭貼 + 識別欄位搬到 ex_staff/{id}（含刪除時間與操作者）
  //   - 從 NurseApp/Staff + StaffPublic 移除、刪除 StaffPrivate/{id}、停用 Auth
  //   - 寫稽核 action='delete-staff'
  // 後端寫完後，localStaff 也要立即剔除該行，否則若 admin 此時有其它未存編輯
  // （isDirty=true），下次按「儲存變更」會把該行重新寫回。
  const handleDelete = async (id, name) => {
    const label = name ? `${name} (${id})` : id;
    if (!window.confirm(
      `確定要永久離職員工 ${label} 嗎？\n\n` +
      `將執行：\n` +
      `• 從員工名單移除\n` +
      `• 頭貼歸檔到「ex_staff」資料夾（含刪除日期）\n` +
      `• 停用其 Firebase 登入帳號\n` +
      `• 寫入稽核紀錄\n\n` +
      `此動作無法復原。`
    )) return;

    try {
      const token = await auth.currentUser.getIdToken();
      const res = await fetch('/api/admin-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ action: 'delete-staff', staffId: id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '刪除失敗');

      // 後端已成功；同步剔除本地 list 避免後續儲存把它寫回
      setLocalStaff(prev => prev.filter(s => s.staff_id !== id));

      alert(
        `✅ ${data.message}\n\n` +
        `📁 歸檔位置：${data.archived_to}\n` +
        `📷 頭貼：${data.had_avatar ? '已一併歸檔' : '原本就沒有頭貼'}\n` +
        `🔒 登入帳號：${data.auth_disabled ? '已停用' : '未停用（可能本來就不存在）'}`
      );
    } catch (err) {
      console.error('刪除員工失敗:', err);
      alert(`❌ 刪除失敗：${err.message}`);
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

  // 觸發後端寄送一次性密碼重設信（不再直接覆寫密碼）
  const handleResetPassword = async (id, name) => {
      if (!window.confirm(`確定要寄送密碼重設信給「${name} (${id})」嗎？\n\n系統將寄出 24 小時內有效的一次性連結，員工點擊後可自行設定新密碼。`)) {
          return;
      }

      try {
          const token = await auth.currentUser.getIdToken();
          const response = await fetch('/api/admin-user', {
              method: 'POST',
              headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${token}`
              },
              body: JSON.stringify({ action: 'reset', staffId: id })
          });

          const data = await response.json();
          if (!response.ok) {
              throw new Error(data.error || '寄送失敗');
          }

          alert(`✅ 已寄送密碼重設信至 ${data.email || name + ' 的信箱'}。\n員工請點擊信中連結設定新密碼（24 小時內有效）。`);
      } catch (error) {
          console.error(error);
          alert(`❌ 寄送密碼重設信失敗：${error.message}`);
      }
  };

const handleSave = async () => {
    // 1. 更新前端畫面與觸發 Firestore 存檔 (靠 App.jsx 原本的 debounce 寫入)
    setStaffData(localStaff);
    setIsDirty(false);

    // 2. 偷偷在背景呼叫 Vercel API，幫大家建帳號！
    try {
        const token = await auth.currentUser.getIdToken();
        const response = await fetch('/api/admin-user', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ action: 'sync', staffList: localStaff })
        });

        const data = await response.json();

        if(response.ok) {
            const r = data.result || {};
            alert(`✅ 員工資料已成功儲存！\n\n🔑 【系統後台報告】\n- 自動開通新帳號：${r.invitedCount ?? r.successCount ?? 0} 人\n- 既有帳號已略過：${r.existedCount ?? 0} 人\n- 發生錯誤：${r.errorCount ?? 0} 人`);
        } else {
            alert(`⚠️ 資料已儲存，但建立登入帳號時發生錯誤：${data.error}`);
        }
    } catch (error) {
        console.error("同步帳號失敗", error);
        alert('✅ 員工資料已儲存！\n(但目前無法連線至自動建帳號系統)');
    }
  };

  const columns = [
    { key: 'avatar', label: '頭貼', type: 'avatar', width: '60px' },
    { key: 'staff_id', label: '工號', type: 'text', width: '70px', readOnly: true },
    { key: 'name', label: '姓名', type: 'text', width: '90px' },
    { key: 'gender', label: '性別', type: 'select', options: ['女', '男'], width: '70px' },
    { key: 'email', label: 'Email信箱', type: 'text', width: '180px', color: 'black' },
    { key: 'level', label: '職級', type: 'select', options: ['N0', 'N1', 'N2', 'N3', 'N4'], width: '80px' },
    { key: 'prevMonthLeave', label: '上月連班天數', type: 'streak_display', width: '90px' },
    { key: 'tenure_years', label: '年資', type: 'number', width: '65px' },
    { key: 'is_leader', label: '組長', type: 'checkbox', width: '60px' },
    { key: 'leave_status', label: '狀態', type: 'select', options: ['None', 'Maternal', 'Student', 'OnLeave'], width: '100px' },
    { key: 'is_active', label: '在職', type: 'checkbox', width: '60px' },
    { key: 'special_status', label: '工時', type: 'select', options: ['Standard', 'BiWeekly'], width: '100px' },
    { key: 'is_pregnant_or_nursing', label: '孕/哺乳', type: 'checkbox', width: '70px' },
    { key: 'can_night_shift', label: '夜班', type: 'checkbox', width: '60px' },
    { key: 'annual_leave_used', label: '已休特休', type: 'number', width: '75px', color: 'black' },
    { key: 'accumulated_ot', label: '積假', type: 'number', width: '65px' },
    { key: 'night_shift_balance', label: '夜餘', type: 'number', width: '65px' },
    // —— 加密欄位 —— Firestore 端僅存 {ct,iv,tag,v} 密文，UI 點開才解
    { key: 'idNumber',    label: '🔒 身分證',   type: 'encrypted', width: '160px' },
    { key: 'bankAccount', label: '🔒 銀行帳號', type: 'encrypted', encryptedKind: 'bank-account', width: '260px' },
    { key: 'phone',       label: '🔒 手機',     type: 'encrypted', width: '140px' },
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

  // ★ 搜尋 & 篩選邏輯
  const filteredStaff = localStaff.filter(staff => {
    // 狀態篩選
    if (filterStatus === 'active' && !staff.is_active) return false;
    if (filterStatus === 'inactive' && staff.is_active) return false;
    // 搜尋關鍵字 (工號、姓名、Email)
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return (
        staff.staff_id.toLowerCase().includes(q) ||
        (staff.name || '').toLowerCase().includes(q) ||
        (staff.email || '').toLowerCase().includes(q)
      );
    }
    return true;
  });

  const activeCount = localStaff.filter(s => s.is_active).length;
  const inactiveCount = localStaff.length - activeCount;

  // 累積寬度，用來算 sticky 欄位的 left 偏移（前三欄都是 sticky：頭貼 / 工號 / 姓名）
  const STICKY_COUNT = 3;
  const getStickyLeft = (idx) => {
    if (idx <= 0) return 0;
    let sum = 0;
    for (let i = 0; i < idx; i++) sum += parseInt(columns[i].width, 10) || 0;
    return sum;
  };

  return (
    <div className="staff-mgmt">
      <div className="staff-mgmt__header">
        <h2 className="staff-mgmt__title">員工資料管理 ({localStaff.length}人)</h2>
        <div className="staff-mgmt__actions">
          <input
            type="file"
            accept=".csv"
            ref={fileInputRef}
            className="staff-mgmt__file-input"
            onChange={handleImportCSV}
          />
          <button onClick={() => fileInputRef.current.click()} className="staff-mgmt__btn staff-mgmt__btn--import">
            <Download size={14} /> 匯入 CSV
          </button>
          <button onClick={handleAddStaff} className="staff-mgmt__btn staff-mgmt__btn--add"><Plus size={14} /> 單筆新增</button>
          <button
            onClick={handleSave}
            disabled={!isDirty}
            className={`staff-mgmt__btn--save ${isDirty ? 'staff-mgmt__btn--save-dirty' : 'staff-mgmt__btn--save-clean'}`}
          >
            {isDirty ? <><Save size={14} /> 儲存變更</> : '已同步'}
          </button>
        </div>
      </div>

      {/* ★ 搜尋與快速篩選列 */}
      <div className="staff-mgmt__filter-bar">
        <div className="staff-mgmt__search-wrap">
          <span className="staff-mgmt__search-icon"><Search size={14} /></span>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜尋工號、姓名或 Email..."
            className="staff-mgmt__search-input"
          />
          {searchQuery && (
            <button onClick={() => setSearchQuery('')} className="staff-mgmt__search-clear"><X size={12} /></button>
          )}
        </div>
        <div className="staff-mgmt__filter-group">
          <button
            onClick={() => setFilterStatus('all')}
            className={`staff-mgmt__filter-btn${filterStatus === 'all' ? ' staff-mgmt__filter-btn--active' : ''}`}
          >
            全部 ({localStaff.length})
          </button>
          <button
            onClick={() => setFilterStatus('active')}
            className={`staff-mgmt__filter-btn${filterStatus === 'active' ? ' staff-mgmt__filter-btn--active' : ''}`}
          >
            在職 ({activeCount})
          </button>
          <button
            onClick={() => setFilterStatus('inactive')}
            className={`staff-mgmt__filter-btn${filterStatus === 'inactive' ? ' staff-mgmt__filter-btn--active' : ''}`}
          >
            離職 ({inactiveCount})
          </button>
        </div>
        {searchQuery && (
          <span className="staff-mgmt__filter-result">找到 {filteredStaff.length} 筆</span>
        )}
      </div>

      <div className="staff-mgmt__table-wrapper">
        <table className="staff-mgmt__table">
          <thead className="staff-mgmt__thead">
            <tr>
              {columns.map((col, idx) => (
                <th
                  key={col.key}
                  className={`staff-mgmt__th${idx < STICKY_COUNT ? ' staff-mgmt__th--sticky' : ''}`}
                  style={{
                    minWidth: col.width,
                    ...(idx < STICKY_COUNT ? { position: 'sticky', left: `${getStickyLeft(idx)}px`, zIndex: 3 } : {})
                  }}
                >
                  {col.label}
                </th>
              ))}
              <th className="staff-mgmt__th--actions">操作</th>
            </tr>
          </thead>
          <tbody>
            {filteredStaff.map((staff) => (
              <tr key={staff.staff_id} className={`staff-mgmt__row${!staff.is_active ? ' staff-mgmt__row--inactive' : ''}`}>
                {columns.map((col, idx) => (
                  <td
                    key={col.key}
                    className={`staff-mgmt__td${idx < STICKY_COUNT ? ' staff-mgmt__td--sticky' : ''}`}
                    style={idx < STICKY_COUNT ? { position: 'sticky', left: `${getStickyLeft(idx)}px`, zIndex: 1 } : undefined}
                  >
                    {col.type === 'avatar' ? (
                      staff.avatar ? (
                        <img src={staff.avatar} alt={`${staff.name || staff.staff_id} 頭貼`} className="staff-mgmt__avatar" />
                      ) : (
                        <div className="staff-mgmt__avatar staff-mgmt__avatar--fallback">
                          {(staff.name || staff.staff_id || '?').trim().charAt(0).toUpperCase()}
                        </div>
                      )
                    ) : col.readOnly ? (
                      <span className="staff-mgmt__readonly">{staff[col.key]}</span>
                    ) : col.type === 'checkbox' ? (
                      <label className="staff-mgmt__toggle">
                        <input type="checkbox" checked={staff[col.key] === true || staff[col.key] === 'True'} onChange={(e) => handleChange(staff.staff_id, col.key, e.target.checked)} className="staff-mgmt__toggle-input" />
                        <span className="staff-mgmt__toggle-slider"></span>
                      </label>
                    ) : col.type === 'select' ? (
                      <select value={staff[col.key] || ''} onChange={(e) => handleChange(staff.staff_id, col.key, e.target.value)} className="staff-mgmt__select">{col.options.map(opt => <option key={opt} value={opt}>{opt === 'None' ? '--' : opt}</option>)}</select>
                    ) : col.type === 'encrypted' ? (
                      <EncryptedField
                        value={staff[col.key]}
                        target={{ kind: 'staff', id: staff.staff_id }}
                        fieldName={col.key}
                        kind={col.encryptedKind || 'text'}
                        onSave={(blobOrEmpty) => handleChange(staff.staff_id, col.key, blobOrEmpty)}
                      />
                    ) : col.type === 'streak_display' ? (
                      (() => {
                        // prevMonthLeave 按日期順序儲存：idx0=倒數第7天, idx6=最後一天
                        // 從尾端(最後一天)往前數，遇到休假或沒資料就停止
                        const leaves = staff[col.key];
                        // 沒有 prevMonthLeave 資料（未同步）→ 當作 0 天
                        let streak = 0;
                        if (Array.isArray(leaves) && leaves.length > 0) {
                          for (let i = 6; i >= 0; i--) {
                            if (leaves[i] !== false) break; // 只有明確 false（上班）才繼續，其餘（true休假/undefined未知）都停止
                            streak++;
                          }
                        }
                        const isWarning = streak >= 6;
                        const isAlert = streak >= 5;
                        return (
                          <div className="staff-mgmt__streak-wrap">
                            <div className={`staff-mgmt__streak-badge ${getStreakClass(isWarning, isAlert)}`}>
                              {streak}天
                            </div>
                            {isWarning && <div className="staff-mgmt__streak-limit"><AlertTriangle size={10} /> 達上限</div>}
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
                  <button onClick={() => handleResetPassword(staff.staff_id, staff.name)} className="staff-mgmt__icon-btn staff-mgmt__icon-btn--reset" title="寄送密碼重設信"><KeyRound size={16} /></button>
                  <button onClick={() => handleDelete(staff.staff_id, staff.name)} className="staff-mgmt__icon-btn staff-mgmt__icon-btn--delete" title="永久離職（歸檔頭貼 + 停用帳號 + 寫稽核）"><Trash2 size={16} /></button>
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
