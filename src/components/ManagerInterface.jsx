import React, { useState, useEffect, useRef, useCallback } from 'react';
import { NavLink, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { motion, useMotionValue, animate } from 'framer-motion';
import { Settings, Users, CalendarCog, Megaphone, ClipboardCheck, BarChart3, ShieldAlert, Scale, Menu, X } from 'lucide-react';
import './ManagerInterface.css';
import RequirementsPanel from './RequirementsPanel';
import StaffManagementPanel from './StaffManagementPanel';
import SchedulePanel from './SchedulePanel';
import PublishPanel from './PublishPanel';
import ScheduleReviewPanel from './ScheduleReviewPanel';
import StatisticsPanel from './StatisticsPanel';
import AccessLogPanel from './AccessLogPanel';
import ComplianceDashboard from './ComplianceDashboard';

const ManagerInterface = ({
  staffData, setStaffData, requirements, setRequirements,
  schedule, violations,
  scheduleRisks,bedConfig, setBedConfig,
  shiftOptions, setShiftOptions, priorityConfig, setPriorityConfig, publicHolidays,
  selectedYear, setSelectedYear,
  selectedMonth, setSelectedMonth,
  onGenerateSchedule, onSaveSchedule, setSchedule,
  finalizedSchedule,
  setFinalizedSchedule,healthStats, onUpdateHealthStats,historyYear, historyMonth, setHistoryYear, setHistoryMonth, historySchedule, setHistorySchedule,onPushToHistory,accumulatedReports, setAccumulatedReports, onManualRefresh, calculateAndNotifyNextStaff,
  baseSalary, setBaseSalary,
  baseSalaryEnc, setBaseSalaryEnc,
  levelBonus, setLevelBonus,
}) => {
  const tabs = [
    { id: 'requirements', path: '/requirements', label: '人力需求', icon: Settings },
    { id: 'staff', path: '/staff', label: '員工管理', icon: Users },
    { id: 'schedule', path: '/schedule', label: '排班工作桌', icon: CalendarCog },
    { id: 'publish', path: '/publish', label: '發布與認領', icon: Megaphone },
    { id: 'review', path: '/review', label: '結算與歷史', icon: ClipboardCheck },
    { id: 'compliance', path: '/compliance', label: '法遵警示', icon: Scale },
    { id: 'statistics', path: '/statistics', label: '統計報表', icon: BarChart3 },
    { id: 'audit', path: '/audit', label: '稽核日誌', icon: ShieldAlert },
  ];

  const location = useLocation();
  const currentPath = location.pathname;

  const tabRefs = useRef([]);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  /* ─── Blob measurements for each tab ─── */
  const [blobRects, setBlobRects] = useState([]);

  /* ─── Motion values for the goo indicator ─── */
  const indicatorX = useMotionValue(0);
  const indicatorY = useMotionValue(0);
  const indicatorW = useMotionValue(0);
  const indicatorH = useMotionValue(0);

  /* Measure all tabs relative to the wrapper (common parent of all layers) */
  const wrapperRef = useRef(null);

  const measureTabs = useCallback(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const wrapperRect = wrapper.getBoundingClientRect();

    const rects = tabRefs.current.map((el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        x: r.left - wrapperRect.left,
        y: r.top - wrapperRect.top,
        w: r.width,
        h: r.height,
      };
    });
    setBlobRects(rects);
    return rects;
  }, []);

  /* Animate indicator to the active tab */
  const animateToTab = useCallback((rects) => {
    let activeIndex = tabs.findIndex(t => t.path === currentPath);
    if (activeIndex === -1 && currentPath === '/') activeIndex = 0;
    if (activeIndex === -1) return;

    const measured = rects || blobRects;
    const target = measured[activeIndex];
    if (!target) return;

    const springConfig = { type: 'spring', stiffness: 170, damping: 20, mass: 1.1 };
    animate(indicatorX, target.x, springConfig);
    animate(indicatorY, target.y, springConfig);
    animate(indicatorW, target.w, springConfig);
    animate(indicatorH, target.h, springConfig);
  }, [currentPath, blobRects, indicatorX, indicatorY, indicatorW, indicatorH]);

  /* Re-measure + animate on route change or menu toggle */
  useEffect(() => {
    const timer = setTimeout(() => {
      const rects = measureTabs();
      if (rects) animateToTab(rects);
    }, 60);
    return () => clearTimeout(timer);
  }, [currentPath, isMobileMenuOpen, measureTabs, animateToTab]);

  /* Also re-measure on window resize */
  useEffect(() => {
    const handleResize = () => {
      const rects = measureTabs();
      if (rects) animateToTab(rects);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [measureTabs, animateToTab]);

  return (
    <div className="manager">

      {/* 🌟 手機版漢堡選單按鈕 */}
      <button
        className="manager__mobile-menu-btn"
        onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
      >
        {isMobileMenuOpen ? <><X size={16} /> 關閉選單</> : <><Menu size={16} /> 開啟導覽選單</>}
      </button>

      {/* ═══ Tab bar with liquid goo effect ═══ */}
      <div ref={wrapperRef} className={`manager__tabs-wrapper ${isMobileMenuOpen ? 'manager__tabs-wrapper--open' : ''}`}>
        {/* SVG Goo Filter Definition */}
        <svg className="manager__goo-svg" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <filter id="tab-goo">
              <feGaussianBlur in="SourceGraphic" stdDeviation="6" result="blur" />
              <feColorMatrix
                in="blur"
                mode="matrix"
                values="1 0 0 0 0
                        0 1 0 0 0
                        0 0 1 0 0
                        0 0 0 18 -7"
                result="goo"
              />
              <feBlend in="SourceGraphic" in2="goo" />
            </filter>
          </defs>
        </svg>

        {/* LAYER 1: Goo-filtered blobs — no text */}
        <div className="manager__goo-layer">
          {/* Static pill blobs for each tab slot */}
          {blobRects.map((rect, i) =>
            rect ? (
              <div
                key={i}
                className="manager__tab-blob"
                style={{
                  left: rect.x,
                  top: rect.y,
                  width: rect.w,
                  height: rect.h,
                }}
              />
            ) : null
          )}

          {/* Animated goo indicator */}
          <motion.div
            className="manager__goo-indicator"
            style={{
              x: indicatorX,
              y: indicatorY,
              width: indicatorW,
              height: indicatorH,
            }}
          />
        </div>

        {/* LAYER 2: Glass overlay + clickable text labels — NOT filtered */}
        <div className={`manager__tabs ${isMobileMenuOpen ? 'manager__tabs--open' : ''}`}>
          {tabs.map((tab, index) => (
            <NavLink
              key={tab.id}
              to={tab.path}
              ref={(el) => (tabRefs.current[index] = el)}
              onClick={() => setIsMobileMenuOpen(false)}
              className={({ isActive }) => `manager__tab${isActive || (currentPath === '/' && tab.id === 'requirements') ? ' manager__tab--active' : ''}`}
              style={{ textDecoration: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <tab.icon size={16} /> {tab.label}
            </NavLink>
          ))}
        </div>

        {/* LAYER 3: Glass shine overlay on the indicator — NOT filtered */}
        <motion.div
          className="manager__indicator-shine"
          style={{
            x: indicatorX,
            y: indicatorY,
            width: indicatorW,
            height: indicatorH,
          }}
        />
      </div>

      <div className="manager__content-area" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <Routes>
              <Route path="/" element={<Navigate to="/requirements" replace />} />

              <Route path="/requirements" element={
                <RequirementsPanel
                  requirements={requirements} setRequirements={setRequirements}
                  bedConfig={bedConfig} setBedConfig={setBedConfig}
                  onGenerateSchedule={onGenerateSchedule}
                  onSaveSchedule={onSaveSchedule} selectedYear={selectedYear} setSelectedYear={setSelectedYear}
                  selectedMonth={selectedMonth} setSelectedMonth={setSelectedMonth}
                />
              } />

              <Route path="/staff" element={
                <StaffManagementPanel staffData={staffData} setStaffData={setStaffData} />
              } />

              <Route path="/schedule" element={
                <SchedulePanel
                  schedule={schedule} staffData={staffData} violations={violations}
                  requirements={requirements} onGenerateSchedule={onGenerateSchedule}
                  onSaveSchedule={onSaveSchedule} setSchedule={setSchedule}
                  selectedYear={selectedYear} selectedMonth={selectedMonth}
                  setSelectedMonth={setSelectedMonth} setSelectedYear={setSelectedYear}
                  shiftOptions={shiftOptions} setShiftOptions={setShiftOptions}
                  finalizedSchedule={finalizedSchedule}
                  setHistoryYear={setHistoryYear}
                  setHistoryMonth={setHistoryMonth}
                  setHistorySchedule={setHistorySchedule}
                  historyYear={historyYear}
                  historyMonth={historyMonth}
                  historySchedule={historySchedule}
                  onManualRefresh={onManualRefresh}
                  publicHolidays={publicHolidays}
                  setFinalizedSchedule={setFinalizedSchedule}
                />
              } />

              <Route path="/publish" element={
                <PublishPanel
                   staffData={staffData}
                   violations={violations} scheduleRisks={scheduleRisks}
                   selectedYear={selectedYear} selectedMonth={selectedMonth}
                   shiftOptions={shiftOptions} setShiftOptions={setShiftOptions}
                   publicHolidays={publicHolidays}
                   finalizedSchedule={finalizedSchedule}
                   setFinalizedSchedule={setFinalizedSchedule}
                   onPushToHistory={onPushToHistory}
                   calculateAndNotifyNextStaff={calculateAndNotifyNextStaff}
                   healthStats={healthStats}
                />
              } />

              <Route path="/review" element={
                <ScheduleReviewPanel
                   staffData={staffData} setStaffData={setStaffData}
                   shiftOptions={shiftOptions} setShiftOptions={setShiftOptions}
                   publicHolidays={publicHolidays}
                   onUpdateHealthStats={onUpdateHealthStats}
                   bedConfig={bedConfig}
                   historyYear={historyYear} historyMonth={historyMonth}
                   setHistoryYear={setHistoryYear} setHistoryMonth={setHistoryMonth}
                   historySchedule={historySchedule} setHistorySchedule={setHistorySchedule}
                   baseSalary={baseSalary} setBaseSalary={setBaseSalary}
                   baseSalaryEnc={baseSalaryEnc} setBaseSalaryEnc={setBaseSalaryEnc}
                   levelBonus={levelBonus} setLevelBonus={setLevelBonus}
                />
              } />

              <Route path="/statistics" element={
                <StatisticsPanel staffData={staffData} priorityConfig={priorityConfig} setPriorityConfig={setPriorityConfig}
                    healthStats={healthStats}
                    accumulatedReports={accumulatedReports}
                    setAccumulatedReports={setAccumulatedReports}
                    calculateAndNotifyNextStaff={calculateAndNotifyNextStaff}
                    bedConfig={bedConfig}
                    schedule={schedule}
                    finalizedSchedule={finalizedSchedule}
                    selectedYear={selectedYear}
                    selectedMonth={selectedMonth}
                />
              } />

              <Route path="/compliance" element={
                <ComplianceDashboard
                  staffData={staffData}
                  schedule={schedule}
                  finalizedSchedule={finalizedSchedule}
                  violations={violations}
                  scheduleRisks={scheduleRisks}
                  selectedYear={selectedYear}
                  selectedMonth={selectedMonth}
                />
              } />

              <Route path="/audit" element={<AccessLogPanel />} />
          </Routes>
      </div>
    </div>
  );
};

export default ManagerInterface;
