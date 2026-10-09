import React, { useState } from 'react';
import { X, Mail, KeyRound, Check, AlertCircle, ArrowRight } from 'lucide-react';
import './ForgotPasswordModal.css';

// 自助「忘記密碼」三步驟流程（毛玻璃 modal，掛在 LoginPanel 內）：
//   step 'request' → 輸入工號 + 註冊信箱 → POST request-reset（後端核對後寄 6 位驗證碼）
//   step 'verify'  → 輸入驗證碼 + 新密碼 → POST verify-reset-otp → 後端直接設定新密碼
//   step 'done'    → 完成，工號帶回登入表單（onFilled），用剛設的新密碼登入
//
// 不再發「暫時密碼」顯示在畫面上（公用電腦易被旁人看到），驗證碼通過就由本人當場設新密碼。
//
// 後端一律回通用訊息以防帳號列舉，所以 request 成功與否前端都前進到 verify 步驟。
const ForgotPasswordModal = ({ onClose, onFilled }) => {
  const [closing, setClosing] = useState(false);
  const [step, setStep] = useState('request');
  const [staffId, setStaffId] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const close = () => {
    setClosing(true);
    setTimeout(() => onClose(), 250);
  };

  const post = async (body) => {
    const r = await fetch('/api/activate-account', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `伺服器回應 ${r.status}`);
    return data;
  };

  const handleRequest = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const data = await post({
        action: 'request-reset',
        staffId: staffId.trim(),
        email: email.trim(),
      });
      setNotice(data.message || '若資料正確，驗證碼已寄出。');
      setStep('verify');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleVerify = async (e) => {
    e.preventDefault();
    setError('');
    if (newPassword !== confirmPassword) {
      setError('兩次輸入的新密碼不一致');
      return;
    }
    setBusy(true);
    try {
      await post({
        action: 'verify-reset-otp',
        staffId: staffId.trim(),
        code: code.trim(),
        newPassword,
      });
      setNewPassword('');
      setConfirmPassword('');
      setStep('done');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const backToLogin = () => {
    if (onFilled) onFilled(staffId.trim());
    close();
  };

  return (
    <div className={`forgot-pw__overlay ${closing ? 'forgot-pw__overlay--closing' : ''}`} onClick={close}>
      <div className="forgot-pw__card" onClick={(e) => e.stopPropagation()}>
        <button className="forgot-pw__close" onClick={close} aria-label="關閉"><X size={18} /></button>

        <h3 className="forgot-pw__title"><KeyRound size={18} /> 忘記密碼</h3>

        {/* 步驟指示 */}
        <div className="forgot-pw__steps">
          <span className={`forgot-pw__step ${step === 'request' ? 'is-active' : ''}`}>1 驗證身分</span>
          <span className={`forgot-pw__step ${step === 'verify' ? 'is-active' : ''}`}>2 設定新密碼</span>
          <span className={`forgot-pw__step ${step === 'done' ? 'is-active' : ''}`}>3 完成</span>
        </div>

        {error && <div className="forgot-pw__msg forgot-pw__msg--error"><AlertCircle size={14} /> {error}</div>}

        {step === 'request' && (
          <form onSubmit={handleRequest} className="forgot-pw__form">
            <p className="forgot-pw__hint">請輸入您的工號與當初登記的 Email，我們會寄送 6 位驗證碼到該信箱。</p>
            <input
              className="forgot-pw__input" value={staffId} autoFocus
              onChange={(e) => setStaffId(e.target.value)}
              placeholder="工號（例如 N001）" required
            />
            <input
              className="forgot-pw__input" type="email" value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="註冊 Email" required
            />
            <button type="submit" className="forgot-pw__btn" disabled={busy}>
              {busy ? '寄送中…' : <><Mail size={15} /> 寄送驗證碼</>}
            </button>
          </form>
        )}

        {step === 'verify' && (
          <form onSubmit={handleVerify} className="forgot-pw__form">
            {notice && <div className="forgot-pw__msg forgot-pw__msg--info">{notice}</div>}
            <input
              className="forgot-pw__input forgot-pw__input--code" value={code} autoFocus
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="6 位驗證碼" inputMode="numeric" maxLength={6} required
            />
            <input
              className="forgot-pw__input" type="password" value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="新密碼（至少 6 碼，含英文與數字）" autoComplete="new-password" required
            />
            <input
              className="forgot-pw__input" type="password" value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="再輸入一次新密碼" autoComplete="new-password" required
            />
            <button type="submit" className="forgot-pw__btn" disabled={busy || code.length !== 6 || !newPassword}>
              {busy ? '設定中…' : <><ArrowRight size={15} /> 驗證並設定新密碼</>}
            </button>
            <button type="button" className="forgot-pw__link" onClick={() => { setStep('request'); setError(''); setCode(''); }}>
              沒收到？重新申請
            </button>
          </form>
        )}

        {step === 'done' && (
          <div className="forgot-pw__form">
            <div className="forgot-pw__msg forgot-pw__msg--info">
              <Check size={14} /> 密碼已重設，其他裝置上的登入已全部登出。請用新密碼登入。
            </div>
            <button type="button" className="forgot-pw__btn" onClick={backToLogin}>
              回到登入
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default ForgotPasswordModal;
