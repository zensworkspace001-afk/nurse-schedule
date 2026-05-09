import React, { useState } from 'react';
import { Lock, ChevronRight, ChevronLeft, CheckCircle2, AlertCircle, Loader2, LogOut } from 'lucide-react';
import { auth } from '../api/database';
import { signOut } from 'firebase/auth';
import ParticleBackground from './ParticleBackground';
import './ProfileWizard.css';

// 員工首次啟用後的「完善個人資料」精靈。
// 三步：
//   1. 基本資料（姓名 / 性別 / 年資）
//   2. 個人狀態（孕/哺乳、可否大夜）
//   3. 加密 PII（身分證 / 銀行帳號 / 手機）
// 提交至 /api/complete-profile，後端統一驗證 + 加密 + 寫稽核。
const ProfileWizard = ({ staffRow, currentUser }) => {
  const [step, setStep] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const [form, setForm] = useState(() => ({
    name: staffRow?.name && staffRow.name !== '載入中...' ? staffRow.name : '',
    gender: staffRow?.gender || '女',
    tenure_years: typeof staffRow?.tenure_years === 'number' ? staffRow.tenure_years : 0,
    is_pregnant_or_nursing: Boolean(staffRow?.is_pregnant_or_nursing),
    can_night_shift: staffRow?.can_night_shift !== false,
    idNumber: '',
    bankAccount: '',
    phone: '',
  }));

  const update = (k, v) => setForm((prev) => ({ ...prev, [k]: v }));

  const validateStep1 = () => {
    if (!form.name.trim()) return '請輸入姓名';
    if (form.name.length > 50) return '姓名長度過長';
    if (form.gender !== '男' && form.gender !== '女') return '請選擇性別';
    const t = Number(form.tenure_years);
    if (!Number.isFinite(t) || t < 0 || t > 60) return '年資需為 0–60 之間的數字';
    return null;
  };

  const validateStep3 = () => {
    if (!form.idNumber.trim()) return '請輸入身分證 / 居留證號';
    if (form.idNumber.length < 4) return '身分證號過短';
    if (!/^[0-9-]{6,30}$/.test(form.bankAccount)) return '銀行帳號僅限數字與連字號（6–30 碼）';
    if (!/^09\d{8}$/.test(form.phone)) return '手機需為 09 開頭共 10 碼';
    return null;
  };

  const handleNext = () => {
    setError('');
    if (step === 1) {
      const e = validateStep1();
      if (e) return setError(e);
    }
    setStep((s) => s + 1);
  };

  const handlePrev = () => {
    setError('');
    setStep((s) => Math.max(1, s - 1));
  };

  const handleSubmit = async () => {
    setError('');
    const e = validateStep3();
    if (e) return setError(e);
    setSubmitting(true);
    try {
      const token = await auth.currentUser?.getIdToken();
      if (!token) throw new Error('登入逾期，請重新登入');
      const res = await fetch('/api/complete-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
          name: form.name.trim(),
          gender: form.gender,
          tenure_years: Number(form.tenure_years),
          is_pregnant_or_nursing: form.is_pregnant_or_nursing,
          can_night_shift: form.can_night_shift,
          idNumber: form.idNumber.trim(),
          bankAccount: form.bankAccount.trim(),
          phone: form.phone.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '伺服器拒絕請求');
      // 成功後不需手動 redirect — App.jsx 的 onSnapshot 會抓到 profile_completed=true
      // 自動把畫面切到 StaffDashboard。
    } catch (err) {
      setError(err.message);
      setSubmitting(false);
    }
  };

  const handleLogout = async () => {
    try { await signOut(auth); } catch { /* 忽略 */ }
    window.location.reload();
  };

  return (
    <div className="profwiz">
      {/* 與主應用一致的粒子 + 色塊背景，玻璃卡片下方才真的有東西可以模糊 */}
      <ParticleBackground />
      <div className="profwiz__blob profwiz__blob--1"></div>
      <div className="profwiz__blob profwiz__blob--2"></div>
      <div className="profwiz__blob profwiz__blob--3"></div>
      <div className="profwiz__card">
        <button onClick={handleLogout} className="profwiz__logout" title="先登出">
          <LogOut size={14} /> 登出
        </button>

        <h1 className="profwiz__title">
          <Lock size={20} /> 完善您的個人資料
        </h1>
        <p className="profwiz__greeting">
          {currentUser?.id ? <>嗨，<strong>{currentUser.id}</strong>。</> : null}
          首次登入需填寫個人資料，這些欄位會嚴格保密 — 身分證 / 銀行帳號 / 手機僅以加密形式存於資料庫，連管理員也需要再經授權才能看到。
        </p>

        <div className="profwiz__steps">
          {[1, 2, 3].map((n) => (
            <div
              key={n}
              className={`profwiz__step${step === n ? ' profwiz__step--active' : ''}${step > n ? ' profwiz__step--done' : ''}`}
            >
              {step > n ? <CheckCircle2 size={14} /> : n}
              <span>{n === 1 ? '基本' : n === 2 ? '狀態' : '加密欄位'}</span>
            </div>
          ))}
        </div>

        {step === 1 && (
          <div className="profwiz__form">
            <label className="profwiz__label">
              姓名
              <input
                type="text"
                value={form.name}
                onChange={(e) => update('name', e.target.value)}
                className="profwiz__input"
                placeholder="與身分證上的姓名一致"
                autoFocus
              />
            </label>

            <label className="profwiz__label">
              性別
              <div className="profwiz__radio-row">
                {['女', '男'].map((g) => (
                  <button
                    key={g}
                    type="button"
                    onClick={() => update('gender', g)}
                    className={`profwiz__radio${form.gender === g ? ' profwiz__radio--active' : ''}`}
                  >
                    {g}
                  </button>
                ))}
              </div>
            </label>

            <label className="profwiz__label">
              護理年資（年）
              <input
                type="number"
                value={form.tenure_years}
                onChange={(e) => update('tenure_years', e.target.value)}
                min={0}
                max={60}
                className="profwiz__input"
              />
            </label>
          </div>
        )}

        {step === 2 && (
          <div className="profwiz__form">
            <p className="profwiz__hint">下列狀態會影響班表生成（如孕/哺乳期會獲得選班優先序、不可上夜班會排除大夜班次）。請據實填寫，後續可隨時請管理員修改。</p>

            <label className="profwiz__check">
              <input
                type="checkbox"
                checked={form.is_pregnant_or_nursing}
                onChange={(e) => update('is_pregnant_or_nursing', e.target.checked)}
              />
              <span>目前正處於孕期或哺乳期</span>
            </label>

            <label className="profwiz__check">
              <input
                type="checkbox"
                checked={form.can_night_shift}
                onChange={(e) => update('can_night_shift', e.target.checked)}
              />
              <span>可以排大夜班（N，23:00–08:00）</span>
            </label>
          </div>
        )}

        {step === 3 && (
          <div className="profwiz__form">
            <p className="profwiz__hint">
              <Lock size={12} /> 以下三個欄位提交後會立即在伺服器加密成密文，明文不會儲存，僅在管理員核薪、申報所得稅時透過稽核紀錄解鎖檢視。
            </p>

            <label className="profwiz__label">
              身分證 / 居留證號
              <input
                type="text"
                value={form.idNumber}
                onChange={(e) => update('idNumber', e.target.value)}
                className="profwiz__input"
                placeholder="例如：A123456789"
                autoComplete="off"
              />
            </label>

            <label className="profwiz__label">
              銀行帳號（薪資匯入用）
              <input
                type="text"
                value={form.bankAccount}
                onChange={(e) => update('bankAccount', e.target.value)}
                className="profwiz__input"
                placeholder="僅輸入數字，連字號可選"
                autoComplete="off"
                inputMode="numeric"
              />
            </label>

            <label className="profwiz__label">
              手機號碼
              <input
                type="tel"
                value={form.phone}
                onChange={(e) => update('phone', e.target.value)}
                className="profwiz__input"
                placeholder="0912345678"
                autoComplete="off"
                inputMode="numeric"
              />
            </label>
          </div>
        )}

        {error && (
          <div className="profwiz__error">
            <AlertCircle size={14} /> {error}
          </div>
        )}

        <div className="profwiz__nav">
          {step > 1 ? (
            <button onClick={handlePrev} className="profwiz__btn profwiz__btn--secondary" disabled={submitting}>
              <ChevronLeft size={16} /> 上一步
            </button>
          ) : <div />}

          {step < 3 ? (
            <button onClick={handleNext} className="profwiz__btn profwiz__btn--primary">
              下一步 <ChevronRight size={16} />
            </button>
          ) : (
            <button onClick={handleSubmit} disabled={submitting} className="profwiz__btn profwiz__btn--primary">
              {submitting ? <><Loader2 size={16} className="profwiz__spin" /> 加密中...</> : '完成並送出'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default ProfileWizard;
