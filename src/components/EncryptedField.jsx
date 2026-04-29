import React, { useState, useEffect, useRef } from 'react';
import { Lock, Unlock, Eye, EyeOff, Loader2, Save } from 'lucide-react';
import { decryptField, encryptFieldRemote, isEncryptedBlob } from '../api/secureField';
import './EncryptedField.css';

// 統一的密文欄位 UI
//
// Props:
//   value      — 來自 Firestore 的值（可能是密文 blob、或明文 string/number、或空）
//   onSave     — async (newPlainText) => void  / 父層收到後轉密文寫入
//   target     — { kind, id }   給稽核日誌
//   fieldName  — string         給稽核日誌
//   placeholder
//   autoLockMs — 解密後幾毫秒自動再鎖回去（預設 30 秒，0 = 不自動鎖）
//   editable   — 是否允許編輯（預設 true）
//   formatter  — 顯示明文時的可選遮罩（例如身分證只露末四碼）
const EncryptedField = ({
  value,
  onSave,
  target,
  fieldName,
  placeholder = '— 未設定 —',
  autoLockMs = 30000,
  editable = true,
  formatter,
}) => {
  const [decrypted, setDecrypted] = useState(null);   // null = 鎖定狀態
  const [showFull, setShowFull] = useState(false);    // 顯示完整明文 vs 遮罩
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const lockTimerRef = useRef(null);

  const isLocked = isEncryptedBlob(value);
  const hasValue = value !== null && value !== undefined && value !== '';

  // 自動鎖回
  useEffect(() => {
    if (decrypted === null) return;
    if (!autoLockMs) return;
    clearTimeout(lockTimerRef.current);
    lockTimerRef.current = setTimeout(() => {
      setDecrypted(null);
      setShowFull(false);
      setEditing(false);
    }, autoLockMs);
    return () => clearTimeout(lockTimerRef.current);
  }, [decrypted, autoLockMs]);

  const handleUnlock = async () => {
    if (!isLocked) return;
    setBusy(true); setErr(null);
    try {
      const plain = await decryptField(value, target, [fieldName]);
      setDecrypted(plain ?? '');
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const handleStartEdit = () => {
    setDraft(decrypted ?? (typeof value === 'string' ? value : ''));
    setEditing(true);
    setShowFull(true);
  };

  const handleCancelEdit = () => {
    setEditing(false);
    setDraft('');
  };

  const handleSave = async () => {
    setBusy(true); setErr(null);
    try {
      // 空字串視為清除：直接讓父層寫 null / 空字串
      if (draft === '') {
        await onSave('');
      } else {
        const blob = await encryptFieldRemote(draft);
        await onSave(blob);
      }
      setDecrypted(draft);
      setEditing(false);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  // —— 渲染 ——

  // 完全沒有值 → 直接顯示「設定」按鈕（若可編輯）
  if (!hasValue) {
    if (editing) {
      return (
        <div className="encfield encfield--editing">
          <input
            className="encfield__input"
            value={draft}
            placeholder="輸入明文後加密儲存"
            onChange={(e) => setDraft(e.target.value)}
            autoFocus
          />
          <button className="encfield__btn encfield__btn--save" onClick={handleSave} disabled={busy}>
            {busy ? <Loader2 size={12} className="encfield__spin" /> : <Save size={12} />}
          </button>
          <button className="encfield__btn encfield__btn--cancel" onClick={handleCancelEdit}>×</button>
          {err && <div className="encfield__err">{err}</div>}
        </div>
      );
    }
    return (
      <div className="encfield encfield--empty">
        <span className="encfield__placeholder">{placeholder}</span>
        {editable && (
          <button className="encfield__btn encfield__btn--edit" onClick={handleStartEdit}>
            設定
          </button>
        )}
      </div>
    );
  }

  // 有值但鎖定 → 顯示遮罩 + 解鎖按鈕
  if (isLocked && decrypted === null) {
    return (
      <div className="encfield encfield--locked">
        <span className="encfield__mask" title="此欄位已加密，點解鎖檢視明文">
          <Lock size={11} /> ●●●●●●
        </span>
        <button
          className="encfield__btn encfield__btn--unlock"
          onClick={handleUnlock}
          disabled={busy}
          title="解鎖檢視（會記錄到稽核日誌）"
        >
          {busy ? <Loader2 size={12} className="encfield__spin" /> : <Unlock size={12} />}
        </button>
        {err && <div className="encfield__err">{err}</div>}
      </div>
    );
  }

  // 已解密：顯示明文（可遮罩切換 + 編輯）
  const display = showFull
    ? (decrypted ?? '')
    : (formatter ? formatter(decrypted ?? '') : maskMiddle(decrypted ?? ''));

  if (editing) {
    return (
      <div className="encfield encfield--editing">
        <input
          className="encfield__input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoFocus
        />
        <button className="encfield__btn encfield__btn--save" onClick={handleSave} disabled={busy}>
          {busy ? <Loader2 size={12} className="encfield__spin" /> : <Save size={12} />}
        </button>
        <button className="encfield__btn encfield__btn--cancel" onClick={handleCancelEdit}>×</button>
        {err && <div className="encfield__err">{err}</div>}
      </div>
    );
  }

  return (
    <div className="encfield encfield--unlocked">
      <span className="encfield__plain">{display}</span>
      <button
        className="encfield__btn encfield__btn--toggle"
        onClick={() => setShowFull(s => !s)}
        title={showFull ? '收合' : '完整顯示'}
      >
        {showFull ? <EyeOff size={12} /> : <Eye size={12} />}
      </button>
      {editable && (
        <button className="encfield__btn encfield__btn--edit" onClick={handleStartEdit} title="修改">
          ✎
        </button>
      )}
    </div>
  );
};

// 預設遮罩：保留前 1 / 後 2，中間以星號替代
function maskMiddle(s) {
  const str = String(s);
  if (str.length <= 3) return '*'.repeat(str.length);
  if (str.length <= 6) return str[0] + '*'.repeat(str.length - 3) + str.slice(-2);
  return str.slice(0, 1) + '*'.repeat(str.length - 3) + str.slice(-2);
}

export default EncryptedField;
