import React, { useEffect, useState } from 'react';
import { Megaphone, AlertTriangle, AlertOctagon, X } from 'lucide-react';
import './AnnouncementBanner.css';

// 全院系統公告 banner — admin 寫，所有 authed 使用者讀
//
// 顯示規則：
//   - announcement.active === false  → 不顯示
//   - announcement.text 為空           → 不顯示
//   - 使用者按 X 後，這一條的 updatedAt 會被存進 sessionStorage 視為「已讀」
//   - admin 改了內容（updatedAt 變新）就會自動再次顯示
//
// 三種等級：info（藍）/ warning（橘）/ urgent（紅，會脈動）

const KINDS = {
  info:    { Icon: Megaphone,     label: '公告' },
  warning: { Icon: AlertTriangle, label: '提醒' },
  urgent:  { Icon: AlertOctagon,  label: '緊急' },
};

const DISMISS_KEY = 'announcement.dismissedAt';

const AnnouncementBanner = ({ announcement }) => {
  const [dismissedAt, setDismissedAt] = useState(() => {
    try { return sessionStorage.getItem(DISMISS_KEY); } catch { return null; }
  });

  // 如果是新的 updatedAt，就清掉本地 dismiss 紀錄
  useEffect(() => {
    if (!announcement?.updatedAt) return;
    if (dismissedAt && dismissedAt !== announcement.updatedAt) {
      setDismissedAt(null);
      try { sessionStorage.removeItem(DISMISS_KEY); } catch { /* noop */ }
    }
  }, [announcement?.updatedAt, dismissedAt]);

  if (!announcement) return null;
  if (announcement.active === false) return null;
  if (!announcement.text || !String(announcement.text).trim()) return null;
  if (dismissedAt && dismissedAt === announcement.updatedAt) return null;

  const kind = KINDS[announcement.kind] ? announcement.kind : 'info';
  const { Icon, label } = KINDS[kind];

  const handleDismiss = () => {
    setDismissedAt(announcement.updatedAt);
    try { sessionStorage.setItem(DISMISS_KEY, announcement.updatedAt); } catch { /* noop */ }
  };

  return (
    <div className={`announcement announcement--${kind}`} role="status">
      <div className="announcement__inner">
        <Icon size={18} className="announcement__icon" />
        <span className="announcement__label">{label}</span>
        <span className="announcement__text">{announcement.text}</span>
        <button
          type="button"
          className="announcement__dismiss"
          onClick={handleDismiss}
          aria-label="關閉公告"
          title="關閉（本次 session 不再顯示，下一條公告會自動重新出現）"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
};

export default AnnouncementBanner;
