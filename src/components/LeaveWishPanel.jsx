import React, { useEffect, useMemo, useState } from 'react';
import { CalendarHeart, Calculator, Lock, Unlock, Loader, AlertTriangle, CheckCircle, Users } from 'lucide-react';
import { saveLeaveWishSettings, subscribeToLeaveWishCounts, subscribeToLeaveWishEntries } from '../api/database';
import { estimateStaffing } from '../api/scheduleEngine';
import { isDirectAssigned, legalDailyFloor, RATIO_STANDARDS } from '../constants';
import './LeaveWishPanel.css';

// ============================================================================
// 預假管理（護理長）
// ----------------------------------------------------------------------------
// 1. 選月份 + 每日最低人力 → 人力試算（排班引擎 CP-SAT：最少 / 建議 / 最多人數）
// 2. 依試算結果設定每日預假名額（預設 = 參與人數 − 每日最低需求）→ 開放預假
// 3. 開放期間即時看每天登記人數、誰登記了哪幾天、誰還沒登記 → 截止
// 員工送出時排班引擎會再做「名額 + 整體仍排得出合法班表」檢查，登記成功即保證滿足。
// ============================================================================
const DAYS_PER_PERSON = 4;
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

const isEligible = (s) =>
  s && s.is_active !== false && s.is_active !== 'false'
  && s.leave_status !== 'Maternal' && s.leave_status !== 'OnLeave';

const LeaveWishPanel = ({ staffData = [], requirements, bedConfig, selectedYear, selectedMonth, leaveWish, publishedDate }) => {
  const [year, setYear] = useState(Number(leaveWish?.year) || selectedYear);
  const [month, setMonth] = useState(Number(leaveWish?.month) || selectedMonth);
  const [reqs, setReqs] = useState(() => ({
    D: Number(leaveWish?.reqs?.D ?? requirements?.D ?? 3),
    E: Number(leaveWish?.reqs?.E ?? requirements?.E ?? 3),
    N: Number(leaveWish?.reqs?.N ?? requirements?.N ?? 2),
  }));
  const [estimate, setEstimate] = useState(null);
  const [estimating, setEstimating] = useState(false);
  const [quota, setQuota] = useState(Number(leaveWish?.quota) || 0);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState({ type: '', text: '' });
  const [countsDoc, setCountsDoc] = useState(null);
  const [entries, setEntries] = useState({});

  useEffect(() => {
    const u1 = subscribeToLeaveWishCounts(year, month, setCountsDoc);
    const u2 = subscribeToLeaveWishEntries(year, month, setEntries);
    return () => { u1(); u2(); };
  }, [year, month]);

  const isOpenHere = !!leaveWish?.open && Number(leaveWish.year) === year && Number(leaveWish.month) === month;
  const isOpenElsewhere = !!leaveWish?.open && !isOpenHere;
  const daysInMonth = new Date(year, month, 0).getDate();
  const firstWeekday = new Date(year, month - 1, 1).getDay();
  const activeQuota = Number(countsDoc?.quota ?? (isOpenHere ? leaveWish.quota : quota) ?? 0);

  const eligible = useMemo(() => staffData.filter(isEligible), [staffData]);
  const nameOf = useMemo(() => Object.fromEntries(staffData.map(s => [s.staff_id, s.name || s.staff_id])), [staffData]);
  const submitted = eligible.filter(s => entries[s.staff_id]);
  const pending = eligible.filter(s => !entries[s.staff_id]);

  const handleEstimate = async () => {
    setEstimating(true);
    setMsg({ type: '', text: '' });
    try {
      const r = await estimateStaffing({ year, month, reqs });
      setEstimate(r);
      if (r.ok) setQuota(r.default_quota);
    } catch (err) {
      setMsg({ type: 'error', text: err.message });
    } finally {
      setEstimating(false);
    }
  };

  const handleOpen = async () => {
    if (!estimate?.ok || quota < 1 || belowFloor.length) return;
    // 已發布直接指派班表的月份再開放預假：新登記的預假不會出現在已發布的班表上
    if (isDirectAssigned(publishedDate, year, month) && !window.confirm(
      `⚠️ ${year}/${month} 的班表已經發布（直接指派）。\n\n重新開放後新登記的預假不會反映在已發布的班表上，` +
      `截止後必須回「排班工作桌」重新排班並發布。\n\n確定要重新開放嗎？`)) return;
    if (isOpenElsewhere && !window.confirm(`目前 ${leaveWish.year}/${leaveWish.month} 的預假仍在開放中，要改為開放 ${year}/${month} 嗎？\n（原月份會自動截止，已登記的資料保留）`)) return;
    setSaving(true);
    try {
      await saveLeaveWishSettings({
        open: true, year, month, reqs, quota, days_per_person: DAYS_PER_PERSON,
        openedAt: new Date().toISOString(),
      });
      setMsg({ type: 'success', text: `已開放 ${year}/${month} 預假，每日名額 ${quota} 人。員工登入後會看到預假月曆。` });
    } catch (err) {
      setMsg({ type: 'error', text: `開放失敗：${err.message}` });
    } finally {
      setSaving(false);
    }
  };

  const handleClose = async () => {
    if (!window.confirm(`確定截止 ${year}/${month} 預假？\n截止後員工無法再登記或改選（已登記的保留，排班時保證滿足）。`)) return;
    setSaving(true);
    try {
      await saveLeaveWishSettings({ ...leaveWish, open: false, closedAt: new Date().toISOString() });
      setMsg({ type: 'success', text: `已截止 ${year}/${month} 預假。` });
    } catch (err) {
      setMsg({ type: 'error', text: `截止失敗：${err.message}` });
    } finally {
      setSaving(false);
    }
  };

  // 衛福部護病比法定下限（依「病床與護病比」的病床數與醫院等級）：預假的每日人力不可低於它，
  // 否則預假檢查與排班都建立在不合法的人力上（排班工作桌也會再取 max 一次）
  const floor = legalDailyFloor(bedConfig?.bedCount ?? 0, bedConfig?.hospitalLevel || 'MedicalCenter');
  const belowFloor = ['D', 'E', 'N'].filter(k => Number(reqs[k]) < floor[k]);
  const levelName = (RATIO_STANDARDS[bedConfig?.hospitalLevel] || RATIO_STANDARDS.MedicalCenter).name;

  const setReq = (k, v) => { setReqs({ ...reqs, [k]: Math.max(0, Number(v) || 0) }); setEstimate(null); };
  const setYm = (y, m) => { setYear(y); setMonth(m); setEstimate(null); };

  return (
    <div className="lw-panel">
      <div className="lw-panel__header">
        <h2 className="lw-panel__title"><CalendarHeart size={22} /> 預假管理</h2>
        <span className={`lw-panel__status ${isOpenHere ? 'lw-panel__status--open' : ''}`}>
          {isOpenHere ? <><Unlock size={14} /> {year}/{month} 開放中</> : <><Lock size={14} /> {year}/{month} 未開放</>}
        </span>
      </div>

      {isOpenElsewhere && (
        <div className="lw-panel__msg lw-panel__msg--warn">
          <AlertTriangle size={14} /> 目前開放中的是 {leaveWish.year}/{leaveWish.month}，不是畫面上的月份。
        </div>
      )}

      {/* ① 月份與人力 → 試算 */}
      <section className="lw-panel__card">
        <h3 className="lw-panel__card-title">① 月份與每日最低人力</h3>
        <div className="lw-panel__form">
          <label className="lw-panel__field">年
            <input type="number" className="lw-panel__input" value={year} min="2024" max="2099"
                   onChange={e => setYm(Number(e.target.value), month)} disabled={isOpenHere} />
          </label>
          <label className="lw-panel__field">月
            <select className="lw-panel__input" value={month} onChange={e => setYm(year, Number(e.target.value))} disabled={isOpenHere}>
              {Array.from({ length: 12 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}
            </select>
          </label>
          {['D', 'E', 'N'].map(k => (
            <label key={k} className="lw-panel__field">{{ D: '白班 D', E: '小夜 E', N: '大夜 N' }[k]}
              <input type="number" className="lw-panel__input" min="0" max="50" value={reqs[k]}
                     onChange={e => setReq(k, e.target.value)} disabled={isOpenHere} />
            </label>
          ))}
          <span className="lw-panel__muted">
            法定下限（{bedConfig?.bedCount ?? 0} 床・{levelName}）：白班 {floor.D} / 小夜 {floor.E} / 大夜 {floor.N}
          </span>
          <button type="button" className="lw-panel__btn" onClick={handleEstimate} disabled={estimating || isOpenHere}>
            {estimating ? <><Loader size={14} className="lw-panel__spin" /> 試算中（最多約 2 分鐘）…</> : <><Calculator size={14} /> 人力試算</>}
          </button>
        </div>

        {belowFloor.length > 0 && !isOpenHere && (
          <div className="lw-panel__msg lw-panel__msg--warn">
            <AlertTriangle size={14} /> {belowFloor.map(k => ({ D: '白班', E: '小夜', N: '大夜' }[k])).join('、')}
            低於衛福部護病比法定下限，不能開放預假。請調高每日人力（或到「護病比」分頁確認病床數與醫院等級）。
          </div>
        )}

        {estimate && (
          <div className={`lw-panel__estimate ${estimate.ok ? '' : 'lw-panel__estimate--bad'}`}>
            <div className="lw-panel__estimate-nums">
              <span>目前可排班 <b>{estimate.team_size}</b> 人</span>
              <span>最少 <b>{estimate.min ?? '—'}</b></span>
              <span>建議 <b>{estimate.recommended ?? '—'}</b></span>
              <span>最多 <b>{estimate.max}</b></span>
              {estimate.gray?.length > 0 && <span className="lw-panel__muted">灰色地帶 {estimate.gray.join('、')} 人（很難排，不建議）</span>}
            </div>
            <div className="lw-panel__estimate-note">
              {estimate.ok ? <CheckCircle size={14} /> : <AlertTriangle size={14} />} {estimate.note}
            </div>
          </div>
        )}
      </section>

      {/* ② 名額 → 開放 / 截止 */}
      <section className="lw-panel__card">
        <h3 className="lw-panel__card-title">② 預假名額與開放</h3>
        <div className="lw-panel__form">
          <label className="lw-panel__field">每日名額（人）
            <input type="number" className="lw-panel__input" min="1" max="50" value={isOpenHere ? leaveWish.quota : quota}
                   onChange={e => setQuota(Math.max(0, Number(e.target.value) || 0))} disabled={isOpenHere || !estimate?.ok} />
          </label>
          <span className="lw-panel__muted">每人 {DAYS_PER_PERSON} 天，先搶先贏；預設名額 = 參與人數 − 每日最低需求</span>
          {isOpenHere ? (
            <button type="button" className="lw-panel__btn lw-panel__btn--danger" onClick={handleClose} disabled={saving}>
              <Lock size={14} /> 截止預假
            </button>
          ) : (
            <button type="button" className="lw-panel__btn lw-panel__btn--primary" onClick={handleOpen}
                    disabled={saving || !estimate?.ok || quota < 1 || belowFloor.length > 0}
                    title={belowFloor.length ? '每日人力低於法定下限' : !estimate?.ok ? '請先完成人力試算' : ''}>
              <Unlock size={14} /> 開放預假
            </button>
          )}
        </div>
      </section>

      {msg.text && (
        <div className={`lw-panel__msg lw-panel__msg--${msg.type}`}>
          {msg.type === 'error' ? <AlertTriangle size={14} /> : <CheckCircle size={14} />} {msg.text}
        </div>
      )}

      {/* ③ 登記狀況 */}
      <section className="lw-panel__card">
        <h3 className="lw-panel__card-title">③ 登記狀況 · {year}/{month}</h3>
        <div className="lw-panel__grid">
          {WEEKDAYS.map(w => <div key={w} className="lw-panel__weekday">{w}</div>)}
          {Array.from({ length: firstWeekday }).map((_, i) => <div key={`pad-${i}`} />)}
          {Array.from({ length: daysInMonth }).map((_, i) => {
            const day = i + 1;
            const n = Number(countsDoc?.counts?.[String(day)] || 0);
            const level = !activeQuota || n === 0 ? 'none' : n >= activeQuota ? 'full' : n / activeQuota >= 0.5 ? 'mid' : 'low';
            return (
              <div key={day} className={`lw-panel__day lw-panel__day--${level}`} title={`${month}/${day}：${n} / ${activeQuota || '—'} 人`}>
                <span className="lw-panel__day-num">{day}</span>
                <span className="lw-panel__day-count">{n}{activeQuota ? ` / ${activeQuota}` : ''}</span>
              </div>
            );
          })}
        </div>

        <div className="lw-panel__lists">
          <div>
            <h4 className="lw-panel__list-title"><CheckCircle size={14} /> 已登記 {submitted.length} 人</h4>
            <ul className="lw-panel__list">
              {submitted.map(s => (
                <li key={s.staff_id}>
                  <span className="lw-panel__who">{nameOf[s.staff_id]}</span>
                  <span className="lw-panel__days">{(entries[s.staff_id].days || []).map(d => `${month}/${d}`).join('、')}</span>
                </li>
              ))}
              {submitted.length === 0 && <li className="lw-panel__muted">尚無人登記</li>}
            </ul>
          </div>
          <div>
            <h4 className="lw-panel__list-title lw-panel__list-title--pending"><Users size={14} /> 未登記 {pending.length} 人</h4>
            <p className="lw-panel__muted">未登記者不受預假限制，由排班引擎自由安排休假。</p>
            <ul className="lw-panel__list lw-panel__list--inline">
              {pending.map(s => <li key={s.staff_id}>{nameOf[s.staff_id]}</li>)}
            </ul>
          </div>
        </div>
      </section>
    </div>
  );
};

export default LeaveWishPanel;
