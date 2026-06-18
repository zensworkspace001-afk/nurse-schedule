import React, { useState, useEffect } from 'react';
import {
  signInWithEmailAndPassword,
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
} from 'firebase/auth';
import { AlertCircle, LogIn, Shield, Eye, EyeOff } from 'lucide-react';
import { auth, subscribeToAnnouncement } from '../api/database';
import WeatherClockWidget from './WeatherClockWidget';
import AnnouncementBanner from './AnnouncementBanner';
import ForgotPasswordModal from './ForgotPasswordModal';
import './LoginPanel.css';

// Hook：偵測是否為行動版尺寸（≤640px）
// 桌面：widget 渲染在卡片外（position: fixed 才能黏到 viewport 右上角）
// 行動：widget 渲染在卡片內（嵌進去當頂端的薄玻璃條）
// 不能單純用 CSS 控制 — 卡片有 backdrop-filter 會建立 containing block，
// 把裡面的 position: fixed 鎖在卡片內。
function useIsMobile(breakpoint = 640) {
  const [isMobile, setIsMobile] = useState(
    typeof window !== 'undefined' ? window.innerWidth <= breakpoint : false,
  );
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth <= breakpoint);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, [breakpoint]);
  return isMobile;
}

// ============================================================================
// 1. LoginPanel (安全升級版 - 串接 Firebase Auth)
// ============================================================================
const LoginPanel = ({ onLogin, onApiStatus }) => {
  const [employeeId, setEmployeeId] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [showForgot, setShowForgot] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  // 「記住我」偏好。預設勾選 → 沿用 Firebase 原本的 browserLocalPersistence
  // 行為（關瀏覽器仍登入），不破壞既有使用者體驗。只記偏好旗標，絕不存帳密。
  const [rememberMe, setRememberMe] = useState(
    () => localStorage.getItem('remember_me') !== 'false',
  );
  const isMobile = useIsMobile(640);

  // 系統公告（Firestore rule 允許未登入讀取此 doc — 登入頁也能拿到）
  const [announcement, setAnnouncement] = useState(null);
  useEffect(() => {
    const unsub = subscribeToAnnouncement(setAnnouncement);
    return () => unsub && unsub();
  }, []);

  const handleLogin = async (e) => {
    e.preventDefault();
    setError('');
    setIsLoggingIn(true);

    const inputId = employeeId.trim().toLowerCase();

    // ★ 系統轉換：將工號 (如 N001 或 admin) 轉換為 Firebase 需要的 Email 格式
    const emailToLogin = `${inputId}@hospital.com`;

try {
        // 0. 設定 token 持久層 — 這就是「記住我」的本質：
        //    勾選 → browserLocalPersistence（存 IndexedDB，關瀏覽器仍登入）
        //    不勾 → browserSessionPersistence（存 sessionStorage，關閉即登出，適合公用電腦）
        //    必須在 signIn 之前設定，整條鏈路不碰 cookie。
        await setPersistence(
          auth,
          rememberMe ? browserLocalPersistence : browserSessionPersistence,
        );

        // 1. 呼叫 Firebase 伺服器進行真實密碼比對！
        const loginStart = Date.now();
        await signInWithEmailAndPassword(auth, emailToLogin, password);
        const loginMs = Date.now() - loginStart;

        // ★ 回報 API 狀態：< 3 秒綠色，3~8 秒黃色，> 8 秒紅色
        if (onApiStatus) {
          if (loginMs < 3000) onApiStatus('green', `登入成功 (${loginMs}ms)`);
          else if (loginMs < 8000) onApiStatus('yellow', `登入回應緩慢 (${loginMs}ms)`);
          else onApiStatus('red', `登入回應過慢 (${loginMs}ms)`);
        }

        // ★ 稽核：登入成功，fire-and-forget 不阻擋 UI
        try {
            const token = await auth.currentUser?.getIdToken();
            if (token) {
                fetch('/api/log-login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                    body: JSON.stringify({ success: true }),
                }).catch(() => {});
            }
        } catch { /* 寫稽核失敗不影響登入流程 */ }

        // 2. 登入成功 → 建立毛玻璃蓋板（與登出同款動畫，方向相反）
        //    glassFadeIn：35% 蓋滿 → 60% 持續 → 100% 退開，總長 1.5s
        //    在 750ms（畫面被蓋滿）時切換 currentUser，主畫面在蓋板退開時逐漸顯露
        const cover = document.createElement('div');
        cover.className = 'app__transition-cover';
        document.body.appendChild(cover);

        const userPayload = inputId === 'admin'
            ? { id: 'ADMIN', name: '管理人員', role: 'admin' }
            : { id: inputId.toUpperCase(), name: '載入中...', role: 'staff', rule: 'Standard' };

        setTimeout(() => onLogin(userPayload), 750);
        setTimeout(() => cover.remove(), 1500);
    } catch (err) {
        // ★ 登入失敗 → API 狀態紅燈
        if (onApiStatus) onApiStatus('red', `登入失敗: ${err.code || err.message}`);

        // ★ 稽核：登入失敗，fire-and-forget 不阻擋 UI
        fetch('/api/log-login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                success: false,
                attempted_email: emailToLogin,
                error_code: err.code || 'unknown',
            }),
        }).catch(() => {});

        if (import.meta.env.DEV) {
        console.error("登入錯誤:", err.code);
        }
        // 翻譯 Firebase 的錯誤訊息
        // OWASP A07: 不洩漏帳號是否存在 — invalid-credential / wrong-password /
        // user-not-found / user-disabled 一律統一為「帳號或密碼錯誤」，避免
        // 攻擊者用 disabled 與 wrong-password 的訊息差異列舉合法工號。
        // 若使用者忘記啟用，UI 預期他會聯絡管理員 / 重新去收啟用信。
        switch (err.code) {
            case 'auth/invalid-credential':
            case 'auth/wrong-password':
            case 'auth/user-not-found':
            case 'auth/user-disabled':
                setError('帳號或密碼錯誤，或帳號狀態異常，請聯絡管理員。');
                break;
            case 'auth/too-many-requests':
                setError('失敗次數過多，請稍後再試。');
                break;
            case 'auth/invalid-email':
                setError('請輸入正確的工號格式。');
                break;
            default:
                setError('登入失敗，請聯絡系統管理員。');
        }
    } finally {
        setIsLoggingIn(false);
    }
  };

  return (
    <div className="login-panel">
      {/* 系統公告 — 登入頁專屬。Firestore rule 開放未登入讀取此 doc */}
      <AnnouncementBanner announcement={announcement} />

      {/* 桌面版：widget 渲染在卡片外，可正常 fixed 在 viewport 右上角 */}
      {!isMobile && <WeatherClockWidget />}

      {/* 🌟 背景動畫色塊 */}
      <div className="login-panel__blob login-panel__blob--1"></div>
      <div className="login-panel__blob login-panel__blob--2"></div>
      <div className="login-panel__blob login-panel__blob--3"></div>
      <div className="login-panel__blob login-panel__blob--4"></div>

      <div className="login-panel__card">
        {/* 行動版：widget 渲染在卡片內、置中（卡片的 backdrop-filter 會造成 containing block，
            所以這個位置只能用 position: static，不能用 fixed） */}
        {isMobile && <WeatherClockWidget />}

        <h2 className="login-panel__title">排班系統 <span className="login-panel__badge"><Shield size={12} /> 安全版</span></h2>

        <form onSubmit={handleLogin} className="login-panel__form" autoComplete="on">
          <input
            type="text" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}
            placeholder="請輸入工號 (例如: N001 或 admin)"
            required
            autoComplete="username"
            name="username"
            className="login-panel__input"
          />
          <div className="login-panel__pw-wrap">
            <input
              type={showPassword ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)}
              placeholder="請輸入密碼"
              required
              autoComplete="current-password"
              name="password"
              className="login-panel__input login-panel__input--password"
            />
            <button
              type="button"
              className="login-panel__pw-toggle"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? '隱藏密碼' : '顯示密碼'}
              title={showPassword ? '隱藏密碼' : '顯示密碼'}
              tabIndex={-1}
            >
              {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>

          <label className="login-panel__remember">
            <input
              type="checkbox"
              checked={rememberMe}
              onChange={(e) => {
                setRememberMe(e.target.checked);
                localStorage.setItem('remember_me', String(e.target.checked));
              }}
              className="login-panel__remember-checkbox"
            />
            <span>記住我（公用電腦請勿勾選）</span>
          </label>

          {error && <div className="login-panel__error"><AlertCircle size={14} /> {error}</div>}

          <button type="submit" disabled={isLoggingIn} className={`login-panel__button ${isLoggingIn ? 'login-panel__button--loading' : 'login-panel__button--active'}`}>
              {isLoggingIn ? <><span className="login-panel__spinner" /> 驗證中...</> : <><LogIn size={16} /> 登入系統</>}
          </button>

          <button type="button" className="login-panel__forgot" onClick={() => setShowForgot(true)}>
            忘記密碼？
          </button>
        </form>
      </div>

      {showForgot && (
        <ForgotPasswordModal
          onClose={() => setShowForgot(false)}
          onFilled={(filledId, tempPw) => {
            // 帶回登入表單：填好工號與暫時密碼，使用者直接按登入即可
            setEmployeeId(filledId);
            setPassword(tempPw);
            setError('');
          }}
        />
      )}
    </div>
  );
};

export default LoginPanel;
