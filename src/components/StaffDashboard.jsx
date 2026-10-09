import React, { useState } from 'react';
import { updatePassword, EmailAuthProvider, reauthenticateWithCredential } from 'firebase/auth';
import { Loader, Ban, CalendarOff, Clock, ClipboardList, Settings, X, Hand, CheckCircle, Camera } from 'lucide-react';
import { auth } from '../api/database';
import AvatarEditModal from './AvatarEditModal';
import LeaveWishPicker from './LeaveWishPicker';
import './StaffDashboard.css';

// ============================================================================
// 2. StaffDashboard (員工自助介面 - 檢視自己的班表、預假、修改密碼與頭貼)
// ============================================================================
// myStaffRow：員工自己的完整 row（含 leave_status / is_pregnant_or_nursing 等敏感欄位）。
//             由 App.jsx 從 StaffPrivate/{id} 訂閱後傳入。
//             staffData 現在只含同事的精簡公開投影（staff_id, name, level, is_leader, is_active），
//             不再含上述敏感欄位 — 故所有「自己的」狀態檢查都改用 myStaffRow。
const StaffDashboard = ({ currentUser, myStaffRow, targetYear = 2026, targetMonth = 2, currentSchedule, leaveWish = null }) => {

  // ★★★ 修正 1：所有的 Hooks (useState) 必須絕對置頂，不能被任何 if return 阻斷 ★★★
  const [showPwdModal, setShowPwdModal] = useState(false);
  const [closingPwdModal, setClosingPwdModal] = useState(false);
  const [pwdData, setPwdData] = useState({ old: '', new: '', confirm: '' });
  const [pwdMsg, setPwdMsg] = useState({ type: '', text: '' });
  const [isPwdSubmitting, setIsPwdSubmitting] = useState(false);
  const [showAvatarEdit, setShowAvatarEdit] = useState(false);

  const closePwdModalAnimated = () => {
    setClosingPwdModal(true);
    setTimeout(() => { setShowPwdModal(false); setClosingPwdModal(false); }, 300);
  };

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

  // 自己的完整 row（含敏感欄位）走 myStaffRow，不再從 staffData 撈
  const currentStaffInfo = myStaffRow;

  // 把「編輯頭貼 modal + 修改密碼 modal + 頂部 header row」抽成可重用 JSX，
  // 讓每個 guard 早退出畫面都能用，UX 跟正常 step1 完全一致：
  //   [頭貼圓圈] 嗨，xxx                 [修改密碼]
  // 為什麼三樣都要共用：以前 guard 內塞了大塊「編輯頭貼」按鈕，視覺不統一且
  // 沒密碼修改入口；現在統一 header row 後，被鎖住的員工（離職/長假/沒輪到/
  // 班表滿）至少都能正常改密碼。
  const avatarModalElement = showAvatarEdit && (
    <AvatarEditModal
      myStaffRow={myStaffRow}
      onClose={() => setShowAvatarEdit(false)}
    />
  );

  const pwdModalElement = showPwdModal && (
    <div
        className={`dashboard__pwd-overlay${closingPwdModal ? ' dashboard__pwd-overlay--closing' : ''}`}
        onClick={(e) => { if (e.target === e.currentTarget) closePwdModalAnimated(); }}
        role="button"
        tabIndex={-1}
        aria-label="點空白處關閉"
    >
        <div className={`dashboard__pwd-modal${closingPwdModal ? ' dashboard__pwd-modal--closing' : ''}`}>
            <button onClick={closePwdModalAnimated} className="dashboard__pwd-close-btn"><X size={14} /></button>
            <h3 className="dashboard__pwd-title"><Settings size={18} /> 修改密碼</h3>
            <form onSubmit={handlePasswordSubmit} className="dashboard__pwd-form">
                <div>
                    <label className="dashboard__pwd-label">舊密碼</label>
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
  );

  // 共用 header row — 與 step1 dashboard__header-row 完全相同的結構與樣式
  const dashboardHeader = (
    <div className="dashboard__header-row">
      <h2 className="dashboard__greeting">
        <button
          type="button"
          onClick={() => setShowAvatarEdit(true)}
          className="dashboard__avatar-btn"
          title="點擊更換頭貼"
          aria-label="編輯頭貼"
        >
          {myStaffRow?.avatar ? (
            <img src={myStaffRow.avatar} alt="頭貼" className="dashboard__greeting-avatar" />
          ) : (
            <span className="dashboard__avatar-fallback">
              <Hand size={22} />
            </span>
          )}
          <span className="dashboard__avatar-cam"><Camera size={12} /></span>
        </button>
        嗨，{currentUser.name}
      </h2>
      <button onClick={() => setShowPwdModal(true)} className="dashboard__pwd-btn"><Settings size={14} /> 修改密碼</button>
    </div>
  );

  // 我的班表月曆 — 已認領畫面與直接指派畫面共用
  const renderMyCalendar = (myData) => {
    if (!myData) return null;
    const daysInMonth = new Date(targetYear, targetMonth, 0).getDate();
    const firstWeekday = new Date(targetYear, targetMonth - 1, 1).getDay();
    const weekDays = ['日', '一', '二', '三', '四', '五', '六'];
    return (
      <div className="dashboard__my-calendar">
        <h4 className="dashboard__my-calendar-title"><ClipboardList size={16} /> 我的 {targetMonth} 月班表</h4>
        <div className="dashboard__my-calendar-grid">
          {weekDays.map(w => <div key={w} className="dashboard__my-calendar-header">{w}</div>)}
          {Array.from({ length: firstWeekday }).map((_, i) => <div key={`empty-${i}`} className="dashboard__my-calendar-empty" />)}
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
  };

  // 預假月曆：護理長開放期間顯示（離職 / 長假的防呆 2、3 在它之前 return，不會看到）。
  // 預假通常在班表發布前開放，所以「尚未輪到您」「班表已認領完」等待畫面也要放。
  const leaveWishElement = leaveWish?.open && currentUser?.id ? (
    <LeaveWishPicker staffId={currentUser.id} leaveWish={leaveWish} />
  ) : null;

  // 防呆 2: 離職或停權檢查
  // 離職員工仍允許登入並改密碼（避免帳號被前同事盜用），但不開放頭貼編輯
  // —— 已離職的個資不該再讓本人擅自修改。
  if (currentStaffInfo && (currentStaffInfo.is_active === false || currentStaffInfo.is_active === 'false')) {
      return (
          <>
              {pwdModalElement}
              <div className="dashboard__guard">
                  <div className="dashboard__header-row">
                      <h2 className="dashboard__greeting">嗨，{currentUser.name}</h2>
                      <button onClick={() => setShowPwdModal(true)} className="dashboard__pwd-btn"><Settings size={14} /> 修改密碼</button>
                  </div>
                  <div className="dashboard__guard-icon"><Ban size={48} /></div>
                  <h2 className="dashboard__guard-title--inactive">帳號無效 / 已離職</h2>
                  <p className="dashboard__guard-text">您的帳號目前為「非在職狀態」，無法登入選班。<br/>如有疑問請洽詢護理長。</p>
              </div>
          </>
      );
  }

  // 防呆 3: 長假/特殊狀態檢查（產假與長假本月不排班）
  if (currentStaffInfo && (currentStaffInfo.leave_status === 'Maternal' || currentStaffInfo.leave_status === 'OnLeave')) {
      const statusMap = { Maternal: '產假/育嬰假', OnLeave: '長假' };
      const statusName = statusMap[currentStaffInfo.leave_status];
      return (
          <>
              {avatarModalElement}
              {pwdModalElement}
              <div className="dashboard__guard">
                  {dashboardHeader}
                  <div className="dashboard__guard-icon"><CalendarOff size={48} /></div>
                  <h2 className="dashboard__guard-title--leave">暫停排班</h2>
                  <p className="dashboard__guard-text">您目前的狀態為<strong>「{statusName}」</strong>，本月不需參與系統排班作業。<br/>祝您休假愉快！</p>
              </div>
          </>
      );
  }

  // 主畫面：本月班表（護理長以 CP-SAT 直接指派後發布，員工只能檢視）
  const hasSchedule = currentSchedule && Object.keys(currentSchedule).length > 0;
  const myData = hasSchedule ? currentSchedule[currentUser.id] : null;
  return (
      <>
          {avatarModalElement}
          {pwdModalElement}
          <div className="dashboard__guard">
              {dashboardHeader}
              {leaveWishElement}
              {!hasSchedule ? (
                  <>
                      <div className="dashboard__guard-icon"><Clock size={48} /></div>
                      <h2 className="dashboard__guard-title--locked">班表尚未發布</h2>
                      <div className="dashboard__guard-info">
                          護理長尚未發布 <strong>{targetYear} 年 {targetMonth} 月</strong> 的班表，發布後會顯示在這裡。
                      </div>
                  </>
              ) : myData ? (
                  <div className="dashboard__claimed-banner">
                      <h3 className="dashboard__claimed-title"><CheckCircle size={18} /> 您 {targetYear} 年 {targetMonth} 月的班表</h3>
                      {renderMyCalendar(myData)}
                      <p className="dashboard__claimed-note">如需調整班別，請與護理長聯繫。</p>
                  </div>
              ) : (
                  <>
                      <div className="dashboard__guard-icon"><CalendarOff size={48} /></div>
                      <h2 className="dashboard__guard-title--locked">本月沒有排入班次</h2>
                      <div className="dashboard__guard-info">
                          <strong>{targetYear} 年 {targetMonth} 月</strong> 的班表已發布，您本月沒有排入班次。<br/><br/>
                          如有疑問請聯絡護理長。
                      </div>
                  </>
              )}
          </div>
      </>
  );
};

export default StaffDashboard;
