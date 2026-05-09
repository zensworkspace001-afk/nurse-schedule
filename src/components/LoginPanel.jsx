import React, { useState } from 'react';
import { signInWithEmailAndPassword } from 'firebase/auth';
import { AlertCircle, LogIn, Shield } from 'lucide-react';
import { auth } from '../api/database';
import WeatherClockWidget from './WeatherClockWidget';
import './LoginPanel.css';

// ============================================================================
// 1. LoginPanel (安全升級版 - 串接 Firebase Auth)
// ============================================================================
const LoginPanel = ({ onLogin, onApiStatus }) => {
  const [employeeId, setEmployeeId] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  const handleLogin = async (e) => {
    e.preventDefault();
    setError('');
    setIsLoggingIn(true);

    const inputId = employeeId.trim().toLowerCase();

    // ★ 系統轉換：將工號 (如 N001 或 admin) 轉換為 Firebase 需要的 Email 格式
    const emailToLogin = `${inputId}@hospital.com`;

try {
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
        switch (err.code) {
            case 'auth/invalid-credential':
            case 'auth/wrong-password':
            case 'auth/user-not-found':
                setError('帳號或密碼錯誤！');
                break;
            case 'auth/user-disabled':
                setError('此帳號尚未啟用，請至 Email 收信並點擊啟用連結。');
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
      {/* 右上角天氣 + 時鐘 widget */}
      <WeatherClockWidget />

      {/* 🌟 背景動畫色塊 */}
      <div className="login-panel__blob login-panel__blob--1"></div>
      <div className="login-panel__blob login-panel__blob--2"></div>
      <div className="login-panel__blob login-panel__blob--3"></div>
      <div className="login-panel__blob login-panel__blob--4"></div>

      <div className="login-panel__card">
        <h2 className="login-panel__title">排班系統 <span className="login-panel__badge"><Shield size={12} /> 安全版</span></h2>

        <form onSubmit={handleLogin} className="login-panel__form">
          <input
            type="text" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}
            placeholder="請輸入工號 (例如: N001 或 admin)"
            required
            className="login-panel__input"
          />
          <input
            type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            placeholder="請輸入密碼"
            required
            className="login-panel__input login-panel__input--password"
          />

          {error && <div className="login-panel__error"><AlertCircle size={14} /> {error}</div>}

          <button type="submit" disabled={isLoggingIn} className={`login-panel__button ${isLoggingIn ? 'login-panel__button--loading' : 'login-panel__button--active'}`}>
              {isLoggingIn ? <><span className="login-panel__spinner" /> 驗證中...</> : <><LogIn size={16} /> 登入系統</>}
          </button>
        </form>
      </div>


    </div>
  );
};

export default LoginPanel;
