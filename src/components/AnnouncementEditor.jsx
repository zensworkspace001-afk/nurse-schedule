import React, { useEffect, useState } from 'react';
import { Megaphone, AlertTriangle, AlertOctagon, Send, Trash2, CheckCircle2 } from 'lucide-react';
import { saveAnnouncement, clearAnnouncement } from '../api/database';
import './AnnouncementEditor.css';

// admin 用：撰寫 / 清除全院系統公告。寫入後所有 authed 使用者首頁的
// AnnouncementBanner 會即時刷新（onSnapshot driven）。

const KIND_OPTIONS = [
  { value: 'info',    label: '一般公告', Icon: Megaphone,     hint: '藍底 — 例行通知、活動公告' },
  { value: 'warning', label: '提醒',     Icon: AlertTriangle, hint: '橘底 — 排班變動、流程提醒' },
  { value: 'urgent',  label: '緊急',     Icon: AlertOctagon,  hint: '紅底脈動 — 系統故障、人力需求緊急狀況' },
];

const MAX_LEN = 500;

const AnnouncementEditor = ({ announcement, currentUser }) => {
  const [text, setText] = useState('');
  const [kind, setKind] = useState('info');
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  // 從雲端公告載入到編輯框
  useEffect(() => {
    if (announcement && announcement.active !== false) {
      setText(announcement.text || '');
      setKind(announcement.kind || 'info');
    } else {
      setText('');
      setKind('info');
    }
  }, [announcement?.text, announcement?.kind, announcement?.active]);

  const handleSave = async () => {
    if (!text.trim()) return;
    setSaving(true);
    try {
      await saveAnnouncement({
        text: text.trim(),
        kind,
        updatedBy: currentUser ? { uid: currentUser.id, name: currentUser.name } : null,
      });
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2000);
    } catch (err) {
      alert('發布失敗：' + err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    if (!window.confirm('確定要清除目前的系統公告嗎？所有員工的 banner 會立即消失。')) return;
    setSaving(true);
    try {
      await clearAnnouncement();
      setText('');
      setKind('info');
    } catch (err) {
      alert('清除失敗：' + err.message);
    } finally {
      setSaving(false);
    }
  };

  const isActive = announcement && announcement.active !== false && announcement.text;
  const remaining = MAX_LEN - text.length;

  return (
    <div className="ann-editor">
      <div className="ann-editor__header">
        <h3 className="ann-editor__title">
          <Megaphone size={18} /> 系統公告
        </h3>
        {isActive && (
          <span className="ann-editor__live-badge">
            <span className="ann-editor__live-dot" />
            目前正在顯示
          </span>
        )}
      </div>

      <p className="ann-editor__desc">
        發布後會在所有員工（含 admin）的首頁頂端顯示。一次只能有一條公告。
        員工可暫時關閉，但你更新內容時會自動再次跳出。
      </p>

      <div className="ann-editor__kind-row">
        {KIND_OPTIONS.map(opt => (
          <label
            key={opt.value}
            className={`ann-editor__kind-card ann-editor__kind-card--${opt.value}${kind === opt.value ? ' ann-editor__kind-card--selected' : ''}`}
          >
            <input
              type="radio"
              name="announcement-kind"
              value={opt.value}
              checked={kind === opt.value}
              onChange={() => setKind(opt.value)}
            />
            <opt.Icon size={16} />
            <div>
              <div className="ann-editor__kind-label">{opt.label}</div>
              <div className="ann-editor__kind-hint">{opt.hint}</div>
            </div>
          </label>
        ))}
      </div>

      <textarea
        className="ann-editor__textarea"
        value={text}
        onChange={(e) => setText(e.target.value.slice(0, MAX_LEN))}
        placeholder="輸入公告內容…（例如：5/15 全院演習，當日請依平日班表上班）"
        rows={4}
      />
      <div className="ann-editor__meta-row">
        <span className={`ann-editor__char-count${remaining < 50 ? ' ann-editor__char-count--low' : ''}`}>
          剩 {remaining} 字
        </span>
        {announcement?.updatedAt && (
          <span className="ann-editor__updated">
            上次更新：{new Date(announcement.updatedAt).toLocaleString('zh-TW')}
            {announcement.updatedBy?.name && ` by ${announcement.updatedBy.name}`}
          </span>
        )}
      </div>

      <div className="ann-editor__actions">
        <button
          type="button"
          className="ann-editor__btn ann-editor__btn--primary"
          onClick={handleSave}
          disabled={saving || !text.trim()}
        >
          {savedFlash ? <><CheckCircle2 size={14} /> 已發布</> : <><Send size={14} /> 發布公告</>}
        </button>
        {isActive && (
          <button
            type="button"
            className="ann-editor__btn ann-editor__btn--ghost"
            onClick={handleClear}
            disabled={saving}
          >
            <Trash2 size={14} /> 清除公告
          </button>
        )}
      </div>
    </div>
  );
};

export default AnnouncementEditor;
