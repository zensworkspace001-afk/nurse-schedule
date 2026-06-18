import React, { useState } from 'react';
import { KeyRound, AlertCircle, ShieldCheck, LogOut } from 'lucide-react';
import { auth } from '../api/database';
import './ForcedPasswordChange.css';

// 強制改密頁 — 當 myStaffRow.must_change_password === true 時由 App.jsx 攔下顯示。
// 觸發來源：員工用「忘記密碼」拿到的暫時密碼登入後（後端在發暫時密碼時設了旗標）。
// 改密走後端 /api/complete-profile mode:'change-password'（Admin SDK 設密碼 + 清旗標），
// 旗標一清，App.jsx 訂閱的 myStaffRow 更新 → gate 自動放行進入系統。
const strongPasswordRegex = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d!@#$%^&*()_+\-=]{6,}$/;

const ForcedPasswordChange = ({ currentUser, onLogout }) => {
  const [pw1, setPw1] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (pw1 !== pw2) return setError('兩次輸入的新密碼不一致');
    if (!strongPasswordRegex.test(pw1)) return setError('密碼至少 6 碼，且需同時包含英文與數字');
    if (pw1 === '123456') return setError('密碼不可使用預設值');

    setBusy(true);
    try {
      const token = await auth.currentUser?.getIdToken();
      if (!token) throw new Error('登入狀態已失效，請重新登入');
      const r = await fetch('/api/complete-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ mode: 'change-password', newPassword: pw1 }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `伺服器回應 ${r.status}`);
      setDone(true);
      // 旗標清除後 myStaffRow 訂閱會更新，App.jsx gate 自動放行；此處顯示短暫成功提示。
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="forced-pw">
      <div className="forced-pw__card">
        <h2 className="forced-pw__title"><KeyRound size={20} /> 請設定新密碼</h2>
        <p className="forced-pw__sub">
          您目前使用的是系統發給的暫時密碼{currentUser?.name ? `，${currentUser.name}` : ''}。
          基於安全考量，請先設定一組新密碼才能繼續使用系統。
        </p>

        {done ? (
          <div className="forced-pw__msg forced-pw__msg--ok">
            <ShieldCheck size={16} /> 密碼已更新，正在進入系統…
          </div>
        ) : (
          <form onSubmit={submit} className="forced-pw__form">
            {error && <div className="forced-pw__msg forced-pw__msg--err"><AlertCircle size={14} /> {error}</div>}
            <input
              className="forced-pw__input" type="password" value={pw1} autoFocus
              onChange={(e) => setPw1(e.target.value)}
              placeholder="新密碼（至少 6 碼，含英文與數字）" required
            />
            <input
              className="forced-pw__input" type="password" value={pw2}
              onChange={(e) => setPw2(e.target.value)}
              placeholder="再次輸入新密碼" required
            />
            <button type="submit" className="forced-pw__btn" disabled={busy}>
              {busy ? '更新中…' : '設定新密碼並進入系統'}
            </button>
            <button type="button" className="forced-pw__logout" onClick={onLogout}>
              <LogOut size={13} /> 先登出，稍後再改
            </button>
          </form>
        )}
      </div>
    </div>
  );
};

export default ForcedPasswordChange;
