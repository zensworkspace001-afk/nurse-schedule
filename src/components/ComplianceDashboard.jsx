import React, { useMemo, useState } from 'react';
import {
  ShieldAlert, ShieldCheck, AlertTriangle, ChevronDown, ChevronRight,
  Heart, Clock, Calendar, Users,
} from 'lucide-react';
import { computeProximityWarnings } from '../constants';
import './ComplianceDashboard.css';

// 即時七休一 / OT 警示 dashboard
//   紅 — 已違規 (從 props.violations 來，由 App.jsx 即時計算)
//   黃 — 接近上限 (computeProximityWarnings 計算)
//   綠 — 全月安全 (其餘員工)
//
// Schedule 異動時 App.jsx 會重算 violations，這裡是純呈現層。
// 點員工列會 emit onSelectStaff(staffId) — 留給將來接「跳到該員工的班表」用，
// 目前還沒接，但 prop 已備好。

const SEVERITY_GROUPS = {
  '七休一': ['CONSECUTIVE_DAYS', 'CONSECUTIVE_DAYS_WARNING'],
  '月工時 / OT': ['WEEKLY_HOURS', 'MONTHLY_OT', 'DAILY_HOURS', 'MONTHLY_OT_WARNING'],
  '例假 / 休息日': ['RG_INTERVAL', 'INSUFFICIENT_RG', 'INSUFFICIENT_OFF', 'RG_INTERVAL_WARNING'],
  '輪班間隔': ['SHIFT_INTERVAL'],
  '母性保護': ['MATERNITY_PROTECTION', 'MATERNITY_OBSERVE'],
  '特休 / 實習生': ['ANNUAL_LEAVE_EXCEEDED', 'STUDENT_NIGHT_FORBIDDEN'],
};

function groupOf(type) {
  for (const [g, types] of Object.entries(SEVERITY_GROUPS)) {
    if (types.includes(type)) return g;
  }
  return '其他';
}

const ComplianceDashboard = ({
  staffData = [],
  schedule = {},
  finalizedSchedule = null,
  violations = [],
  scheduleRisks = [],
  selectedYear,
  selectedMonth,
  onSelectStaff,
}) => {
  const [expandSafe, setExpandSafe] = useState(false);

  // 以 finalizedSchedule 為準（已發布），否則 fall back 到 draft schedule。
  // 包進 useMemo 避免 || 表達式讓下游 useMemo 每次 re-render 都重算。
  const activeSchedule = useMemo(
    () => finalizedSchedule || schedule || {},
    [finalizedSchedule, schedule],
  );

  // 計算 proximity warnings
  const { warnings, perStaffStats } = useMemo(() => {
    if (!selectedYear || !selectedMonth) return { warnings: [], perStaffStats: {} };
    return computeProximityWarnings(activeSchedule, staffData, selectedYear, selectedMonth);
  }, [activeSchedule, staffData, selectedYear, selectedMonth]);

  // 把 violations + warnings 依 staff 分組
  const perStaff = useMemo(() => {
    const map = new Map();
    const upsert = (staffId, name, item) => {
      if (!map.has(staffId)) map.set(staffId, { staffId, name, red: [], yellow: [], info: [] });
      const bucket = map.get(staffId);
      if (item.severity === 'warning') bucket.yellow.push(item);
      else if (item.severity === 'info') bucket.info.push(item);
      else bucket.red.push(item);
    };
    violations.forEach(v => upsert(v.staffId, v.staffName, v));
    warnings.forEach(w => upsert(w.staffId, w.staffName, w));
    return Array.from(map.values()).sort((a, b) => {
      // red 多的排前面，再來 yellow，再來 staff_id
      if (b.red.length !== a.red.length) return b.red.length - a.red.length;
      if (b.yellow.length !== a.yellow.length) return b.yellow.length - a.yellow.length;
      return String(a.staffId).localeCompare(String(b.staffId));
    });
  }, [violations, warnings]);

  // 全月安全名單 = 在 staffData 裡但沒出現在 perStaff 紅黃裡
  const safeStaff = useMemo(() => {
    const flagged = new Set(perStaff.filter(s => s.red.length || s.yellow.length).map(s => s.staffId));
    return staffData
      .filter(s => s.staff_id && s.staff_id !== 'admin' && !flagged.has(s.staff_id))
      .filter(s => s.is_active !== false)
      .sort((a, b) => String(a.staff_id).localeCompare(String(b.staff_id)));
  }, [staffData, perStaff]);

  const redStaff = perStaff.filter(s => s.red.length > 0);
  const yellowStaff = perStaff.filter(s => s.red.length === 0 && s.yellow.length > 0);

  // Quick stats
  const totals = {
    redCount: redStaff.length,
    yellowCount: yellowStaff.length,
    safeCount: safeStaff.length,
    totalViolations: violations.length,
    totalWarnings: warnings.length,
    softRisks: scheduleRisks.length,
  };

  return (
    <div className="compliance-dash">
      <div className="compliance-dash__header">
        <div>
          <h2 className="compliance-dash__title">
            <ShieldAlert size={22} />
            法遵即時警示 — {selectedYear}年{selectedMonth}月
          </h2>
          <p className="compliance-dash__subtitle">
            依勞基法第 32、36 條 + 母性保護 + 護理人員法即時掃描。
            班表異動時自動重算。
          </p>
        </div>
        <div className="compliance-dash__stats">
          <Pill kind="red"    icon={<ShieldAlert size={14} />}  label="違規員工" value={totals.redCount} />
          <Pill kind="yellow" icon={<AlertTriangle size={14} />} label="逼近上限" value={totals.yellowCount} />
          <Pill kind="green"  icon={<ShieldCheck size={14} />}  label="全月安全" value={totals.safeCount} />
        </div>
      </div>

      {/* 紅 —— 已違規 */}
      <Section
        kind="red"
        icon={<ShieldAlert size={18} />}
        title={`🔴 已違規 (${redStaff.length} 位)`}
        empty="目前無員工違反勞基法。"
        defaultOpen={true}
      >
        {redStaff.map(s => (
          <StaffCard
            key={s.staffId}
            kind="red"
            staff={s}
            stats={perStaffStats[s.staffId]}
            onClick={onSelectStaff && (() => onSelectStaff(s.staffId))}
          />
        ))}
      </Section>

      {/* 黃 —— 接近上限 */}
      <Section
        kind="yellow"
        icon={<AlertTriangle size={18} />}
        title={`🟡 接近上限 (${yellowStaff.length} 位)`}
        empty="目前無員工逼近勞基法上限。"
        defaultOpen={true}
      >
        {yellowStaff.map(s => (
          <StaffCard
            key={s.staffId}
            kind="yellow"
            staff={s}
            stats={perStaffStats[s.staffId]}
            onClick={onSelectStaff && (() => onSelectStaff(s.staffId))}
          />
        ))}
      </Section>

      {/* 綠 —— 全月安全（預設收起） */}
      <Section
        kind="green"
        icon={<ShieldCheck size={18} />}
        title={`🟢 全月安全 (${safeStaff.length} 位)`}
        empty="尚無安全的員工 — 全員至少有一項警示。"
        defaultOpen={expandSafe}
        onToggle={setExpandSafe}
      >
        <div className="compliance-dash__safe-grid">
          {safeStaff.map(s => (
            <span key={s.staff_id} className="compliance-dash__safe-pill">
              {s.staff_id} {s.name}
            </span>
          ))}
        </div>
      </Section>
    </div>
  );
};

// ─── 小元件 ───────────────────────────────────────────────────

const Pill = ({ kind, icon, label, value }) => (
  <div className={`compliance-dash__pill compliance-dash__pill--${kind}`}>
    {icon}
    <span className="compliance-dash__pill-label">{label}</span>
    <span className="compliance-dash__pill-value">{value}</span>
  </div>
);

const Section = ({ kind, icon, title, empty, defaultOpen = true, onToggle, children }) => {
  const [open, setOpenLocal] = useState(defaultOpen);
  const isOpen = onToggle ? defaultOpen : open;
  const toggle = () => {
    if (onToggle) onToggle(!defaultOpen);
    else setOpenLocal(o => !o);
  };
  const childArr = React.Children.toArray(children).filter(Boolean);
  const isEmpty = childArr.length === 0
    || (childArr.length === 1 && childArr[0]?.props?.children?.length === 0);

  return (
    <section className={`compliance-dash__section compliance-dash__section--${kind}`}>
      <button className="compliance-dash__section-header" onClick={toggle} type="button">
        {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        {icon}
        <span>{title}</span>
      </button>
      {isOpen && (
        <div className="compliance-dash__section-body">
          {isEmpty ? <div className="compliance-dash__empty">{empty}</div> : children}
        </div>
      )}
    </section>
  );
};

const StaffCard = ({ kind, staff, stats, onClick }) => {
  const groupedItems = useMemo(() => {
    const all = [...staff.red, ...staff.yellow, ...staff.info];
    const groups = {};
    all.forEach(item => {
      const g = groupOf(item.type);
      if (!groups[g]) groups[g] = [];
      groups[g].push(item);
    });
    return groups;
  }, [staff]);

  return (
    <div
      className={`compliance-dash__card compliance-dash__card--${kind}${onClick ? ' compliance-dash__card--clickable' : ''}`}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => (e.key === 'Enter' || e.key === ' ') && onClick() : undefined}
    >
      <div className="compliance-dash__card-head">
        <span className="compliance-dash__card-staff">
          <Users size={14} /> <strong>{staff.staffId}</strong> {staff.name || ''}
        </span>
        {stats && (
          <span className="compliance-dash__card-stats">
            <Clock size={11} /> {stats.totalMonthlyHours}h ·
            <Calendar size={11} /> 例 {stats.totalRG} · 休 {stats.totalRC} ·
            連 {stats.maxConsecutive}天
            {stats.isPregnant && <Heart size={11} className="compliance-dash__preg-icon" />}
          </span>
        )}
      </div>
      <ul className="compliance-dash__card-list">
        {Object.entries(groupedItems).map(([g, items]) => (
          <li key={g} className="compliance-dash__card-group">
            <span className="compliance-dash__card-group-label">{g}</span>
            <ul>
              {items.map((it, idx) => (
                <li
                  key={`${it.type}-${it.day}-${idx}`}
                  className={`compliance-dash__card-item compliance-dash__card-item--${it.severity || 'red'}`}
                >
                  <span className="compliance-dash__card-day">{it.day}</span>
                  <span className="compliance-dash__card-msg">{it.message}</span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
};

export default ComplianceDashboard;
