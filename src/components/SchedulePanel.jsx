import React, { useState, useEffect, useRef } from 'react';
import { auth } from '../api/database';
import { backupScheduleToArchive } from '../api/database';
import './SchedulePanel.css';

// ============================================================================
// 總班表顯示面板 (精簡版：移除認領清單，專注於 AI 排班工作桌)
// ============================================================================
const SchedulePanel = ({
    onSaveSchedule, schedule, setSchedule, staffData, violations, requirements,
    onGenerateSchedule, selectedYear, selectedMonth, setSelectedYear, setSelectedMonth,
    shiftOptions, setShiftOptions, setFinalizedSchedule, // ★ 接收參數
    // ★★★ 在這裡補上 finalizedSchedule 與 setFinalizedSchedule 的接收 ★★★
    finalizedSchedule, setHistoryYear, setHistoryMonth, setHistorySchedule, historyYear, historyMonth, historySchedule, onManualRefresh, publicHolidays
}) => {
  const [geminiMessages, setGeminiMessages] = useState([]);
  const [geminiInput, setGeminiInput] = useState('');
  const [showGemini, setShowGemini] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState('');
  // ★ 新增一個控制客製化視窗的狀態
  const [showOverwriteModal, setShowOverwriteModal] = useState(false);
  const [isBackingUp, setIsBackingUp] = useState(false);
  const [customAiInstruction, setCustomAiInstruction] = useState('');
  const [showInstructionModal, setShowInstructionModal] = useState(false);
  const [showAddOption, setShowAddOption] = useState(false);
  const [newOption, setNewOption] = useState({ code: '', name: '', color: '#cccccc' });

  const messagesEndRef = useRef(null);

  const scrollToBottom = () => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); };
  useEffect(() => { scrollToBottom(); }, [geminiMessages, loadingStatus]);

  const daysInMonth = new Date(selectedYear, selectedMonth, 0).getDate();
  const daysArray = Array.from({length: daysInMonth}, (_,i)=>i+1);

// ★★★ 修改：一鍵清空整張班表 ★★★
  const handleClearAll = () => {
    if (window.confirm(`⚠️ 確定要【清空 ${selectedMonth}月 的所有班表】嗎？\n\n這將刪除目前工作桌上的所有資料，讓您有一張乾淨的空白桌面。\n(此操作不可逆)`)) {
        setSchedule({});
        if (setFinalizedSchedule) setFinalizedSchedule(null); // ★ 關鍵修復 3：連發布區一起殺乾淨
    }
  };

const handleReset = () => {
    // ★★★ 抓取畫面上「最新」的狀態 (包含員工已認領的發布區，或是剛生成的草稿區)
    const targetSchedule = finalizedSchedule || schedule;

    if (!targetSchedule || Object.keys(targetSchedule).length === 0) {
        alert("目前沒有班表可重置。");
        return;
    }
    if (window.confirm("⚠️ 確定要【退回所有認領狀態】嗎？\n\n執行後：\n1. 班表內容將全數保留。\n2. 但所有員工的名字會被拔除，全部變回待認領的虛擬空缺 (Dxxx)。")) {
      const newSchedule = {};
      let index = 1;

      Object.keys(targetSchedule).sort().forEach(key => {
          const virtualId = `D${String(index).padStart(3, '0')}`;
          newSchedule[virtualId] = targetSchedule[key];
          index++;
      });

      setSchedule(newSchedule);
      if (setFinalizedSchedule) setFinalizedSchedule(null); // ★★★ 同步清除發布區，防止舊資料干擾
      alert("✅ 系統已重置！所有班次已退回待認領狀態。");
    }
  };

// ★ 這是專屬於 SchedulePanel (排班工作桌) 的簡易版匯出功能
  const handleExportExcel = () => {
    // 抓取草稿或已發布的班表
    const targetSchedule = finalizedSchedule || schedule;
    if (!targetSchedule || Object.keys(targetSchedule).length === 0) return alert("無資料可匯出");

    let csv = "\uFEFF工號,姓名,";
    for (let d = 1; d <= daysInMonth; d++) csv += `${d}號,`;
    csv += "\n";

    Object.keys(targetSchedule).sort().forEach(rowId => {
        // 找出員工姓名
        const name = staffData.find(s => s.staff_id === rowId)?.name || "待認領";
        let row = `${rowId},${name},`;

        // 填入每日班別
        for (let d = 1; d <= daysInMonth; d++) {
            const cell = targetSchedule[rowId]?.[d];
            const type = (typeof cell === 'object') ? cell.type : (cell || '');
            row += `${type},`;
        }
        csv += row + "\n";
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${selectedYear}年${selectedMonth}月_排班表草稿.csv`;
    link.click();
  };


// --- ★ 升級版的 AI 生成邏輯 ---
// 1. 點擊「生成 AI 班表」時，第一步先跳出要求詢問視窗
  const handleGeminiSolveClick = () => {
      setShowInstructionModal(true);
  };

  // 1.5 當使用者在詢問視窗輸入完要求，按下「確認並繼續」時的邏輯
  const handleConfirmInstruction = () => {
      setShowInstructionModal(false); // 關閉要求詢問視窗

      // 接著檢查畫面上是不是已經有舊班表了？
      if (schedule && Object.keys(schedule).length > 0) {
          setShowOverwriteModal(true); // 如果有資料，跳出覆蓋警告視窗
      } else {
          executeGeminiSolve(); // 如果是空的，直接發送給 AI 開始生成
      }
  };

// 2. 選項 A：先封存至伺服器歷史區，再重新生成
  const handleArchiveThenGenerate = async () => {
      const targetSchedule = finalizedSchedule || schedule;

      if (targetSchedule && Object.keys(targetSchedule).length > 0) {
          setIsBackingUp(true);

          try {
              // ★ 動作 1：將原本躺在「歷史區」的班表，精準備份到 archive_reports/YYYY_M
              if (historySchedule && Object.keys(historySchedule).length > 0) {
                  await backupScheduleToArchive(
                      historyYear,
                      historyMonth,
                      historySchedule,
                      "歷史區舊班表被覆蓋前自動歸檔"
                  );
              }

              // ★ 動作 2：將「目前工作桌」的班表也備份一份到對應的月份
              await backupScheduleToArchive(
                  selectedYear,
                  selectedMonth,
                  targetSchedule,
                  "重新生成 AI 班表前自動備份"
              );

              // ★ 動作 3：將目前工作桌的班表，移動並「覆蓋」掉歷史區原本躺著的班表
              if (setHistoryYear) setHistoryYear(selectedYear);
              if (setHistoryMonth) setHistoryMonth(selectedMonth);
              if (setHistorySchedule) setHistorySchedule(targetSchedule);

              if (import.meta.env.DEV) console.log("✅ 舊班表已成功歸檔至 archive_reports，並完成歷史區替換！");

          } catch (error) {
              console.error("伺服器備份失敗:", error);
              alert("❌ 備份至伺服器失敗，請確認網路！\n(錯誤：" + error.message + ")");
              setIsBackingUp(false);
              return;
          }

          setIsBackingUp(false);
      }

      // 3. 確定伺服器備份成功後，關閉視窗並開始生成全新 AI 班表
      setShowOverwriteModal(false);
      executeGeminiSolve();
  };
  // 👇 ★★★ 請把這段遺失的「選項 B」補在這裡！ ★★★ 👇
  const handleDirectOverwrite = () => {
      setShowOverwriteModal(false); // 關閉彈出視窗
      executeGeminiSolve();         // 直接呼叫 AI 重新生成新班表
  };
  // 👆 ★★★ 補上這段就修復了！ ★★★ 👆

  // 4. 真正的 AI 呼叫核心 (原來的 handleGeminiSolve 邏輯移到這裡)
  const executeGeminiSolve = async () => {
    // ★★★ 新增：自動計算本月的週末與國定假日 ★★★
    const weekends = [];
    const natHolidays = [];
    for (let d = 1; d <= daysInMonth; d++) {
        const date = new Date(selectedYear, selectedMonth - 1, d);
        const dayOfWeek = date.getDay();
        const dateStr = `${selectedYear}${String(selectedMonth).padStart(2, '0')}${String(d).padStart(2, '0')}`;

        if (dayOfWeek === 0 || dayOfWeek === 6) weekends.push(d);
        if (publicHolidays.includes(dateStr)) natHolidays.push(d);
    }

    const calendarContext = `
[本月曆法資訊]
- 週末 (六日) 日期：${weekends.join(', ')} 號
- 國定假日 日期：${natHolidays.length > 0 ? natHolidays.join(', ') + ' 號' : '無'}
    `;
    setShowGemini(true);
    setProcessing(true);
    const dailyNeeded = (requirements.D || 0) + (requirements.E || 0) + (requirements.N || 0);
    const totalShiftsNeeded = dailyNeeded * daysInMonth;
    let estimatedCount = dailyNeeded > 0 ? Math.ceil(totalShiftsNeeded / 22) : 10;
    estimatedCount += 2;

    setGeminiMessages([{ role: 'assistant', content: `🤖 根據人力需求 (${dailyNeeded}人/日)，正在為 ${selectedMonth}月 生成 ${estimatedCount} 份匿名班表...` }]);

    let currentPrompt = `
[角色定義]
你是一個高階排班演算法引擎，採用「目標規劃法 (Goal Programming)」邏輯。你精通台灣勞動基準法 (Taiwan Labor Standards Act) 與護理人員排班規則。
${calendarContext}
[使用者額外指令]
${customAiInstruction ? `請特別注意以下要求: "${customAiInstruction}"` : "無額外特殊要求，請依照一般最佳化原則排班。"}
[任務目標]
為 ${selectedYear}年${selectedMonth}月 (共 ${daysInMonth} 天) 的護理團隊規劃班表。
目標是將目標函數 Z 的總罰分降至最低： Minimize Z = (W1 * 工作量偏差) + (W2 * 偏好偏差) + (W3 * 班別公平性偏差)。

[輸入資料：員工與限制]
2. 班別定義: D (07-16), E (15-00), N (23-08)
- 休假班: **RG (例假), RC (休假)**。
- 所有休假必須明確標示為 RG 或 RC。
3. 每日人力需求: 早班(D)至少 ${requirements.D} 人, 小夜(E)至少 ${requirements.E} 人, 大夜(N)至少 ${requirements.N} 人。

[硬性約束 (Hard Constraints) - 必須完全遵守，違反即失敗]
高優先級別-**每個護理人員班表僅能出現一種班別，也就是說第一天出現白班，接下來的排班除休假日外也僅可以出現白班。**
- **🚨 護病比天條**: 任何一天的 D、E、N 班人數，【絕對不可】低於上述的每日人力需求！
1. **法規底線**:
   - 任何員工不得連續工作超過 6 天 (勞基法「七休一」)。
   - 輪班間隔必須 >= 11 小時 (例如: 今天 E 班 24:00 下班，明天最早只能接 E 班，不能接 D 班)。
   - 每 7 天週期內，至少要有 1 個 RG (例假) 和 1 個 RC (休假)。
   - RG (例假) 之間間隔不得超過 6 天。
   - 4週內總計至少應有 8 天休假 (4個 RG + 4個 RC)。
2. **24小時無縫覆蓋**: 任何時段護理站都不能空班。
3. **工時制度**:
   - "Standard" (單週): 每日 8 小時，每週工時 <= 40。
   - "BiWeekly" (雙週變形): 每日可達 10 小時，雙週總工時 <= 80。
4. **夜班限制**: 禁止連續大夜班 (N) 超過44 天 (避免過勞)。

[軟性目標 (Soft Goals) - 盡力達成，做不到則計入罰分]
1. **Goal 1 (工作量公平性)**: 每人每月總班數應介於 22-24 班之間。偏差值越小越好。
2. **Goal 2 (個人偏好)**: 盡量滿足員工「假日休假」與「連續休假」。(若違反，每錯一個罰 10 分)。

[輸出格式 JSON - 極度重要]
為了追求極致的運算速度，請絕對不要輸出複雜的 JSON 物件！
請只輸出一個包含 ${estimatedCount} 個字串的陣列 (Array)。
每個字串代表一個人的整月班表，以「逗號」分隔，剛好 ${daysInMonth} 個班別。

格式範例:
{
  "patterns": [
    "D,D,D,D,D,RG,RC,D,D,D,D,E,E,OFF,OFF...",
    "E,E,E,E,OFF,RC,E,E,E,E,D,D,RG,OFF,OFF..."
  ],
  "summary": "已生成符合勞基法的高效排班陣列。"
}
`;
    let attempts = 0; const MAX_RETRIES = 5; let isSuccess = false;

    while (attempts < MAX_RETRIES && !isSuccess) {
        try {
            attempts++;
            setLoadingStatus(attempts === 1 ? "🧠 AI 正在計算最佳排班陣列..." : `♻️ 第 ${attempts} 次嘗試...`);
            const token = await auth.currentUser.getIdToken();
            const response = await fetch('/api/gemini', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json',
                           'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ prompt: currentPrompt })
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || "伺服器連線失敗");
            }

            const data = await response.json();
            const text = data.text.replace(/```json|```/g, '').trim();
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (!jsonMatch) throw new Error("JSON 格式錯誤");
            const parsed = JSON.parse(jsonMatch[0]);

            if (parsed.patterns && Array.isArray(parsed.patterns)) {
                const virtualSchedule = {};

                parsed.patterns.forEach((patternStr, index) => {
                    const virtualId = `D${String(index + 1).padStart(3, '0')}`;
                    const shifts = patternStr.split(',').map(s => s.trim());

                    virtualSchedule[virtualId] = {};

                    shifts.forEach((shiftType, dIndex) => {
                        const dayNum = dIndex + 1;
                        if (dayNum <= daysInMonth) {
                            virtualSchedule[virtualId][dayNum] = { type: shiftType, time: '' };
                        }
                    });
                });
                // =========================================================
                // ★★★ 新增：護病比 (每日人力需求) 嚴格把關攔截網 ★★★
                let isRatioValid = true;
                let errorMsg = "";

                for (let d = 1; d <= daysInMonth; d++) {
                    let countD = 0, countE = 0, countN = 0;
                    Object.values(virtualSchedule).forEach(staff => {
                        const type = staff[d]?.type;
                        if (type === 'D') countD++;
                        if (type === 'E') countE++;
                        if (type === 'N') countN++;
                    });

                    // 只要有一天的人數小於首頁設定的需求，立刻判定為「不合格廢品」
                    if (countD < (requirements.D || 0) || countE < (requirements.E || 0) || countN < (requirements.N || 0)) {
                        isRatioValid = false;
                        errorMsg = `第 ${d} 天人力不足 (法定需 D${requirements.D} E${requirements.E} N${requirements.N} / AI卻只排了 D${countD} E${countE} N${countN})`;
                        break; // 抓到一天違規就不用看了，直接跳出迴圈
                    }
                }

                if (!isRatioValid) {
                    // 故意丟出錯誤，這會讓系統直接跳到 catch 區塊，並自動啟動下一次 attempt 重試！
                    throw new Error(`護病比未達標 (${errorMsg})，正強制 AI 重新洗牌運算...`);
                }
                // =========================================================

                setGeminiMessages(prev => [...prev, { role: 'assistant', content: `✅ **排班成功 (全新產生)**\n\n已為您配置 ${Object.keys(virtualSchedule).length} 位人力！` }]);
                isSuccess = true;

                onGenerateSchedule(virtualSchedule);


            } else {
                throw new Error("AI 未回傳正確的 patterns 陣列");
            }
        } catch (e) {
            console.error(e);
            if (attempts >= MAX_RETRIES) {
                setGeminiMessages(prev => [...prev, { role: 'assistant', content: "❌ 系統錯誤: " + e.message }]);
                break;
            }
        }
    }
    setProcessing(false); setLoadingStatus('');
  };

  const handleUserChat = async () => {
      if (!geminiInput.trim()) return;
      const userMsg = geminiInput;
      setGeminiInput(''); setProcessing(true);
      setLoadingStatus("🤖 AI 正在思考回應...");
      setGeminiMessages(prev => [...prev, { role: 'user', content: userMsg }]);

      try {
          const token = await auth.currentUser.getIdToken();
          const response = await fetch('/api/gemini', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}` // <--- 加上這行防護罩
               },
              body: JSON.stringify({ prompt: userMsg })
          });

          if (!response.ok) throw new Error("伺服器連線失敗");

          const data = await response.json();
          setGeminiMessages(prev => [...prev, { role: 'assistant', content: data.text }]);
      } catch (error) {
          setGeminiMessages(prev => [...prev, { role: 'assistant', content: "❌ 錯誤: " + error.message }]);
      } finally { setProcessing(false); setLoadingStatus(''); }
  };

const handleCellChange = (staffId, day, newValue) => {
    // === RG 絕對防護罩 ===
    const currentCell = schedule[staffId]?.[day];
    const currentValue = (typeof currentCell === 'object') ? currentCell?.type : currentCell;
    const workShifts = ['D', 'E', 'N', '支援', 'OT'];
    if (currentValue === 'RG' && workShifts.some(shift => newValue.includes(shift))) {
        alert('🚨 勞基法天條攔截：\n「例假 (RG)」絕對禁止出勤！\n\n系統已強制阻擋您將 RG 變更為上班班別。');
        return;
    }
    // ===================

    const newSchedule = JSON.parse(JSON.stringify(schedule));
    if (!newSchedule[staffId]) newSchedule[staffId] = {};
    const oldCell = newSchedule[staffId][day];
    const opt = shiftOptions.find(o => o.code === newValue);
    const defaultTime = opt ? opt.time : '';
    newSchedule[staffId][day] = { ...(typeof oldCell === 'object' ? oldCell : {}), type: newValue, time: defaultTime };
    setSchedule(newSchedule);
  };

  const handleAddOption = () => {
    if (!newOption.code || !newOption.name) return alert("請輸入代號與名稱！");
    if (shiftOptions.find(o => o.code === newOption.code)) return alert("此代號已存在！");
    setShiftOptions([...shiftOptions, { ...newOption, time: '' }]);
    setNewOption({ code: '', name: '', color: '#cccccc' });
  };
  const handleDeleteOption = (code) => {
      if(window.confirm(`確定要刪除班別「${code}」嗎？`)) {
          setShiftOptions(shiftOptions.filter(o => o.code !== code));
      }
  };

  const calculateDailyStats = () => {
      const stats = {};
      for(let d=1; d<=daysInMonth; d++) stats[d] = { D:0, E:0, N:0 };
      if(schedule) {
          Object.values(schedule).forEach(staffSchedule => {
              for(let d=1; d<=daysInMonth; d++) {
                  const cell = staffSchedule[d];
                  const type = (typeof cell === 'object' ? cell.type : cell) || 'OFF';
                  if(['D','E','N'].includes(type)) stats[d][type]++;
              }
          });
      }
      return stats;
  };
  const dailyStats = calculateDailyStats();

 return (
    <div className="schedule-panel">

      {/* 1. 載入中畫面 */}
      {processing && (
        <div className="schedule-panel__loading-overlay">
          <div className="schedule-panel__spinner"></div>
          <div className="schedule-panel__loading-title">AI 正在排班中...</div>
          <div className="schedule-panel__loading-status">{loadingStatus}</div>
        </div>
      )}
{/* ★★★ 新增的：AI 需求詢問視窗 (Modal) ★★★ */}
      {showInstructionModal && (
        <div className="schedule-panel__modal-backdrop schedule-panel__modal-backdrop--instruction">
            <div className="schedule-panel__modal-box">
                <h3 className="schedule-panel__modal-title schedule-panel__modal-title--instruction">
                    ✨ 告訴 AI 您的特殊要求
                </h3>
                <p className="schedule-panel__modal-desc">
                    除了遵守勞基法與基本人力外，您本月還有什麼特別想交代的嗎？<br/>
                    <span className="schedule-panel__modal-hint">(例如：「請盡量讓 N001 都在週末休假」、「大夜班盡量安排給年資高的人」)</span>
                </p>

                <textarea
                    value={customAiInstruction}
                    onChange={(e) => setCustomAiInstruction(e.target.value)}
                    placeholder="請輸入您的特殊要求 (若無特殊要求，可直接留空並點擊繼續)..."
                    className="schedule-panel__modal-textarea"
                />

                <div className="schedule-panel__modal-actions">
                    <button onClick={() => setShowInstructionModal(false)} className="schedule-panel__btn schedule-panel__btn--cancel">
                        取消
                    </button>
                    <button onClick={handleConfirmInstruction} className="schedule-panel__btn schedule-panel__btn--confirm">
                        確認並繼續 🚀
                    </button>
                </div>
            </div>
        </div>
      )}
      {/* ★★★ 需求詢問視窗結束 ★★★ */}
      {/* ★★★ 2. 全新加入的：客製化覆蓋警告視窗 (Modal) ★★★ */}
      {showOverwriteModal && (
        <div className="schedule-panel__modal-backdrop schedule-panel__modal-backdrop--overwrite">
            <div className="schedule-panel__modal-box">
                <h3 className="schedule-panel__modal-title schedule-panel__modal-title--overwrite">
                    ⚠️ 畫面上已經有班表資料！
                </h3>
                <p className="schedule-panel__modal-desc schedule-panel__modal-desc--overwrite">
                    為避免「新舊班表疊加」導致人數暴增（產生多餘的幽靈空缺），系統必須清除目前的畫面。<br/><br/>
                    請問您希望如何處理目前的舊班表？
                </p>

                <div className="schedule-panel__modal-actions schedule-panel__modal-actions--column">
                <button onClick={handleArchiveThenGenerate} disabled={isBackingUp} className="schedule-panel__btn schedule-panel__btn--archive">
                <span>{isBackingUp ? '⏳ 正在備份至伺服器...' : '📂 儲存至伺服器備份後重新生成'}</span>
                <span>→</span>
                </button>

                    <button onClick={handleDirectOverwrite} className="schedule-panel__btn schedule-panel__btn--danger">
                        <span>🗑️ 直接清除畫面並覆蓋</span>
                        <span>→</span>
                    </button>

                    <button onClick={() => setShowOverwriteModal(false)} className="schedule-panel__btn schedule-panel__btn--keep">
                        取消，保留目前畫面
                    </button>
                </div>
            </div>
        </div>
      )}
      {/* ★★★ Modal 結束 ★★★ */}

      {/* 3. 頂部工具列 */}
      <div className="schedule-panel__toolbar">
        <div className="schedule-panel__toolbar-left">
            <h2 className="schedule-panel__title">總班表 (排班工作桌)</h2>
        </div>

       <div className="schedule-panel__toolbar-right">
           {/* 日期控制區 */}
           <div className="schedule-panel__date-picker">
               <input
                  type="number" value={selectedYear} onChange={(e) => setSelectedYear(Number(e.target.value))}
                  className="schedule-panel__year-input"
               />
               <span className="schedule-panel__date-label">年</span>
               <select
                  value={selectedMonth} onChange={(e) => setSelectedMonth(Number(e.target.value))}
                  className="schedule-panel__month-select"
               >
                  {Array.from({length:12},(_,i)=>i+1).map(m=><option key={m} value={m}>{m}</option>)}
               </select>
               <span className="schedule-panel__date-label">月</span>
               <span className="schedule-panel__days-count">({daysInMonth}天)</span>
           </div>
           {/* ★★★★ 請把這顆「手動同步按鈕」加在這裡！ ★★★★ */}
           <button
             onClick={onManualRefresh}
             className="schedule-panel__toolbar-btn schedule-panel__toolbar-btn--sync"
           >
             🔄 手動同步
           </button>
           <button onClick={() => setShowAddOption(!showAddOption)} className="schedule-panel__toolbar-btn schedule-panel__toolbar-btn--options">➕ 選項</button>

           {/* ★ 確保這裡綁定的是 handleGeminiSolveClick */}
           <button id="gemini-trigger-btn" onClick={handleGeminiSolveClick} disabled={processing} className="schedule-panel__toolbar-btn schedule-panel__toolbar-btn--generate">{processing ? '⏳' : '✨ 生成 AI 班表'}</button>

           <button onClick={handleClearAll} className="schedule-panel__toolbar-btn schedule-panel__toolbar-btn--clear">🗑️ 清空舊班表</button>

           <button onClick={handleExportExcel} className="schedule-panel__toolbar-btn schedule-panel__toolbar-btn--export">📥 Excel</button>
           <button onClick={onSaveSchedule} className="schedule-panel__toolbar-btn schedule-panel__toolbar-btn--save">💾 儲存並發布</button>
        </div>
      </div>

      {/* 4. 新增選項面板 */}
      {showAddOption && (
        <div className="schedule-panel__option-panel">
          <div className="schedule-panel__option-form">
          <input placeholder="代號" value={newOption.code} onChange={e=>setNewOption({...newOption, code: e.target.value})} className="schedule-panel__option-input schedule-panel__option-input--code" />
          <input placeholder="名稱" value={newOption.name} onChange={e=>setNewOption({...newOption, name: e.target.value})} className="schedule-panel__option-input schedule-panel__option-input--name" />
          <input type="color" value={newOption.color} onChange={e=>setNewOption({...newOption, color: e.target.value})} className="schedule-panel__option-color-input" />
          <button onClick={handleAddOption} className="schedule-panel__option-add-btn">確認新增</button>
        </div>
          <div className="schedule-panel__option-list">
              {shiftOptions.map(opt => (
                  <div key={opt.code} className="schedule-panel__option-tag">
                      <span className="schedule-panel__option-dot" style={{background:opt.color}}></span>
                      <b className="schedule-panel__option-code">{opt.code}</b>
                      <button onClick={() => handleDeleteOption(opt.code)} className="schedule-panel__option-delete-btn">×</button>
                  </div>
              ))}
          </div>
        </div>
      )}

      {/* 5. AI 對話框 */}
      {showGemini && (
        <div className="schedule-panel__chat">
            <div className="schedule-panel__chat-messages">
                {geminiMessages.map((m, i) => (
                    <div key={i} className={`schedule-panel__chat-bubble-wrapper schedule-panel__chat-bubble-wrapper--${m.role}`}>
                        <div className={`schedule-panel__chat-bubble schedule-panel__chat-bubble--${m.role}`}>{m.content}</div>
                    </div>
                ))}
                <div ref={messagesEndRef} />
            </div>
            <div className="schedule-panel__chat-input-row">
                <input value={geminiInput} onChange={(e) => setGeminiInput(e.target.value)} onKeyPress={(e) => e.key === 'Enter' && handleUserChat()} placeholder="輸入指令..." className="schedule-panel__chat-input" disabled={processing} />
                <button onClick={handleUserChat} disabled={processing} className="schedule-panel__chat-send-btn">發送指令</button>
            </div>
        </div>
      )}

      {/* 6. 班表主體 */}
      {schedule && Object.keys(schedule).length > 0 ? (
        <div className="schedule-panel__table-container">
            <table className="schedule-panel__table">
                <thead className="schedule-panel__thead">
                    <tr className="schedule-panel__header-row">
                        <th className="schedule-panel__header-cell">員工</th>
                        {daysArray.map(d => {
                            const dayOfWeek = new Date(selectedYear, selectedMonth - 1, d).getDay();
                            const dayStrs = ['日', '一', '二', '三', '四', '五', '六'];
                            const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

                            return (
                                <th key={d} className={`schedule-panel__header-day${isWeekend ? ' schedule-panel__header-day--weekend' : ''}`}>
                                    <div className="schedule-panel__header-day-num">{d}</div>
                                    <div className="schedule-panel__header-day-name">{dayStrs[dayOfWeek]}</div>
                                </th>
                            )
                        })}
                    </tr>
                </thead>
                <tbody>
                   {Object.keys(schedule).sort((a, b) => {
                        const aIsVirtual = a.startsWith('D');
                        const bIsVirtual = b.startsWith('D');
                        if (aIsVirtual && !bIsVirtual) return 1;  // D 永遠墊底
                        if (!aIsVirtual && bIsVirtual) return -1; // 員工永遠置頂
                        return a.localeCompare(b);
                    }).map(rowId => {
                        const isVirtual = rowId.startsWith('D');
                        return (
                            <tr key={rowId} className={`schedule-panel__row${isVirtual ? ' schedule-panel__row--virtual' : ''}`}>
                                <td className={`schedule-panel__staff-cell${isVirtual ? ' schedule-panel__staff-cell--virtual' : ''}`}>
                                    {isVirtual ? (
                                        <>
                                            <div className="schedule-panel__staff-name schedule-panel__staff-name--virtual">🎲 待認領</div>
                                            <div className="schedule-panel__staff-id schedule-panel__staff-id--virtual">{rowId}</div>
                                        </>
                                    ) : (
                                        <>
                                            <div className="schedule-panel__staff-name schedule-panel__staff-name--real">{staffData.find(s=>s.staff_id===rowId)?.name || rowId}</div>
                                            <div className="schedule-panel__staff-id schedule-panel__staff-id--real">{rowId}</div>
                                        </>
                                    )}
                                </td>
                                {daysArray.map(d => {
                                    const cellData = schedule[rowId]?.[d];
                                    const currentType = (typeof cellData === 'object') ? cellData.type : (cellData || 'OFF');
                                    const optionInfo = shiftOptions.find(o => o.code === currentType) || { color: '#fff', code: currentType };
                                    const isDarkBg = ['N', 'E', 'D', 'RG', '支援'].includes(currentType);
                                    return (
                                        <td key={d} className="schedule-panel__cell">
                                            <select value={currentType} onChange={(e) => handleCellChange(rowId, d, e.target.value)} className={`schedule-panel__cell-select${isDarkBg ? ' schedule-panel__cell-select--dark' : ' schedule-panel__cell-select--light'}`} style={{ background: optionInfo.color }}>
                                                {shiftOptions.map(opt => <option key={opt.code} value={opt.code} className="schedule-panel__cell-option">{opt.code}</option>)}
                                            </select>
                                        </td>
                                    )
                                })}
                            </tr>
                        );
                    })}
                </tbody>

                <tfoot className="schedule-panel__tfoot">
                  {['D', 'E', 'N'].map(type => {
                      const req = requirements[type] || 0;
                      return (
                          <tr key={type} className="schedule-panel__stats-row">
                              <td className="schedule-panel__stats-label">
                                  {type === 'D' ? '早班' : type === 'E' ? '小夜' : '大夜'}
                                  <span className="schedule-panel__stats-req">(需{req})</span>
                              </td>
                              {daysArray.map(d => {
                                  const count = dailyStats[d]?.[type] || 0;
                                  const isOk = count >= req;
                                  return (
                                      <td key={d} className={`schedule-panel__stats-cell${isOk ? ' schedule-panel__stats-cell--ok' : ' schedule-panel__stats-cell--fail'}`}>
                                          {count}
                                      </td>
                                  )
                              })}
                          </tr>
                      )
                  })}
                </tfoot>
            </table>
        </div>
      ) : <div className="schedule-panel__empty">
          <h3 className="schedule-panel__empty-title">桌面空空如也 🌬️</h3>
          <p>請點擊上方的「✨ 生成 AI 班表」開始排班，或是切換其他月份。</p>
      </div>}
    </div>
 );
};

export default SchedulePanel;
