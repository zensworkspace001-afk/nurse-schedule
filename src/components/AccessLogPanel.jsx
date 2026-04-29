import React, { useEffect, useState, useMemo } from 'react';
import { ShieldAlert, RefreshCw, Filter } from 'lucide-react';
import {
  collection, query, orderBy, limit, onSnapshot,
} from 'firebase/firestore';
import { db } from '../api/database';
import './AccessLogPanel.css';

// 敏感欄位存取稽核日誌檢視器（admin 專用）
//
// 從 Firestore `access_logs` collection 即時拉最近 N 筆，提供日期 / 動作 / 對象篩選。
const AccessLogPanel = () => {
  const [logs, setLogs] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [actionFilter, setActionFilter] = useState('all');   // all | decrypt | encrypt | ai-access
  const [actorFilter, setActorFilter] = useState('');
  const [maxRows, setMaxRows] = useState(200);

  useEffect(() => {
    setIsLoading(true);
    const q = query(
      collection(db, 'access_logs'),
      orderBy('ts', 'desc'),
      limit(maxRows),
    );
    const unsub = onSnapshot(q, (snap) => {
      const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      setLogs(rows);
      setIsLoading(false);
    }, (err) => {
      console.error('access_logs 訂閱失敗:', err);
      setIsLoading(false);
    });
    return () => unsub();
  }, [maxRows]);

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
    const c = { decrypt: 0, encrypt: 0, 'ai-access': 0, other: 0 };
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
          <span className="acclog__stat acclog__stat--ai">AI 存取 {counts['ai-access']}</span>
        </div>
      </div>

      <div className="acclog__filter-bar">
        <div className="acclog__filter-group">
          <Filter size={12} />
          {['all', 'decrypt', 'encrypt', 'ai-access'].map(a => (
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
        <button onClick={() => setMaxRows(m => m)} className="acclog__refresh" title="重新整理">
          <RefreshCw size={12} />
        </button>
      </div>

      {isLoading ? (
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
