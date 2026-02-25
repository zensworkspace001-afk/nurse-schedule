import React, { useState, useEffect, useRef } from 'react';
import { Calendar, Users, Clock, AlertCircle, CheckCircle, Download, Upload, Moon, Sun, Sunset, Search, Filter, Settings, Bell, FileText, TrendingUp, Award } from 'lucide-react';
import { GoogleGenerativeAI } from "@google/generative-ai";

// ============================================================================
// 設定區
// ============================================================================
// 注意：請勿將真實 API Key 推送到公開 GitHub。建議使用環境變數。
const GEMINI_API_KEY = "AIzaSyC93wpAHbYeKrfVgEAF9DkIFi2OAC33lJM"; 

// 初始化 API (全域使用)
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// ============================================================================
// 資料結構與常數定義
// ============================================================================

const SHIFT_TYPES = {
  D: { name: '白班', time: '07:00-16:00', color: '#FFD93D', icon: Sun, hours: 9 },
  E: { name: '小夜班', time: '15:00-00:00', color: '#FF6B9D', icon: Sunset, hours: 9 },
  N: { name: '大夜班', time: '23:00-08:00', color: '#4D96FF', icon: Moon, hours: 9 },
  OFF: { name: '休假', time: '', color: '#E8E8E8', icon: null, hours: 0 },
  REGULAR: { name: '例假', time: '', color: '#95E1D3', icon: null, hours: 0 },
  REST: { name: '休息日', time: '', color: '#B8E6D5', icon: null, hours: 0 },
  '支援': { name: '支援', time: '依需求', color: '#D4AC0D', icon: Users, hours: 9 }
};

const LABOR_LAW_RULES = {
  MAX_DAILY_HOURS: 8,
  MAX_WEEKLY_HOURS: 40,
  MAX_WEEKLY_HOURS_WITH_BREAK: 45,
  MAX_MONTHLY_OT: 46,
  MIN_REST_HOURS: 11,
  MAX_CONSECUTIVE_DAYS: 6,
  REQUIRED_DAYS_OFF_PER_4_WEEKS: 8,
  REQUIRED_REGULAR_DAYS: 4,
  REQUIRED_REST_DAYS: 4
};

// ============================================================================
// 工具函數
// ============================================================================

const parseCSV = (csvText) => {
  const lines = csvText.trim().split('\n');
  const headers = lines[0].replace(/^\uFEFF/, '').split(',').map(h => h.trim());
  return lines.slice(1).map(line => {
    const values = line.split(',').map(v => v.trim());
    const obj = {};
    headers.forEach((header, i) => {
      let value = values[i];
      if (value === 'True' || value === 'TRUE') value = true;
      else if (value === 'False' || value === 'FALSE') value = false;
      else if (value === 'None' || value === '') value = null;
      else if (!isNaN(value) && value !== '') value = parseFloat(value);
      obj[header] = value;
    });
    return obj;
  });
};

const calculateShiftInterval = (lastShift, lastDateStr, nextShift, nextDateStr) => {
  if (['OFF', 'REGULAR', 'REST', '支援'].includes(lastShift)) return 999;
  if (['OFF', 'REGULAR', 'REST', '支援'].includes(nextShift)) return 999;

  const shiftTimes = {
    'D': { start: 7, end: 16 },
    'E': { start: 15, end: 24 },
    'N': { start: 23, end: 32 }
  };

  const lastS = shiftTimes[lastShift];
  const nextS = shiftTimes[nextShift];

  if (!lastS || !nextS) return 999;

  const lastDate = new Date(lastDateStr);
  const nextDate = new Date(nextDateStr);

  const lastEndTimestamp = new Date(lastDate);
  lastEndTimestamp.setHours(lastS.end, 0, 0, 0);

  const nextStartTimestamp = new Date(nextDate);
  nextStartTimestamp.setHours(nextS.start, 0, 0, 0);

  const diffMs = nextStartTimestamp - lastEndTimestamp;
  return diffMs / (1000 * 60 * 60);
};

const checkLaborLawCompliance = (schedule, staffData, historyData, year, month) => {
  const violations = [];
  const daysInMonth = new Date(year, month, 0).getDate();
  
  const lastMonthYear = month === 1 ? year - 1 : year;
  const lastMonth = month === 1 ? 12 : month - 1;
  const lastMonthLastDay = new Date(lastMonthYear, lastMonth, 0).getDate();
  const defaultLastDate = `${lastMonthYear}-${String(lastMonth).padStart(2, '0')}-${String(lastMonthLastDay).padStart(2, '0')}`;
  
  Object.keys(schedule).forEach(staffId => {
    const staff = staffData.find(s => s.staff_id === staffId);
    const history = historyData.find(h => h.staff_id === staffId);
    const monthSchedule = schedule[staffId];
    
    let consecutiveDays = history?.consecutive_work_days || 0;
    let lastShift = history?.last_shift_type || 'OFF';
    let lastDate = history?.last_shift_date || defaultLastDate;
    let weeklyHours = 0;
    let regularDays = 0;
    let restDays = 0;
    
    for (let day = 1; day <= daysInMonth; day++) {
      const currentShift = monthSchedule[day] || 'OFF';
      const currentDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      
      if (['D', 'E', 'N'].includes(currentShift)) {
        const interval = calculateShiftInterval(lastShift, lastDate, currentShift, currentDate);
        if (interval < LABOR_LAW_RULES.MIN_REST_HOURS) {
          violations.push({
            staffId,
            staffName: staff?.name,
            day,
            type: 'REST_INTERVAL',
            message: `班次間隔不足 ${LABOR_LAW_RULES.MIN_REST_HOURS} 小時 (實際: ${interval.toFixed(1)}小時)`
          });
        }
      }
      
      if (['D', 'E', 'N', '支援'].includes(currentShift)) {
        consecutiveDays++;
        if (consecutiveDays > LABOR_LAW_RULES.MAX_CONSECUTIVE_DAYS) {
          violations.push({
            staffId,
            staffName: staff?.name,
            day,
            type: 'CONSECUTIVE_DAYS',
            message: `連續工作超過 ${LABOR_LAW_RULES.MAX_CONSECUTIVE_DAYS} 天`
          });
        }
      } else {
        consecutiveDays = 0;
      }
      
      const hours = SHIFT_TYPES[currentShift]?.hours || 0;
      weeklyHours += hours;
      
      if (currentShift === 'REGULAR') regularDays++;
      if (currentShift === 'REST') restDays++;
      
      if (day % 7 === 0) {
        if (weeklyHours > LABOR_LAW_RULES.MAX_WEEKLY_HOURS_WITH_BREAK) {
          violations.push({
            staffId,
            staffName: staff?.name,
            day,
            type: 'WEEKLY_HOURS',
            message: `每週總在班時數超過 ${LABOR_LAW_RULES.MAX_WEEKLY_HOURS_WITH_BREAK} 小時`
          });
        }
        weeklyHours = 0;
      }
      
      lastShift = currentShift;
      lastDate = currentDate;
    }
    
    if (regularDays < LABOR_LAW_RULES.REQUIRED_REGULAR_DAYS) {
      violations.push({ staffId, staffName: staff?.name, day: 0, type: 'REGULAR_DAYS', message: `例假日不足` });
    }
    if (restDays < LABOR_LAW_RULES.REQUIRED_REST_DAYS) {
      violations.push({ staffId, staffName: staff?.name, day: 0, type: 'REST_DAYS', message: `休息日不足` });
    }
  });
  
  return violations;
};

const generateAutoSchedule = (staffData, historyData, requirements, preferences, year, month) => {
    return {}; 
};

const exportToExcel = (preferences, staffData, year, month) => {};

// ============================================================================
// 1. LoginPanel (登入介面)
// ============================================================================
const LoginPanel = ({ onLogin, staffData = [] }) => { 
  const [employeeId, setEmployeeId] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const handleLogin = (e) => {
    e.preventDefault();
    setError('');

    if (employeeId === 'admin' && password === 'admin') {
      onLogin({ id: 'ADMIN', name: '管理人員', role: 'admin' });
      return;
    }

    if (!staffData || staffData.length === 0) {
      setError('⚠️ 系統錯誤：員工資料尚未載入。請先使用 admin / admin 登入檢查。');
      return;
    }

    const staff = staffData.find(s => 
      (s.staff_id && s.staff_id.trim() === employeeId.trim()) || 
      (s.name && s.name.trim() === employeeId.trim())
    );
    
    if (staff) {
      if (password === '1234') {
        onLogin({ 
            id: staff.staff_id, 
            name: staff.name, 
            role: 'staff',
            rule: staff.special_status === 'Standard' ? 'Standard' : 'BiWeekly'
        });
      } else {
        setError('密碼錯誤 (預設密碼為 1234)');
      }
    } else {
      setError(`找不到工號或姓名 "${employeeId}"`);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' }}>
      <div style={{ background: 'white', padding: '3rem', borderRadius: '20px', width: '100%', maxWidth: '400px', boxShadow: '0 10px 25px rgba(0,0,0,0.2)', textAlign: 'center' }}>
        <h2 style={{ color: '#333', marginBottom: '0.5rem' }}>護理排班系統</h2>
        <div style={{ background: '#f8f9fa', padding: '10px', borderRadius: '8px', marginBottom: '1.5rem', fontSize: '0.8rem', color: '#666', textAlign: 'left' }}>
          <strong>💡 測試帳號提示：</strong><br/>
          1. 管理員：admin / admin<br/>
          2. 員工：請輸入CSV內的工號 (如 N001) / 1234
        </div>
        
        <form onSubmit={handleLogin}>
          <input 
            type="text" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} 
            placeholder="工號 (例如: N001 或 admin)" 
            style={{ width: '100%', padding: '12px', marginBottom: '1rem', borderRadius: '8px', border: '1px solid #ddd', boxSizing: 'border-box' }}
          />
          <input 
            type="password" value={password} onChange={(e) => setPassword(e.target.value)} 
            placeholder="密碼 (預設: 1234)" 
            style={{ width: '100%', padding: '12px', marginBottom: '1.5rem', borderRadius: '8px', border: '1px solid #ddd', boxSizing: 'border-box' }}
          />
          {error && <div style={{ color: '#e74c3c', background: '#fdecea', padding: '10px', borderRadius: '6px', marginBottom: '1rem', fontSize: '0.9rem', textAlign: 'left' }}>❌ {error}</div>}
          <button type="submit" style={{ width: '100%', padding: '14px', background: '#667eea', color: 'white', border: 'none', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer', fontSize: '1rem' }}>登入系統</button>
        </form>
      </div>
    </div>
  );
};

// ============================================================================
// 2. StaffDashboard (員工自助介面)
// ============================================================================
const StaffDashboard = ({ currentUser, onConfirmSchedule, targetYear = 2026, targetMonth = 2, currentSchedule }) => {
  const [currentStep, setCurrentStep] = useState(1);
  const [selectedShiftType, setSelectedShiftType] = useState(null); 
  const [selectedOption, setSelectedOption] = useState(null);      
  const [aiSlots, setAiSlots] = useState([]);                      
  const [previewSchedule, setPreviewSchedule] = useState({});      
  const [isProcessing, setIsProcessing] = useState(false);

  const prevMonthHistory = { lastShift: 'E', lastDate: '2026-01-31', consecutiveDays: 3 };

  useEffect(() => {
    if (currentSchedule) {
        const slots = [];
        const daysInMonth = new Date(targetYear, targetMonth, 0).getDate();

        Object.keys(currentSchedule).forEach((virtualId, index) => {
            const rowData = currentSchedule[virtualId];
            const patternArr = [];
            const shiftCounts = { D: 0, E: 0, N: 0 };
            
            for (let d = 1; d <= daysInMonth; d++) {
                const cell = rowData[d] || 'OFF';
                const shiftCode = (typeof cell === 'object') ? cell.type : cell;
                patternArr.push(shiftCode);
                if(['D','E','N'].includes(shiftCode)) shiftCounts[shiftCode]++;
            }

            let majorShift = 'OFF';
            if (shiftCounts.D >= shiftCounts.E && shiftCounts.D >= shiftCounts.N && shiftCounts.D > 5) majorShift = 'D';
            else if (shiftCounts.E >= shiftCounts.D && shiftCounts.E >= shiftCounts.N && shiftCounts.E > 5) majorShift = 'E';
            else if (shiftCounts.N >= shiftCounts.D && shiftCounts.N >= shiftCounts.E && shiftCounts.N > 5) majorShift = 'N';

            if (majorShift !== 'OFF') {
                slots.push({
                    id: virtualId, title: `AI 推薦班表 #${index + 1}`, shift: majorShift, pattern: patternArr, rowData: rowData
                });
            }
        });
        setAiSlots(slots);
    }
  }, [currentSchedule, targetYear, targetMonth]);

  const checkCompliance = (pattern) => {
      let currentStreak = prevMonthHistory.consecutiveDays;
      for (let i = 0; i < pattern.length; i++) {
          const shift = pattern[i];
          if (shift !== 'OFF' && shift !== 'REGULAR' && shift !== 'REST') currentStreak++;
          else currentStreak = 0;
          if (currentStreak > 6) return { valid: false, reason: `第 ${i+1} 天將造成連續上班 7 天` };
      }
      return { valid: true };
  };

  const filteredOptions = aiSlots.filter(opt => opt.shift === selectedShiftType);

  const handleSelectType = (type) => {
      setIsProcessing(true);
      setTimeout(() => { setSelectedShiftType(type); setCurrentStep(2); setIsProcessing(false); }, 300);
  };

  const handleSelectOption = (opt) => {
      setSelectedOption(opt.id);
      const map = {};
      opt.pattern.forEach((s, i) => map[i+1] = s);
      setPreviewSchedule(map);
      setCurrentStep(3);
  };

  const handleFinalSubmit = () => {
      const choice = aiSlots.find(opt => opt.id === selectedOption);
      onConfirmSchedule({ 
          staffId: currentUser.id, staffName: currentUser.name, shiftType: selectedShiftType, 
          chosenSchedule: { id: choice.id, title: choice.title }, fullMonthData: previewSchedule 
      });
      setCurrentStep(4);
  };

  const getShiftColor = (shift) => {
      if (shift === 'D') return '#FFD93D';
      if (shift === 'E') return '#FF6B9D';
      if (shift === 'N') return '#4D96FF';
      return '#f0f0f0';
  };

  return (
    <div style={{ padding: '2rem', maxWidth: '900px', margin: '0 auto', background: 'white', borderRadius: '16px', minHeight: '80vh', boxShadow: '0 4px 20px rgba(0,0,0,0.05)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '2rem', borderBottom: '1px solid #eee', paddingBottom: '1rem' }}>
          {['班別選擇', '認領班表', '確認預覽', '完成'].map((label, idx) => (
              <div key={idx} style={{ color: currentStep >= idx+1 ? '#667eea' : '#ccc', fontWeight: 'bold' }}>{idx+1}. {label}</div>
          ))}
      </div>

      {currentStep === 1 && (
        <div style={{ textAlign: 'center' }}>
          <h2>👋 嗨，{currentUser.name}</h2>
          <p style={{ marginBottom: '2rem', color: '#666' }}>請選擇您下個月希望認領的班別類型：</p>
          {!currentSchedule || Object.keys(currentSchedule).length === 0 ? (
             <div style={{padding:'20px', background:'#fff3cd', color:'#856404', borderRadius:'8px'}}>⚠️ 目前尚未生成/發布班表，請稍後再來。</div>
          ) : (
             <div style={{ display: 'flex', gap: '20px', justifyContent: 'center' }}>
                {[{t:'D',l:'白班'}, {t:'E',l:'小夜'}, {t:'N',l:'大夜'}].map(i => (
                    <button key={i.t} onClick={() => handleSelectType(i.t)} disabled={isProcessing} 
                        style={{ width: '120px', height: '120px', border: 'none', borderRadius: '15px', background: getShiftColor(i.t), color: 'white', fontSize: '1.2rem', cursor: 'pointer', opacity: isProcessing?0.7:1 }}>
                        {i.l}
                    </button>
                ))}
             </div>
          )}
        </div>
      )}

      {currentStep === 2 && (
        <div>
          <button onClick={()=>setCurrentStep(1)} style={{border:'none', background:'none', cursor:'pointer', marginBottom:'10px'}}>← 返回</button>
          <h2>📋 選擇方案</h2>
          <div style={{ display: 'grid', gap: '15px', maxHeight:'500px', overflowY:'auto' }}>
            {filteredOptions.length === 0 ? <div style={{padding:'20px', textAlign:'center'}}>無推薦方案</div> : filteredOptions.map(opt => {
                const check = checkCompliance(opt.pattern);
                return (
                    <div key={opt.id} onClick={() => check.valid && handleSelectOption(opt)}
                        style={{ padding: '1rem', borderRadius: '12px', border: selectedOption === opt.id ? '2px solid #667eea' : '1px solid #eee', background: !check.valid ? '#f9f9f9' : 'white', opacity: !check.valid?0.6:1, cursor: !check.valid?'not-allowed':'pointer' }}>
                        <div style={{fontWeight:'bold'}}>{opt.title} {!check.valid && <span style={{color:'red'}}>({check.reason})</span>}</div>
                        <div style={{display:'flex', gap:'2px', marginTop:'5px'}}>
                            {opt.pattern.map((s, i) => <div key={i} style={{flex:1, height:'8px', background: getShiftColor(s)}}/>)}
                        </div>
                    </div>
                );
            })}
          </div>
        </div>
      )}

      {currentStep === 3 && (
        <div>
          <button onClick={()=>setCurrentStep(2)} style={{border:'none', background:'none', cursor:'pointer', marginBottom:'10px'}}>← 重選</button>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '5px', maxWidth:'600px', margin:'0 auto' }}>
              {['日','一','二','三','四','五','六'].map(d=><div key={d} style={{textAlign:'center'}}>{d}</div>)}
              {Array.from({ length: new Date(targetYear, targetMonth-1, 1).getDay() }).map((_, i) => <div key={`e-${i}`} />)}
              {Object.keys(previewSchedule).map(d => (
                  <div key={d} style={{ border:'1px solid #eee', padding:'5px', textAlign:'center', background: previewSchedule[d]==='OFF'?'#fafafa':'white' }}>
                      <div style={{fontSize:'0.7rem', color:'#ccc'}}>{d}</div>
                      <div style={{fontWeight:'bold', color: previewSchedule[d]==='OFF'?'#bbb':'#333'}}>{previewSchedule[d]}</div>
                  </div>
              ))}
          </div>
          <div style={{textAlign:'center', marginTop:'20px'}}>
             <button onClick={handleFinalSubmit} style={{padding:'10px 40px', background:'#667eea', color:'white', border:'none', borderRadius:'20px', cursor:'pointer'}}>確認認領</button>
          </div>
        </div>
      )}

      {currentStep === 4 && (
        <div style={{ textAlign: 'center', padding: '3rem' }}>
          <h2>🎉 認領成功！</h2>
          <button onClick={() => window.location.reload()} style={{ marginTop: '20px', padding: '10px 20px', border:'1px solid #ddd', background:'white', cursor:'pointer' }}>回首頁</button>
        </div>
      )}
    </div>
  );
};

// ============================================================================
// 3. NurseSchedulingSystem (主元件)
// ============================================================================
const NurseSchedulingSystem = () => {
  const [currentUser, setCurrentUser] = useState(null);
  const [staffData, setStaffData] = useState([
      { staff_id: 'N001', name: '測試員A', special_status: 'BiWeekly', is_active: true },
      { staff_id: 'N002', name: '測試員B', special_status: 'Standard', is_active: true }
  ]);
  const [historyData, setHistoryData] = useState([]);
  const [requirements, setRequirements] = useState({ D: 15, E: 12, N: 8 });
  const [preferences, setPreferences] = useState({});
  const [schedule, setSchedule] = useState(null);
  const [finalizedSchedule, setFinalizedSchedule] = useState(null);
  const [violations, setViolations] = useState([]);
  const [selectedMonth, setSelectedMonth] = useState(2);
  const [selectedYear, setSelectedYear] = useState(2026);

  useEffect(() => {
    // 預設資料
    const staffCSV = `staff_id,name,level,tenure_years,is_leader,leave_status,is_active,special_status,can_night_shift,accumulated_ot,night_shift_balance
N001,謝佩珊,N2,5.9,False,None,True,None,True,11.8,14
N002,王承恩,N2,6.5,False,None,True,None,True,22.2,6
N003,王玉琴,N3,6.8,True,None,True,Maternal,False,7.5,0`;
    setStaffData(parseCSV(staffCSV));
  }, []);

  const handleGenerateSchedule = (providedSchedule = null) => {
    let newSchedule = providedSchedule;
    if (!newSchedule) {
      newSchedule = generateAutoSchedule(staffData, historyData, requirements, preferences, selectedYear, selectedMonth);
    }
    if (newSchedule) {
        setSchedule(newSchedule);
        const newViolations = checkLaborLawCompliance(newSchedule, staffData, historyData, selectedYear, selectedMonth);
        setViolations(newViolations);
    }
  };

  const handleExportPreferences = () => {
    exportToExcel(preferences, staffData, selectedYear, selectedMonth);
  };

  const handleLogout = () => {
    setCurrentUser(null);
  };

  const handleStaffScheduleUpdate = (result) => {
    setSchedule(prevSchedule => {
      const newSchedule = { ...(prevSchedule || {}) };
      newSchedule[result.staffId] = result.fullMonthData;
      return newSchedule;
    });

    setStaffData(prevData => {
      const exists = prevData.find(s => s.staff_id === result.staffId);
      if (exists) return prevData;
      return [...prevData, { staff_id: result.staffId, name: result.staffName, special_status: result.shiftType === 'D' ? 'Standard' : 'BiWeekly', is_active: true }];
    });

    alert(`✅ 已更新總班表！\n員工 ${result.staffName} (${result.staffId}) 的班表已確認。`);
  };

  const handleSaveAndPublish = () => {
    if (!schedule || Object.keys(schedule).length === 0) {
      alert("❌ 目前沒有班表內容，無法儲存！");
      return;
    }
    setFinalizedSchedule(JSON.parse(JSON.stringify(schedule)));
    alert("✅ 班表已鎖定並發布！\n員工現在可以登入並開始認領此版本的班表。");
  };

  if (!currentUser) {
    return <LoginPanel onLogin={setCurrentUser} staffData={staffData} />;
  }

  return (
    <div style={{ minHeight: '100vh', background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', padding: '2rem', fontFamily: 'sans-serif' }}>
      <div style={{ maxWidth: '1400px', margin: '0 auto 2rem', background: 'rgba(255,255,255,0.95)', borderRadius: '16px', padding: '1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <Calendar size={28} color="#667eea" />
            <h1 style={{ margin: 0, fontSize: '1.8rem', color: '#333' }}>智能排班系統</h1>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <span style={{ color: '#555', fontWeight: 'bold' }}>👋 {currentUser.name} {currentUser.role === 'admin' ? '' : ' (護理師)'}</span>
            <button onClick={handleLogout} style={{ padding: '0.5rem 1rem', background: '#e74c3c', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer' }}>登出</button>
          </div>
      </div>

      <div style={{ maxWidth: '1400px', margin: '0 auto' }}>
        {currentUser.role === 'admin' ? (
          <ManagerInterface
            staffData={staffData} setStaffData={setStaffData} historyData={historyData}
            requirements={requirements} setRequirements={setRequirements}
            preferences={preferences} setPreferences={setPreferences}
            schedule={schedule} violations={violations}
            selectedYear={selectedYear} selectedMonth={selectedMonth}
            onGenerateSchedule={handleGenerateSchedule} onExportPreferences={handleExportPreferences}
            setSchedule={setSchedule} setViolations={setViolations}
            onSaveSchedule={handleSaveAndPublish}
          />
        ) : (
          <StaffDashboard
            currentUser={currentUser}
            targetYear={selectedYear}
            targetMonth={selectedMonth}
            currentSchedule={finalizedSchedule} 
            onConfirmSchedule={handleStaffScheduleUpdate} 
          />
        )}
      </div>
    </div>
  );
};

// ============================================================================
// 子元件區
// ============================================================================

// ============================================================================
// 管理者介面元件
// ============================================================================
const ManagerInterface = ({
  staffData, setStaffData, historyData, requirements, setRequirements,
  preferences, setPreferences, schedule, violations,
  selectedYear, selectedMonth, onGenerateSchedule, onExportPreferences, onSaveSchedule, setSchedule
}) => {
  const [activeTab, setActiveTab] = useState('requirements');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <div style={{ background: 'rgba(255,255,255,0.95)', borderRadius: '16px', padding: '1rem', display: 'flex', gap: '1rem' }}>
        {['requirements', 'staff', 'schedule', 'violations', 'statistics'].map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)} style={{
            flex: 1, padding: '1rem', border: 'none', borderRadius: '10px', cursor: 'pointer',
            background: activeTab === tab ? '#667eea' : 'transparent', color: activeTab === tab ? 'white' : '#666'
          }}>
            {tab === 'requirements' && '人力需求'}
            {tab === 'staff' && '員工管理'}
            {tab === 'schedule' && '總班表'}
            {tab === 'violations' && '法遵檢查'}
            {tab === 'statistics' && '統計報表'}
          </button>
        ))}
      </div>

      {activeTab === 'requirements' && (
        <RequirementsPanel
          requirements={requirements} setRequirements={setRequirements}
          onGenerateSchedule={onGenerateSchedule} onExportPreferences={onExportPreferences}
        />
      )}
      
      {activeTab === 'staff' && (
        <StaffManagementPanel 
           staffData={staffData} 
           setStaffData={setStaffData} 
        />
      )}
      
      {activeTab === 'schedule' && (
        <SchedulePanel
          schedule={schedule} 
          staffData={staffData} 
          violations={violations}
          requirements={requirements} 
          onGenerateSchedule={onGenerateSchedule} 
          onSaveSchedule={onSaveSchedule}
          selectedYear={selectedYear} 
          selectedMonth={selectedMonth}
          setSchedule={setSchedule}
        />
      )}
      
      {activeTab === 'violations' && <ViolationsPanel violations={violations} />}
      
      {activeTab === 'statistics' && <StatisticsPanel staffData={staffData} />}
    </div>
  );
};

// ============================================================================
// 人力需求設定面板
// ============================================================================
const RequirementsPanel = ({ requirements, setRequirements }) => {
  const [bedCount, setBedCount] = useState(50);
  const [ratioD, setRatioD] = useState(10);
  const [ratioE, setRatioE] = useState(12);
  const [ratioN, setRatioN] = useState(15);

  const dailyD = Math.ceil(bedCount / ratioD);
  const dailyE = Math.ceil(bedCount / ratioE);
  const dailyN = Math.ceil(bedCount / ratioN);

  useEffect(() => {
    setRequirements({
      ...requirements, D: dailyD, E: dailyE, N: dailyN,
      optimalD: Math.ceil(dailyD * 1.4), optimalE: Math.ceil(dailyE * 1.4), optimalN: Math.ceil(dailyN * 1.4)
    });
  }, [bedCount, ratioD, ratioE, ratioN]);

  return (
    <div style={{ background: 'white', borderRadius: '16px', padding: '2rem' }}>
      <h2>人力需求設定</h2>
      <div style={{ background: '#f8f9fa', padding: '1.5rem', borderRadius: '12px', marginBottom: '2rem' }}>
        <div style={{ marginBottom: '1rem' }}>
            <label style={{ fontWeight: 'bold', display: 'block', marginBottom: '0.5rem' }}>病床數: {bedCount}</label>
            <input 
              type="range" min="0" max="100" value={bedCount} 
              onChange={e=>setBedCount(Number(e.target.value))} 
              style={{ width:'100%', cursor: 'pointer' }}
            />
        </div>
        <div style={{ display: 'flex', gap: '1rem', marginTop: '1rem' }}>
            <div style={{ flex: 1, background: '#FFD93D', padding: '1rem', borderRadius: '8px', textAlign: 'center' }}>
                <div style={{ fontWeight: 'bold', fontSize: '1.2rem' }}>{dailyD} 人</div>
                <label style={{ fontSize: '0.9rem', opacity: 0.8 }}>早班 (1:{ratioD})</label>
            </div>
            <div style={{ flex: 1, background: '#FF6B9D', padding: '1rem', borderRadius: '8px', textAlign: 'center' }}>
                <div style={{ fontWeight: 'bold', fontSize: '1.2rem' }}>{dailyE} 人</div>
                <label style={{ fontSize: '0.9rem', opacity: 0.8 }}>小夜 (1:{ratioE})</label>
            </div>
            <div style={{ flex: 1, background: '#4D96FF', padding: '1rem', borderRadius: '8px', textAlign: 'center' }}>
                <div style={{ fontWeight: 'bold', fontSize: '1.2rem' }}>{dailyN} 人</div>
                <label style={{ fontSize: '0.9rem', opacity: 0.8 }}>大夜 (1:{ratioN})</label>
            </div>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// 總班表顯示面板
// ============================================================================
const SchedulePanel = ({ onSaveSchedule, schedule, setSchedule, staffData, requirements, onGenerateSchedule, selectedYear, selectedMonth }) => {
  const [geminiMessages, setGeminiMessages] = useState([]); 
  const [geminiInput, setGeminiInput] = useState('');       
  const [showGemini, setShowGemini] = useState(false);      
  const [processing, setProcessing] = useState(false);
  
  const [shiftOptions, setShiftOptions] = useState([
    { code: 'D', name: '白班', color: '#FFD93D' },
    { code: 'E', name: '小夜', color: '#FF6B9D' },
    { code: 'N', name: '大夜', color: '#4D96FF' },
    { code: 'OFF', name: '休假', color: '#E8E8E8' },
    { code: 'REGULAR', name: '例假', color: '#95E1D3' },
    { code: 'REST', name: '休息', color: '#B8E6D5' },
    { code: '支援', name: '支援', color: '#D4AC0D' }
  ]);
  
  const [showAddOption, setShowAddOption] = useState(false);
  const [newOption, setNewOption] = useState({ code: '', name: '', color: '#cccccc' });

  const chatSessionRef = useRef(null);
  const messagesEndRef = useRef(null);

  const scrollToBottom = () => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); };
  useEffect(() => { scrollToBottom(); }, [geminiMessages]);

  const handleGeminiSolve = async () => {
    setShowGemini(true);
    setProcessing(true);
    
    const reqD = requirements.optimalD || Math.ceil(requirements.D * 1.4);
    const reqE = requirements.optimalE || Math.ceil(requirements.E * 1.4);
    const reqN = requirements.optimalN || Math.ceil(requirements.N * 1.4);
    const totalHeadcount = reqD + reqE + reqN;

    setGeminiMessages([{ role: 'assistant', content: `🤖 啟動智慧排班...\n目標：${totalHeadcount} 人 (白${reqD}/小${reqE}/大${reqN})` }]);
    
    try {
       const virtualCount = totalHeadcount > 0 ? totalHeadcount : 20;
       const activeStaff = Array.from({ length: virtualCount }, (_, i) => {
           const id = `N${String(i + 1).padStart(2, '0')}`;
           return { id: id, name: `虛擬人員 ${id}`, rule: i < Math.ceil(virtualCount * 0.2) ? "Standard" : "BiWeekly" };
       });
       
       const daysInMonth = new Date(selectedYear, selectedMonth, 0).getDate();
       const prompt = `
[系統設定]
角色：你是一個高階排班演算法引擎，精通台灣勞動基準法。
當前任務：為混合編制的護理團隊規劃 ${selectedYear}年${selectedMonth}月 (共 ${daysInMonth} 天) 的詳細排班表。

[輸入資料]
員工名單與屬性：${JSON.stringify(activeStaff)}

[排班邏輯核心]
1. 24小時無縫覆蓋。
2. 符合單週/雙週工時。
3. 輸出純 JSON。

[輸出格式要求]
{
  "schedule": {
    "N01": {
      "1": { "type": "D", "time": "08:00-16:00" },
      ...
    }
  }
}
`;
       
       const model = genAI.getGenerativeModel({ model: "gemini-pro-latest" });
       const chat = model.startChat();
       chatSessionRef.current = chat;

       const result = await chat.sendMessage(prompt);
       const text = result.response.text().replace(/```json|```/g, '').trim();
       const jsonMatch = text.match(/\{[\s\S]*\}/);

       if (jsonMatch) {
           const parsed = JSON.parse(jsonMatch[0]);
           if(parsed.schedule) {
               onGenerateSchedule(parsed.schedule);
               setGeminiMessages(prev => [...prev, { role: 'assistant', content: `✅ 排班完成！已生成 ${Object.keys(parsed.schedule).length} 位人員班表。` }]);
           }
       } else {
           throw new Error("AI 格式錯誤");
       }
    } catch(e) {
        setGeminiMessages(prev => [...prev, { role: 'assistant', content: "❌ 錯誤: " + e.message }]);
    } finally {
        setProcessing(false);
    }
  };

  const handleUserChat = async () => {
      if (!geminiInput.trim() || !chatSessionRef.current) return;
      const userMsg = geminiInput;
      setGeminiInput(''); 
      setProcessing(true);
      setGeminiMessages(prev => [...prev, { role: 'user', content: userMsg }]);

      try {
          const result = await chatSessionRef.current.sendMessage(userMsg);
          const text = result.response.text();
          const jsonMatch = text.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
              try {
                  const parsed = JSON.parse(jsonMatch[0]);
                  if(parsed.schedule) onGenerateSchedule(parsed.schedule);
              } catch (e) {}
          }
          setGeminiMessages(prev => [...prev, { role: 'assistant', content: text }]);
      } catch (error) {
          setGeminiMessages(prev => [...prev, { role: 'assistant', content: "❌ 錯誤: " + error.message }]);
      } finally {
          setProcessing(false);
      }
  };

  const handleCellChange = (staffId, day, newValue) => {
    const newSchedule = JSON.parse(JSON.stringify(schedule));
    if (!newSchedule[staffId]) newSchedule[staffId] = {};
    const oldCell = newSchedule[staffId][day];
    if (typeof oldCell === 'object' && oldCell !== null) {
        newSchedule[staffId][day] = { ...oldCell, type: newValue };
    } else {
        newSchedule[staffId][day] = newValue;
    }
    setSchedule(newSchedule);
  };

  const handleAddOption = () => {
    if (!newOption.code || !newOption.name) {
      alert("請輸入代號與名稱！");
      return;
    }
    if (shiftOptions.find(o => o.code === newOption.code)) {
      alert("此代號已存在！");
      return;
    }
    setShiftOptions([...shiftOptions, newOption]);
    setNewOption({ code: '', name: '', color: '#cccccc' });
    setShowAddOption(false);
  };

  const displayStaffList = schedule 
    ? Object.keys(schedule).sort().map(id => {
        const original = staffData.find(s => s.staff_id === id);
        return { staff_id: id, name: original ? original.name : `人員 ${id}`, rule: original?.special_status };
    }) 
    : staffData;

  return (
    <div style={{ background: 'white', borderRadius: '16px', padding: '2rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1rem', alignItems: 'center' }}>
        <h2>總班表 ({selectedYear}年{selectedMonth}月)</h2>
        <div style={{ display: 'flex', gap: '10px' }}>
           <button onClick={() => setShowAddOption(!showAddOption)} style={{ padding: '0.5rem 1rem', background: '#6c757d', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer' }}>➕ 新增班別選項</button>
           <button id="gemini-trigger-btn" onClick={handleGeminiSolve} disabled={processing} style={{ padding: '0.5rem 1rem', background: processing ? '#ccc' : '#8e44ad', color: 'white', border: 'none', borderRadius: '8px', cursor: processing ? 'not-allowed' : 'pointer' }}>{processing ? '⏳ 運算中...' : '✨ 生成模擬排班'}</button>
           <button onClick={onSaveSchedule} style={{ padding: '0.5rem 1rem', background: '#e67e22', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>💾 儲存並發布</button>
        </div>
      </div>

      {showAddOption && (
        <div style={{ marginBottom: '1rem', padding: '1rem', background: '#f1f3f5', borderRadius: '8px', display: 'flex', gap: '10px', alignItems: 'center' }}>
          <input placeholder="代號 (如: VL)" value={newOption.code} onChange={e=>setNewOption({...newOption, code: e.target.value})} style={{padding:'5px', width:'80px'}} />
          <input placeholder="名稱 (如: 特休)" value={newOption.name} onChange={e=>setNewOption({...newOption, name: e.target.value})} style={{padding:'5px', width:'120px'}} />
          <input type="color" value={newOption.color} onChange={e=>setNewOption({...newOption, color: e.target.value})} style={{border:'none', width:'40px', height:'30px', cursor:'pointer'}} />
          <button onClick={handleAddOption} style={{padding:'5px 15px', background:'#28a745', color:'white', border:'none', borderRadius:'4px', cursor:'pointer'}}>確認新增</button>
        </div>
      )}
      
      {showGemini && (
        <div style={{ marginBottom: '1rem', padding: '1rem', background: '#f8f9fa', borderRadius: '12px' }}>
            <div style={{ height: '300px', overflowY: 'auto', marginBottom: '1rem' }}>
                {geminiMessages.map((m, i) => (
                    <div key={i} style={{ marginBottom: '0.8rem', textAlign: m.role === 'user' ? 'right' : 'left' }}>
                        <span style={{ padding: '0.5rem 1rem', borderRadius: '12px', background: m.role === 'user' ? '#667eea' : 'white', color: m.role === 'user' ? 'white' : '#333' }}>{m.content}</span>
                    </div>
                ))}
                <div ref={messagesEndRef} />
            </div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
                <input value={geminiInput} onChange={(e) => setGeminiInput(e.target.value)} onKeyPress={(e) => e.key === 'Enter' && handleUserChat()} placeholder="輸入..." style={{ flex: 1, padding: '0.8rem' }} />
                <button onClick={handleUserChat} disabled={processing}>發送</button>
            </div>
        </div>
      )}

      {schedule ? (
        <div style={{ overflowX: 'auto', border: '1px solid #eee', borderRadius: '8px' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
                <thead>
                    <tr style={{ background: '#667eea', color: 'white' }}>
                        <th style={{ padding: '8px', minWidth: '80px', position: 'sticky', left: 0, background: '#667eea', zIndex: 10 }}>員工</th>
                        {Array.from({length: new Date(selectedYear, selectedMonth, 0).getDate()}, (_,i)=>i+1).map(d=><th key={d} style={{padding:'4px', minWidth:'45px'}}>{d}</th>)}
                    </tr>
                </thead>
                <tbody>
                    {displayStaffList.map(s => (
                        <tr key={s.staff_id} style={{ borderBottom: '1px solid #eee' }}>
                            <td style={{ padding: '8px', borderRight: '1px solid #eee', position: 'sticky', left: 0, background: 'white', zIndex: 5 }}>
                                <div style={{ fontWeight: 'bold' }}>{s.name}</div>
                                <div style={{ fontSize: '0.7rem', color: '#888' }}>{s.rule?.includes('Standard') ? '單週' : '雙週'}</div>
                            </td>
                            {Array.from({length: new Date(selectedYear, selectedMonth, 0).getDate()}, (_,i)=>i+1).map(d => {
                                const cellData = schedule[s.staff_id]?.[d];
                                const currentType = (typeof cellData === 'object') ? cellData.type : (cellData || 'OFF');
                                const optionInfo = shiftOptions.find(o => o.code === currentType) || { color: '#fff' };

                                return (
                                    <td key={d} style={{ padding: 0, borderRight: '1px solid #f0f0f0' }}>
                                        <select
                                            value={currentType}
                                            onChange={(e) => handleCellChange(s.staff_id, d, e.target.value)}
                                            style={{
                                                width: '100%', height: '100%', padding: '8px 2px', border: 'none',
                                                background: optionInfo.color,
                                                color: ['D','E','N'].includes(currentType) ? 'white' : '#333',
                                                fontWeight: 'bold', textAlign: 'center', textAlignLast: 'center', cursor: 'pointer',
                                                appearance: 'none', WebkitAppearance: 'none'
                                            }}
                                            title={`${d}號: ${currentType}`}
                                        >
                                            {shiftOptions.map(opt => (
                                                <option key={opt.code} value={opt.code} style={{background:'white', color:'black'}}>
                                                    {opt.code}
                                                </option>
                                            ))}
                                        </select>
                                    </td>
                                )
                            })}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
      ) : <div style={{textAlign:'center', padding:'2rem', color:'#666'}}>尚未產生班表</div>}
    </div>
  );
};

// ============================================================================
// 員工管理面板 (可編輯版)
// ============================================================================
const StaffManagementPanel = ({ staffData, setStaffData }) => {
  const [localStaff, setLocalStaff] = useState([]);
  const [isDirty, setIsDirty] = useState(false);

  useEffect(() => {
    setLocalStaff(staffData);
    setIsDirty(false);
  }, [staffData]);

  const handleChange = (id, field, value) => {
    setLocalStaff(prev => prev.map(staff => {
      if (staff.staff_id === id) {
        return { ...staff, [field]: value };
      }
      return staff;
    }));
    setIsDirty(true);
  };

  const handleAddStaff = () => {
    const newId = `N${String(localStaff.length + 1).padStart(3, '0')}`;
    const newStaff = {
      staff_id: newId, name: '新員工', level: 'N0', tenure_years: 0, is_leader: false,
      leave_status: 'None', is_active: true, special_status: 'Standard',
      can_night_shift: true, accumulated_ot: 0, night_shift_balance: 0
    };
    setLocalStaff([...localStaff, newStaff]);
    setIsDirty(true);
  };

  const handleDelete = (id) => {
    if (window.confirm(`確定要刪除員工 ${id} 嗎？`)) {
      setLocalStaff(prev => prev.filter(s => s.staff_id !== id));
      setIsDirty(true);
    }
  };

  const handleSave = () => {
    setStaffData(localStaff);
    setIsDirty(false);
    alert('✅ 員工資料已儲存！');
  };

  const columns = [
    { key: 'staff_id', label: '工號', type: 'text', width: '80px', readOnly: true },
    { key: 'name', label: '姓名', type: 'text', width: '100px' },
    { key: 'level', label: '職級', type: 'select', options: ['N0', 'N1', 'N2', 'N3', 'N4'], width: '80px' },
    { key: 'tenure_years', label: '年資', type: 'number', width: '80px' },
    { key: 'is_leader', label: '組長', type: 'checkbox', width: '60px' },
    { key: 'leave_status', label: '假別狀態', type: 'select', options: ['None', 'Maternal', 'Student', 'OnLeave'], width: '100px' },
    { key: 'is_active', label: '在職', type: 'checkbox', width: '60px' },
    { key: 'special_status', label: '工時制', type: 'select', options: ['Standard', 'BiWeekly'], width: '100px' },
    { key: 'can_night_shift', label: '輪夜班', type: 'checkbox', width: '70px' },
    { key: 'accumulated_ot', label: '積借休', type: 'number', width: '80px' },
    { key: 'night_shift_balance', label: '夜班結餘', type: 'number', width: '80px' },
  ];

  return (
    <div style={{ background: 'white', borderRadius: '16px', padding: '2rem', height: '80vh', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <h2 style={{ margin: 0 }}>員工資料管理 ({localStaff.length}人)</h2>
        <div style={{ display: 'flex', gap: '1rem' }}>
          <button onClick={handleAddStaff} style={{ padding: '0.5rem 1rem', background: '#27ae60', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer' }}>+ 新增員工</button>
          <button onClick={handleSave} disabled={!isDirty} style={{ padding: '0.5rem 2rem', background: isDirty ? '#e67e22' : '#ccc', color: 'white', border: 'none', borderRadius: '8px', cursor: isDirty ? 'pointer' : 'not-allowed', fontWeight: 'bold', boxShadow: isDirty ? '0 4px 10px rgba(230, 126, 34, 0.4)' : 'none' }}>{isDirty ? '💾 儲存變更' : '已同步'}</button>
        </div>
      </div>

      <div style={{ flex: 1, overflow: 'auto', border: '1px solid #eee', borderRadius: '8px' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '1200px' }}>
          <thead style={{ position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 1 }}>
            <tr>
              {columns.map(col => <th key={col.key} style={{ padding: '12px', textAlign: 'left', borderBottom: '2px solid #ddd', minWidth: col.width }}>{col.label}</th>)}
              <th style={{ padding: '12px', borderBottom: '2px solid #ddd', width: '60px' }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {localStaff.map((staff) => (
              <tr key={staff.staff_id} style={{ borderBottom: '1px solid #f0f0f0', background: !staff.is_active ? '#fafafa' : 'white', opacity: !staff.is_active ? 0.7 : 1 }}>
                {columns.map(col => (
                  <td key={col.key} style={{ padding: '8px' }}>
                    {col.readOnly ? <span style={{ color: '#888', fontWeight: 'bold' }}>{staff[col.key]}</span> : col.type === 'checkbox' ? <input type="checkbox" checked={staff[col.key] === true || staff[col.key] === 'True'} onChange={(e) => handleChange(staff.staff_id, col.key, e.target.checked)} style={{ width: '20px', height: '20px', cursor: 'pointer' }} /> : col.type === 'select' ? <select value={staff[col.key] || ''} onChange={(e) => handleChange(staff.staff_id, col.key, e.target.value)} style={{ padding: '6px', borderRadius: '4px', border: '1px solid #ddd', width: '100%' }}>{col.options.map(opt => <option key={opt} value={opt}>{opt === 'None' ? '--' : opt}</option>)}</select> : <input type={col.type} value={staff[col.key] ?? ''} onChange={(e) => handleChange(staff.staff_id, col.key, col.type === 'number' ? parseFloat(e.target.value) : e.target.value)} style={{ padding: '6px', borderRadius: '4px', border: '1px solid #ddd', width: '100%', background: col.key === 'name' ? '#fff' : 'transparent' }} />}
                  </td>
                ))}
                <td style={{ padding: '8px', textAlign: 'center' }}>
                  <button onClick={() => handleDelete(staff.staff_id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#e74c3c', fontSize: '1.2rem' }} title="刪除">🗑️</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// ============================================================================
// 統計報表面板 (含排名)
// ============================================================================
const StatisticsPanel = ({ staffData }) => {
  const calculateStats = (data, key) => {
    const validData = data.map(s => ({ ...s, value: Number(s[key]) || 0 })).sort((a, b) => a.value - b.value);
    const values = validData.map(d => d.value);
    if (values.length === 0) return { avg: 0, median: 0, top5: [], bottom5: [] };
    const sum = values.reduce((acc, curr) => acc + curr, 0);
    const avg = (sum / values.length).toFixed(1);
    const mid = Math.floor(values.length / 2);
    const median = values.length % 2 !== 0 ? values[mid] : ((values[mid - 1] + values[mid]) / 2).toFixed(1);
    const top5 = [...validData].slice(validData.length >= 5 ? -5 : -validData.length).reverse(); 
    const bottom5 = validData.slice(0, 5);
    return { avg, median, top5, bottom5 };
  };

  const otStats = calculateStats(staffData, 'accumulated_ot');
  const nightStats = calculateStats(staffData, 'night_shift_balance');

  const RankingList = ({ title, data, color }) => (
    <div style={{ flex: 1, minWidth: '140px' }}>
      <div style={{ fontSize: '0.85rem', fontWeight: 'bold', color: '#666', marginBottom: '8px', borderBottom: '1px solid #eee', paddingBottom: '4px' }}>{title}</div>
      {data.map((s, i) => (
        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', marginBottom: '4px' }}>
          <span>{i + 1}. {s.name}</span>
          <span style={{ fontWeight: 'bold', color: color }}>{s.value}</span>
        </div>
      ))}
    </div>
  );

  return (
    <div style={{ background: 'white', borderRadius: '16px', padding: '2rem' }}>
      <h2 style={{ marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '10px' }}><TrendingUp color="#667eea" /> 團隊人力統計報表</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '1.5rem' }}>
        <div style={{ padding: '1.5rem', background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', borderRadius: '16px', color: 'white', boxShadow: '0 10px 20px rgba(102, 126, 234, 0.2)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}><h3 style={{ margin: 0, opacity: 0.9 }}>總員工數</h3><Users size={24} style={{ opacity: 0.8 }} /></div>
          <div style={{ fontSize: '3.5rem', fontWeight: 'bold', lineHeight: 1 }}>{staffData.length} <span style={{ fontSize: '1rem', fontWeight: 'normal', opacity: 0.8 }}>人</span></div>
          <div style={{ marginTop: '1rem', fontSize: '0.9rem', opacity: 0.8 }}>目前在職率: {Math.round((staffData.filter(s=>s.is_active).length / staffData.length || 1) * 100)}%</div>
        </div>

        <div style={{ padding: '1.5rem', background: 'white', borderRadius: '16px', border: '1px solid #eee', boxShadow: '0 4px 6px rgba(0,0,0,0.02)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '1rem' }}><div style={{ padding: '8px', background: '#e3f2fd', borderRadius: '8px', color: '#1976d2' }}><Clock size={20}/></div><h3 style={{ margin: 0, color: '#444' }}>積借休時數 (OT)</h3></div>
          <div style={{ display: 'flex', gap: '1rem', marginBottom: '1.5rem' }}>
             <div style={{ flex:1, textAlign: 'center', padding: '8px', background: '#f8f9fa', borderRadius: '8px' }}><div style={{ fontSize: '0.75rem', color: '#666' }}>平均</div><div style={{ fontSize: '1.4rem', fontWeight: 'bold', color: '#333' }}>{otStats.avg}</div></div>
             <div style={{ flex:1, textAlign: 'center', padding: '8px', background: '#f8f9fa', borderRadius: '8px' }}><div style={{ fontSize: '0.75rem', color: '#666' }}>中位數</div><div style={{ fontSize: '1.4rem', fontWeight: 'bold', color: '#1976d2' }}>{otStats.median}</div></div>
          </div>
          <div style={{ display: 'flex', gap: '1.5rem' }}><RankingList title="🔥 最高 Top 5 (積假多)" data={otStats.top5} color="#e67e22" /><RankingList title="❄️ 最低 Top 5 (欠假多)" data={otStats.bottom5} color="#3498db" /></div>
        </div>

        <div style={{ padding: '1.5rem', background: 'white', borderRadius: '16px', border: '1px solid #eee', boxShadow: '0 4px 6px rgba(0,0,0,0.02)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '1rem' }}><div style={{ padding: '8px', background: '#f3e5f5', borderRadius: '8px', color: '#8e44ad' }}><Moon size={20}/></div><h3 style={{ margin: 0, color: '#444' }}>夜班結餘 (Night)</h3></div>
          <div style={{ display: 'flex', gap: '1rem', marginBottom: '1.5rem' }}>
             <div style={{ flex:1, textAlign: 'center', padding: '8px', background: '#f8f9fa', borderRadius: '8px' }}><div style={{ fontSize: '0.75rem', color: '#666' }}>平均</div><div style={{ fontSize: '1.4rem', fontWeight: 'bold', color: '#333' }}>{nightStats.avg}</div></div>
             <div style={{ flex:1, textAlign: 'center', padding: '8px', background: '#f8f9fa', borderRadius: '8px' }}><div style={{ fontSize: '0.75rem', color: '#666' }}>中位數</div><div style={{ fontSize: '1.4rem', fontWeight: 'bold', color: '#8e44ad' }}>{nightStats.median}</div></div>
          </div>
          <div style={{ display: 'flex', gap: '1.5rem' }}><RankingList title="🌙 最高 Top 5 (夜班多)" data={nightStats.top5} color="#8e44ad" /><RankingList title="☀️ 最低 Top 5 (夜班少)" data={nightStats.bottom5} color="#95a5a6" /></div>
        </div>
      </div>
    </div>
  );
};

const ViolationsPanel = ({ violations }) => {
  return (
    <div style={{ background: 'white', borderRadius: '16px', padding: '2rem' }}>
      <h2>法遵檢查結果</h2>
      {violations.length === 0 ? <div style={{ color: 'green' }}><CheckCircle /> 無違規</div> : (
        violations.map((v, i) => (
          <div key={i} style={{ padding: '10px', background: '#fdecea', margin: '5px 0', borderLeft: '4px solid red' }}>
            <strong>{v.staffName} Day{v.day}</strong>: {v.message}
          </div>
        ))
      )}
    </div>
  );
};

export default NurseSchedulingSystem;



// ============================================================================
// 工具函數
// ============================================================================

const parseCSV = (csvText) => {
  const lines = csvText.trim().split('\n');
  const headers = lines[0].replace(/^\uFEFF/, '').split(',').map(h => h.trim());
  return lines.slice(1).map(line => {
    const values = line.split(',').map(v => v.trim());
    const obj = {};
    headers.forEach((header, i) => {
      let value = values[i];
      if (value === 'True' || value === 'TRUE') value = true;
      else if (value === 'False' || value === 'FALSE') value = false;
      else if (value === 'None' || value === '') value = null;
      else if (!isNaN(value) && value !== '') value = parseFloat(value);
      obj[header] = value;
    });
    return obj;
  });
};