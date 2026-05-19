import React, { useState, useEffect, useRef } from 'react';
import { Banknote, FileDown, Settings, X, Lock, Unlock, Save, Loader2 } from 'lucide-react';
import { auth, updateStaffSchedule, saveArchiveReport, backupScheduleToArchive, saveGlobalSettings } from '../api/database';
import { decryptField, encryptFieldRemote, logRelock } from '../api/secureField';
import { checkLaborLawCompliance, checkSkillMixSafety, calculateScheduleRisks } from '../constants';
import './ScheduleReviewPanel.css';

const ScheduleReviewPanel = ({
  staffData, setStaffData,
  shiftOptions,
  publicHolidays = [],
  onUpdateHealthStats,
  baseSalary, setBaseSalary, // 明文（已解鎖時為數字，未解鎖時為 null）
  baseSalaryEnc,             // 來自雲端的密文 blob
  // ★ 接收專屬的歷史狀態
  setHistorySchedule,
  historyYear, historyMonth, setHistoryYear, setHistoryMonth,
    historySchedule = {},
    levelBonus = { N0: 0, N1: 1000, N2: 2000, N3: 3200, N4: 5000 },
}) => {
  // 底薪加密欄位的本地狀態
  const [salaryBusy, setSalaryBusy] = useState(false);
  const [salaryErr, setSalaryErr] = useState(null);

  // Auto-relock：底薪解鎖後 60 秒無操作即自動上鎖，與 <EncryptedField> 30s 行為對齊。
  // 因為底薪是可編輯欄位（用戶可能要輸入數字），給予比唯讀解密欄位較寬鬆的 60s。
  const RELOCK_MS = 60_000;
  const relockTimerRef = useRef(null);
  const scheduleRelock = () => {
    if (relockTimerRef.current) clearTimeout(relockTimerRef.current);
    if (!baseSalaryEnc) return; // 從未加密過的純文字不需鎖
    relockTimerRef.current = setTimeout(() => {
      setBaseSalary(null);
      relockTimerRef.current = null;
      // 自動鎖回也要寫稽核 — 留下「閒置 60 秒被系統收回」的軌跡
      logRelock(
        { kind: 'settings', id: null },
        ['baseSalary'],
        { trigger: 'auto-idle', idleMs: RELOCK_MS }
      ).catch(err => console.warn('relock 稽核寫入失敗:', err));
    }, RELOCK_MS);
  };

  useEffect(() => {
    // 只在「已解鎖」狀態下啟動計時；組件卸載 / state 變動時清掉舊計時器
    if (baseSalary !== null && baseSalaryEnc) scheduleRelock();
    return () => {
      if (relockTimerRef.current) {
        clearTimeout(relockTimerRef.current);
        relockTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseSalary, baseSalaryEnc]);

  const handleUnlockBaseSalary = async () => {
    if (!baseSalaryEnc) return;
    setSalaryBusy(true); setSalaryErr(null);
    try {
      const v = await decryptField(baseSalaryEnc, { kind: 'settings', id: null }, ['baseSalary']);
      setBaseSalary(Number(v) || 0);
    } catch (e) {
      setSalaryErr(e.message);
    } finally {
      setSalaryBusy(false);
    }
  };

  const handleLockBaseSalary = () => {
    if (relockTimerRef.current) { clearTimeout(relockTimerRef.current); relockTimerRef.current = null; }
    setBaseSalary(null);
    // 手動上鎖也寫稽核 — 跟 auto-idle 用 trigger 區分
    logRelock(
      { kind: 'settings', id: null },
      ['baseSalary'],
      { trigger: 'manual' }
    ).catch(err => console.warn('relock 稽核寫入失敗:', err));
  };

  const handleSaveBaseSalary = async () => {
    if (typeof baseSalary !== 'number' || Number.isNaN(baseSalary)) return;
    setSalaryBusy(true); setSalaryErr(null);
    try {
      const blob = await encryptFieldRemote(Number(baseSalary), { kind: 'settings', id: null }, ['baseSalary']);
      await saveGlobalSettings({ baseSalary: blob });
      // onSnapshot 會自動把 baseSalaryEnc 更新；本地 baseSalary 留著（仍解鎖中）
      // 儲存成功 = 用戶在用，延長一輪解鎖時間
      scheduleRelock();
    } catch (e) {
      setSalaryErr(e.message);
    } finally {
      setSalaryBusy(false);
    }
  };
    // ★ 加這兩行防呆，避免 undefined 傳進來導致 NaN crash
  const safeYear  = historyYear  || new Date().getFullYear();
  const safeMonth = historyMonth || (new Date().getMonth() === 0 ? 12 : new Date().getMonth());
  const daysInMonth = new Date(safeYear, safeMonth, 0).getDate();
  const daysArray = Array.from({length: daysInMonth}, (_,i)=>i+1);

 const [showSettlement, setShowSettlement] = useState(false);
  const [closingSettlement, setClosingSettlement] = useState(false);

  const closeSettlementAnimated = () => {
    setClosingSettlement(true);
    setTimeout(() => { setShowSettlement(false); setClosingSettlement(false); }, 300);
  };

  // ★★★ 自動同步：結算月份變更且班表載入後，靜默更新員工 prevMonthLeave ★★★
  // 用 ref 記錄「上次已同步的月份」，避免重複覆蓋
  const lastSyncedMonthRef = useRef(null);

  useEffect(() => {
    if (!historySchedule || Object.keys(historySchedule).length === 0) return;
    if (!setStaffData) return;

    const monthKey = `${historyYear}-${historyMonth}`;
    // 同一個月份已同步過就不重複執行
    if (lastSyncedMonthRef.current === monthKey) return;
    lastSyncedMonthRef.current = monthKey;

    const daysInThisMonth = new Date(historyYear, historyMonth, 0).getDate();
    // 按日期順序存：idx0=倒數第7天, idx6=月底最後一天
    const last7Days = Array.from({ length: 7 }, (_, i) => daysInThisMonth - 6 + i);

    const isLeaveShift = (shift) => {
      if (!shift) return true;
      const s = typeof shift === 'object' ? (shift?.type || 'OFF') : shift;
      return ['OFF', 'RG', 'RC', '事假', '病假', '特休'].includes(s);
    };

    setStaffData(prevData =>
      prevData.map(staff => {
        // Step 1: 先清空（避免舊資料殘留）
        const cleared = { ...staff, prevMonthLeave: null };
        // Step 2: 只有在 historySchedule 裡有這位員工的班表才寫入
        const staffSchedule = historySchedule[staff.staff_id];
        if (!staffSchedule) return cleared;
        const newPrevMonthLeave = last7Days.map(day => isLeaveShift(staffSchedule[day]));
        return { ...cleared, prevMonthLeave: newPrevMonthLeave };
      })
    );
  }, [historySchedule, historyYear, historyMonth]);

  // -- 健康度評分引擎 --
  const calculateHealthScore = (staffSchedule) => {
      let score = 100;
      const deductions = [];
      const shifts = []; 
      for (let d = 1; d <= daysInMonth; d++) {
          const cell = staffSchedule[d];
          shifts.push((typeof cell === 'object') ? (cell?.type || 'OFF') : (cell || 'OFF'));
      }
      const isWork = (s) => ['D', 'E', 'N', '支援'].includes(s) || (s && s.includes('OT'));
      const isOff = (s) => ['OFF', 'RG', 'RC', '事假', '病假', '特休'].includes(s);

      for (let i = 0; i < shifts.length - 1; i++) {
          if ((shifts[i] === 'E' && shifts[i+1] === 'D') || (shifts[i] === 'N' && (shifts[i+1] === 'D' || shifts[i+1] === 'E'))) { score -= 20; deductions.push(`[-20] 短間隔`); }
      }
      let lastWork = null;
      for (let i = 0; i < shifts.length; i++) {
          if (isWork(shifts[i])) {
              if (lastWork === 'N' && shifts[i] === 'E') { score -= 10; deductions.push(`[-10] 逆時鐘 N接E`); }
              if (lastWork === 'E' && shifts[i] === 'D') { score -= 10; deductions.push(`[-10] 逆時鐘 E接D`); }
              lastWork = shifts[i];
          }
      }
      for (let i = 0; i <= shifts.length - 7; i++) {
          const window = shifts.slice(i, i + 7);
          const workTypes = new Set(window.filter(s => ['D', 'E', 'N'].includes(s)));
          if (workTypes.size === 3) { score -= 15; deductions.push(`[-15] 花花班`); i += 6; }
      }
      let consecutiveN = 0, consecutiveWork = 0;
      for (let i = 0; i <= shifts.length; i++) {
          const s = shifts[i];
          if (s === 'N') consecutiveN++; else { if (consecutiveN >= 4) { score -= 5; deductions.push(`[-5] 連續大夜過長`); } consecutiveN = 0; }
          if (s && isWork(s)) consecutiveWork++; else { if (consecutiveWork >= 6) { score -= 5; deductions.push(`[-5] 連六疲勞`); } consecutiveWork = 0; }
      }
      for (let i = 1; i < shifts.length - 1; i++) {
          if (isWork(shifts[i-1]) && isOff(shifts[i]) && isWork(shifts[i+1])) {
              score -= 5; deductions.push(`[-5] 孤立休假`);
              if (shifts[i-1] === 'N') { score -= 15; deductions.push(`[-15] 大夜後無連休`); }
          }
      }
      let hasFullWeekendOff = false;
      for (let d = 1; d <= daysInMonth; d++) {
          const date = new Date(safeYear, safeMonth - 1, d);
          if (date.getDay() === 6 && d < daysInMonth) { if (isOff(shifts[d-1]) && isOff(shifts[d])) { hasFullWeekendOff = true; break; } }
      }
      if (!hasFullWeekendOff) { score -= 5; deductions.push(`[-5] 週末零休假`); }

      return { score, deductions };
  };

  const handleOpenSettlement = () => {
      // 底薪為加密未解鎖時，攔阻：避免薪資全部結算為 0 卻不知為何
      if (baseSalary === null && baseSalaryEnc) {
        alert('⚠️ 底薪為加密狀態，請先點擊「🔒 解鎖」後再執行結算。');
        return;
      }
      const scores = [];
      Object.keys(historySchedule).forEach(rowId => {
          if (!rowId.startsWith('D')) {
             const { score } = calculateHealthScore(historySchedule[rowId]);
             scores.push(score);
          }
      });
      let avg = 0, median = 0;
      if (scores.length > 0) {
          avg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
          scores.sort((a, b) => a - b);
          const mid = Math.floor(scores.length / 2);
          median = scores.length % 2 !== 0 ? scores[mid] : Math.round((scores[mid - 1] + scores[mid]) / 2);
      }
      if (onUpdateHealthStats) onUpdateHealthStats(historyYear, historyMonth, avg, median);
      setShowSettlement(true);
  };

  
const handleCellChange = async (staffId, day, newValue) => {
      // === RG 絕對防護罩 (針對 historySchedule) ===
      const currentCell = historySchedule[staffId]?.[day];
      const currentValue = (typeof currentCell === 'object') ? currentCell?.type : currentCell;
      const workShifts = ['D', 'E', 'N', '支援', 'OT']; 
      if (currentValue === 'RG' && workShifts.some(shift => newValue.includes(shift))) {
          alert('🚨 勞基法天條攔截：\n「例假 (RG)」絕對禁止出勤！\n\n系統已強制阻擋您將 RG 變更為上班班別。');
          return; 
      }
      // =========================================

 const newSchedule = JSON.parse(JSON.stringify(historySchedule));
      if (!newSchedule[staffId]) newSchedule[staffId] = {};
      newSchedule[staffId][day] = { ...(typeof newSchedule[staffId][day] === 'object' ? newSchedule[staffId][day] : {}), type: newValue };
      setHistorySchedule(newSchedule);

      // 同步寫入 Firebase 雲端
      try {
          await updateStaffSchedule(historyYear, historyMonth, newSchedule);
          // ★★★ 關鍵修復：同時強制覆蓋大數據封存庫，讓統計報表能瞬間抓到最新數值！ ★★★
          await backupScheduleToArchive(historyYear, historyMonth, newSchedule, "手動修改歷史班表自動同步");
      } catch (e) {
          console.error("同步歷史班表失敗", e);
      }
  };

  // --- 抓取結算數據 ---
  const getSettlementData = () => {
      const data = [];
      const currentBaseSalary = Number(baseSalary) || 0; 
      const dailyWage = Math.round(currentBaseSalary / 30);
      const hourlyWage = Math.round(dailyWage / 8); 

      Object.keys(historySchedule || {}).forEach(rowId => {
          if (rowId.startsWith('D')) return; 
          const staff = staffData.find(s => s.staff_id === rowId);
          const name = (staff && staff.name && staff.name.trim() !== '') ? staff.name : '未知姓名'; 
          
          let workDays = 0, nationalHolidayWorkDays = 0, explicitOtDays = 0; 
          let personalLeaveDays = 0, sickLeaveDays = 0;
          let nightShiftsCount = 0;

          for (let d = 1; d <= daysInMonth; d++) {
              const cell = historySchedule[rowId]?.[d];
              const type = (typeof cell === 'object') ? cell.type : (cell || 'OFF');
              const dateStr = `${historyYear}${String(historyMonth).padStart(2, '0')}${String(d).padStart(2, '0')}`;
              const isNationalHoliday = publicHolidays.includes(dateStr);

              if (['D', 'E', 'N', '支援'].includes(type)) {
                  workDays++;
                  if (isNationalHoliday) nationalHolidayWorkDays++;
                  if (type === 'N') nightShiftsCount++;
              }
              else if (type.includes('(OT)')) explicitOtDays++;
              else if (type === '事假') personalLeaveDays++;
              else if (type === '病假') sickLeaveDays++;
          }

          const nationalHolidayPay = nationalHolidayWorkDays * (hourlyWage * 8);
          const regularWorkDays = workDays - nationalHolidayWorkDays;
          const standardWorkDays = daysInMonth - 8;
          const overStandardDays = Math.max(0, regularWorkDays - standardWorkDays);
          const totalRestOtDays = overStandardDays + explicitOtDays;
          const restDayOtPayPerDay = Math.round((hourlyWage * 1.34 * 2) + (hourlyWage * 1.67 * 6));
const restDayOtPay = totalRestOtDays * restDayOtPayPerDay;
          const totalOtPay = restDayOtPay + nationalHolidayPay;
          const deduction = Math.round((personalLeaveDays * dailyWage) + (sickLeaveDays * dailyWage * 0.5));
          
          // ★★★ 新增：大夜班 40% 加給 (日薪 * 40% * 大夜天數) ★★★
          const nightShiftBonus = Math.round(dailyWage * 0.4 * nightShiftsCount);

          // ★ 進階加給 (依職級 N0-N4)
          const staffLevel = staff?.level || 'N0';
          const levelBonusAmount = Number(levelBonus[staffLevel]) || 0;

          // ★ 最終薪水把大夜獎金 + 進階加給加進去
          const finalSalary = currentBaseSalary + totalOtPay + nightShiftBonus + levelBonusAmount - deduction;

          data.push({
              staff_id: rowId, name, avatar_thumb: staff?.avatar_thumb || null, baseSalary: currentBaseSalary, hourlyWage, dailyWage,
              workDays: workDays + explicitOtDays, standardWorkDays, otDays: totalRestOtDays,
              nightShiftsCount, nightShiftBonus,
              staffLevel, levelBonusAmount, // 👈 匯出職級加給
              restDayOtPay, nationalHolidayWorkDays, nationalHolidayPay, totalOtPay,
              personalLeaveDays, sickLeaveDays, deduction, totalSalary: finalSalary
          });
      });
      return data;
  };

  // ★★★ 核心新增：差額帳本寫入引擎 ★★★
  const handleConfirmSettlement = () => {
      if (!window.confirm(`⚠️ 確定要將 ${historyYear}年${historyMonth}月 的數據正式寫入員工帳戶嗎？\n\n系統將自動派發「積假 (OT)」與「夜班結餘」，\n並具備防呆機制，若本月重複結算不會導致無限累加，也不會覆蓋您在員工頁面手動微調的基準值。`)) return;

      const currentSettlement = getSettlementData();
      const monthKey = `${historyYear}-${String(historyMonth).padStart(2, '0')}`; 

      if (setStaffData) {
          setStaffData(prevData => {
              return prevData.map(staff => {
                  const sData = currentSettlement.find(s => s.staff_id === staff.staff_id);
                  if (!sData) return staff; 

            const newHistory = { ...(staff.settlement_history || {}) };
                  const oldRecord = newHistory[monthKey] || { ot: 0, night: 0, annual: 0 };

                  const otDiff = sData.otDays - oldRecord.ot;
                  const nightDiff = sData.nightShiftsCount - oldRecord.night;
                  const annualDiff = (sData.annualLeaveDays || 0) - (oldRecord.annual || 0); // ★ 算出本次結算多請了幾天特休

                  newHistory[monthKey] = {
                      ot: sData.otDays,
                      night: sData.nightShiftsCount,
                      annual: sData.annualLeaveDays || 0 // ★ 紀錄本月扣了幾天
                  };

                  return {
                      ...staff,
                      settlement_history: newHistory,
                      accumulated_ot: (Number(staff.accumulated_ot) || 0) + otDiff,
                      night_shift_balance: (Number(staff.night_shift_balance) || 0) + nightDiff,
                      annual_leave_used: (Number(staff.annual_leave_used) || 0) + annualDiff // ★ 正式扣除特休額度
                  };
              });
          });
      }

      alert(`✅ ${historyYear}年${historyMonth}月 結算完成！\n已成功將 ${currentSettlement.length} 位員工的 OT 與夜班數派發至帳戶餘額。`);
      closeSettlementAnimated();
  };

const handleExportExcel = async () => {
    if (!historySchedule || Object.keys(historySchedule).length === 0) return alert("無資料可匯出");
    
    // 1. 先取得當月所有的薪資結算數據
    const settlementData = getSettlementData();
    
    // 2. 新增 Excel 表頭欄位
    let csv = "\uFEFF工號,姓名,";
    for (let d = 1; d <= daysInMonth; d++) csv += `${d}號,`;
    csv += "健康度評分,總工時(天),國定假日出勤(天),夜班總數,總加班費(元),積假派發(天),事假(天),病假(天),扣薪(元),預估總薪資(元)\n"; 

    Object.keys(historySchedule).sort((a, b) => {
        const aIsVirtual = a.startsWith('D'), bIsVirtual = b.startsWith('D');
        if (aIsVirtual && !bIsVirtual) return 1; 
        if (!aIsVirtual && bIsVirtual) return -1;
        return a.localeCompare(b);
    }).forEach(rowId => {
        const realStaff = staffData.find(s => s.staff_id === rowId);
        const name = realStaff ? realStaff.name : "待認領";
        const { score } = calculateHealthScore(historySchedule[rowId]);
        
        let row = `${rowId},${name},`;
        for (let d = 1; d <= daysInMonth; d++) {
            const cell = historySchedule[rowId]?.[d];
            const type = (typeof cell === 'object' ? cell.type : cell) || '';
            row += `${type},`;
        }
        
        // 3. 抓取該員工的對應薪水數據
        let extraCols = ",,,,,,,,,"; 
        if (!rowId.startsWith('D')) {
            const sData = settlementData.find(s => s.staff_id === rowId);
            if (sData) {
                extraCols = `,${sData.workDays},${sData.nationalHolidayWorkDays},${sData.nightShiftsCount},${sData.totalOtPay},${sData.otDays},${sData.personalLeaveDays},${sData.sickLeaveDays},${sData.deduction},${sData.totalSalary}`;
            }
        }

        // 把結算資料接在最後面
        row += `${score}${extraCols}`; 
        csv += row + "\n";
    });

    // 4. 將 CSV 正式上傳至 Firebase 雲端伺服器
    try {
        await saveArchiveReport(historyYear, historyMonth, csv);
    } catch (e) {
        console.error("上傳報表至伺服器失敗:", e);
    }

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${historyYear}年${historyMonth}月_結算歷史班表與薪資.csv`;
    link.click();
    
    alert(`✅ Excel 已下載！\n\n系統已在背景將 ${historyYear}年${historyMonth}月 的數據【永久備份至雲端】。\n即使關閉網頁，AI 日後依然能讀取此月份進行跨月分析！`);
  };
  // ★★★ 新增：針對「歷史紀錄區」專用的法遵與壓力風險計算 ★★★
  const historyViolations = historySchedule && Object.keys(historySchedule).length > 0 ? 
      [...checkLaborLawCompliance(historySchedule, staffData, [], historyYear, historyMonth), ...checkSkillMixSafety(historySchedule, staffData, historyYear, historyMonth)] : [];
      
  const historyRisks = historySchedule && Object.keys(historySchedule).length > 0 ? 
      calculateScheduleRisks(historySchedule, staffData, publicHolidays, historyYear, historyMonth) : [];
        // ★★★ 隱藏版功能：開發者時光機 (手動觸發自動結算 API) ★★★
  const handleTestAutoSettle = async () => {
      const testDate = window.prompt(
          "【開發者時光機測試】\n請輸入您想穿越到的日期 (格式 YYYY-MM-DD)，例如 2026-02-28。\n\n💡 若留空並直接按「確定」，系統將【強制結算】本月班表：", 
          ""
      );
      
      if (testDate === null) return; // 使用者按了取消

      try {
          // 判斷要帶入哪種參數
          const url = testDate.trim() !== '' 
              ? `/api/auto-settle?targetDate=${testDate}` 
              : '/api/auto-settle?force=true';
          
          const idToken = await auth.currentUser.getIdToken();
          const response = await fetch(url, {
              headers: { 'Authorization': `Bearer ${idToken}` }
          });
          const data = await response.json();
          
          if (response.ok) {
              alert(`✅ API 執行成功！\n\n伺服器回應：${data.message}`);
          } else {
              alert(`❌ API 執行失敗！\n\n錯誤：${data.error}\n詳細：${data.details || '無'}`);
          }
      } catch (error) {
          alert(`❌ 網路連線異常：${error.message}`);
      }
  };

return (
    <div className="review">

      {/* ▼▼▼ 這是全新替換的頂部區塊 (已拔除下拉選單，改為純文字標籤) ▼▼▼ */}
      <div className="review__header">
           <div className="review__header-left">
               <h2 className="review__title">✅ 結算與歷史大帳本</h2>

{/* ★★★ 修改為：可切換年月選項的控制器 ★★★ */}
               <div className="review__archive-selector">
                   <span className="review__archive-label">📂 封存檔案：</span>
                   <input
                       type="number"
                       value={historyYear}
                       onChange={(e) => setHistoryYear(Number(e.target.value))}
                       className="review__year-input"
                   />
                   <span className="review__year-separator">年</span>
                   <select
                       value={historyMonth}
                       onChange={(e) => setHistoryMonth(Number(e.target.value))}
                       className="review__month-select"
                   >
                       {Array.from({length: 12}, (_, i) => i + 1).map(m => (
                           <option key={m} value={m}>{m}</option>
                       ))}
                   </select>
                   <span className="review__month-separator">月</span>
               </div>
           </div>

<div className="review__toolbar">
              {/* ★ 加密底薪欄位：未解鎖→顯示鎖；已解鎖→可編輯 + 加密儲存 ★ */}
              <div className="review__salary-field">
                  <span className="review__salary-label">
                    {baseSalaryEnc ? <Lock size={11} /> : null} 預設底薪:
                  </span>
                  {baseSalary === null && baseSalaryEnc ? (
                    <button
                      onClick={handleUnlockBaseSalary}
                      disabled={salaryBusy}
                      className="review__salary-unlock"
                      title="解鎖檢視底薪（會記錄到稽核日誌）"
                    >
                      {salaryBusy ? <Loader2 size={12} className="review__salary-spin" /> : <Unlock size={12} />}
                      已加密 — 點此解鎖
                    </button>
                  ) : (
                    <>
                      <input
                          type="number"
                          value={baseSalary ?? ''}
                          onChange={(e) => setBaseSalary(Number(e.target.value))}
                          className="review__salary-input"
                          title="此底薪將用於計算加班費與請假扣薪。修改後請按💾 儲存以加密寫入雲端。閒置 60 秒會自動上鎖。"
                      />
                      <button
                        onClick={handleSaveBaseSalary}
                        disabled={salaryBusy || typeof baseSalary !== 'number'}
                        className="review__salary-save"
                        title="加密寫入雲端"
                      >
                        {salaryBusy ? <Loader2 size={12} className="review__salary-spin" /> : <Save size={12} />} 儲存
                      </button>
                      {baseSalaryEnc && (
                        <button
                          onClick={handleLockBaseSalary}
                          disabled={salaryBusy}
                          className="review__salary-relock"
                          title="立即上鎖（不等 60 秒自動鎖）"
                        >
                          <Lock size={12} /> 上鎖
                        </button>
                      )}
                    </>
                  )}
                  {salaryErr && <span className="review__salary-err">{salaryErr}</span>}
              </div>

              <button onClick={handleOpenSettlement} className="review__btn review__btn--settle"><Banknote size={14} /> 薪資與加班費結算</button>
              <button onClick={handleExportExcel} className="review__btn review__btn--export"><FileDown size={14} /> 匯出 Excel</button>
              {import.meta.env.DEV && <button onClick={handleTestAutoSettle} className="review__btn review__btn--test-api" title="開發者測試專用"><Settings size={14} /> 測試 API</button>}
           </div>
      </div>
      {/* ▲▲▲ 頂部區塊結束 ▲▲▲ */}


      {showSettlement && (
          <div
              className={`review__modal-overlay${closingSettlement ? ' review__modal-overlay--closing' : ''}`}
              onClick={(e) => { if (e.target === e.currentTarget) closeSettlementAnimated(); }}
              role="button"
              tabIndex={-1}
              aria-label="點空白處關閉"
          >
              <div className={`review__modal-content${closingSettlement ? ' review__modal-content--closing' : ''}`}>
                  <button onClick={closeSettlementAnimated} className="review__modal-close"><X size={14} /></button>
                  <h2 className="review__modal-title"><Banknote size={20} /> 薪資與加班費結算預覽 ({historyYear}年{historyMonth}月)</h2>

                  <table className="review__settlement-table">
                      <thead className="review__settlement-thead">
                          <tr>
                              <th className="review__settlement-th">員工姓名</th>
                              <th className="review__settlement-th">上班/國定</th>
                              <th className="review__settlement-th--night">夜班總數</th>
                              <th className="review__settlement-th--overtime">加班費 (積假)</th>
                              <th className="review__settlement-th--leave">請假 (事/病)</th>
                              <th className="review__settlement-th--deduction">扣薪</th>
                              <th className="review__settlement-th--salary">預估薪資</th>
                          </tr>
                      </thead>
                      <tbody>
                          {getSettlementData().map(row => (
                              <tr key={row.staff_id} className="review__settlement-row">
                                  <td className="review__settlement-td review__settlement-name">
                                      <div className="review__settlement-name-wrap">
                                          {row.avatar_thumb ? (
                                              <img src={row.avatar_thumb} alt="" className="review__settlement-avatar" />
                                          ) : (
                                              <div className="review__settlement-avatar review__settlement-avatar--fallback">
                                                  {(row.name || row.staff_id).charAt(0).toUpperCase()}
                                              </div>
                                          )}
                                          <div>
                                              <div>{row.name}</div>
                                              <div className="review__settlement-id">({row.staff_id})</div>
                                          </div>
                                      </div>
                                  </td>
                                  <td className="review__settlement-td review__settlement-work">
                                      <div>總工時: {row.workDays} 天</div>
                                      {row.nationalHolidayWorkDays > 0 && <div className="review__settlement-holiday">含國定: {row.nationalHolidayWorkDays}天</div>}
                                  </td>
                                  <td className="review__settlement-td" style={{ color: '#8e44ad' }}>
                                      <div className="review__settlement-night-count">{row.nightShiftsCount} 班</div>
                                      {/* ★ 顯示 40% 換算出來的獎金 */ }
                                      {row.nightShiftBonus > 0 && <div className="review__settlement-night-bonus">津貼: +${row.nightShiftBonus.toLocaleString()}</div>}
                                  </td>
                                  <td className="review__settlement-td" style={{ color: row.totalOtPay > 0 ? '#e74c3c' : '#ccc', fontWeight: 'bold' }}>
                                      NT$ {row.totalOtPay.toLocaleString()}
                                      {row.otDays > 0 && <div className="review__settlement-ot-detail">積假派發: +{row.otDays}天</div>}
                                  </td>
                                  <td className="review__settlement-td" style={{ color: (row.personalLeaveDays + row.sickLeaveDays) > 0 ? '#555' : '#ccc' }}>
                                      {row.personalLeaveDays > 0 && <div>事假: {row.personalLeaveDays}天</div>}
                                      {row.sickLeaveDays > 0 && <div>病假: {row.sickLeaveDays}天</div>}
                                      {(row.personalLeaveDays === 0 && row.sickLeaveDays === 0) && '-'}
                                  </td>
                                  <td className="review__settlement-td" style={{ color: row.deduction > 0 ? 'red' : '#ccc' }}>{row.deduction > 0 ? `- $${row.deduction.toLocaleString()}` : '-'}</td>
                                  <td className="review__settlement-td review__settlement-salary">
                                      NT$ {row.totalSalary.toLocaleString()}
                                      {row.levelBonusAmount > 0 && <div className="review__settlement-level-bonus">(含 {row.staffLevel} 進階加給 +${row.levelBonusAmount.toLocaleString()})</div>}
                                  </td>
                              </tr>
                          ))}
                          {getSettlementData().length === 0 && <tr><td colSpan="7" className="review__settlement-empty">尚無已認領的員工資料</td></tr>}
                      </tbody>
                  </table>

                  <div className="review__settlement-confirm">
                      <div className="review__settlement-confirm-hint">確認預覽無誤後，可點擊下方按鈕將數據派發至每位員工的「積假與夜班餘額」中。</div>
                      <button onClick={handleConfirmSettlement} className="review__settlement-confirm-btn">
                          💾 確認無誤，正式寫入員工帳本
                      </button>
                      <div className="review__settlement-confirm-warning">⚠️ 智慧防呆：重複點擊只會更新當月差額，不會造成數據無限膨脹或覆蓋您手動微調的基準值。</div>
                  </div>

              </div>
          </div>
      )}


   <div className="review__body">

          {/* 左側：班表主視窗 (改成 flex: 3 以預留空間給右側) */}
          <div className="review__table-wrapper">
            <div className="review__table-scroll">
              {historySchedule && Object.keys(historySchedule).length > 0 ? (
                <table className="review__table">
                    <thead>
                        <tr className="review__table-header-row">
                            <th className="review__table-th-name">員工指派</th>
                            <th className="review__table-th-health">健康度</th>
                            {daysArray.map(d => {
                                const dayOfWeek = new Date(historyYear, historyMonth - 1, d).getDay();
                                const dayStrs = ['日', '一', '二', '三', '四', '五', '六'];
                                const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
                                const dateStr = `${historyYear}${String(historyMonth).padStart(2, '0')}${String(d).padStart(2, '0')}`;
                                const isNationalHoliday = publicHolidays.includes(dateStr);
                                return (
                                    <th key={d} className={`review__table-th-day${isNationalHoliday ? ' review__table-th-day--holiday' : isWeekend ? ' review__table-th-day--weekend' : ''}`}>
                                        <div className="review__table-day-number">{d}</div>
                                        <div className="review__table-day-label">{isNationalHoliday ? '國假' : dayStrs[dayOfWeek]}</div>
                                    </th>
                                )
                            })}
                        </tr>
                    </thead>
                    <tbody>
                        {Object.keys(historySchedule).sort((a, b) => {
                            const aIsVirtual = a.startsWith('D'), bIsVirtual = b.startsWith('D');
                            if (aIsVirtual && !bIsVirtual) return 1; if (!aIsVirtual && bIsVirtual) return -1;
                            return a.localeCompare(b);
                        }).map(rowId => {
                            const isVirtual = rowId.startsWith('D');
                            const staffRow = !isVirtual ? staffData.find(s => s.staff_id === rowId) : null;
                            const displayName = isVirtual ? '🎲 待認領' : (staffRow?.name || rowId);
                            const { score, deductions } = calculateHealthScore(historySchedule[rowId]);
                            const scoreColor = score >= 90 ? '#27ae60' : (score >= 75 ? '#f39c12' : '#c0392b');

                            return (
                                <tr key={rowId} className={`review__table-row${isVirtual ? ' review__table-row--virtual' : ''}`}>
                                    <td className={`review__table-td-name${isVirtual ? ' review__table-td-name--virtual' : ''}`}>
                                       <div className="review__table-staff-wrap">
                                           {!isVirtual && (
                                               staffRow?.avatar_thumb ? (
                                                   <img src={staffRow.avatar_thumb} alt="" className="review__table-staff-avatar" />
                                               ) : (
                                                   <div className="review__table-staff-avatar review__table-staff-avatar--fallback">
                                                       {(staffRow?.name || rowId).charAt(0).toUpperCase()}
                                                   </div>
                                               )
                                           )}
                                           <div className={`review__table-staff-name${isVirtual ? ' review__table-staff-name--virtual' : ''}`}>{displayName}</div>
                                       </div>
                                    </td>
                                    <td className={`review__table-td-health${isVirtual ? ' review__table-td-health--bg-virtual' : ' review__table-td-health--bg-default'}`} style={{ color: scoreColor }} title={deductions.length > 0 ? `扣分明細：\n${deductions.join('\n')}` : '✨ 完美班表！無身心損耗'}>{score}</td>
                                    {daysArray.map(d => {
                                        const cellData = historySchedule[rowId]?.[d];
                                        const type = (typeof cellData === 'object') ? cellData.type : (cellData || '');
                                        const optionInfo = shiftOptions.find(o => o.code === type) || { color: '#fff' };
                                        return (
                                            <td key={d} className="review__table-td-cell">
                                                <select value={type} onChange={(e) => handleCellChange(rowId, d, e.target.value)} className="review__table-cell-select" style={{ background: optionInfo.color }}>
                                                    {shiftOptions.map(opt => <option key={opt.code} value={opt.code} style={{background:'white', color:'black'}}>{opt.code}</option>)}
                                                </select>
                                            </td>
                                        )
                                    })}
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
              ) : <div className="review__table-empty">歷史資料庫尚無該月班表資料</div>}
            </div>
          </div>

          {/* ★★★ 新增右側：法遵與壓力風險監控面板 ★★★ */}
          <div className="review__sidebar">

             <div className="review__violations">
                <h2 className="review__violations-title">⚖️ 法遵檢查結果</h2>
                <div className="review__violations-body">
                   {historyViolations.length === 0 ? <div className="review__violations-ok">✅ 無勞基法違規</div> : (() => {
                     const skillMix = historyViolations.filter(v => v.type === 'SKILL_MIX');
                     const others = historyViolations.filter(v => v.type !== 'SKILL_MIX');
                     const grouped = [];
                     if (skillMix.length > 0) {
                       const byShift = {};
                       skillMix.forEach(v => {
                         const shift = v.message.match(/\[(.+?)\]/)?.[1] || '未知';
                         if (!byShift[shift]) byShift[shift] = [];
                         byShift[shift].push(v.day);
                       });
                       Object.entries(byShift).forEach(([shift, days]) => {
                         grouped.push({ staffName: '⚠️ 臨床安全警告', message: `[${shift}] Day ${days.join(', ')} 全為新人(N0/N1)，無資深人員(N2+)或組長坐鎮！` });
                       });
                     }
                     return (
                       <>
                         {others.map((v, i) => (
                           <div key={i} className="review__violations-item">
                             <div className="review__violations-item-name">{v.staffName}</div>
                             <div className="review__violations-item-msg">Day {v.day}: {v.message}</div>
                           </div>
                         ))}
                         {grouped.map((g, i) => (
                           <div key={`mix-${i}`} className="review__violations-item">
                             <div className="review__violations-item-name">{g.staffName}</div>
                             <div className="review__violations-item-msg">{g.message}</div>
                           </div>
                         ))}
                       </>
                     );
                   })()}
                </div>
             </div>
             <div className="review__risks">
                <h2 className="review__risks-title">⚠️ 壓力風險監控</h2>
                <div className="review__risks-body">
                   {(!historyRisks || historyRisks.length === 0) ? <div className="review__risks-ok">✨ 團隊負荷平均</div> : historyRisks.map((risk, i) => (
                         <div key={i} className="review__risks-item">
                           <div className="review__risks-item-name">{risk.staffName}</div>
                           {risk.tags.map((tag, j) => (<div key={j} className="review__risks-item-tag">- {tag.label}</div>))}
                         </div>
                   ))}
                </div>
             </div>
          </div>

      </div>
    </div>
  );
};

export default ScheduleReviewPanel;
