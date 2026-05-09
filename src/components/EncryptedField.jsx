import React, { useState, useEffect, useRef } from 'react';
import { Lock, Unlock, Eye, EyeOff, Loader2, Save } from 'lucide-react';
import { decryptField, encryptFieldRemote, isEncryptedBlob } from '../api/secureField';
import {
  TAIWAN_BANKS,
  parseBankAccount,
  formatBankAccount,
  displayBankAccount,
  maskBankAccount,
} from '../constants/banks';
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
//   kind       — 'text' (預設) | 'bank-account'
//                bank-account：edit 用銀行下拉 + 帳號輸入；display 顯示「008 華南銀行 / 1234567890」
const EncryptedField = ({
  value,
  onSave,
  target,
  fieldName,
  placeholder = '— 未設定 —',
  autoLockMs = 30000,
  editable = true,
  formatter,
  kind = 'text',
}) => {
  const isBank = kind === 'bank-account';

  const [decrypted, setDecrypted] = useState(null);   // null = 鎖定狀態
  const [showFull, setShowFull] = useState(false);    // 顯示完整明文 vs 遮罩
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  // bank-account 模式下另外保存銀行代碼/帳號分離狀態（編輯 UI 用）
  const [bankCodeDraft, setBankCodeDraft] = useState('');
  const [bankAcctDraft, setBankAcctDraft] = useState('');
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
    const initialPlain = decrypted ?? (typeof value === 'string' ? value : '');
    setDraft(initialPlain);
    if (isBank) {
      const { code, account } = parseBankAccount(initialPlain);
      setBankCodeDraft(code);
      setBankAcctDraft(account);
    }
    setEditing(true);
    setShowFull(true);
  };

  const handleCancelEdit = () => {
    setEditing(false);
    setDraft('');
    setBankCodeDraft('');
    setBankAcctDraft('');
  };

  const handleSave = async () => {
    setBusy(true); setErr(null);
    try {
      // 確認要存的明文：bank-account 模式組合代碼 + 帳號；其他模式用 draft
      const plain = isBank ? formatBankAccount(bankCodeDraft, bankAcctDraft) : draft;

      if (isBank) {
        if (!bankCodeDraft && !bankAcctDraft) {
          // 兩個都空 → 視為清除
          await onSave('');
          setDecrypted('');
          setEditing(false);
          return;
        }
        if (!bankCodeDraft) throw new Error('請選擇匯款銀行');
        if (!/^\d{6,16}$/.test(bankAcctDraft)) throw new Error('銀行帳號需為 6–16 碼純數字');
      }

      // 空字串視為清除：直接讓父層寫 null / 空字串
      if (plain === '') {
        await onSave('');
      } else {
        const blob = await encryptFieldRemote(plain, target, [fieldName]);
        await onSave(blob);
      }
      setDecrypted(plain);
      setEditing(false);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  // —— 渲染 ——

  // 共用的「銀行下拉 + 帳號輸入」編輯區塊（empty / unlocked 兩種狀態都會用到）
  const renderBankEditor = () => (
    <>
      <select
        className="encfield__input encfield__input--bank-select"
        value={bankCodeDraft}
        onChange={(e) => setBankCodeDraft(e.target.value)}
      >
        <option value="" disabled>— 銀行 —</option>
        {TAIWAN_BANKS.map((b) => (
          <option key={b.code} value={b.code}>{b.code} {b.name}</option>
        ))}
      </select>
      <input
        className="encfield__input encfield__input--bank-account"
        value={bankAcctDraft}
        onChange={(e) => setBankAcctDraft(e.target.value.replace(/\D/g, ''))}
        placeholder="帳號（純數字）"
        inputMode="numeric"
        maxLength={16}
        autoComplete="off"
      />
    </>
  );

  // 完全沒有值 → 直接顯示「設定」按鈕（若可編輯）
  if (!hasValue) {
    if (editing) {
      return (
        <div className="encfield encfield--editing">
          {isBank ? renderBankEditor() : (
            <input
              className="encfield__input"
              value={draft}
              placeholder="輸入明文後加密儲存"
              onChange={(e) => setDraft(e.target.value)}
              autoFocus
            />
          )}
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
  // bank-account 模式有自己的 display / mask formatter
  const plainStr = decrypted ?? '';
  const display = showFull
    ? (isBank ? displayBankAccount(plainStr) : plainStr)
    : (isBank
        ? maskBankAccount(plainStr)
        : (formatter ? formatter(plainStr) : maskMiddle(plainStr)));

  if (editing) {
    return (
      <div className="encfield encfield--editing">
        {isBank ? renderBankEditor() : (
          <input
            className="encfield__input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoFocus
          />
        )}
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
