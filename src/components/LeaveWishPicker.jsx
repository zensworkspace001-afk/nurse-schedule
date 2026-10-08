import React, { useEffect, useMemo, useState } from 'react';
import { CalendarHeart, CheckCircle, AlertTriangle, Loader, Send } from 'lucide-react';
import { subscribeToLeaveWishCounts, subscribeToMyLeaveWish } from '../api/database';
import { submitLeaveWish } from '../api/scheduleEngine';
import './LeaveWishPicker.css';

// ============================================================================
// 員工預假（護理長開放期間顯示）
// ----------------------------------------------------------------------------
// - 每人選固定天數（預設 4 天），先搶先贏；每天有名額上限，額滿的日期反灰不能選
// - 送出由排班引擎檢查：開放中、本人、天數、名額、整體仍排得出合法班表 → 才登記
// - 登記成功 = 保證排班時那幾天一定休（排班引擎把已登記預假當硬約束）
// - 開放期間可以改選；改選時自己原本的日期會先釋出
// ============================================================================
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

const LeaveWishPicker = ({ staffId, leaveWish }) => {
  const year = Number(leaveWish?.year);
  const month = Number(leaveWish?.month);
  const need = Number(leaveWish?.days_per_person) || 4;
  const daysInMonth = year && month ? new Date(year, month, 0).getDate() : 0;
  const firstWeekday = year && month ? new Date(year, month - 1, 1).getDay() : 0;

  const [countsDoc, setCountsDoc] = useState(null);
  const [mine, setMine] = useState(null);
  const [selected, setSelected] = useState([]);
  const [editing, setEditing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState({ type: '', text: '' });

  useEffect(() => {
    if (!year || !month || !staffId) return undefined;
    const u1 = subscribeToLeaveWishCounts(year, month, setCountsDoc);
    const u2 = subscribeToMyLeaveWish(year, month, staffId, setMine);
    return () => { u1(); u2(); };
  }, [year, month, staffId]);

  const myDays = useMemo(() => (mine?.days || []).map(Number), [mine]);
  const quota = Number(countsDoc?.quota ?? leaveWish?.quota ?? 0);

  // 剩餘名額：自己原本登記的日期要先扣回來（改選時那一格對自己仍可選）
  const remainingFor = (day) => {
    const used = Number(countsDoc?.counts?.[String(day)] || 0) - (myDays.includes(day) ? 1 : 0);
    return Math.max(0, quota - used);
  };

  const isEditing = editing || myDays.length === 0;
  const shown = isEditing ? selected : myDays;

  const toggle = (day) => {
    if (!isEditing || submitting) return;
    setMsg({ type: '', text: '' });
    if (selected.includes(day)) {
      setSelected(selected.filter(d => d !== day));
    } else if (selected.length < need && remainingFor(day) > 0) {
      setSelected([...selected, day].sort((a, b) => a - b));
    }
  };

  const startEdit = () => {
    setSelected(myDays);
    setEditing(true);
    setMsg({ type: '', text: '' });
  };

  const handleSubmit = async () => {
    if (selected.length !== need || submitting) return;
    setSubmitting(true);
    setMsg({ type: '', text: '' });
    try {
      await submitLeaveWish(selected);
      setEditing(false);
      setMsg({ type: 'success', text: `已登記 ${selected.map(d => `${month}/${d}`).join('、')}，排班時保證這幾天休假。` });
    } catch (err) {
      setMsg({ type: 'error', text: err.message || '送出失敗，請稍後再試' });
    } finally {
      setSubmitting(false);
    }
  };

  if (!daysInMonth) return null;

  return (
    <section className="leave-wish">
      <h3 className="leave-wish__title"><CalendarHeart size={18} /> {year} 年 {month} 月預假</h3>
      <p className="leave-wish__desc">
        請選 <strong>{need}</strong> 天想休假的日子，先登記先得；每天最多 <strong>{quota}</strong> 人。
        登記成功後，排班時這幾天<strong>保證休假</strong>。開放期間可以改選。
      </p>

      <div className="leave-wish__grid" role="grid" aria-label="預假月曆">
        {WEEKDAYS.map(w => <div key={w} className="leave-wish__weekday">{w}</div>)}
        {Array.from({ length: firstWeekday }).map((_, i) => <div key={`pad-${i}`} />)}
        {Array.from({ length: daysInMonth }).map((_, i) => {
          const day = i + 1;
          const left = remainingFor(day);
          const picked = shown.includes(day);
          const full = left === 0 && !picked;
          const weekday = (firstWeekday + i) % 7;
          const cls = [
            'leave-wish__day',
            picked ? 'leave-wish__day--picked' : '',
            full ? 'leave-wish__day--full' : '',
            !full && !picked && left <= 1 ? 'leave-wish__day--low' : '',
            weekday === 0 || weekday === 6 ? 'leave-wish__day--weekend' : '',
            isEditing ? 'leave-wish__day--editable' : '',
          ].filter(Boolean).join(' ');
          return (
            <button
              type="button"
              key={day}
              className={cls}
              onClick={() => toggle(day)}
              disabled={!isEditing || full || submitting}
              aria-pressed={picked}
              title={full ? '已額滿' : `剩 ${left} 個名額`}
            >
              <span className="leave-wish__day-num">{day}</span>
              <span className="leave-wish__day-left">{full ? '額滿' : picked ? '已選' : `剩 ${left}`}</span>
            </button>
          );
        })}
      </div>

      {msg.text && (
        <div className={`leave-wish__msg leave-wish__msg--${msg.type}`}>
          {msg.type === 'error' ? <AlertTriangle size={14} /> : <CheckCircle size={14} />} {msg.text}
        </div>
      )}

      <div className="leave-wish__actions">
        {isEditing ? (
          <>
            <span className="leave-wish__count">已選 {selected.length} / {need} 天</span>
            {myDays.length > 0 && (
              <button type="button" className="leave-wish__btn leave-wish__btn--ghost"
                      onClick={() => { setEditing(false); setMsg({ type: '', text: '' }); }} disabled={submitting}>
                取消改選
              </button>
            )}
            <button type="button" className="leave-wish__btn" onClick={handleSubmit}
                    disabled={selected.length !== need || submitting}>
              {submitting
                ? <><Loader size={14} className="leave-wish__spin" /> 檢查中（約 2–5 秒）…</>
                : <><Send size={14} /> 送出預假</>}
            </button>
          </>
        ) : (
          <>
            <span className="leave-wish__count leave-wish__count--done">
              <CheckCircle size={14} /> 已登記：{myDays.map(d => `${month}/${d}`).join('、')}
            </span>
            <button type="button" className="leave-wish__btn leave-wish__btn--ghost" onClick={startEdit}>改選</button>
          </>
        )}
      </div>
    </section>
  );
};

export default LeaveWishPicker;
