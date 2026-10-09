import React, { useState, useEffect, useRef } from 'react';
import { Sparkles, Loader, Trash2, Plus, FileDown, Save, RefreshCw, Calculator } from 'lucide-react';
import { auth } from '../api/database';
import { saveLeaveWishSettings } from '../api/database';
import { generateCpsatSchedule } from '../api/scheduleEngine';
import { computeDailyRequirements, legalDailyFloor } from '../constants';
import './SchedulePanel.css';

// ============================================================================
// 排班工作桌：CP-SAT 直接指派排班 → 檢視 / 手動微調草稿 → 儲存並發布
// ============================================================================
const SchedulePanel = ({
    onSaveSchedule, schedule, setSchedule, staffData, requirements, bedConfig,
    onGenerateSchedule, selectedYear, selectedMonth, setSelectedYear, setSelectedMonth,
    shiftOptions, setShiftOptions, setFinalizedSchedule, // ★ 接收參數
    leaveWish, // 預假設定（同月份時 CP-SAT 沿用當時的每日人力）
    // ★★★ 在這裡補上 finalizedSchedule 與 setFinalizedSchedule 的接收 ★★★
    finalizedSchedule, onManualRefresh,
}) => {
  const [geminiMessages, setGeminiMessages] = useState([]);
  const [geminiInput, setGeminiInput] = useState('');
  const [showGemini, setShowGemini] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState('');
  // ★ 新增一個控制客製化視窗的狀態
  const [showAddOption, setShowAddOption] = useState(false);
  const [newOption, setNewOption] = useState({ code: '', name: '', color: '#cccccc' });
  const [justGenerated, setJustGenerated] = useState(false);
  const [processingFadeOut] = useState(false);


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



  // ============================================================================
  // CP-SAT 直接指派排班（Cloud Run 排班引擎：main1.py + cpsat_service.py）
  // ----------------------------------------------------------------------------
  // 取代舊的「SA 最佳化排班 → 匿名虛擬 slot → 員工認領」：
  //   - CP-SAT 把勞基法、每日人力、孕哺 / 實習禁夜、週內不花花班、連上 ≤ 5 天、連大夜 ≤ 3 晚、
  //     大夜後連休 2 天、每月至少上班 20 天當「硬約束」→ 有解就保證合法，無解會說明原因
  //   - 已登記的預假（人力與預假分頁）也是硬約束 → 保證滿足
  //   - 結果直接指派到真實工號（不再匿名化），寫進草稿；護理長檢視後按「儲存並發布」
  // 人數由引擎先做人力試算：不足就拒絕並說明，過多則本月不排尾端的一般護理師。
  // ============================================================================
  const handleCpsatAssign = async () => {
    // 每日最低人力：本月若已開放過預假，沿用當時的設定（預假的可行性檢查是用這組人力算的，
    // 換一組人力就不保證預假可滿足）；否則取 max(「病床與護病比」算出的需求, 衛福部護病比法定下限)。
    // 不論哪一種都不可低於法定下限 — 預假那條路以前直接沿用，會繞過下限。
    const wishForThisMonth = leaveWish && Number(leaveWish.year) === selectedYear && Number(leaveWish.month) === selectedMonth;
    const legal = computeDailyRequirements(bedConfig || {});
    const floor = legalDailyFloor(bedConfig?.bedCount ?? 0, bedConfig?.hospitalLevel || 'MedicalCenter');
    const base = wishForThisMonth && leaveWish.reqs
      ? { D: Number(leaveWish.reqs.D), E: Number(leaveWish.reqs.E), N: Number(leaveWish.reqs.N) }
      : {
          D: Math.max(requirements.D || 0, legal.D),
          E: Math.max(requirements.E || 0, legal.E),
          N: Math.max(requirements.N || 0, legal.N),
        };
    const reqs = { D: Math.max(base.D, floor.D), E: Math.max(base.E, floor.E), N: Math.max(base.N, floor.N) };
    const raisedToFloor = ['D', 'E', 'N'].filter(k => reqs[k] > base[k]);
    if (raisedToFloor.length && !window.confirm(
      `⚠️ ${selectedYear}/${selectedMonth} 預假開放時設定的每日人力（D${base.D} / E${base.E} / N${base.N}）` +
      `低於衛福部護病比法定下限，排班改用 D${reqs.D} / E${reqs.E} / N${reqs.N}。\n\n` +
      `已登記的預假是用較低的人力檢查的，可能無法全部保證（排不出來時會改為盡量滿足並標示）。\n` +
      `人力不足時會排班失敗，請到「人力與預假」的「病房設定」確認病床數與醫院等級。要繼續嗎？`)) return;

    // 預假還開放就排班 → 之後才登記的人會被告知「保證休假」，但班表沒有反映。必須先截止（引擎也會擋）。
    if (wishForThisMonth && leaveWish.open) {
      const closeNow = window.confirm(
        `⚠️ ${selectedYear}/${selectedMonth} 的預假尚未截止\n\n` +
        `截止前排出的班表不會包含之後才登記的預假，但員工那邊會顯示「登記成功、保證休假」。\n\n` +
        `要現在截止預假並開始排班嗎？（已登記的預假保留，排班時保證滿足）`
      );
      if (!closeNow) return;
      try {
        await saveLeaveWishSettings({ ...leaveWish, open: false, closedAt: new Date().toISOString() });
      } catch (err) {
        alert(`❌ 截止預假失敗：${err.message}`);
        return;
      }
    }

    const okGo = window.confirm(
      `🧮 CP-SAT 直接指派排班\n\n` +
      `${selectedYear}/${selectedMonth}  每日最低人力：D=${reqs.D} / E=${reqs.E} / N=${reqs.N}` +
      `${wishForThisMonth ? '（沿用預假開放時的設定）' : ''}\n\n` +
      `• 勞基法、護病比、孕哺 / 實習禁夜、休息與連班上限一律保證遵守\n` +
      `• 已登記的預假保證滿足\n` +
      `• 結果直接指派給每位員工並放進草稿（不再匿名認領），檢視後再按「儲存並發布」\n\n` +
      `最多約 2 分鐘（超過會自動中止），要繼續嗎？`
    );
    if (!okGo) return;

    setProcessing(true);
    setShowGemini(true);
    setGeminiMessages([{ role: 'assistant', content: `🧮 CP-SAT 排班中…（${selectedYear}/${selectedMonth}，D=${reqs.D} / E=${reqs.E} / N=${reqs.N}）` }]);
    setLoadingStatus('🧮 CP-SAT 排班中（最多約 2 分鐘）...');

    try {
      const t0 = Date.now();
      const data = await generateCpsatSchedule({ year: selectedYear, month: selectedMonth, reqs, timeLimit: 120 });

      // 直接指派：key 是真實工號（與舊 SA 路徑不同，不再編成 D001… 匿名 slot）
      const assigned = {};
      (data.schedule || []).forEach(cell => {
        const day = parseInt(cell.date.split('-')[2], 10);
        if (!assigned[cell.nurse_id]) assigned[cell.nurse_id] = {};
        assigned[cell.nurse_id][day] = { type: cell.shift, time: '' };
      });

      setJustGenerated(true);
      onGenerateSchedule(assigned);

      const st = data.stats || {};
      const elapsedClient = ((Date.now() - t0) / 1000).toFixed(1);
      const nameOf = Object.fromEntries((staffData || []).map(s => [s.staff_id, s.name || s.staff_id]));
      const types = st.shift_types || {};
      const legalOk = st.hard_penalty === 0;
      setGeminiMessages(prev => [...prev, {
        role: 'assistant',
        content:
          `${legalOk ? '✅' : '⛔'} CP-SAT 排班完成（${data.solver_status}${st.gap != null ? `，距最佳約 ${Math.round(st.gap * 100)}%` : ''}）\n` +
          `⏱️ 伺服器 ${data.elapsed_seconds}s / 含網路 ${elapsedClient}s\n` +
          `👥 ${st.staffing?.note || ''}\n` +
          `📋 參與排班 ${st.num_nurses} 人：${Object.keys(assigned).map(id => nameOf[id] || id).join('、')}\n` +
          `🛡️ 法遵硬約束違規：${st.hard_penalty}\n` +
          `🌴 預假：${st.wishes_total ? `${st.wishes_met} / ${st.wishes_total} 天已滿足${st.wishes_hard ? '（保證）' : '（⚠️ 無法全部保證，已盡量滿足）'}` : '本月沒有登記預假'}\n` +
          (st.senior_gaps != null ? `👩‍⚕️ 資深坐鎮：${st.senior_gaps === 0 ? '每班都有 N2+ 或組長' : `⚠️ 有 ${st.senior_gaps} 個班次沒有 N2+ 或組長（資深人力不足）`}\n` : '') +
          `🔁 整月班別：只上 1 種 ${types[1] ?? types['1'] ?? 0} 人、混 2 種 ${types[2] ?? types['2'] ?? 0} 人、混 3 種 ${types[3] ?? types['3'] ?? 0} 人｜逆向輪班 ${st.backward_rotations} 次\n\n` +
          `班表已放進草稿，請檢視後按「儲存並發布」。`
      }]);
    } catch (err) {
      console.error('CP-SAT 排班失敗:', err);
      setGeminiMessages(prev => [...prev, {
        role: 'assistant',
        content: `❌ CP-SAT 排班失敗：\n${err.message}\n\n` +
          (err.status === 400
            ? '這通常代表人力不足或需求過高：請到「人力與預假」做人力試算，增補人力或降低每日需求後再試。'
            : err.status === 409
            ? '請先到「人力與預假」截止本月預假，再回來排班。'
            : err.status === 503 || err.status === 504
            ? '已達 2 分鐘上限。人力試算的結果會保留，再按一次通常會比較快；仍然逾時請降低每日需求。'
            : '請稍後再試；若持續失敗，請確認排班引擎（Cloud Run）是否正常。')
      }]);
    } finally {
      setProcessing(false);
      setLoadingStatus('');
    }
  };


  const handleUserChat = async () => {
      if (!geminiInput.trim()) return;
      const userMsg = geminiInput;
      setGeminiInput(''); setProcessing(true);
      setLoadingStatus("🤖 AI 正在思考回應...");
      setGeminiMessages(prev => [...prev, { role: 'user', content: userMsg }]);

      try {
          const token = await auth.currentUser.getIdToken();

          // 個資法稽核：admin 自由輸入的 chat 內容無法事前匿名（可能含工號 / 姓名等）；
          // 至少留下「誰、何時、把多少 prompt 預覽 送給了 Gemini」的軌跡。fire-and-forget
          // 不阻擋業務 — 寫 log 失敗只 console.warn。
          // preview 加長至 500 字以提升事後溯源完整度（原本 80 字幾乎只夠看到開頭問句）。
          fetch('/api/secure-field', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
              body: JSON.stringify({
                  action: 'logAiAccess',
                  target: { kind: 'chat', id: null },
                  fields: ['admin_chat_message'],
                  extra: {
                      source: 'SchedulePanel.handleUserChat',
                      vendor: 'google-gemini',
                      prompt_preview: userMsg.slice(0, 500),
                      prompt_truncated: userMsg.length > 500,
                      prompt_length: userMsg.length,
                  },
              }),
          }).catch((e) => console.warn('AI 存取稽核寫入失敗（不阻擋）:', e.message));

          const response = await fetch('/api/gemini', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
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
        <div className={`schedule-panel__loading-overlay${processingFadeOut ? ' schedule-panel__loading-overlay--out' : ''}`}>
          <div className="schedule-panel__loading-orb">
            <div className="schedule-panel__loading-orb-ring"></div>
            <div className="schedule-panel__loading-orb-core"><Sparkles size={24} /></div>
          </div>
          <div className="schedule-panel__loading-title">AI 正在排班中...</div>
          <div className="schedule-panel__loading-status">{loadingStatus}</div>
        </div>
      )}

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
             <RefreshCw size={14} /> 手動同步
           </button>
           <button onClick={() => setShowAddOption(!showAddOption)} className="schedule-panel__toolbar-btn schedule-panel__toolbar-btn--options"><Plus size={14} /> 選項</button>

           {/* SA 模擬退火排班（獨立微服務 main1.py）— 與 Gemini 並列、互補 */}
           <button
              id="cpsat-trigger-btn"
              onClick={handleCpsatAssign}
              disabled={processing}
              className="schedule-panel__toolbar-btn schedule-panel__toolbar-btn--cpsat"
              title="CP-SAT 求解器：勞基法與預假保證滿足，直接指派到每位員工（不再匿名認領）"
           >
              {processing ? <Loader size={16} className="schedule-panel__spin" /> : <><Calculator size={16} /> CP-SAT 直接指派排班</>}
           </button>

           <button onClick={handleClearAll} className="schedule-panel__toolbar-btn schedule-panel__toolbar-btn--clear"><Trash2 size={14} /> 清空舊班表</button>

           <button onClick={handleExportExcel} className="schedule-panel__toolbar-btn schedule-panel__toolbar-btn--export"><FileDown size={14} /> Excel</button>
           <button onClick={onSaveSchedule} className="schedule-panel__toolbar-btn schedule-panel__toolbar-btn--save"><Save size={14} /> 儲存並發布</button>
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
                    }).map((rowId, rowIndex) => {
                        const isVirtual = rowId.startsWith('D');
                        return (
                            <tr key={rowId} className={`schedule-panel__row${isVirtual ? ' schedule-panel__row--virtual' : ''}${justGenerated ? ' schedule-panel__row--animate' : ''}`} style={justGenerated ? { animationDelay: `${rowIndex * 80}ms` } : undefined}>
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
          <p>請點擊上方的「CP-SAT 直接指派排班」開始排班，或是切換其他月份。</p>
      </div>}
    </div>
 );
};

export default SchedulePanel;
