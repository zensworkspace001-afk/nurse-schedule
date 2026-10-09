import React, { useState } from 'react';
import { ShieldCheck, ExternalLink, LogOut, Loader2, AlertCircle } from 'lucide-react';
import { signOut } from 'firebase/auth';
import { auth } from '../api/database';
import ParticleBackground from './ParticleBackground';
import { usePerformanceMode } from '../hooks/usePerformanceMode';
import { usePdpaRead, PDPA_NOTICE_VERSION } from '../utils/pdpa';
import './ProfileWizard.css';

// 個資告知升版後的「重新同意」畫面。已填過個人資料的員工不必重走整份精靈：
// 讀完新版告知 → 勾選同意 → /api/complete-profile mode 'consent'（後端只接受目前版本並記錄伺服器時間）。
// App.jsx 在員工資料的 pdpa_notice_version 不是目前版本時顯示這頁；寫入後訂閱更新，畫面自動放行。
const PdpaReconsent = ({ currentUser, hadConsentedBefore }) => {
  const [perfMode] = usePerformanceMode();
  const pdpaRead = usePdpaRead();
  const [agreed, setAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setError('');
    setSubmitting(true);
    try {
      const token = await auth.currentUser?.getIdToken();
      if (!token) throw new Error('登入逾期，請重新登入');
      const res = await fetch('/api/complete-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ mode: 'consent', pdpa_notice_version: PDPA_NOTICE_VERSION }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '伺服器拒絕請求');
    } catch (err) {
      setError(err.message);
      setSubmitting(false);
    }
  };

  const logout = async () => {
    try { await signOut(auth); } catch { /* 忽略 */ }
    window.location.reload();
  };

  return (
    <div className="profwiz">
      {!perfMode && <ParticleBackground />}
      <div className="profwiz__blob profwiz__blob--1"></div>
      <div className="profwiz__blob profwiz__blob--2"></div>
      <div className="profwiz__blob profwiz__blob--3"></div>
      <div className="profwiz__card">
        <button onClick={logout} className="profwiz__logout" title="先登出">
          <LogOut size={14} /> 登出
        </button>
        <h1 className="profwiz__title"><ShieldCheck size={20} /> 個人資料蒐集告知</h1>
        <p className="profwiz__greeting">
          {currentUser?.id ? <>嗨，<strong>{currentUser.id}</strong>。</> : null}
          {hadConsentedBefore
            ? '本院的個人資料蒐集告知內容已更新，請閱讀新版並同意後繼續使用系統。'
            : '使用系統前，請先閱讀本院如何蒐集、保護及使用您的個人資料並表示同意。'}
        </p>

        {error && <div className="profwiz__error"><AlertCircle size={14} /> {error}</div>}

        <div className="profwiz__form">
          <div className={`profwiz__pdpa${agreed ? ' profwiz__pdpa--done' : ''}`}>
            <div className="profwiz__pdpa-header">
              <ShieldCheck size={16} />
              <strong>個人資料蒐集告知（依個資法 §8）</strong>
            </div>
            <a href="/privacy-notice" target="_blank" rel="noopener noreferrer" className="profwiz__pdpa-link">
              <ExternalLink size={12} /> 開啟個人資料蒐集告知（新分頁）
            </a>
            <label className={`profwiz__pdpa-check${pdpaRead ? '' : ' profwiz__pdpa-check--locked'}`}>
              <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} disabled={!pdpaRead} />
              <span>
                {pdpaRead
                  ? '我已詳閱並同意上述告知事項'
                  : '請先點擊上方連結，把告知頁滑到底並按「我已詳閱完畢」'}
              </span>
            </label>
          </div>
        </div>

        <div className="profwiz__nav">
          <button onClick={submit} disabled={!pdpaRead || !agreed || submitting} className="profwiz__btn profwiz__btn--primary">
            {submitting ? <><Loader2 size={16} className="profwiz__spin" /> 送出中...</> : '同意並繼續'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default PdpaReconsent;
