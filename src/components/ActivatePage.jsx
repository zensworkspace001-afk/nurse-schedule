import React, { useState, useEffect } from 'react';
import { Lock, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import ParticleBackground from './ParticleBackground';
import './ActivatePage.css';

// 帳號啟用 / 密碼重設頁面
//
// URL 形式：/activate?token=<plainToken>
// 此頁面公開（不需登入），由 token 本身擔任授權。
// 後端 /api/activate-account 會根據 token doc 上的 purpose 決定是「啟用」還是「重設密碼」。
const ActivatePage = () => {
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(null); // { purpose, message }

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('token') || '';
    setToken(t.trim());
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (!token) {
      setError('連結遺失 token 參數，請重新點擊信件中的連結。');
      return;
    }
    if (password !== confirm) {
      setError('兩次輸入的密碼不一致');
      return;
    }
    const strong = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d!@#$%^&*()_+\-=]{6,}$/;
    if (!strong.test(password)) {
      setError('密碼至少 6 碼，且必須同時包含英文與數字');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/activate-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword: password }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || '伺服器拒絕請求');
      }
      setSuccess({ purpose: data.purpose, message: data.message });
    } catch (err) {
      setError(err.message || '啟用失敗，請稍後再試');
    } finally {
      setSubmitting(false);
    }
  };

  if (success) {
    const isActivation = success.purpose === 'activation';
    return (
      <div className="activate-page">
        <ParticleBackground />
        <div className="activate-page__blob activate-page__blob--1"></div>
        <div className="activate-page__blob activate-page__blob--2"></div>
        <div className="activate-page__blob activate-page__blob--3"></div>
        <div className="activate-page__card activate-page__card--success">
          <CheckCircle2 size={56} className="activate-page__success-icon" />
          <h1 className="activate-page__title">
            {isActivation ? '帳號啟用成功！' : '密碼已重設'}
          </h1>
          <p className="activate-page__desc">
            {isActivation
              ? '您的帳號已開通，現在可以使用工號與剛剛設定的密碼登入。'
              : '您的密碼已成功更新，請使用新密碼登入。'}
          </p>
          <a href="/" className="activate-page__primary-btn">前往登入頁</a>
        </div>
      </div>
    );
  }

  return (
    <div className="activate-page">
      <ParticleBackground />
      <div className="activate-page__blob activate-page__blob--1"></div>
      <div className="activate-page__blob activate-page__blob--2"></div>
      <div className="activate-page__blob activate-page__blob--3"></div>
      <div className="activate-page__card">
        <h1 className="activate-page__title">
          <Lock size={22} /> 啟用帳號 / 設定密碼
        </h1>
        <p className="activate-page__desc">
          請設定您的登入密碼。設定完成後即可使用工號（例如 N001）登入排班系統。
        </p>

        <form onSubmit={handleSubmit} className="activate-page__form">
          <label className="activate-page__label">
            新密碼
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="至少 6 碼，需含英文與數字"
              autoComplete="new-password"
              required
              minLength={6}
              className="activate-page__input"
            />
          </label>
          <label className="activate-page__label">
            確認新密碼
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              required
              minLength={6}
              className="activate-page__input"
            />
          </label>

          {error && (
            <div className="activate-page__error">
              <AlertCircle size={14} /> {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className={`activate-page__primary-btn${submitting ? ' activate-page__primary-btn--loading' : ''}`}
          >
            {submitting ? (
              <><Loader2 size={16} className="activate-page__spin" /> 處理中...</>
            ) : (
              '送出'
            )}
          </button>
        </form>

        <p className="activate-page__hint">
          連結 24 小時內有效，僅可使用一次。若已過期，請聯絡管理員重新發送。
        </p>
      </div>
    </div>
  );
};

export default ActivatePage;
