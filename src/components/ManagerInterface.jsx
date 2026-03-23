import React, { useState } from 'react';
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
  baseSalary, setBaseSalary, // ★ 這裡接住 
}) => {
  const [activeTab, setActiveTab] = useState('requirements');

  return (
    <div className="manager">

      <div className="manager__tabs">
        {['requirements', 'staff', 'schedule', 'publish','review', 'statistics'].map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`manager__tab${activeTab === tab ? ' manager__tab--active' : ''}`}
          >
            {tab === 'requirements' && '⚙️ 人力需求'}
            {tab === 'staff' && '👥 員工管理'}
            {tab === 'schedule' && '🛠️ 排班工作桌'} 
            {tab === 'publish' && '📢 2. 發布與認領'} {/* ★ 新增 */}
            {tab === 'review' && '✅ 3. 結算與歷史'}  {/* ★ 改名 */}
            {tab === 'statistics' && '📊 統計報表'}
          </button>
        ))}
      </div>

      {activeTab === 'requirements' && (
        <RequirementsPanel
          requirements={requirements} setRequirements={setRequirements}
          bedConfig={bedConfig} setBedConfig={setBedConfig}
          onGenerateSchedule={onGenerateSchedule} 
          onSaveSchedule={onSaveSchedule} selectedYear={selectedYear} setSelectedYear={setSelectedYear}
          selectedMonth={selectedMonth} setSelectedMonth={setSelectedMonth}
        />
      )}
      
      {activeTab === 'staff' && (
        <StaffManagementPanel staffData={staffData} setStaffData={setStaffData} />
      )}
      
      {activeTab === 'schedule' && (
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
// 👇 請在這裡補上下面這三行 👇
          historyYear={historyYear}
          historyMonth={historyMonth}
          historySchedule={historySchedule}
          onManualRefresh={onManualRefresh} 
          publicHolidays={publicHolidays}        
          setFinalizedSchedule={setFinalizedSchedule} 
        />
      )}
      
{/* ★ 新增：階段二 (發布與認領區) */}
      {activeTab === 'publish' && (
        <PublishPanel 
           staffData={staffData}
           violations={violations} scheduleRisks={scheduleRisks} 
           selectedYear={selectedYear} selectedMonth={selectedMonth}
           shiftOptions={shiftOptions} setShiftOptions={setShiftOptions} 
           publicHolidays={publicHolidays}
           finalizedSchedule={finalizedSchedule} 
           setFinalizedSchedule={setFinalizedSchedule}
           onPushToHistory={onPushToHistory} // 👈 補上這行
        />
      )}

      {/* ★ 修改：階段三 (結算與歷史區)，改吃 history 狀態 */}
      {activeTab === 'review' && (
        <ScheduleReviewPanel 
           staffData={staffData} setStaffData={setStaffData}
           shiftOptions={shiftOptions} setShiftOptions={setShiftOptions} 
           publicHolidays={publicHolidays}
           onUpdateHealthStats={onUpdateHealthStats}
           bedConfig={bedConfig}
           // 改吃專屬的歷史狀態
           historyYear={historyYear} historyMonth={historyMonth}
           setHistoryYear={setHistoryYear} setHistoryMonth={setHistoryMonth}
           historySchedule={historySchedule} setHistorySchedule={setHistorySchedule}
           baseSalary={baseSalary} setBaseSalary={setBaseSalary} // ★ 傳給歷史面板
        />
      )}
      
      {activeTab === 'statistics' && (
        <StatisticsPanel staffData={staffData} priorityConfig={priorityConfig} setPriorityConfig={setPriorityConfig} 
        healthStats={healthStats} // ★ 傳遞歷年數據給報表畫圖
        accumulatedReports={accumulatedReports}       // 👈 補上：把雲端抓下來的報表傳進去
            setAccumulatedReports={setAccumulatedReports} // 👈 補上：讓面板可以清空記憶
            // 🌟 ★★★ 這裡再往下傳給 StatisticsPanel ★★★
            calculateAndNotifyNextStaff={calculateAndNotifyNextStaff}
            bedConfig={bedConfig} // ★★★ 新增這行：把病床設定傳進來
            schedule={schedule}
            finalizedSchedule={finalizedSchedule}
            selectedYear={selectedYear}
            selectedMonth={selectedMonth}
        />
      )}

     {/* {activeTab === 'simulation' && (
        <SimulationPanel 
            staffData={staffData} requirements={requirements}
            baseSalary={localStorage.getItem('globalBaseSalary') || 40000}
            publicHolidays={publicHolidays} selectedYear={selectedYear}
            selectedMonth={selectedMonth} shiftOptions={shiftOptions}
        />
      )}
        */}
    </div>
  );
};

export default ManagerInterface;
