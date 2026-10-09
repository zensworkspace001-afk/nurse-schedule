import { useEffect, useState } from 'react';
import { PDPA_NOTICE_VERSION, PDPA_NOTICE_EFFECTIVE_DATE } from '../../shared/policy.js';

// 「已把告知頁滑到底並按下我已詳閱完畢」的本機旗標。只用來解鎖同意勾選框（UX），
// 不是法律留證 — 真正的同意紀錄是後端寫進員工資料的 pdpa_notice_version + pdpa_consented_at。
// key 跟著版本走：告知升版後舊旗標自動失效，員工必須重讀新版。
export { PDPA_NOTICE_VERSION, PDPA_NOTICE_EFFECTIVE_DATE };
export const PDPA_READ_KEY = `pdpa_read_${PDPA_NOTICE_VERSION}`;

// 無痕視窗 / 封鎖網站資料時 localStorage 可能丟例外 — 一律包起來，失敗就當作沒讀過
export function hasReadNotice() {
  try { return !!localStorage.getItem(PDPA_READ_KEY); } catch { return false; }
}

export function markNoticeRead() {
  try { localStorage.setItem(PDPA_READ_KEY, new Date().toISOString()); return true; } catch { return false; }
}

// 告知頁在另一個分頁開啟：監聽 storage 事件，切回來時（focus）再補查一次
export function usePdpaRead() {
  const [read, setRead] = useState(hasReadNotice);
  useEffect(() => {
    const onStorage = (e) => { if (e.key === PDPA_READ_KEY && e.newValue) setRead(true); };
    const onFocus = () => { if (hasReadNotice()) setRead(true); };
    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', onFocus);
    };
  }, []);
  return read;
}
