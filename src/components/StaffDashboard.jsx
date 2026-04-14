import React, { useState, useEffect } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { updatePassword, EmailAuthProvider, reauthenticateWithCredential } from 'firebase/auth';
import { Loader, Ban, CalendarOff, Clock, Lock, ClipboardList, Lightbulb, PartyPopper, Eye, Bell, Settings, X, Hand, Info, AlertTriangle, CheckCircle, RefreshCw } from 'lucide-react';
import { auth, db } from '../api/database';
import './StaffDashboard.css';

// ============================================================================
// 2. StaffDashboard (員工自助介面 - 顯示已認領班表與協調機制 + 修改密碼功能)
// ============================================================================
const StaffDashboard = ({ currentUser, onConfirmSchedule, targetYear = 2026, targetMonth = 2, currentSchedule, staffData = [], setStaffData, priorityConfig }) => {

  // ★★★ 修正 1：所有的 Hooks (useState) 必須絕對置頂，不能被任何 if return 阻斷 ★★★
  const [showPwdModal, setShowPwdModal] = useState(false);
  const [closingPwdModal, setClosingPwdModal] = useState(false);
  const [pwdData, setPwdData] = useState({ old: '', new: '', confirm: '' });
  const [pwdMsg, setPwdMsg] = useState({ type: '', text: '' });
  const [isPwdSubmitting, setIsPwdSubmitting] = useState(false);

  const closePwdModalAnimated = () => {
    setClosingPwdModal(true);
    setTimeout(() => { setShowPwdModal(false); setClosingPwdModal(false); }, 300);
  };

  const [currentStep, setCurrentStep] = useState(1);
  const [selectedShiftType, setSelectedShiftType] = useState('ALL');
  const [selectedOption, setSelectedOption] = useState(null);
  const [aiSlots, setAiSlots] = useState([]);
  const [previewSchedule, setPreviewSchedule] = useState({});
  const [isProcessing, setIsProcessing] = useState(false);
  const [isExiting, setIsExiting] = useState(false);
  // ★ 新增：嚴格判定該名員工是否已經存在於本月班表中
  const hasClaimed = currentSchedule && Object.keys(currentSchedule).includes(currentUser.id);
  // ★★★ 修正：改為監聽 SelectionTurn/latest，避免年月不一致導致讀到舊資料 ★★★
  const [activeTurn, setActiveTurn] = useState(null);
  useEffect(() => {
      const latestRef = doc(db, "SelectionTurn", "latest");
      const unsub = onSnapshot(latestRef, (docSnap) => {
          if (docSnap.exists()) {
              setActiveTurn(docSnap.data());
          } else {
              // fallback：若 latest 不存在，嘗試讀取原始年月文件
              const turnRef = doc(db, "SelectionTurn", `${targetYear}_${targetMonth}`);
              onSnapshot(turnRef, (fallbackSnap) => {
                  setActiveTurn(fallbackSnap.exists() ? fallbackSnap.data() : null);
              });
          }
      });
      return () => unsub();
  }, [targetYear, targetMonth]);

  // ★★★ 修正 2：useEffect 也必須置頂 ★★★
  useEffect(() => {
    if (!currentSchedule || Object.keys(currentSchedule).length === 0) { setAiSlots([]); return; }
    const daysInMonth = new Date(targetYear, targetMonth, 0).getDate();

    const allSlots = Object.keys(currentSchedule).sort((a, b) => {
        if (a.startsWith('D') && !b.startsWith('D')) return -1;
        if (!a.startsWith('D') && b.startsWith('D')) return 1;
        return a.localeCompare(b);
    });

    const formattedSlots = allSlots.map(slotId => {
        const slotData = currentSchedule[slotId];
        const pattern = [];
        const shiftCounts = { D: 0, E: 0, N: 0 };

        for (let d = 1; d <= daysInMonth; d++) {
            const cell = slotData[d];
            const type = (typeof cell === 'object') ? cell.type : (cell || 'OFF');
            pattern.push(type);
            if (['D', 'E', 'N'].includes(type)) shiftCounts[type]++;
        }

        let mainShift = 'D';
        if (shiftCounts.E > shiftCounts.D && shiftCounts.E > shiftCounts.N) mainShift = 'E';
        if (shiftCounts.N > shiftCounts.D && shiftCounts.N > shiftCounts.E) mainShift = 'N';

        let title = "混合班表";
        if (shiftCounts.D >= 10) title = "白班為主";
        else if (shiftCounts.E >= 10) title = "小夜為主";
        else if (shiftCounts.N >= 10) title = "大夜為主";

        const isClaimed = !slotId.startsWith('D');
        const claimant = isClaimed ? (staffData.find(s => s.staff_id === slotId)?.name || slotId) : null;

        return { id: slotId, title: isClaimed ? `${title}` : `${title} (${slotId})`, shift: mainShift, pattern: pattern, isClaimed: isClaimed, claimantName: claimant };
    });
    setAiSlots(formattedSlots);
  }, [currentSchedule, targetYear, targetMonth, staffData]);

// 計算上個月底的「連續上班天數」，用來銜接本月 1 號的七休一防呆
  const getPrevMonthStreak = () => {
    if (!currentUser || !currentUser.id) return 0;
    if (!staffData || staffData.length === 0) return 0;

    const staff = staffData.find(s => s.staff_id === currentUser.id);
    if (!staff || !staff.prevMonthLeave) return 0;

    // prevMonthLeave 陣列紀錄上個月最後 7 天的「休假狀態」
    // 💡 狀態對應：true = 有休假 (UI打勾)，false = 有上班 (UI未打勾)
    const leaves = staff.prevMonthLeave;
    let streak = 0;

    // 從陣列尾端 (i=6，代表上個月最後一天) 往前倒推檢查
    for (let i = 6; i >= 0; i--) {
      if (leaves[i] !== false) break; // 只有明確 false（上班）才繼續，true 或 undefined 都停止
      streak++;
    }

    return streak;
  };
  const prevStreak = getPrevMonthStreak();

  const handlePasswordSubmit = async (e) => {
      e.preventDefault();
      if (pwdData.new !== pwdData.confirm) return setPwdMsg({ type: 'error', text: '兩次輸入的新密碼不一致！' });
      const strongPasswordRegex = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d]{6,}$/;
      if (!strongPasswordRegex.test(pwdData.new)) return setPwdMsg({ type: 'error', text: '密碼強度不足：需至少 6 碼，且必須包含英文與數字！' });

      setIsPwdSubmitting(true);
      try {
          const user = auth.currentUser;
          if (user) {
              const credential = EmailAuthProvider.credential(user.email, pwdData.old);
              await reauthenticateWithCredential(user, credential);
              await updatePassword(user, pwdData.new);
              setIsPwdSubmitting(false);
              setPwdMsg({ type: 'success', text: '✅ 密碼修改成功！下次請使用新密碼登入。' });
              setTimeout(() => {
                  setClosingPwdModal(true);
                  setTimeout(() => {
                    setShowPwdModal(false);
                    setClosingPwdModal(false);
                    setPwdData({ old: '', new: '', confirm: '' });
                    setPwdMsg({ type: '', text: '' });
                  }, 300);
              }, 2000);
          } else {
              setPwdMsg({ type: 'error', text: '找不到登入狀態，請重新登入。' });
          }
      } catch (error) {
          if (import.meta.env.DEV) console.error("修改密碼失敗:", error);
          if (error.code === 'auth/invalid-credential' || error.code === 'auth/wrong-password') {
              setPwdMsg({ type: 'error', text: '❌ 舊密碼輸入錯誤，請重新確認！' });
          } else if (error.code === 'auth/requires-recent-login') {
              setPwdMsg({ type: 'error', text: '⚠️ 基於安全考量，請先「登出再重新登入」後，才能修改密碼。' });
          } else {
              setPwdMsg({ type: 'error', text: '修改失敗：' + error.message });
          }
      } finally {
          setIsPwdSubmitting(false);
      }
  };

  // ============================================================================
  // ★★★ 修正 3：現在才開始放「條件 Return (防呆)」 ★★★
  // ============================================================================

// 防呆 1: 基本未載入檢查
  if (!currentUser) return <div className="dashboard__loading"><Loader size={18} className="dashboard__spin" /> 正在載入使用者資料...</div>;

  const currentStaffInfo = staffData.find(s => s.staff_id === currentUser.id);

  // 防呆 2: 離職或停權檢查
  if (currentStaffInfo && (currentStaffInfo.is_active === false || currentStaffInfo.is_active === 'false')) {
      return (
          <div className="dashboard__guard">
              <div className="dashboard__guard-icon"><Ban size={48} /></div>
              <h2 className="dashboard__guard-title--inactive">帳號無效 / 已離職</h2>
              <p className="dashboard__guard-text">您的帳號目前為「非在職狀態」，無法登入選班。<br/>如有疑問請洽詢護理長。</p>
          </div>
      );
  }

  // 防呆 3: 長假/特殊狀態檢查
  if (currentStaffInfo && currentStaffInfo.leave_status && currentStaffInfo.leave_status !== 'None') {
      const statusMap = { Maternal: '產假/育嬰假', Student: '進修留職', OnLeave: '長假' };
      const statusName = statusMap[currentStaffInfo.leave_status] || '特殊休假';
      return (
          <div className="dashboard__guard">
              <div className="dashboard__guard-icon"><CalendarOff size={48} /></div>
              <h2 className="dashboard__guard-title--leave">暫停排班</h2>
              <p className="dashboard__guard-text">您目前的狀態為<strong>「{statusName}」</strong>，本月不需參與系統排班作業。<br/>祝您休假愉快！</p>
          </div>
      );
  }

  // 防呆 4: AI 接力選班引擎鎖定 (最核心！)
  // 若引擎有指定人 (active_staff_id 有值)，且那個人不是我，我就不能選！
  // ★ 但已經認領過的員工不受此限制，允許他們查看自己的班表
  const activeStaffIdSafe = activeTurn?.active_staff_id ? String(activeTurn.active_staff_id).trim().toUpperCase() : null;
  const currentUserIdSafe = currentUser?.id ? String(currentUser.id).trim().toUpperCase() : null;

  if (!hasClaimed && activeStaffIdSafe && currentUserIdSafe && activeStaffIdSafe !== currentUserIdSafe) {
      const activeStaffName = staffData.find(s => String(s.staff_id).trim().toUpperCase() === activeStaffIdSafe)?.name || activeTurn.active_staff_id;
      return (
          <div className="dashboard__guard">
              <div className="dashboard__guard-icon dashboard__guard-icon--pulse"><Clock size={48} /></div>
              <h2 className="dashboard__guard-title--locked">尚未輪到您選班</h2>
              <div className="dashboard__guard-info">
                  目前的 <strong>優先發球權</strong> 在 <span className="dashboard__guard-highlight">{activeStaffName}</span> 手上。<br/><br/>
                  為確保最需要的人能優先挑選好班，請等待 AI 引擎發送您的專屬換棒 Email 通知！
              </div>
              <button onClick={() => window.location.reload()} className="dashboard__guard-refresh-btn"><RefreshCw size={14} /> 重新整理確認狀態</button>
          </div>
      );
  }

  const checkCompliance = (pattern) => {
    // ★★★ 新增：3. 提前攔截！檢查母性保護 (懷孕/哺乳禁止夜班) ★★★
      const currentStaffInfo = staffData.find(s => s.staff_id === currentUser.id);
      const isPregnant = currentStaffInfo?.is_pregnant_or_nursing === true || currentStaffInfo?.is_pregnant_or_nursing === 'True' || currentStaffInfo?.is_pregnant_or_nursing === 'true';

      if (isPregnant) {
          for (let i = 0; i < pattern.length; i++) {
              if (pattern[i] === 'E' || pattern[i] === 'N') {
                  return { valid: false, reason: `違反母性保護 (含有夜間班別)` };
              }
          }
      }
      // 1. 檢查七休一
      let currentStreak = prevStreak;
      for (let i = 0; i < pattern.length; i++) {
          const shift = pattern[i];
          if (shift !== 'OFF' && shift !== 'RG' && shift !== 'RC' && shift !== '空班') currentStreak++;
          else currentStreak = 0;
          if (currentStreak > 6) return { valid: false, reason: `違反七休一 (第${i+1}天連上${currentStreak}天)` };
      }

      // 2. 檢查輪班間隔 (必須包在這個函式裡面！)
      const isForbiddenSeq = (a, b) => (a==='E'&&b==='D') || (a==='N'&&b==='D') || (a==='N'&&b==='E');
      for (let i = 0; i < pattern.length - 1; i++) {
          if (isForbiddenSeq(pattern[i], pattern[i+1])) {
              return { valid: false, reason: `第${i+1}天 ${pattern[i]} 接 ${pattern[i+1]} 輪班間隔不足` };
          }
      }

      // 如果都沒違規，才回傳 true
      return { valid: true };
  };


  // ★ 未認領的員工：只顯示未被選走的班表；已認領的員工：可查看全部
  const visibleSlots = hasClaimed ? aiSlots : aiSlots.filter(opt => !opt.isClaimed);
  const filteredOptions = selectedShiftType === 'ALL' ? visibleSlots : visibleSlots.filter(opt => opt.shift === selectedShiftType);

  const handleSelectType = (type) => { setIsProcessing(true); setTimeout(() => { setSelectedShiftType(type); setCurrentStep(2); setIsProcessing(false); }, 300); };
  const handleSelectOption = (opt) => { setSelectedOption(opt.id); const map = {}; opt.pattern.forEach((s, i) => map[i+1] = { type: s, time: '' }); setPreviewSchedule(map); setCurrentStep(3); };
const handleFinalSubmit = async () => { // 🌟 1. 加上 async
    if (hasClaimed) {
        alert("⚠️ 您已經認領過班表，無法重複認領！");
        return;
    }

    const choice = aiSlots.find(opt => opt.id === selectedOption);
    if (!choice || choice.isClaimed) {
        alert("⚠️ 此班表已被他人搶先選擇並鎖住！\n請返回重新選擇。");
        setCurrentStep(2);
        return;
    }

    // 🌟 2. 啟動鎖定狀態，防止員工亂點
    setIsProcessing(true);

    // 🌟 3. 加上 await，強制等待主程式 (存檔 + AI算分數 + 寄信) 跑完！
    await onConfirmSchedule({
        staffId: currentUser.id,
        staffName: currentUser.name,
        shiftType: selectedShiftType === 'ALL' ? 'D' : selectedShiftType,
        chosenSchedule: { id: choice.id, title: choice.title },
        fullMonthData: previewSchedule
    });

    // 🌟 4. 全部跑完才解鎖並進入成功畫面
    setIsProcessing(false);
    setCurrentStep(4);
  };
  const getShiftColor = (shift) => { if (shift === 'D') return '#FFD93D'; if (shift === 'E') return '#FF6B9D'; if (shift === 'N') return '#4D96FF'; return '#f0f0f0'; };
  const firstDayOfWeek = new Date(targetYear, targetMonth - 1, 1).getDay();

  return (
    <div className="dashboard">

      {/* ★★★ 新增：修改密碼 Modal 視窗 ★★★ */}
      {showPwdModal && (
        <div className={`dashboard__pwd-overlay${closingPwdModal ? ' dashboard__pwd-overlay--closing' : ''}`}>
            <div className={`dashboard__pwd-modal${closingPwdModal ? ' dashboard__pwd-modal--closing' : ''}`}>
                <button onClick={closePwdModalAnimated} className="dashboard__pwd-close-btn"><X size={14} /></button>
                <h3 className="dashboard__pwd-title"><Settings size={18} /> 修改密碼</h3>
                <form onSubmit={handlePasswordSubmit} className="dashboard__pwd-form">
                    <div>
                        <label className="dashboard__pwd-label">舊密碼 (預設: 123456)</label>
                        <input type="password" value={pwdData.old} onChange={e=>setPwdData({...pwdData, old: e.target.value})} required className="dashboard__pwd-input" />
                    </div>
                    <div>
                        <label className="dashboard__pwd-label">新密碼</label>
                        <input type="password" value={pwdData.new} onChange={e=>setPwdData({...pwdData, new: e.target.value})} required minLength="4" className="dashboard__pwd-input" />
                    </div>
                    <div>
                        <label className="dashboard__pwd-label">確認新密碼</label>
                        <input type="password" value={pwdData.confirm} onChange={e=>setPwdData({...pwdData, confirm: e.target.value})} required minLength="4" className="dashboard__pwd-input" />
                    </div>
                    {pwdMsg.text && (
                        <div className={`dashboard__pwd-msg ${pwdMsg.type === 'error' ? 'dashboard__pwd-msg--error' : 'dashboard__pwd-msg--success'}`}>
                            {pwdMsg.text}
                        </div>
                    )}
                    <button type="submit" disabled={isPwdSubmitting} className={`dashboard__pwd-submit-btn${isPwdSubmitting ? ' dashboard__pwd-submit-btn--loading' : ''}`}>
                        {isPwdSubmitting ? <><span className="dashboard__pwd-spinner" /> 驗證中...</> : '儲存修改'}
                    </button>
                </form>
            </div>
        </div>
      )}

      <div className="dashboard__stepper">
          {['班別選擇', '認領班表', '確認預覽', '完成'].map((label, idx) => (
              <div key={idx} className={`dashboard__step ${currentStep >= idx+1 ? 'dashboard__step--active' : ''}`}>{idx+1}. {label}</div>
          ))}
      </div>

      {currentStep === 1 && (
        <div className="dashboard__step1">
          <div className="dashboard__header-row">
             <h2 className="dashboard__greeting"><Hand size={22} /> 嗨，{currentUser.name}</h2>
              {/* ★★★ 新增：修改密碼按鈕 ★★★ */}
              <button onClick={() => setShowPwdModal(true)} className="dashboard__pwd-btn"><Settings size={14} /> 修改密碼</button>
          </div>

          <h3 className="dashboard__month-subtitle">
            目前開放認領月份：<span className="dashboard__month-highlight">{targetYear}年 {targetMonth}月</span>
          </h3>

          <div className="dashboard__streak-info">
              <Info size={14} /> 系統偵測：您上個月底已連續上班 <strong>{prevStreak}</strong> 天。
              {prevStreak >= 6 && <div className="dashboard__streak-warning"><AlertTriangle size={14} /> 警告：您已達連六上限，本月 1 號必須排休！</div>}
          </div>

          {!currentSchedule || Object.keys(currentSchedule).length === 0 ? (
              <div className="dashboard__no-schedule"><AlertTriangle size={16} /> 管理員尚未發布此月份 ({targetMonth}月) 的班表，請稍後再來。</div>
          ) : hasClaimed ? (
              // ★ 已經認領過的畫面：顯示完成狀態 + 自己的班表月曆
              <div className="dashboard__claimed-banner">
                  <h3 className="dashboard__claimed-title"><CheckCircle size={18} /> 您已完成 {targetMonth} 月的認領！</h3>
                  <p className="dashboard__claimed-desc">您的排班已成功鎖定。選好的班表不能再被選一次。</p>

                  {/* 我的班表月曆 */}
                  {(() => {
                    const myData = currentSchedule[currentUser.id];
                    if (!myData) return null;
                    const daysInMonth = new Date(targetYear, targetMonth, 0).getDate();
                    const weekDays = ['日', '一', '二', '三', '四', '五', '六'];
                    return (
                      <div className="dashboard__my-calendar">
                        <h4 className="dashboard__my-calendar-title"><ClipboardList size={16} /> 我的 {targetMonth} 月班表</h4>
                        <div className="dashboard__my-calendar-grid">
                          {weekDays.map(w => <div key={w} className="dashboard__my-calendar-header">{w}</div>)}
                          {Array.from({ length: firstDayOfWeek }).map((_, i) => <div key={`empty-${i}`} className="dashboard__my-calendar-empty" />)}
                          {Array.from({ length: daysInMonth }).map((_, i) => {
                            const day = i + 1;
                            const cell = myData[day];
                            const shift = (typeof cell === 'object') ? (cell?.type || 'OFF') : (cell || 'OFF');
                            return (
                              <div key={day} className={`dashboard__my-calendar-cell dashboard__my-calendar-cell--${shift.toLowerCase()}`}>
                                <span className="dashboard__my-calendar-day">{day}</span>
                                <span className="dashboard__my-calendar-shift">{shift}</span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })()}

                  <p className="dashboard__claimed-note">如需修改，請聯繫護理長在後台將您「拔除釋出」，您才能重新選擇。</p>
                  <button onClick={() => setCurrentStep(2)} className="dashboard__claimed-view-btn"><Eye size={14} /> 進入查看所有人認領狀況</button>
              </div>
          ) : (
              // ★ 尚未認領的畫面：顯示閃爍提醒與選擇按鈕
              <>
                <div className="dashboard__unclaimed-alert">
                    <Bell size={16} /> 提醒：您尚未認領 {targetMonth} 月的班表，請盡速於下方選擇！
                </div>
                <p className="dashboard__shift-prompt">請選擇您下個月希望認領的班別類型：</p>

                <div className="dashboard__shift-buttons">
                  <button onClick={() => handleSelectType('ALL')} disabled={isProcessing}
                      className={`dashboard__shift-btn dashboard__shift-btn--all ${isProcessing ? 'dashboard__shift-btn--disabled' : ''}`}>
                      全部顯示
                  </button>
                  {[{t:'D',l:'白班'}, {t:'E',l:'小夜'}, {t:'N',l:'大夜'}].map(i => (
                      <button key={i.t} onClick={() => handleSelectType(i.t)} disabled={isProcessing}
                          className={`dashboard__shift-btn ${isProcessing ? 'dashboard__shift-btn--disabled' : ''}`}
                          style={{ background: getShiftColor(i.t) }}>
                          {i.l}
                      </button>
                  ))}
                </div>
              </>
          )}
        </div>
      )}

      {currentStep === 2 && (
        <div>
          <button onClick={() => setCurrentStep(1)} className="dashboard__back-btn">← 返回</button>
          <h2 className="dashboard__step2-title"><ClipboardList size={20} /> 選擇整月方案 ({targetYear}年{targetMonth}月)</h2>
          <div className="dashboard__step2-hint"><Lightbulb size={14} /> 提示：灰底並標示「鎖頭」的班表代表已被其他人選走。若您極需該班表，請私下與該同仁協調。</div>
          {hasClaimed && <div className="dashboard__claimed-readonly"><Lock size={14} /> 您已完成認領，目前僅供檢視狀態，無法再選擇其他班表。</div>}
          <div className="dashboard__options-grid">
            {filteredOptions.length === 0 ? (
              <div className="dashboard__options-empty"><h3>無符合條件的推薦方案 😕</h3></div>
            ) : (
              filteredOptions.map(opt => {
                const check = checkCompliance(opt.pattern);
                const isSelectable = !opt.isClaimed && check.valid && !hasClaimed; // ★ 加上 && !hasClaimed 徹底鎖死點擊;
                const shiftColors = { 'D': '#FFD93D', 'E': '#FF6B9D', 'N': '#4D96FF', 'RG': '#2ecc71', 'RC': '#d5f5e3', 'OFF': '#d5f5e3', '空班': '#d5f5e3' };

                const cardClass = [
                    'dashboard__shift-card',
                    selectedOption === opt.id ? 'dashboard__shift-card--selected' : '',
                    opt.isClaimed ? 'dashboard__shift-card--claimed' : '',
                    !opt.isClaimed && !check.valid ? 'dashboard__shift-card--invalid' : ''
                ].filter(Boolean).join(' ');

                return (
                    <div key={opt.id} onClick={() => isSelectable && handleSelectOption(opt)}
                        className={cardClass}
                        style={{ cursor: isSelectable ? 'pointer' : 'not-allowed' }}>
                        <div className="dashboard__shift-card-header">
                            <div>
                                <div className={`dashboard__shift-card-title ${opt.isClaimed ? 'dashboard__shift-card-title--claimed' : ''}`}>{opt.title}</div>
                                {opt.isClaimed && <div className="dashboard__shift-card-locked"><Lock size={12} /> 已被 {opt.claimantName} 選擇 (請員工間自主協調)</div>}
                            </div>
                            {!opt.isClaimed && !check.valid && <div className="dashboard__shift-card-warning"><AlertTriangle size={12} /> {check.reason}</div>}
                        </div>
                        <div className={`dashboard__mini-calendar ${opt.isClaimed ? 'dashboard__mini-calendar--greyed' : ''}`}>
                            {['日','一','二','三','四','五','六'].map(d => <div key={d} className="dashboard__mini-calendar-weekday">{d}</div>)}
                            {Array.from({ length: firstDayOfWeek }).map((_, i) => <div key={`empty-${i}`} />)}
                            {opt.pattern.map((s, i) => {
                              const isLight = ['RG','RC','OFF','空班'].includes(s);
                              return (
                                <div key={i} title={`${i+1}號: ${s}`}
                                    className={`dashboard__mini-calendar-cell ${isLight ? 'dashboard__mini-calendar-cell--light' : 'dashboard__mini-calendar-cell--dark'}`}
                                    style={{ background: shiftColors[s] || '#edf2f7' }}>
                                       {i+1}
                                </div>
                              );
                            })}
                        </div>
                    </div>
                );
            }))}
          </div>
        </div>
      )}

      {currentStep === 3 && (
        <div>
          <button onClick={() => setCurrentStep(2)} className="dashboard__back-btn">← 重選</button>
          <h2 className="dashboard__step3-title">確認您的班表 ({targetYear}年{targetMonth}月)</h2>
          <div className="dashboard__preview-grid">
              {['日','一','二','三','四','五','六'].map(d=><div key={d} className="dashboard__preview-weekday">{d}</div>)}
              {Array.from({ length: firstDayOfWeek }).map((_, i) => <div key={`e-${i}`} />)}
              {Object.keys(previewSchedule).map(d => {
                  const cell = previewSchedule[d];
                  const type = (typeof cell === 'object') ? cell.type : cell;
                  const shiftColors = { 'D': '#FFD93D', 'E': '#FF6B9D', 'N': '#4D96FF', 'RG': '#2ecc71', 'RC': '#d5f5e3', 'OFF': '#E8E8E8', '空班': '#E8E8E8', '支援': '#D4AC0D' };
                  const bgColor = shiftColors[type] || '#fff';
                  const isDarkBg = ['D', 'E', 'N', 'RG', '支援'].includes(type);
                  return (
                      <div key={d} className={`dashboard__preview-cell ${!isDarkBg ? 'dashboard__preview-cell--light' : ''}`} style={{ background: bgColor }}>
                          <div className={`dashboard__preview-day ${isDarkBg ? 'dashboard__preview-day--dark' : 'dashboard__preview-day--light'}`}>{d}</div>
                          <div className={`dashboard__preview-type ${isDarkBg ? 'dashboard__preview-type--dark' : 'dashboard__preview-type--light'}`}>{type}</div>
                      </div>
                  )
              })}
          </div>
          <div className="dashboard__confirm-area">
            <button
    onClick={handleFinalSubmit}
    disabled={isProcessing}
    className={`dashboard__confirm-btn ${isProcessing ? 'dashboard__confirm-btn--processing' : 'dashboard__confirm-btn--active'}`}
>
    {isProcessing ? <><Loader size={14} className="dashboard__spin" /> 正在交棒給下一位 (約需10秒)...</> : '確認認領'}
</button>
          </div>
        </div>
      )}

      {currentStep === 4 && (
        <div className={`dashboard__success${isExiting ? ' dashboard__success--exiting' : ''}`}>
          <h2 className="dashboard__success-title"><PartyPopper size={24} /> 認領成功！</h2>
          <p className="dashboard__success-text">您的班表已成功送出，系統已更新。<br/>(您選擇的月份：{targetYear}年 {targetMonth}月)</p>
          <button onClick={() => { setIsExiting(true); setTimeout(() => window.location.reload(), 500); }} className="dashboard__success-btn">回首頁</button>
        </div>
      )}
    </div>
  );
};

export default StaffDashboard;
