import React, { useState } from 'react';
import { signInWithEmailAndPassword } from 'firebase/auth';
import { auth } from '../api/database';
import './LoginPanel.css';

// ============================================================================
// 1. LoginPanel (安全升級版 - 串接 Firebase Auth)
// ============================================================================
const LoginPanel = ({ onLogin, staffData = [] }) => {
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
        await signInWithEmailAndPassword(auth, emailToLogin, password);

        // 2. 登入成功後，判斷角色權限
        if (inputId === 'admin') {
            onLogin({ id: 'ADMIN', name: '管理人員', role: 'admin' });
        } else {
            // 🌟 核心修復：登入瞬間先給一個「載入中」的假名字，不要去依賴空的 staffData
            onLogin({
                id: inputId.toUpperCase(),
                name: '載入中...',
                role: 'staff',
                rule: 'Standard'
            });
        }
    } catch (err) {
        // ... 原本的 catch 錯誤處理保留不動 ...
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
      <div className="login-panel__card">
        <h2 className="login-panel__title">護理排班系統 <span className="login-panel__badge">安全版</span></h2>

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

          {error && <div className="login-panel__error">❌ {error}</div>}

          <button type="submit" disabled={isLoggingIn} className={`login-panel__button ${isLoggingIn ? 'login-panel__button--disabled' : 'login-panel__button--active'}`}>
              {isLoggingIn ? '驗證中...' : '登入系統'}
          </button>
        </form>
      </div>


    </div>
  );
};

export default LoginPanel;
