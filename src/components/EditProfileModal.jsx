import React, { useState, useRef } from 'react';
import { X, Save, Loader2, AlertCircle, CheckCircle2, Camera, Trash2, UserCircle } from 'lucide-react';
import { auth } from '../api/database';
import './EditProfileModal.css';

// 把使用者選的圖片壓到 200x200 webp，回傳 data URL
// 為何 webp：在 Chrome / Edge / Firefox / Safari 14+ 都支援；體積比 jpeg 小 ~25%
// 為何 200x200：員工管理列表只顯示 32px 圓圈，dashboard greeting 也只用 40-64px，
// 200px 雙倍解析度已綽綽有餘；30 員工 × ~15 KB = ~450 KB，遠低於 Firestore 1 MiB 上限
async function resizeImageToDataURL(file, targetSize = 200, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onerror = () => reject(new Error('無法讀取圖片'));
    img.onload = () => {
      // center-crop 成正方形
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      const sx = (img.naturalWidth - side) / 2;
      const sy = (img.naturalHeight - side) / 2;

      const canvas = document.createElement('canvas');
      canvas.width = targetSize;
      canvas.height = targetSize;
      const ctx = canvas.getContext('2d');
      if (!ctx) return reject(new Error('Canvas 不可用'));
      ctx.drawImage(img, sx, sy, side, side, 0, 0, targetSize, targetSize);

      // 先試 webp；瀏覽器若不支援會落回 jpeg
      const tryEncode = (mime) => {
        try {
          const dataUrl = canvas.toDataURL(mime, quality);
          if (dataUrl && dataUrl.startsWith(`data:${mime}`)) return dataUrl;
        } catch { /* fall through */ }
        return null;
      };
      const webp = tryEncode('image/webp');
      const out = webp || tryEncode('image/jpeg') || canvas.toDataURL('image/png');
      resolve(out);
    };
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('檔案讀取失敗'));
    reader.onload = (e) => { img.src = e.target.result; };
    reader.readAsDataURL(file);
  });
}

const EditProfileModal = ({ myStaffRow, onClose }) => {
  const [closing, setClosing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState({ type: '', text: '' });

  const [form, setForm] = useState(() => ({
    name: myStaffRow?.name || '',
    gender: myStaffRow?.gender || '女',
    tenure_years: typeof myStaffRow?.tenure_years === 'number' ? myStaffRow.tenure_years : 0,
    is_pregnant_or_nursing: Boolean(myStaffRow?.is_pregnant_or_nursing),
    can_night_shift: myStaffRow?.can_night_shift !== false,
  }));

  // avatar 三態：undefined = 不改 / null = 移除 / string = 新圖 data URL
  const [avatar, setAvatar] = useState(undefined);
  const [avatarPreview, setAvatarPreview] = useState(myStaffRow?.avatar || null);
  const fileRef = useRef(null);

  const update = (k, v) => setForm((prev) => ({ ...prev, [k]: v }));

  const handleClose = () => {
    if (submitting) return;
    setClosing(true);
    setTimeout(onClose, 300);
  };

  const handlePickFile = () => fileRef.current?.click();

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!/^image\/(png|jpe?g|webp|gif|bmp)$/i.test(file.type)) {
      setMsg({ type: 'error', text: '僅支援 PNG / JPG / WebP 圖片' });
      e.target.value = '';
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setMsg({ type: 'error', text: '原始檔案需在 8 MB 以內' });
      e.target.value = '';
      return;
    }
    try {
      const dataUrl = await resizeImageToDataURL(file);
      setAvatar(dataUrl);
      setAvatarPreview(dataUrl);
      setMsg({ type: '', text: '' });
    } catch (err) {
      setMsg({ type: 'error', text: '圖片處理失敗：' + err.message });
    } finally {
      e.target.value = '';
    }
  };

  const handleRemoveAvatar = () => {
    setAvatar(null);
    setAvatarPreview(null);
  };

  const validate = () => {
    if (!form.name.trim()) return '請輸入姓名';
    if (form.name.length > 50) return '姓名長度過長';
    if (form.gender !== '男' && form.gender !== '女') return '請選擇性別';
    const t = Number(form.tenure_years);
    if (!Number.isFinite(t) || t < 0 || t > 60) return '年資需為 0–60 之間的數字';
    return null;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setMsg({ type: '', text: '' });
    const err = validate();
    if (err) return setMsg({ type: 'error', text: err });

    setSubmitting(true);
    try {
      const token = await auth.currentUser?.getIdToken();
      if (!token) throw new Error('登入逾期，請重新登入');

      const body = {
        mode: 'update',
        name: form.name.trim(),
        gender: form.gender,
        tenure_years: Number(form.tenure_years),
        is_pregnant_or_nursing: form.is_pregnant_or_nursing,
        can_night_shift: form.can_night_shift,
      };
      // 只有顯式改過時才送 avatar 欄位；不送 = 後端不動現有頭貼
      if (avatar !== undefined) body.avatar = avatar === null ? '' : avatar;

      const res = await fetch('/api/complete-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '伺服器拒絕請求');

      setMsg({ type: 'success', text: '✅ 個人資料已更新' });
      // 1.2 秒後自動關閉；StaffPrivate onSnapshot 會自動把新資料推到 myStaffRow
      setTimeout(() => {
        setClosing(true);
        setTimeout(onClose, 300);
      }, 1200);
    } catch (err) {
      setMsg({ type: 'error', text: err.message });
      setSubmitting(false);
    }
  };

  const initial = (form.name || myStaffRow?.staff_id || '?').trim().charAt(0).toUpperCase();

  return (
    <div
      className={`editprof__overlay${closing ? ' editprof__overlay--closing' : ''}`}
      onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}
      role="button"
      tabIndex={-1}
      aria-label="點空白處關閉"
    >
      <div className={`editprof__modal${closing ? ' editprof__modal--closing' : ''}`}>
        <button onClick={handleClose} className="editprof__close" disabled={submitting}>
          <X size={14} />
        </button>

        <h3 className="editprof__title">
          <UserCircle size={18} /> 編輯個人資料
        </h3>

        <p className="editprof__hint">
          這裡能更新基本資料與頭貼。身分證 / 銀行帳號 / 手機等加密欄位若需修改，請聯絡管理員。
        </p>

        <form onSubmit={handleSubmit} className="editprof__form">
          {/* 頭貼區 */}
          <div className="editprof__avatar-block">
            <div className="editprof__avatar-wrap">
              {avatarPreview ? (
                <img src={avatarPreview} alt="頭貼預覽" className="editprof__avatar-img" />
              ) : (
                <div className="editprof__avatar-fallback">{initial}</div>
              )}
            </div>
            <div className="editprof__avatar-actions">
              <input
                type="file"
                ref={fileRef}
                accept="image/png,image/jpeg,image/webp"
                onChange={handleFileChange}
                style={{ display: 'none' }}
              />
              <button type="button" onClick={handlePickFile} className="editprof__btn editprof__btn--ghost" disabled={submitting}>
                <Camera size={14} /> 選擇圖片
              </button>
              {avatarPreview && (
                <button type="button" onClick={handleRemoveAvatar} className="editprof__btn editprof__btn--danger-ghost" disabled={submitting}>
                  <Trash2 size={14} /> 移除頭貼
                </button>
              )}
            </div>
            <p className="editprof__avatar-note">
              系統會自動將圖片置中裁切並壓縮為 200×200。
            </p>
          </div>

          <label className="editprof__label">
            姓名
            <input
              type="text"
              value={form.name}
              onChange={(e) => update('name', e.target.value)}
              className="editprof__input"
              disabled={submitting}
            />
          </label>

          <label className="editprof__label">
            性別
            <div className="editprof__radio-row">
              {['女', '男'].map((g) => (
                <button
                  key={g}
                  type="button"
                  onClick={() => update('gender', g)}
                  className={`editprof__radio${form.gender === g ? ' editprof__radio--active' : ''}`}
                  disabled={submitting}
                >
                  {g}
                </button>
              ))}
            </div>
          </label>

          <label className="editprof__label">
            護理年資（年）
            <input
              type="number"
              min={0}
              max={60}
              value={form.tenure_years}
              onChange={(e) => update('tenure_years', e.target.value)}
              className="editprof__input"
              disabled={submitting}
            />
          </label>

          <label className="editprof__check">
            <input
              type="checkbox"
              checked={form.is_pregnant_or_nursing}
              onChange={(e) => update('is_pregnant_or_nursing', e.target.checked)}
              disabled={submitting}
            />
            <span>目前正處於孕期或哺乳期</span>
          </label>

          <label className="editprof__check">
            <input
              type="checkbox"
              checked={form.can_night_shift}
              onChange={(e) => update('can_night_shift', e.target.checked)}
              disabled={submitting}
            />
            <span>可以排大夜班（N，23:00–08:00）</span>
          </label>

          {msg.text && (
            <div className={`editprof__msg ${msg.type === 'error' ? 'editprof__msg--error' : 'editprof__msg--success'}`}>
              {msg.type === 'error' ? <AlertCircle size={14} /> : <CheckCircle2 size={14} />} {msg.text}
            </div>
          )}

          <button type="submit" disabled={submitting} className={`editprof__submit${submitting ? ' editprof__submit--loading' : ''}`}>
            {submitting ? <><Loader2 size={14} className="editprof__spin" /> 儲存中...</> : <><Save size={14} /> 儲存變更</>}
          </button>
        </form>
      </div>
    </div>
  );
};

export default EditProfileModal;
