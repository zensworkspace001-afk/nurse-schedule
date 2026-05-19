import React, { useEffect, useRef, useState } from 'react';
import { ShieldCheck, CheckCircle2, ChevronDown } from 'lucide-react';
import './PrivacyNoticePage.css';

// 個資法 §8 告知頁。
// 強制使用者滑到底才能按下「我已詳閱完畢」；按下後寫 localStorage.pdpa_read_v1，
// 讓 ProfileWizard 的 storage 事件監聽器解鎖同意 checkbox。
//
// 為什麼用 localStorage 而非 postMessage：localStorage 跨分頁 + 重啟後仍持久；
// 即使使用者關掉這個分頁再回到 wizard 也能讀得到，UX 更穩。
//
// 版本碼 v1：未來告知文案修訂時把 key 升到 v2，員工會被強制重讀新版（舊版同意不算）。
const STORAGE_KEY = 'pdpa_read_v1';
const SCROLL_BOTTOM_THRESHOLD = 50; // 距離底部 ≤50px 視為已讀完

const PrivacyNoticePage = () => {
  const scrollRef = useRef(null);
  const [hasReachedBottom, setHasReachedBottom] = useState(false);
  const [acked, setAcked] = useState(() => !!localStorage.getItem(STORAGE_KEY));

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const check = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (distance <= SCROLL_BOTTOM_THRESHOLD) setHasReachedBottom(true);
    };
    // 初始判定 — 若內容本身不夠長到要滾動，直接視為已讀完
    if (el.scrollHeight <= el.clientHeight + SCROLL_BOTTOM_THRESHOLD) {
      setHasReachedBottom(true);
    }
    el.addEventListener('scroll', check, { passive: true });
    return () => el.removeEventListener('scroll', check);
  }, []);

  const handleAck = () => {
    const ts = new Date().toISOString();
    localStorage.setItem(STORAGE_KEY, ts);
    setAcked(true);
  };

  const handleScrollToBottom = () => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  };

  return (
    <div className="privnotice">
      <div className="privnotice__card">
        <header className="privnotice__header">
          <ShieldCheck size={24} className="privnotice__header-icon" />
          <div>
            <h1 className="privnotice__title">個人資料蒐集告知</h1>
            <p className="privnotice__subtitle">依《個人資料保護法》第 8 條規定告知</p>
          </div>
        </header>

        <div className="privnotice__body" ref={scrollRef}>
          <section className="privnotice__section">
            <h2>1. 蒐集機關</h2>
            <p>◯◯醫院 護理部（部署時請替換為實際單位名稱）</p>
          </section>

          <section className="privnotice__section">
            <h2>2. 蒐集目的</h2>
            <p>法務部公告之特定目的代號：</p>
            <ul>
              <li><strong>002 人事管理</strong></li>
              <li><strong>069 契約、類似契約或其他法律關係事務</strong></li>
            </ul>
            <p>用途：護理人員排班、薪資結算、勞動基準法合規檢核、組織管理。</p>
          </section>

          <section className="privnotice__section">
            <h2>3. 個人資料類別</h2>
            <table className="privnotice__table">
              <thead><tr><th>類別</th><th>欄位</th><th>備註</th></tr></thead>
              <tbody>
                <tr><td>識別類</td><td>姓名、員工編號、性別、Email、手機</td><td>—</td></tr>
                <tr className="privnotice__row--sensitive">
                  <td><strong>健康類</strong>（特種個資 §6）</td>
                  <td>孕期 / 哺乳期狀態</td>
                  <td>用於母性保護排班（勞基法 §49）</td>
                </tr>
                <tr><td>財務類</td><td>銀行帳號</td><td>薪資匯入用</td></tr>
                <tr><td>政府資料</td><td>身分證 / 居留證號</td><td>扣繳憑單申報用</td></tr>
                <tr><td>職業類</td><td>護理職級、年資、是否組長</td><td>—</td></tr>
                <tr><td>影像</td><td>員工頭貼</td><td>同事間排班協作識別用</td></tr>
              </tbody>
            </table>
          </section>

          <section className="privnotice__section">
            <h2>4. 蒐集方式</h2>
            <p>由您本人於本系統線上填寫。提交時系統會自動將「身分證 / 銀行帳號 / 手機」三項以 AES-256-GCM 加密儲存，明文絕不留存於資料庫。</p>
          </section>

          <section className="privnotice__section">
            <h2>5. 利用期間</h2>
            <p>在職期間及離職後依法令應保存之最低年限（勞動契約相關文件依《勞動基準法》§38 保存 5 年）。</p>
            <p>離職時，您的頭貼與識別資料將自動歸檔至加密的「離職人員」紀錄；加密 PII（身分證 / 銀行帳號 / 手機）將一併銷毀，避免無止盡的金鑰維護成本。</p>
          </section>

          <section className="privnotice__section privnotice__section--important">
            <h2>6. 利用地區（跨境傳輸告知 §21）</h2>
            <p>本系統使用 <strong>Google Cloud Firestore</strong> 服務，伺服器位於美國，構成個人資料國際傳輸。本院已評估該服務商之資料保護措施符合《個人資料保護法》第 21 條相關規定。</p>
          </section>

          <section className="privnotice__section">
            <h2>7. 利用對象</h2>
            <ul>
              <li>您本人</li>
              <li>本院授權之系統管理員（護理長 / HR）</li>
              <li>您的「姓名、職級、頭貼」會於系統內向同事顯示，用於排班協作</li>
              <li>所有敏感欄位之操作紀錄將留存於稽核日誌供事後查核</li>
            </ul>
          </section>

          <section className="privnotice__section">
            <h2>8. 利用方式</h2>
            <p>電腦自動化處理。身分證、銀行帳號、手機於資料庫中以密文形式儲存；管理員存取加密欄位時，系統將自動寫入稽核紀錄。您可請求查閱您個人資料被存取的紀錄。</p>
          </section>

          <section className="privnotice__section privnotice__section--rights">
            <h2>9. 您就個人資料得行使之權利（§3）</h2>
            <ul>
              <li>查詢或請求閱覽</li>
              <li>請求製給複製本</li>
              <li>請求補充或更正</li>
              <li>請求停止蒐集、處理或利用</li>
              <li>請求刪除</li>
            </ul>
            <p><strong>行使方式：</strong>登入後於「編輯頭貼」、「修改密碼」自行操作；其餘事項或向護理部資訊管理員提出書面申請。</p>
          </section>

          <section className="privnotice__section">
            <h2>10. 不提供個人資料之影響</h2>
            <p>若您不同意提供，本系統將無法為您建立帳號、無法產出您的班表、無法計算與支付薪資，可能影響您於本院之執業權益。</p>
          </section>

          <section className="privnotice__section privnotice__section--footer">
            <p>本告知文案版本：v1（{new Date().toLocaleDateString('zh-TW')} 起適用）</p>
            <p>如告知內容修訂，本系統將要求您重新確認新版本。</p>
          </section>
        </div>

        {/* 滑到底之前顯示提示；滑到底之後出現「我已詳閱完畢」按鈕 */}
        <div className="privnotice__footer">
          {!hasReachedBottom && (
            <button
              type="button"
              onClick={handleScrollToBottom}
              className="privnotice__scroll-hint"
              aria-live="polite"
            >
              <ChevronDown size={14} /> 請繼續往下捲動讀完全文，才能繼續
            </button>
          )}

          {hasReachedBottom && !acked && (
            <button
              type="button"
              onClick={handleAck}
              className="privnotice__ack-btn"
              autoFocus
            >
              <CheckCircle2 size={16} /> 我已詳閱完畢，繼續填寫資料
            </button>
          )}

          {acked && (
            <div className="privnotice__done">
              <CheckCircle2 size={18} /> 已完成詳閱確認，請關閉此分頁，回到原系統勾選同意框。
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default PrivacyNoticePage;
