import React from 'react';
import { Megaphone, AlertTriangle, ArrowRight, Scale, CheckCircle, Sparkles } from 'lucide-react';
import { updateStaffSchedule } from '../api/database';
import './PublishPanel.css';

const PublishPanel = ({
    staffData, violations, scheduleRisks,
    selectedYear, selectedMonth, shiftOptions,
    finalizedSchedule, setFinalizedSchedule, onPushToHistory,
    calculateAndNotifyNextStaff, healthStats,
}) => {
    const daysInMonth = new Date(selectedYear, selectedMonth, 0).getDate();
    const daysArray = Array.from({length: daysInMonth}, (_,i)=>i+1);

        const handleCellChange = async (staffId, day, newValue) => {
        // === RG 絕對防護罩 (針對 finalizedSchedule) ===
        const currentCell = finalizedSchedule[staffId]?.[day];
        const currentValue = (typeof currentCell === 'object') ? currentCell?.type : currentCell;
        const workShifts = ['D', 'E', 'N', '支援', 'OT'];
        if (currentValue === 'RG' && workShifts.some(shift => newValue.includes(shift))) {
            alert('🚨 勞基法天條攔截：\n「例假 (RG)」絕對禁止出勤！\n\n系統已強制阻擋您將 RG 變更為上班班別。');
            return;
        }
const newSchedule = JSON.parse(JSON.stringify(finalizedSchedule));
        if (!newSchedule[staffId]) newSchedule[staffId] = {};
        newSchedule[staffId][day] = { ...(typeof newSchedule[staffId][day] === 'object' ? newSchedule[staffId][day] : {}), type: newValue };
        const previousSchedule = finalizedSchedule;
        setFinalizedSchedule(newSchedule);

      try {
          await updateStaffSchedule(selectedYear, selectedMonth, newSchedule);
      } catch (e) {
          console.error("同步發布班表失敗", e);
          setFinalizedSchedule(previousSchedule);
          alert("❌ 班表更新失敗，已還原變更！");
      }
  };

    // -- 沿用健康度評分引擎 --
    const calculateHealthScore = (staffSchedule) => {
        let score = 100; const deductions = []; const shifts = [];
        for (let d = 1; d <= daysInMonth; d++) {
            const cell = staffSchedule[d];
            shifts.push((typeof cell === 'object') ? (cell?.type || 'OFF') : (cell || 'OFF'));
        }
        const isWork = (s) => ['D', 'E', 'N', '支援'].includes(s) || (s && s.includes('OT'));

        for (let i = 0; i < shifts.length - 1; i++) {
            if ((shifts[i] === 'E' && shifts[i+1] === 'D') || (shifts[i] === 'N' && (shifts[i+1] === 'D' || shifts[i+1] === 'E'))) { score -= 20; deductions.push(`[-20] 短間隔`); }
        }
        let consecutiveN = 0, consecutiveWork = 0;
        for (let i = 0; i <= shifts.length; i++) {
            const s = shifts[i];
            if (s === 'N') consecutiveN++; else { if (consecutiveN >= 4) { score -= 5; deductions.push(`[-5] 連續大夜`); } consecutiveN = 0; }
            if (s && isWork(s)) consecutiveWork++; else { if (consecutiveWork >= 6) { score -= 5; deductions.push(`[-5] 連六疲勞`); } consecutiveWork = 0; }
        }
        return { score, deductions };
    };

// ★★★ 核心邏輯 1：單點拔除名字，轉回待認領 ★★★
    // 👉 加上 async
    const handleUnassignSingleStaff = async (staffId) => {
        const staffName = (staffData || []).find(s => s.staff_id === staffId)?.name || staffId;
        if (!window.confirm(`⚠️ 確定要拔除「${staffName}」的班表嗎？\n\n這將把此排班轉為「待認領 (Dxxx)」空缺，\n員工介面會立刻同步釋出，供其他人重新選擇。`)) return;

        const newSchedule = JSON.parse(JSON.stringify(finalizedSchedule));

        let vIndex = 1; let newVirtualId = '';
        while (true) {
            newVirtualId = `D${String(vIndex).padStart(3, '0')}`;
            if (!newSchedule[newVirtualId]) break;
            vIndex++;
        }

        newSchedule[newVirtualId] = newSchedule[staffId];
        delete newSchedule[staffId];

        const previousSchedule = finalizedSchedule;
        setFinalizedSchedule(newSchedule);

        // 🌟 ★★★ 關鍵修復：強制把拔除後的結果寫入 Firebase 雲端！ ★★★ 🌟
        try {
            await updateStaffSchedule(selectedYear, selectedMonth, newSchedule);
            // 🔁 重新啟動 AI 接力：auto-relay 會自動把幽靈 submittedList 清乾淨並挑下一位
            if (typeof calculateAndNotifyNextStaff === 'function') {
                try {
                    await calculateAndNotifyNextStaff(newSchedule, healthStats, selectedYear, selectedMonth);
                } catch (relayErr) {
                    console.error("拔除後重啟接力失敗:", relayErr);
                }
            }
        } catch (error) {
            console.error("拔除失敗:", error);
            setFinalizedSchedule(previousSchedule);
            alert("❌ 雲端同步失敗，已還原變更！請檢查網路連線！");
        }
    };

    // ★★★ 核心邏輯 2：一鍵拔除所有人 ★★★
    // 👉 加上 async
    const handleUnassignAll = async () => {
        if (!window.confirm(`⚠️ 確定要【拔除所有人】的班表嗎？\n\n這會將目前畫面上所有已認領的班表，全部退回「待認領 (Dxxx)」狀態！\n員工必須重新登入選擇。`)) return;

        const newSchedule = {};
        let vIndex = 1;

        Object.keys(finalizedSchedule).sort().forEach(rowId => {
            const newVirtualId = `D${String(vIndex).padStart(3, '0')}`;
            newSchedule[newVirtualId] = finalizedSchedule[rowId];
            vIndex++;
        });

        const previousSchedule = finalizedSchedule;
        setFinalizedSchedule(newSchedule);

        // 🌟 ★★★ 關鍵修復：強制把拔除後的結果寫入 Firebase 雲端！ ★★★ 🌟
        try {
            await updateStaffSchedule(selectedYear, selectedMonth, newSchedule);
            // 🔁 全部拔除相當於重新開放接力：走 resetRelay 完全清空 SelectionProgress
            if (typeof calculateAndNotifyNextStaff === 'function') {
                try {
                    await calculateAndNotifyNextStaff(newSchedule, healthStats, selectedYear, selectedMonth, null, true);
                } catch (relayErr) {
                    console.error("拔除後重啟接力失敗:", relayErr);
                }
            }
            alert("✅ 所有人員已成功拔除並同步至雲端！");
        } catch (error) {
            console.error("拔除失敗:", error);
            setFinalizedSchedule(previousSchedule);
            alert("❌ 雲端同步失敗，已還原變更！請檢查網路連線！");
        }
    };

    const getScoreClass = (score) => {
        if (score >= 90) return 'publish__score--good';
        if (score >= 75) return 'publish__score--warn';
        return 'publish__score--bad';
    };

 return (
      <div className="publish">

        {/* ▼▼▼ 這是全新替換的頂部區塊 (包含 Push 封存按鈕) ▼▼▼ */}
        <div className="publish__header">
             <div className="publish__header-left">
                 <h2 className="publish__header-title"><Megaphone size={20} /> 當前發布與認領動態</h2>
                 <span className="publish__header-badge">{selectedYear}年 {selectedMonth}月</span>
             </div>

           <div className="publish__header-actions">
                 <button onClick={handleUnassignAll} className="publish__btn publish__btn--unassign-all"><AlertTriangle size={14} /> 全部拔除釋出</button>
                 <button onClick={onPushToHistory} className="publish__btn publish__btn--archive">
                     <ArrowRight size={14} /> 結算並封存至歷史區
                 </button>
             </div>
        </div>
        {/* ▲▲▲ 頂部區塊結束 ▲▲▲ */}


        <div className="publish__content">
            {/* ... 下面的左側班表與右側監控，請保持原本的樣子不要動它 ... */}            {/* 左側：班表主視窗 */}
            <div className="publish__table-wrapper">
              <div className="publish__table-scroll">
                {!finalizedSchedule || Object.keys(finalizedSchedule).length === 0 ? (
                  <div className="publish__empty">尚無發布的班表，請先在「排班工作桌」儲存並發布。</div>
                ) : (
                  <table className="publish__table">
                      <thead className="publish__thead">
                          <tr className="publish__thead-row">
                              <th className="publish__th-staff">員工指派 / 操作</th>
                              <th className="publish__th-health">健康度</th>
                              {daysArray.map(d => (
                                  <th key={d} className="publish__th-day">
                                      <div className="publish__th-day-label">{d}</div>
                                  </th>
                              ))}
                          </tr>
                      </thead>
                     <tbody>
    {Object.keys(finalizedSchedule).sort((a, b) => {
        const aIsVirtual = a.startsWith('D'), bIsVirtual = b.startsWith('D');
        if (aIsVirtual && !bIsVirtual) return 1;
        if (!aIsVirtual && bIsVirtual) return -1;
        return a.localeCompare(b); // 讓 D017, D018, D019 乖乖照數字排好
    }).map(rowId => {
                              const isVirtual = rowId.startsWith('D');
                              const staffRow = !isVirtual ? (staffData || []).find(s => s.staff_id === rowId) : null;
                              const displayName = isVirtual ? '🎲 待認領' : (staffRow?.name || rowId);
                              const { score, deductions } = calculateHealthScore(finalizedSchedule[rowId]);

                              return (
                                  <tr key={rowId} className={`publish__row${isVirtual ? ' publish__row--virtual' : ''}`}>
                                      <td className={`publish__td-staff${isVirtual ? ' publish__td-staff--virtual' : ''}`}>
                                          <div className="publish__staff-info">
                                              {!isVirtual && (
                                                  staffRow?.avatar_thumb ? (
                                                      <img src={staffRow.avatar_thumb} alt="" className="publish__staff-avatar" />
                                                  ) : (
                                                      <div className="publish__staff-avatar publish__staff-avatar--fallback">
                                                          {(staffRow?.name || rowId).charAt(0).toUpperCase()}
                                                      </div>
                                                  )
                                              )}
                                              <div>
                                                  <div className={`publish__staff-name${isVirtual ? ' publish__staff-name--virtual' : ''}`}>{displayName}</div>
                                                  <div className="publish__staff-id">{rowId}</div>
                                              </div>
                                          </div>
                                          {/* ★ 拔除名字按鈕 */}
                                          {!isVirtual && (
                                              <button onClick={() => handleUnassignSingleStaff(rowId)} className="publish__btn--unassign">
                                                  拔除釋出
                                              </button>
                                          )}
                                      </td>
                                      <td className={`publish__td-health ${getScoreClass(score)}`} title={deductions.join('\n')}>{score}</td>
                                     {daysArray.map(d => {
                                          const cellData = finalizedSchedule[rowId]?.[d];
                                          const type = (typeof cellData === 'object') ? cellData.type : (cellData || '');
                                          const optionInfo = shiftOptions.find(o => o.code === type) || { color: '#fff' };
                                          return (
                                              <td key={d} className="publish__td-day">
                                                  <select value={type} onChange={(e) => handleCellChange(rowId, d, e.target.value)} className="publish__day-select" style={{ background: optionInfo.color }}>
                                                      {shiftOptions.map(opt => <option key={opt.code} value={opt.code} className="publish__day-option">{opt.code}</option>)}
                                                  </select>
                                              </td>
                                          )
                                      })}
                                  </tr>
                              );
                          })}
                      </tbody>
                  </table>
                )}
              </div>
            </div>

            {/* 右側：風險與法遵監控 (原封不動從舊版搬過來) */}
            <div className="publish__sidebar">
               <div className="publish__violations">
                  <h2 className="publish__violations-title"><Scale size={18} /> 法遵檢查結果</h2>
                  <div className="publish__violations-list">
                     {violations.length === 0 ? <div className="publish__violations-ok"><CheckCircle size={16} /> 無勞基法違規</div> : (() => {
                       const skillMix = violations.filter(v => v.type === 'SKILL_MIX');
                       const others = violations.filter(v => v.type !== 'SKILL_MIX');
                       const grouped = [];
                       if (skillMix.length > 0) {
                         const byShift = {};
                         skillMix.forEach(v => {
                           const shift = v.message.match(/\[(.+?)\]/)?.[1] || '未知';
                           if (!byShift[shift]) byShift[shift] = [];
                           byShift[shift].push(v.day);
                         });
                         Object.entries(byShift).forEach(([shift, days]) => {
                           grouped.push({ staffName: '臨床安全警告', message: `[${shift}] Day ${days.join(', ')} 全為新人(N0/N1)，無資深人員(N2+)或組長坐鎮！` });
                         });
                       }
                       return (
                         <>
                           {others.map((v, i) => (
                             <div key={i} className="publish__violation-item">
                               <div className="publish__violation-name">{v.staffName}</div>
                               <div className="publish__violation-msg">Day {v.day}: {v.message}</div>
                             </div>
                           ))}
                           {grouped.map((g, i) => (
                             <div key={`mix-${i}`} className="publish__violation-item">
                               <div className="publish__violation-name"><AlertTriangle size={14} /> {g.staffName}</div>
                               <div className="publish__violation-msg">{g.message}</div>
                             </div>
                           ))}
                         </>
                       );
                     })()}
                  </div>
               </div>
               <div className="publish__risks">
                  <h2 className="publish__risks-title"><AlertTriangle size={18} /> 壓力風險監控</h2>
                  <div className="publish__risks-list">
                     {(!scheduleRisks || scheduleRisks.length === 0) ? <div className="publish__risks-ok"><Sparkles size={16} /> 團隊負荷平均</div> : scheduleRisks.map((risk, i) => (
                           <div key={i} className="publish__risk-item">
                             <div className="publish__risk-name">{risk.staffName}</div>
                             {risk.tags.map((tag, j) => (<div key={j} className="publish__risk-tag">- {tag.label}</div>))}
                           </div>
                     ))}
                  </div>
               </div>
            </div>
        </div>
      </div>
    );
};

export default PublishPanel;
