import React, { useState, useEffect, useRef } from 'react';
import { NavLink, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { Settings, Users, CalendarCog, Megaphone, ClipboardCheck, BarChart3, Menu, X } from 'lucide-react';
import './ManagerInterface.css';
import RequirementsPanel from './RequirementsPanel';
import StaffManagementPanel from './StaffManagementPanel';
import SchedulePanel from './SchedulePanel';
import PublishPanel from './PublishPanel';
import ScheduleReviewPanel from './ScheduleReviewPanel';
import StatisticsPanel from './StatisticsPanel';

const ManagerInterface = ({
  staffData, setStaffData, historyData, requirements, setRequirements,
  preferences, setPreferences, schedule, violations,
  scheduleRisks,bedConfig, setBedConfig,
  shiftOptions, setShiftOptions, priorityConfig, setPriorityConfig, publicHolidays,
  selectedYear, setSelectedYear,
  selectedMonth, setSelectedMonth,
  onGenerateSchedule, onSaveSchedule, setSchedule,
  finalizedSchedule,
  setFinalizedSchedule,healthStats, onUpdateHealthStats,historyYear, historyMonth, setHistoryYear, setHistoryMonth, historySchedule, setHistorySchedule,onPushToHistory,accumulatedReports, setAccumulatedReports, onManualRefresh, calculateAndNotifyNextStaff,
  baseSalary, setBaseSalary,
  levelBonus, setLevelBonus,
}) => {
  const tabs = [
    { id: 'requirements', path: '/requirements', label: '人力需求', icon: Settings },
    { id: 'staff', path: '/staff', label: '員工管理', icon: Users },
    { id: 'schedule', path: '/schedule', label: '排班工作桌', icon: CalendarCog },
    { id: 'publish', path: '/publish', label: '發布與認領', icon: Megaphone },
    { id: 'review', path: '/review', label: '結算與歷史', icon: ClipboardCheck },
    { id: 'statistics', path: '/statistics', label: '統計報表', icon: BarChart3 }
  ];

  const location = useLocation();
  const currentPath = location.pathname;

  // Ref 用於取得每個按鈕的實際大小與位置，以便滑塊能精準跟隨
  const tabRefs = useRef([]);
  const [gliderStyle, setGliderStyle] = useState({ transform: 'translate(0px, 0px)', width: 0, height: 0, opacity: 0 });

  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  useEffect(() => {
    // 找出目前路由對應的 tab index，若在根目錄則預設為 0
    let activeIndex = tabs.findIndex(t => t.path === currentPath);
    if (activeIndex === -1 && currentPath === '/') activeIndex = 0;
    
    const currentTab = tabRefs.current[activeIndex];
    
    // 加一點延遲確保 DOM 已渲染
    const timer = setTimeout(() => {
        if (currentTab) {
          setGliderStyle({
            transform: `translate(${currentTab.offsetLeft}px, ${currentTab.offsetTop}px)`,
            width: currentTab.offsetWidth,
            height: currentTab.offsetHeight,
            opacity: 1,
          });
        }
    }, 50);
    return () => clearTimeout(timer);
  }, [currentPath, isMobileMenuOpen]);

  return (
    <div className="manager">

      {/* 🌟 手機版漢堡選單按鈕 */}
      <button 
        className="manager__mobile-menu-btn" 
        onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
      >
        {isMobileMenuOpen ? <><X size={16} /> 關閉選單</> : <><Menu size={16} /> 開啟導覽選單</>}
      </button>

      <div className={`manager__tabs ${isMobileMenuOpen ? 'manager__tabs--open' : ''}`}>
        {/* 🌟 背景滑動毛玻璃游標 */}
        <div className="manager__glider" style={gliderStyle}></div>

        {tabs.map((tab, index) => (
          <NavLink
            key={tab.id}
            to={tab.path}
            ref={(el) => (tabRefs.current[index] = el)}
            onClick={() => setIsMobileMenuOpen(false)} // 點擊後自動收起
            className={({ isActive }) => `manager__tab${isActive || (currentPath === '/' && tab.id === 'requirements') ? ' manager__tab--active' : ''}`}
            style={{ textDecoration: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <tab.icon size={16} /> {tab.label}
          </NavLink>
        ))}
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
          </Routes>
      </div>
    </div>
  );
};

export default ManagerInterface;
