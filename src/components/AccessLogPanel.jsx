import React, { useEffect, useState, useMemo } from 'react';
import { ShieldAlert, RefreshCw, Filter } from 'lucide-react';
import { auth } from '../api/database';
import './AccessLogPanel.css';

// 敏感欄位存取稽核日誌檢視器（admin 專用）
//
// 透過 /api/admin-user (action='list-access-logs') 拉最近 N 筆，提供日期 / 動作 / 對象篩選。
// 後端依 ACCESS_LOG_BACKEND 決定資料來源（Firestore 或 MySQL）。稽核日誌不需即時，
// 故採「拉取 + 手動 refresh」而非 onSnapshot 即時訂閱。
const AccessLogPanel = () => {
  const [logs, setLogs] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errMsg, setErrMsg] = useState(null);
  const [actionFilter, setActionFilter] = useState('all');   // all | decrypt | encrypt | relock | ai-access | login | login-failure
  const [actorFilter, setActorFilter] = useState('');
  const [maxRows, setMaxRows] = useState(200);
  const [tick, setTick] = useState(0); // 用於手動重新訂閱（refresh 按鈕）

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setIsLoading(true);
      setErrMsg(null);
      try {
        const token = await auth.currentUser.getIdToken();
        const res = await fetch('/api/admin-user', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ action: 'list-access-logs', limit: maxRows }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(res.status === 403
            ? '無權限讀取稽核日誌（請確認您以管理員身份登入）'
            : (data.error || `HTTP ${res.status}`));
        }
        if (!cancelled) {
          setLogs(Array.isArray(data.logs) ? data.logs : []);
          setIsLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          console.error('access_logs 載入失敗:', err);
          setErrMsg(`稽核日誌載入失敗：${err.message}`);
          setIsLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [maxRows, tick]);

  const filtered = useMemo(() => logs.filter(log => {
    if (actionFilter !== 'all' && log.action !== actionFilter) return false;
    if (actorFilter) {
      const q = actorFilter.toLowerCase();
      const email = (log.actor?.email || '').toLowerCase();
      const uid = (log.actor?.uid || '').toLowerCase();
      if (!email.includes(q) && !uid.includes(q)) return false;
    }
    return true;
  }), [logs, actionFilter, actorFilter]);

  const counts = useMemo(() => {
    const c = { decrypt: 0, encrypt: 0, relock: 0, 'ai-access': 0, login: 0, 'login-failure': 0, other: 0 };
    logs.forEach(l => { (c[l.action] !== undefined ? c[l.action]++ : c.other++); });
    return c;
  }, [logs]);

  return (
    <div className="acclog">
      <div className="acclog__header">
        <h2 className="acclog__title">
          <ShieldAlert size={18} /> 敏感資料存取稽核
        </h2>
        <div className="acclog__stats">
          <span className="acclog__stat acclog__stat--decrypt">解密 {counts.decrypt}</span>
          <span className="acclog__stat acclog__stat--encrypt">加密 {counts.encrypt}</span>
          <span className="acclog__stat acclog__stat--relock">上鎖 {counts.relock}</span>
          <span className="acclog__stat acclog__stat--ai">AI 存取 {counts['ai-access']}</span>
          <span className="acclog__stat acclog__stat--login">登入成功 {counts.login}</span>
          <span className="acclog__stat acclog__stat--login-fail">登入失敗 {counts['login-failure']}</span>
          {counts.other > 0 && (
            <span className="acclog__stat acclog__stat--other">其他 {counts.other}</span>
          )}
        </div>
      </div>

      <div className="acclog__filter-bar">
        <div className="acclog__filter-group">
          <Filter size={12} />
          {['all', 'decrypt', 'encrypt', 'relock', 'ai-access', 'login', 'login-failure'].map(a => (
            <button
              key={a}
              onClick={() => setActionFilter(a)}
              className={`acclog__filter-btn${actionFilter === a ? ' acclog__filter-btn--active' : ''}`}
            >
              {a === 'all' ? '全部' : a}
            </button>
          ))}
        </div>
        <input
          type="text"
          value={actorFilter}
          onChange={(e) => setActorFilter(e.target.value)}
          placeholder="篩選使用者 email / UID"
          className="acclog__search-input"
        />
        <select value={maxRows} onChange={(e) => setMaxRows(Number(e.target.value))} className="acclog__limit-select">
          <option value={50}>最近 50 筆</option>
          <option value={200}>最近 200 筆</option>
          <option value={500}>最近 500 筆</option>
          <option value={1000}>最近 1000 筆</option>
        </select>
        <button onClick={() => setTick(t => t + 1)} className="acclog__refresh" title="重新載入">
          <RefreshCw size={12} />
        </button>
      </div>

      {errMsg ? (
        <div className="acclog__empty acclog__empty--error">⚠️ {errMsg}</div>
      ) : isLoading ? (
        <div className="acclog__empty">載入中…</div>
      ) : filtered.length === 0 ? (
        <div className="acclog__empty">尚無稽核紀錄</div>
      ) : (
        <div className="acclog__table-wrap">
          <table className="acclog__table">
            <thead>
              <tr>
                <th>時間</th>
                <th>動作</th>
                <th>使用者</th>
                <th>對象</th>
                <th>欄位</th>
                <th>IP</th>
                <th>備註</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((log) => (
                <tr key={log.id} className={`acclog__row acclog__row--${log.action}`}>
                  <td className="acclog__cell-ts">{formatTs(log.ts)}</td>
                  <td>
                    <span className={`acclog__action acclog__action--${log.action}`}>
                      {log.action}
                    </span>
                  </td>
                  <td className="acclog__cell-actor">
                    <div>{log.actor?.email || '-'}</div>
                    <div className="acclog__cell-uid">{log.actor?.uid}</div>
                  </td>
                  <td>
                    {log.target?.kind ? (
                      <>
                        <strong>{log.target.kind}</strong>
                        {log.target.id ? ` / ${log.target.id}` : ''}
                      </>
                    ) : '-'}
                  </td>
                  <td className="acclog__cell-fields">
                    {(log.fields || []).map(f => (
                      <span key={f} className="acclog__field-tag">{f}</span>
                    ))}
                  </td>
                  <td className="acclog__cell-ip">{log.ip || '-'}</td>
                  <td className="acclog__cell-extra">
                    {log.extra ? JSON.stringify(log.extra) : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

function formatTs(iso) {
  if (!iso) return '-';
  try {
    const d = new Date(iso);
    return d.toLocaleString('zh-TW', { hour12: false });
  } catch {
    return iso;
  }
}

export default AccessLogPanel;
