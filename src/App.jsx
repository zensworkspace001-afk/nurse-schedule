import React, { useState, useEffect, useRef } from 'react';
import { Calendar, Users, Clock, AlertCircle, CheckCircle, Download, Upload, Moon, Sun, Sunset, Search, Filter, Settings, Bell, FileText, TrendingUp, Award, Trash2 } from 'lucide-react';
import { 
  doc, getDoc, setDoc, addDoc, collection, 
  query, orderBy, limit, getDocs, arrayUnion, onSnapshot
} from 'firebase/firestore';
import { signInWithEmailAndPassword, updatePassword, EmailAuthProvider, reauthenticateWithCredential } from "firebase/auth";
import { auth, db, subscribeToSettings, subscribeToStaff, subscribeToSchedule, saveGlobalSettings, saveGlobalStaff, saveMonthlySchedule, updateStaffSchedule, saveArchiveReport, subscribeToArchiveReports, clearArchiveReports, backupScheduleToArchive, fetchScheduleBackups } from './api/database';
import { signOut } from "firebase/auth"; // 加到 import

// ============================================================================
// 資料結構與常數定義
// ============================================================================

const SHIFT_TYPES = {
  D: { name: '白班', time: '07:00-16:00', color: '#FFD93D', icon: Sun, hours: 9 },
  E: { name: '小夜班', time: '15:00-00:00', color: '#FF6B9D', icon: Sunset, hours: 9 },
  N: { name: '大夜班', time: '23:00-08:00', color: '#4D96FF', icon: Moon, hours: 9 },
  OFF: { name: '休假', time: '', color: '#E8E8E8', icon: null, hours: 0 },
  RG: { name: '例假', time: '', color: '#2ecc71', icon: null, hours: 0 }, // 深綠
  RC: { name: '休假', time: '', color: '#d5f5e3', icon: null, hours: 0 }, // 淺綠 (亦可稱休息日)
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
// 勞基法特休假計算公式 (依據年資)
// ============================================================================
const calculateAnnualLeave = (tenureYears) => {
    if (tenureYears < 0.5) return 0;
    if (tenureYears >= 0.5 && tenureYears < 1) return 3;
    if (tenureYears >= 1 && tenureYears < 2) return 7;
    if (tenureYears >= 2 && tenureYears < 3) return 10;
    if (tenureYears >= 3 && tenureYears < 5) return 14;
    if (tenureYears >= 5 && tenureYears < 10) return 15;
    if (tenureYears >= 10) return Math.min(30, 15 + Math.floor(tenureYears - 9));
    return 0;
};

// ============================================================================
// 法遵檢查邏輯 (全功能版：含工時、間隔、休假、加班)
// ============================================================================
const checkLaborLawCompliance = (schedule, staffData, historyData, year, month) => {
  const violations = [];
  const daysInMonth = new Date(year, month, 0).getDate();
  
  // 定義每種班別的「工作時數」 (扣除休息時間)
  // 假設 D/E/N 均為 8 小時工時 (不含休息)
  const SHIFT_HOURS = { 'D': 8, 'E': 8, 'N': 8, '支援': 8, 'OFF': 0, 'RG': 0, 'RC': 0 };

  // 輪班間隔檢查邏輯 (E接D, N接D, N接E 都是違規)
  const isForbiddenSequence = (prev, curr) => {
      if (prev === 'E' && curr === 'D') return true; 
      if (prev === 'N' && curr === 'D') return true; 
      if (prev === 'N' && curr === 'E') return true; 
      return false;
  };

  Object.keys(schedule).forEach(staffId => {
    const staff = staffData.find(s => s.staff_id === staffId);
    if (!staff) return; // 只檢查真實員工

    const monthSchedule = schedule[staffId];
    
    let consecutiveDays = 0;
    let lastShiftType = null;
    let totalOffDays = 0;
    let totalMonthlyHours = 0;
    let totalRG = 0; // ★ 新增：統計例假 (不可出勤)
    let totalRC = 0; // ★ 新增：統計休息日 (可加班)
    let daysSinceLastRG = 0; // ★ 新增：距離上次例假的天數
    let scheduledAnnualLeave = 0; // ★ 新增：統計本月排了幾天特休
    // 用來計算每週工時 (以週一為起始)
    let currentWeekHours = 0;
    let isWeeklyViolationReported = false; // ★ 新增這行

    for (let day = 1; day <= daysInMonth; day++) {
      const cell = monthSchedule[day] || 'OFF';
      const shiftType = (typeof cell === 'object') ? (cell.type || 'OFF') : cell;
      
      // 取得當日工時
      const dailyHours = SHIFT_HOURS[shiftType] || 0;
      totalMonthlyHours += dailyHours;

      // --- A. 每日工時檢查 (MAX_DAILY_HOURS: 8) ---
      if (dailyHours > 8) {
           violations.push({
            staffId, staffName: staff?.name, day, type: 'DAILY_HOURS',
            message: `⚠️ 每日工時超標：${dailyHours} 小時 (上限 8)`
          });
      }

      // --- B. 每週工時檢查 (MAX_WEEKLY_HOURS: 40) ---
      // 判斷是否為週一 (若是週一，重置週工時計數器)
      const currentDayOfWeek = new Date(year, month - 1, day).getDay(); // 0=週日, 1=週一
      if (currentDayOfWeek === 1) { 
          currentWeekHours = 0;
          isWeeklyViolationReported = false; // ← 補上這行 
      }
      
      currentWeekHours += dailyHours;
      
// ★ 3. 加上 !isWeeklyViolationReported 條件，並且在報錯後把 flag 設為 true
      if (currentWeekHours > 40 && !isWeeklyViolationReported) {
          violations.push({
            staffId, staffName: staff?.name, day, type: 'WEEKLY_HOURS',
            message: `⚠️ 每週工時超標：本週已於 ${day} 號累計達 ${currentWeekHours} 小時 (上限 40)`
          });
          isWeeklyViolationReported = true; // ★ 標記本週已經警告過了，這週剩下的日子不要再吵了
      }

      // --- C. 統計休假天數 ---
      // --- C. 統計休假天數與種類 ---
      if (['RG', 'RC', 'OFF', '空班'].includes(shiftType)) totalOffDays++;
      if (shiftType === '特休') scheduledAnnualLeave++; // ★ 算特休天數
      if (shiftType === 'RG') {
          totalRG++;
          daysSinceLastRG = 0; // 遇到例假，計數器安全歸零
      } else {
          daysSinceLastRG++;
          // ★ 檢查例假間隔天條 (勞基法第36條)
          // 標準工時下，例假之間最多只能間隔 6 天。若員工為雙週變形(BiWeekly)則可挪移至最多 12 天。
          const maxRgInterval = staff.special_status === 'BiWeekly' ? 12 : 6;
          
          if (daysSinceLastRG > maxRgInterval) {
              violations.push({
                  staffId, staffName: staff?.name, day, type: 'RG_INTERVAL',
                  message: `⚠️ 違反例假天條：已連續 ${daysSinceLastRG} 天未排例假(RG)！(上限 ${maxRgInterval} 天)`
              });
              daysSinceLastRG = 0; // 報錯後重置，避免同一週期重複洗版
          }
      }
      if (shiftType === 'RC') totalRC++;

      // --- D. 檢查連續工作天數 (連六) ---
      if (dailyHours > 0) { // 有工時代表有上班
        consecutiveDays++;
        if (consecutiveDays > 6) { 
          violations.push({
            staffId, staffName: staff?.name, day, type: 'CONSECUTIVE_DAYS',
            message: `⚠️ 違反七休一：連續工作已達 ${consecutiveDays} 天`
          });
        }
      } else {
        consecutiveDays = 0;
      }

      // --- E. 檢查輪班間隔 (MIN_REST_HOURS: 11) ---
      if (lastShiftType && dailyHours > 0 && SHIFT_HOURS[lastShiftType] > 0) {
          if (isForbiddenSequence(lastShiftType, shiftType)) {
              violations.push({
                  staffId, staffName: staff?.name, day, type: 'SHIFT_INTERVAL',
                  message: `⚠️ 輪班間隔不足：${lastShiftType} 接 ${shiftType} (休息 < 11小時)`
              });
          }
      }
      // ★★★ 新增：H. 檢查母性保護條款 (懷孕/哺乳禁止夜班) ★★★
      const isPregnant = staff.is_pregnant_or_nursing === true || staff.is_pregnant_or_nursing === 'True' || staff.is_pregnant_or_nursing === 'true';
      if (isPregnant && (shiftType === 'E' || shiftType === 'N')) {
          violations.push({
              staffId, staffName: staff?.name, day, type: 'MATERNITY_PROTECTION',
              message: `⚠️ 違反母性保護：懷孕/哺乳期間禁止夜間出勤 (${shiftType}班)`
          });
      }
      // ★★★ 新增結束 ★★★
      if (dailyHours > 0) lastShiftType = shiftType;
      else lastShiftType = null;
    }
    // ✅ 在它【上面】插入特休餘額檢查：
    // --- ★ 檢查特休餘額 ---
    const totalAnnualLeave = calculateAnnualLeave(staff.tenure_years || 0);
    const usedAnnualLeave = staff.annual_leave_used || 0;
    const remainingLeave = totalAnnualLeave - usedAnnualLeave;

    if (scheduledAnnualLeave > remainingLeave) {
        violations.push({
            staffId, staffName: staff?.name, day: '整月', type: 'ANNUAL_LEAVE_EXCEEDED',
            message: `⚠️ 特休超休：本月排 ${scheduledAnnualLeave} 天特休 (剩餘額度僅 ${remainingLeave} 天，全年總額度 ${totalAnnualLeave} 天)`
        });
    }
// --- F. 檢查例假(RG)與休息日(RC)總量管制 ---
    if (totalRG < 4) {
        violations.push({
            staffId, staffName: staff?.name, day: '整月', type: 'INSUFFICIENT_RG',
            message: `⚠️ 例假嚴重違規：本月僅 ${totalRG} 天例假(RG)，依法至少需 4 天且絕對禁止出勤！`
        });
    }
    if ((totalRG + totalRC) < 8) {
        violations.push({
            staffId, staffName: staff?.name, day: '整月', type: 'INSUFFICIENT_OFF',
            message: `⚠️ 總休假不足：本月 RG+RC 僅 ${totalRG + totalRC} 天 (法定標準約 8 天)`
        });
    }

    // --- G. 檢查每月加班上限 (MAX_MONTHLY_OT: 46) ---
    // 簡單估算：正常工時約 176小時 (22天*8)，超過的部分視為延長工時
    // 若總工時 > (上班天數 * 8) + 46 ? 
    // 更嚴格的算法：直接看總數是否超過 "月標準工時 + 46"
    // 假設月標準工時以 4 週 160 小時估算，或以當月天數估算
    // 這裡採用較寬鬆標準：當月總工時若超過 222 小時 (176正常 + 46加班) 則警告
    const MONTHLY_LIMIT = 176 + 46; 
    if (totalMonthlyHours > MONTHLY_LIMIT) {
        violations.push({
            staffId, staffName: staff?.name, day: '整月', type: 'MONTHLY_OT',
            message: `⚠️ 加班超標：本月總工時 ${totalMonthlyHours} 小時 (含加班上限約 ${MONTHLY_LIMIT})`
        });
    }

  });
  return violations;
};
// ============================================================================
// 護理專業安全檢查：資歷搭配 (Skill Mix)
// ============================================================================
const checkSkillMixSafety = (schedule, staffData, year, month) => {
  const mixViolations = [];
  // 取得當月天數
  const daysInMonth = new Date(year, month, 0).getDate();
  const targetShifts = ['D', 'E', 'N']; // 主要檢查這三個臨床班別

  for (let day = 1; day <= daysInMonth; day++) {
    targetShifts.forEach(shiftType => {
      const workingStaffIds = [];
      let hasSenior = false;

      // 掃描這天、這個班別有誰上班
      Object.keys(schedule).forEach(staffId => {
        if (staffId.startsWith('D')) return; // 忽略尚未指派真人的虛擬空缺
        
        const cell = schedule[staffId]?.[day];
        const type = (typeof cell === 'object') ? (cell?.type || 'OFF') : (cell || 'OFF');
        
        if (type === shiftType) {
          workingStaffIds.push(staffId);
          // 找出該員工的詳細資料
          const staff = staffData.find(s => s.staff_id === staffId);
          
          if (staff) {
            // ★ 定義「資深人員」：擔任組長，或是職階為 N2, N3, N4
            const isLeader = staff.is_leader === true || staff.is_leader === 'True';
            const isSeniorLevel = ['N2', 'N3', 'N4'].includes(staff.level);
            
            if (isLeader || isSeniorLevel) {
              hasSenior = true;
            }
          }
        }
      });

      // 判斷邏輯：若該班次有人上班 (非空班)，但「全都是新人」，觸發警報！
      if (workingStaffIds.length > 0 && !hasSenior) {
        mixViolations.push({
            staffId: '🏥 單位排班',
            staffName: '⚠️ 臨床安全警告',
            day: day,
            type: 'SKILL_MIX',
            message: `[${shiftType === 'D' ? '早班' : shiftType === 'E' ? '小夜' : '大夜'}] 全為新人(N0/N1)，無資深人員(N2+)或組長坐鎮！`
        });
      }
    });
  }
  
  return mixViolations;
};
// ============================================================================
// 壓力與公平風險運算引擎 (Soft Risk Engine)
// ============================================================================
const calculateScheduleRisks = (schedule, staffData, publicHolidays, year, month) => {
  const risks = [];
  const stats = {};
  let totalN = 0, totalE = 0, totalHolidayWork = 0;
  let validStaffCount = 0;
  const daysInMonth = new Date(year, month, 0).getDate();

  // 1. 收集全單位數據，建立「團隊平均基準線」
  Object.keys(schedule).forEach(staffId => {
    if (staffId.startsWith('D')) return; // 略過尚未認領的虛擬班表
    
    validStaffCount++;
    stats[staffId] = { N: 0, E: 0, holidayWork: 0, maxConsecutive: 0 };
    let currentConsecutive = 0;

    for (let d = 1; d <= daysInMonth; d++) {
      const cell = schedule[staffId][d];
      const type = (typeof cell === 'object') ? (cell.type || 'OFF') : (cell || 'OFF');
      const isWork = ['D', 'E', 'N', '支援'].includes(type) || type.includes('(OT)');
      
      const dayOfWeek = new Date(year, month - 1, d).getDay();
      const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
      const dateStr = `${year}${String(month).padStart(2, '0')}${String(d).padStart(2, '0')}`;
      const isHoliday = publicHolidays.includes(dateStr);

      if (type === 'N') { stats[staffId].N++; totalN++; }
      if (type === 'E') { stats[staffId].E++; totalE++; }
      if (isWork && (isWeekend || isHoliday)) { stats[staffId].holidayWork++; totalHolidayWork++; }

      if (isWork) {
        currentConsecutive++;
        stats[staffId].maxConsecutive = Math.max(stats[staffId].maxConsecutive, currentConsecutive);
      } else {
        currentConsecutive = 0;
      }
    }
  });

  if (validStaffCount === 0) return [];

  // 計算團隊平均值
  const avgN = totalN / validStaffCount;
  const avgHolidayWork = totalHolidayWork / validStaffCount;

  // 2. 抓出「相對剝奪感」與「疲勞」極端值
  Object.keys(stats).forEach(staffId => {
    const staffStats = stats[staffId];
    const staffName = staffData.find(s => s.staff_id === staffId)?.name || staffId;
    const personalRisks = [];

    // [風險 A: 連續工作疲勞] - 雖然沒違法(連7)，但連5、連6已經很累
    if (staffStats.maxConsecutive === 5 || staffStats.maxConsecutive === 6) {
       personalRisks.push({ label: '連六風險', desc: `連續工作達 ${staffStats.maxConsecutive} 天，接近法定疲勞臨界點。` });
    }
    
    // [風險 B: 大夜班不均] - 高於單位平均 2 天以上
    if (staffStats.N > avgN + 2) { 
       personalRisks.push({ label: '大夜偏多', desc: `大夜班(${staffStats.N}天) 顯著高於團隊平均(${avgN.toFixed(1)}天)。` });
    }

    // [風險 C: 假日剝奪感] - 假日出勤高於平均 2 天以上
    if (staffStats.holidayWork > avgHolidayWork + 2) {
       personalRisks.push({ label: '假日班集中', desc: `週末/國定假日出勤(${staffStats.holidayWork}天) 高於單位平均(${avgHolidayWork.toFixed(1)}天)。` });
    }

    // 如果有中標，就推入風險清單
    if (personalRisks.length > 0) {
       risks.push({ staffId, staffName, tags: personalRisks });
    }
  });

  return risks;
};

// ============================================================================
// 1. LoginPanel (安全升級版 - 串接 Firebase Auth)
// ============================================================================
const LoginPanel = ({ onLogin, staffData = [] }) => { 
  const [employeeId, setEmployeeId] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  const handleLogin = async (e) => {
    e.preventDefault();
    setError('');
    setIsLoggingIn(true);

    const inputId = employeeId.trim().toLowerCase();
    
    // ★ 系統轉換：將工號 (如 N001 或 admin) 轉換為 Firebase 需要的 Email 格式
    const emailToLogin = `${inputId}@hospital.com`;

try {
        // 1. 呼叫 Firebase 伺服器進行真實密碼比對！
        await signInWithEmailAndPassword(auth, emailToLogin, password);
        
        // 2. 登入成功後，判斷角色權限
        if (inputId === 'admin') {
            onLogin({ id: 'ADMIN', name: '管理人員', role: 'admin' });
        } else {
            // 🌟 核心修復：登入瞬間先給一個「載入中」的假名字，不要去依賴空的 staffData
            onLogin({ 
                id: inputId.toUpperCase(), 
                name: '載入中...',  
                role: 'staff',
                rule: 'Standard' 
            });
        }
    } catch (err) {
        // ... 原本的 catch 錯誤處理保留不動 ...
        if (import.meta.env.DEV) {
        console.error("登入錯誤:", err.code);
        }
        // 翻譯 Firebase 的錯誤訊息
        switch (err.code) {
            case 'auth/invalid-credential':
            case 'auth/wrong-password':
            case 'auth/user-not-found':
                setError('帳號或密碼錯誤！');
                break;
            case 'auth/too-many-requests':
                setError('失敗次數過多，請稍後再試。');
                break;
            case 'auth/invalid-email':
                setError('請輸入正確的工號格式。');
                break;
            default:
                setError('登入失敗，請聯絡系統管理員。');
        }
    } finally {
        setIsLoggingIn(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', position:'relative', padding:'20px' }}>
      <div style={{ background: 'white', padding: '3rem', borderRadius: '20px', width: '100%', maxWidth: '400px', boxShadow: '0 10px 25px rgba(0,0,0,0.2)', textAlign: 'center', marginBottom:'30px', zIndex: 10 }}>
        <h2 style={{ color: '#333', marginBottom: '0.5rem' }}>護理排班系統 <span style={{fontSize:'0.9rem', background:'#e8f8f5', color:'#27ae60', padding:'2px 8px', borderRadius:'10px'}}>安全版</span></h2>
        
        <form onSubmit={handleLogin} style={{ marginTop: '20px' }}>
          <input 
            type="text" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} 
            placeholder="請輸入工號 (例如: N001 或 admin)" 
            required
            style={{ width: '100%', padding: '12px', marginBottom: '1rem', borderRadius: '8px', border: '1px solid #ddd', boxSizing: 'border-box' }}
          />
          <input 
            type="password" value={password} onChange={(e) => setPassword(e.target.value)} 
            placeholder="請輸入密碼" 
            required
            style={{ width: '100%', padding: '12px', marginBottom: '1.5rem', borderRadius: '8px', border: '1px solid #ddd', boxSizing: 'border-box' }}
          />

          {error && <div style={{ color: '#e74c3c', background: '#fdecea', padding: '10px', borderRadius: '6px', marginBottom: '1rem', fontSize: '0.9rem', textAlign: 'left' }}>❌ {error}</div>}
          
          <button type="submit" disabled={isLoggingIn} style={{ width: '100%', padding: '14px', background: isLoggingIn ? '#ccc' : '#667eea', color: 'white', border: 'none', borderRadius: '8px', fontWeight: 'bold', cursor: isLoggingIn ? 'not-allowed' : 'pointer', fontSize: '1rem' }}>
              {isLoggingIn ? '驗證中...' : '登入系統'}
          </button>
        </form>
      </div>


    </div>
  );
};
// ============================================================================
// 2. StaffDashboard (員工自助介面 - 顯示已認領班表與協調機制 + 修改密碼功能)
// ============================================================================
const StaffDashboard = ({ currentUser, onConfirmSchedule, targetYear = 2026, targetMonth = 2, currentSchedule, staffData = [], setStaffData, priorityConfig }) => {  
  
  // ★★★ 修正 1：所有的 Hooks (useState) 必須絕對置頂，不能被任何 if return 阻斷 ★★★
  const [showPwdModal, setShowPwdModal] = useState(false);
  const [pwdData, setPwdData] = useState({ old: '', new: '', confirm: '' });
  const [pwdMsg, setPwdMsg] = useState({ type: '', text: '' });
  
  const [currentStep, setCurrentStep] = useState(1);
  const [selectedShiftType, setSelectedShiftType] = useState('ALL'); 
  const [selectedOption, setSelectedOption] = useState(null);      
  const [aiSlots, setAiSlots] = useState([]);                      
  const [previewSchedule, setPreviewSchedule] = useState({});      
  const [isProcessing, setIsProcessing] = useState(false);
  // ★ 新增：嚴格判定該名員工是否已經存在於本月班表中
  const hasClaimed = currentSchedule && Object.keys(currentSchedule).includes(currentUser.id);
  // ★★★ 新增：即時監聽 AI 接力選班雷達狀態 ★★★
  const [activeTurn, setActiveTurn] = useState(null);
  useEffect(() => {
      const turnRef = doc(db, "SelectionTurn", `${targetYear}_${targetMonth}`);
      const unsub = onSnapshot(turnRef, (docSnap) => {
          if (docSnap.exists()) {
              setActiveTurn(docSnap.data());
          } else {
              setActiveTurn(null);
          }
      });
      return () => unsub();
  }, [targetYear, targetMonth]);

  // ★★★ 修正 2：useEffect 也必須置頂 ★★★
  useEffect(() => {
    if (!currentSchedule || Object.keys(currentSchedule).length === 0) { setAiSlots([]); return; }
    const daysInMonth = new Date(targetYear, targetMonth, 0).getDate();
    
    const allSlots = Object.keys(currentSchedule).sort((a, b) => {
        if (a.startsWith('D') && !b.startsWith('D')) return -1;
        if (!a.startsWith('D') && b.startsWith('D')) return 1;
        return a.localeCompare(b);
    });

    const formattedSlots = allSlots.map(slotId => {
        const slotData = currentSchedule[slotId];
        const pattern = [];
        const shiftCounts = { D: 0, E: 0, N: 0 };

        for (let d = 1; d <= daysInMonth; d++) {
            const cell = slotData[d];
            const type = (typeof cell === 'object') ? cell.type : (cell || 'OFF');
            pattern.push(type);
            if (['D', 'E', 'N'].includes(type)) shiftCounts[type]++;
        }

        let mainShift = 'D';
        if (shiftCounts.E > shiftCounts.D && shiftCounts.E > shiftCounts.N) mainShift = 'E';
        if (shiftCounts.N > shiftCounts.D && shiftCounts.N > shiftCounts.E) mainShift = 'N';

        let title = "混合班表";
        if (shiftCounts.D >= 10) title = "白班為主";
        else if (shiftCounts.E >= 10) title = "小夜為主";
        else if (shiftCounts.N >= 10) title = "大夜為主";

        const isClaimed = !slotId.startsWith('D');
        const claimant = isClaimed ? (staffData.find(s => s.staff_id === slotId)?.name || slotId) : null;

        return { id: slotId, title: isClaimed ? `${title}` : `${title} (${slotId})`, shift: mainShift, pattern: pattern, isClaimed: isClaimed, claimantName: claimant };
    });
    setAiSlots(formattedSlots);
  }, [currentSchedule, targetYear, targetMonth, staffData]);

// 計算上個月底的「連續上班天數」，用來銜接本月 1 號的七休一防呆
  const getPrevMonthStreak = () => {
    if (!currentUser || !currentUser.id) return 0;
    if (!staffData || staffData.length === 0) return 0;
    
    const staff = staffData.find(s => s.staff_id === currentUser.id);
    if (!staff || !staff.prevMonthLeave) return 0;
    
    // prevMonthLeave 陣列紀錄上個月最後 7 天的「休假狀態」
    // 💡 狀態對應：true = 有休假 (UI打勾)，false = 有上班 (UI未打勾)
    const leaves = staff.prevMonthLeave; 
    let streak = 0;
    
    // 從陣列尾端 (i=6，代表上個月最後一天) 往前倒推檢查
    for (let i = 6; i >= 0; i--) {
      if (leaves[i] !== false) break; // 只有明確 false（上班）才繼續，true 或 undefined 都停止
      streak++;
    }
    
    return streak;
  };
  const prevStreak = getPrevMonthStreak();

  const handlePasswordSubmit = async (e) => {
      e.preventDefault();
      if (pwdData.new !== pwdData.confirm) return setPwdMsg({ type: 'error', text: '兩次輸入的新密碼不一致！' });
      const strongPasswordRegex = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d]{6,}$/;
      if (!strongPasswordRegex.test(pwdData.new)) return setPwdMsg({ type: 'error', text: '密碼強度不足：需至少 6 碼，且必須包含英文與數字！' });

      try {
          const user = auth.currentUser;
          if (user) {
              const credential = EmailAuthProvider.credential(user.email, pwdData.old);
              await reauthenticateWithCredential(user, credential);
              await updatePassword(user, pwdData.new);
              setPwdMsg({ type: 'success', text: '✅ 密碼修改成功！下次請使用新密碼登入。' });
              setTimeout(() => {
                  setShowPwdModal(false);
                  setPwdData({ old: '', new: '', confirm: '' });
                  setPwdMsg({ type: '', text: '' });
              }, 2000);
          } else {
              setPwdMsg({ type: 'error', text: '找不到登入狀態，請重新登入。' });
          }
      } catch (error) {
          if (import.meta.env.DEV) console.error("修改密碼失敗:", error);
          if (error.code === 'auth/invalid-credential' || error.code === 'auth/wrong-password') {
              setPwdMsg({ type: 'error', text: '❌ 舊密碼輸入錯誤，請重新確認！' });
          } else if (error.code === 'auth/requires-recent-login') {
              setPwdMsg({ type: 'error', text: '⚠️ 基於安全考量，請先「登出再重新登入」後，才能修改密碼。' });
          } else {
              setPwdMsg({ type: 'error', text: '修改失敗：' + error.message });
          }
      }
  };

  // ============================================================================
  // ★★★ 修正 3：現在才開始放「條件 Return (防呆)」 ★★★
  // ============================================================================

// 防呆 1: 基本未載入檢查
  if (!currentUser) return <div style={{ padding: '40px', textAlign: 'center', color: '#666' }}>🔄 正在載入使用者資料...</div>;

  const currentStaffInfo = staffData.find(s => s.staff_id === currentUser.id);

  // 防呆 2: 離職或停權檢查
  if (currentStaffInfo && (currentStaffInfo.is_active === false || currentStaffInfo.is_active === 'false')) {
      return (
          <div style={{ padding: '3rem', textAlign: 'center', background: 'white', borderRadius: '16px', maxWidth: '500px', margin: '3rem auto', boxShadow: '0 4px 15px rgba(0,0,0,0.1)' }}>
              <div style={{ fontSize: '4rem', marginBottom: '1rem' }}>🚫</div>
              <h2 style={{ color: '#c0392b', marginBottom: '1rem' }}>帳號無效 / 已離職</h2>
              <p style={{ color: '#7f8c8d', fontSize: '1.1rem', lineHeight: '1.6' }}>您的帳號目前為「非在職狀態」，無法登入選班。<br/>如有疑問請洽詢護理長。</p>
          </div>
      );
  }

  // 防呆 3: 長假/特殊狀態檢查
  if (currentStaffInfo && currentStaffInfo.leave_status && currentStaffInfo.leave_status !== 'None') {
      const statusMap = { Maternal: '產假/育嬰假', Student: '進修留職', OnLeave: '長假' };
      const statusName = statusMap[currentStaffInfo.leave_status] || '特殊休假';
      return (
          <div style={{ padding: '3rem', textAlign: 'center', background: 'white', borderRadius: '16px', maxWidth: '500px', margin: '3rem auto', boxShadow: '0 4px 15px rgba(0,0,0,0.1)' }}>
              <div style={{ fontSize: '4rem', marginBottom: '1rem' }}>🏖️</div>
              <h2 style={{ color: '#f39c12', marginBottom: '1rem' }}>暫停排班</h2>
              <p style={{ color: '#7f8c8d', fontSize: '1.1rem', lineHeight: '1.6' }}>您目前的狀態為<strong>「{statusName}」</strong>，本月不需參與系統排班作業。<br/>祝您休假愉快！</p>
          </div>
      );
  }

  // 防呆 4: AI 接力選班引擎鎖定 (最核心！)
  // 若引擎有指定人 (active_staff_id 有值)，且那個人不是我，我就不能選！
  if (activeTurn && activeTurn.active_staff_id && activeTurn.active_staff_id !== currentUser.id) {
      const activeStaffName = staffData.find(s => s.staff_id === activeTurn.active_staff_id)?.name || activeTurn.active_staff_id;
      return (
          <div style={{ padding: '3rem', textAlign: 'center', background: 'white', borderRadius: '16px', maxWidth: '500px', margin: '3rem auto', boxShadow: '0 4px 15px rgba(0,0,0,0.1)' }}>
              <style>{`@keyframes pulseLock { 0% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.1); opacity: 0.7; } 100% { transform: scale(1); opacity: 1; } }`}</style>
              <div style={{ fontSize: '4rem', marginBottom: '1rem', animation: 'pulseLock 2s infinite' }}>⏳</div>
              <h2 style={{ color: '#2980b9', marginBottom: '1rem', fontWeight: 'bold' }}>尚未輪到您選班</h2>
              <div style={{ color: '#34495e', fontSize: '1.1rem', lineHeight: '1.6', marginBottom: '1.5rem', background: '#f8f9fa', padding: '15px', borderRadius: '8px', borderLeft: '4px solid #3498db', textAlign: 'left' }}>
                  目前的 <strong>優先發球權</strong> 在 <span style={{color: '#e74c3c', fontWeight: 'bold', fontSize: '1.2rem'}}>{activeStaffName}</span> 手上。<br/><br/>
                  為確保最需要的人能優先挑選好班，請等待 AI 引擎發送您的專屬換棒 Email 通知！
              </div>
              <button onClick={() => window.location.reload()} style={{ padding: '12px 30px', background: '#667eea', color: 'white', border: 'none', borderRadius: '50px', cursor: 'pointer', fontWeight: 'bold', fontSize: '1rem', boxShadow: '0 4px 10px rgba(102, 126, 234, 0.4)' }}>🔄 重新整理確認狀態</button>
          </div>
      );
  }

  const checkCompliance = (pattern) => {
    // ★★★ 新增：3. 提前攔截！檢查母性保護 (懷孕/哺乳禁止夜班) ★★★
      const currentStaffInfo = staffData.find(s => s.staff_id === currentUser.id);
      const isPregnant = currentStaffInfo?.is_pregnant_or_nursing === true || currentStaffInfo?.is_pregnant_or_nursing === 'True' || currentStaffInfo?.is_pregnant_or_nursing === 'true';
      
      if (isPregnant) {
          for (let i = 0; i < pattern.length; i++) {
              if (pattern[i] === 'E' || pattern[i] === 'N') {
                  return { valid: false, reason: `違反母性保護 (含有夜間班別)` };
              }
          }
      }
      // 1. 檢查七休一
      let currentStreak = prevStreak;
      for (let i = 0; i < pattern.length; i++) {
          const shift = pattern[i];
          if (shift !== 'OFF' && shift !== 'RG' && shift !== 'RC' && shift !== '空班') currentStreak++;
          else currentStreak = 0;
          if (currentStreak > 6) return { valid: false, reason: `違反七休一 (第${i+1}天連上${currentStreak}天)` };
      }

      // 2. 檢查輪班間隔 (必須包在這個函式裡面！)
      const isForbiddenSeq = (a, b) => (a==='E'&&b==='D') || (a==='N'&&b==='D') || (a==='N'&&b==='E');
      for (let i = 0; i < pattern.length - 1; i++) {
          if (isForbiddenSeq(pattern[i], pattern[i+1])) {
              return { valid: false, reason: `第${i+1}天 ${pattern[i]} 接 ${pattern[i+1]} 輪班間隔不足` };
          }
      }

      // 如果都沒違規，才回傳 true
      return { valid: true };
  };

  
  const filteredOptions = selectedShiftType === 'ALL' ? aiSlots : aiSlots.filter(opt => opt.shift === selectedShiftType);

  const handleSelectType = (type) => { setIsProcessing(true); setTimeout(() => { setSelectedShiftType(type); setCurrentStep(2); setIsProcessing(false); }, 300); };
  const handleSelectOption = (opt) => { setSelectedOption(opt.id); const map = {}; opt.pattern.forEach((s, i) => map[i+1] = s); setPreviewSchedule(map); setCurrentStep(3); };
const handleFinalSubmit = async () => { // 🌟 1. 加上 async
    if (hasClaimed) {
        alert("⚠️ 您已經認領過班表，無法重複認領！");
        return;
    }

    const choice = aiSlots.find(opt => opt.id === selectedOption);
    if (!choice || choice.isClaimed) {
        alert("⚠️ 此班表已被他人搶先選擇並鎖住！\n請返回重新選擇。");
        setCurrentStep(2);
        return;
    }

    // 🌟 2. 啟動鎖定狀態，防止員工亂點
    setIsProcessing(true); 

    // 🌟 3. 加上 await，強制等待主程式 (存檔 + AI算分數 + 寄信) 跑完！
    await onConfirmSchedule({ 
        staffId: currentUser.id, 
        staffName: currentUser.name, 
        shiftType: selectedShiftType === 'ALL' ? 'D' : selectedShiftType, 
        chosenSchedule: { id: choice.id, title: choice.title }, 
        fullMonthData: previewSchedule 
    });

    // 🌟 4. 全部跑完才解鎖並進入成功畫面
    setIsProcessing(false);
    setCurrentStep(4);
  };
  const getShiftColor = (shift) => { if (shift === 'D') return '#FFD93D'; if (shift === 'E') return '#FF6B9D'; if (shift === 'N') return '#4D96FF'; return '#f0f0f0'; };
  const firstDayOfWeek = new Date(targetYear, targetMonth - 1, 1).getDay();

  return (
    <div style={{ padding: '2rem', maxWidth: '900px', margin: '0 auto', background: 'white', borderRadius: '16px', minHeight: '80vh', boxShadow: '0 4px 20px rgba(0,0,0,0.05)', position: 'relative' }}>
      
      {/* ★★★ 新增：修改密碼 Modal 視窗 ★★★ */}
      {showPwdModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
            <div style={{ background: 'white', padding: '2rem', borderRadius: '16px', width: '90%', maxWidth: '400px', position: 'relative' }}>
                <button onClick={() => setShowPwdModal(false)} style={{ position: 'absolute', top: '10px', right: '15px', background: 'none', border: 'none', fontSize: '1.2rem', cursor: 'pointer', color: '#666' }}>✖</button>
                <h3 style={{ marginTop: 0, color: '#333' }}>⚙️ 修改密碼</h3>
                <form onSubmit={handlePasswordSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '15px', marginTop: '15px' }}>
                    <div>
                        <label style={{ fontSize: '0.85rem', color: '#666', marginBottom: '5px', display: 'block' }}>舊密碼 (預設: 123456)</label>
                        <input type="password" value={pwdData.old} onChange={e=>setPwdData({...pwdData, old: e.target.value})} required style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid #ddd', boxSizing: 'border-box' }} />
                    </div>
                    <div>
                        <label style={{ fontSize: '0.85rem', color: '#666', marginBottom: '5px', display: 'block' }}>新密碼</label>
                        <input type="password" value={pwdData.new} onChange={e=>setPwdData({...pwdData, new: e.target.value})} required minLength="4" style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid #ddd', boxSizing: 'border-box' }} />
                    </div>
                    <div>
                        <label style={{ fontSize: '0.85rem', color: '#666', marginBottom: '5px', display: 'block' }}>確認新密碼</label>
                        <input type="password" value={pwdData.confirm} onChange={e=>setPwdData({...pwdData, confirm: e.target.value})} required minLength="4" style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid #ddd', boxSizing: 'border-box' }} />
                    </div>
                    {pwdMsg.text && (
                        <div style={{ color: pwdMsg.type === 'error' ? '#e74c3c' : '#27ae60', background: pwdMsg.type === 'error' ? '#fdecea' : '#e8f8f5', padding: '10px', borderRadius: '8px', fontSize: '0.9rem' }}>
                            {pwdMsg.text}
                        </div>
                    )}
                    <button type="submit" style={{ padding: '12px', background: '#667eea', color: 'white', border: 'none', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer', marginTop: '10px' }}>儲存修改</button>
                </form>
            </div>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '2rem', borderBottom: '1px solid #eee', paddingBottom: '1rem' }}>
          {['班別選擇', '認領班表', '確認預覽', '完成'].map((label, idx) => (
              <div key={idx} style={{ color: currentStep >= idx+1 ? '#667eea' : '#ccc', fontWeight: 'bold' }}>{idx+1}. {label}</div>
          ))}
      </div>

      {currentStep === 1 && (
        <div style={{ textAlign: 'center' }}> 
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '15px', marginBottom: '10px' }}>
             <h2 style={{ color: 'black', fontWeight: 'bold', margin: 0 }}>👋 嗨，{currentUser.name} <span style={{color: 'red'}}> (路徑修復版 V3)</span></h2>
              {/* ★★★ 新增：修改密碼按鈕 ★★★ */}
              <button onClick={() => setShowPwdModal(true)} style={{ background: '#f8f9fa', border: '1px solid #ddd', padding: '6px 12px', borderRadius: '20px', cursor: 'pointer', fontSize: '0.85rem', color: '#555', fontWeight: 'bold' }}>⚙️ 修改密碼</button>
          </div>

          <h3 style={{ color: '#666', fontSize:'1rem', marginTop:0 }}>
            目前開放認領月份：<span style={{color:'#667eea', fontWeight:'bold'}}>{targetYear}年 {targetMonth}月</span>
          </h3>

          <div style={{ background: '#e3f2fd', padding: '10px', borderRadius: '8px', display: 'inline-block', marginBottom: '2rem', fontSize:'0.9rem', color:'#0d47a1', marginTop:'1rem' }}>
              ℹ️ 系統偵測：您上個月底已連續上班 <strong>{prevStreak}</strong> 天。
              {prevStreak >= 6 && <div style={{color:'red', fontWeight:'bold'}}>⚠️ 警告：您已達連六上限，本月 1 號必須排休！</div>}
          </div>

{/* ★ 加入閃爍動畫的 CSS */}
          <style>{`
            @keyframes pulseAlert {
              0% { transform: scale(1); box-shadow: 0 0 0 0 rgba(220, 53, 69, 0.4); }
              70% { transform: scale(1.01); box-shadow: 0 0 0 10px rgba(220, 53, 69, 0); }
              100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(220, 53, 69, 0); }
            }
          `}</style>

          {!currentSchedule || Object.keys(currentSchedule).length === 0 ? (
              <div style={{padding:'20px', background:'#fff3cd', color:'#856404', borderRadius:'8px'}}>⚠️ 管理員尚未發布此月份 ({targetMonth}月) 的班表，請稍後再來。</div>
          ) : hasClaimed ? (
              // ★ 已經認領過的畫面：隱藏選擇按鈕，顯示完成狀態
              <div style={{ padding: '25px', background: '#d4edda', color: '#155724', borderRadius: '12px', marginTop: '20px', border: '2px solid #c3e6cb' }}>
                  <h3 style={{ margin: 0, fontSize: '1.4rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>✅ 您已完成 {targetMonth} 月的認領！</h3>
                  <p style={{ marginTop: '10px', color: '#155724', fontWeight: 'bold' }}>您的排班已成功鎖定。選好的班表不能再被選一次。</p>
                  <p style={{ fontSize: '0.9rem', marginTop: '5px' }}>如需修改，請聯繫護理長在後台將您「拔除釋出」，您才能重新選擇。</p>
                  <button onClick={() => setCurrentStep(2)} style={{ marginTop: '15px', padding: '10px 25px', background: '#28a745', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight:'bold' }}>👀 進入查看所有人認領狀況</button>
              </div>
          ) : (
              // ★ 尚未認領的畫面：顯示閃爍提醒與選擇按鈕
              <>
                <div style={{ background: '#ffebee', color: '#c62828', padding: '15px', borderRadius: '8px', marginBottom: '25px', fontWeight: 'bold', border: '2px solid #ffcdd2', animation: 'pulseAlert 2s infinite', fontSize: '1.1rem' }}>
                    🔔 提醒：您尚未認領 {targetMonth} 月的班表，請盡速於下方選擇！
                </div>
                <p style={{ marginBottom: '1rem', color: '#666', fontWeight: 'bold' }}>請選擇您下個月希望認領的班別類型：</p>
                
                <div style={{ display: 'flex', gap: '20px', justifyContent: 'center', flexWrap:'wrap' }}>
                  <button onClick={() => handleSelectType('ALL')} disabled={isProcessing} 
                      style={{ width: '120px', height: '120px', border: 'none', borderRadius: '15px', background: '#95a5a6', color: 'white', fontSize: '1.2rem', cursor: 'pointer', opacity: isProcessing?0.7:1 }}>
                      全部顯示
                  </button>
                  {[{t:'D',l:'白班'}, {t:'E',l:'小夜'}, {t:'N',l:'大夜'}].map(i => (
                      <button key={i.t} onClick={() => handleSelectType(i.t)} disabled={isProcessing} 
                          style={{ width: '120px', height: '120px', border: 'none', borderRadius: '15px', background: getShiftColor(i.t), color: 'white', fontSize: '1.2rem', cursor: 'pointer', opacity: isProcessing?0.7:1 }}>
                          {i.l}
                      </button>
                  ))}
                </div>
              </>
          )}
        </div>
      )}

      {currentStep === 2 && (
        <div>
          <button onClick={() => setCurrentStep(1)} style={{ border: 'none', background: '#4a5568', color: 'white', padding: '8px 16px', borderRadius: '8px', cursor: 'pointer', marginBottom: '15px', fontWeight: 'bold', fontSize: '0.95rem', display: 'flex', alignItems: 'center', gap: '5px' }}>← 返回</button>
          <h2 style={{ color: 'black', fontWeight: 'bold' }}>📋 選擇整月方案 ({targetYear}年{targetMonth}月)</h2>
          <div style={{color:'#666', fontSize:'0.9rem', marginBottom:'15px'}}>💡 提示：灰底並標示「鎖頭」的班表代表已被其他人選走。若您極需該班表，請私下與該同仁協調。</div>
          {hasClaimed && <div style={{padding:'10px', background:'#d4edda', color:'#155724', borderRadius:'8px', marginBottom:'15px', fontWeight:'bold', textAlign:'center', border:'1px solid #c3e6cb'}}>🔒 您已完成認領，目前僅供檢視狀態，無法再選擇其他班表。</div>}
          <div style={{ display: 'grid', gap: '20px', maxHeight:'600px', overflowY:'auto', paddingRight:'10px' }}>
            {filteredOptions.length === 0 ? (
              <div style={{padding:'40px', textAlign:'center', color: '#666', background:'#f9f9f9', borderRadius:'12px'}}><h3>無符合條件的推薦方案 😕</h3></div>
            ) : (
              filteredOptions.map(opt => {
                const check = checkCompliance(opt.pattern);
                const isSelectable = !opt.isClaimed && check.valid && !hasClaimed; // ★ 加上 && !hasClaimed 徹底鎖死點擊;
                const shiftColors = { 'D': '#FFD93D', 'E': '#FF6B9D', 'N': '#4D96FF', 'RG': '#2ecc71', 'RC': '#d5f5e3', 'OFF': '#d5f5e3', '空班': '#d5f5e3' };

                return (
                    <div key={opt.id} onClick={() => isSelectable && handleSelectOption(opt)}
                        style={{ padding: '1.5rem', borderRadius: '16px', border: selectedOption === opt.id ? '3px solid #667eea' : '1px solid #e2e8f0', background: opt.isClaimed ? '#f1f3f5' : (!check.valid ? '#fff5f5' : 'white'), cursor: isSelectable ? 'pointer' : 'not-allowed', opacity: opt.isClaimed ? 0.7 : 1, boxShadow: '0 4px 6px rgba(0,0,0,0.05)', transition: 'transform 0.2s' }}>
                        <div style={{display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'10px'}}>
                            <div>
                                <div style={{fontWeight:'bold', fontSize:'1.1rem', color: opt.isClaimed ? '#7f8c8d' : '#2d3748'}}>{opt.title}</div>
                                {opt.isClaimed && <div style={{color:'#e67e22', fontSize:'0.85rem', fontWeight:'bold', marginTop:'4px'}}>🔒 已被 {opt.claimantName} 選擇 (請員工間自主協調)</div>}
                            </div>
                            {!opt.isClaimed && !check.valid && <div style={{color:'#e53e3e', fontSize:'0.9rem', fontWeight:'bold'}}>⚠️ {check.reason}</div>}
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '4px', filter: opt.isClaimed ? 'grayscale(30%)' : 'none' }}>
                            {['日','一','二','三','四','五','六'].map(d => <div key={d} style={{textAlign:'center', fontSize:'0.7rem', color:'#718096', marginBottom:'2px'}}>{d}</div>)}
                            {Array.from({ length: firstDayOfWeek }).map((_, i) => <div key={`empty-${i}`} />)}
                            {opt.pattern.map((s, i) => (
                              <div key={i} title={`${i+1}號: ${s}`} style={{ height: '25px', background: shiftColors[s] || '#edf2f7', borderRadius: '4px', fontSize: '0.75rem', color: ['RG','RC','OFF','空班'].includes(s) ? '#333' : 'white', fontWeight: 'bold', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                   {i+1} 
                              </div>
                            ))}
                        </div>
                    </div>
                );
            }))}
          </div>
        </div>
      )}

      {currentStep === 3 && (
        <div>
          <button onClick={() => setCurrentStep(2)} style={{ border: 'none', background: '#4a5568', color: 'white', padding: '8px 16px', borderRadius: '8px', cursor: 'pointer', marginBottom: '15px', fontWeight: 'bold', fontSize: '0.95rem', display: 'flex', alignItems: 'center', gap: '5px' }}>← 重選</button>
          <h2 style={{ color: 'black', fontWeight: 'bold', textAlign:'center', marginBottom:'20px' }}>確認您的班表 ({targetYear}年{targetMonth}月)</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '8px', maxWidth:'600px', margin:'0 auto' }}>
              {['日','一','二','三','四','五','六'].map(d=><div key={d} style={{textAlign:'center', fontWeight:'bold', color:'#555', paddingBottom:'5px'}}>{d}</div>)}
              {Array.from({ length: firstDayOfWeek }).map((_, i) => <div key={`e-${i}`} />)}
              {Object.keys(previewSchedule).map(d => {
                  const type = previewSchedule[d];
                  const shiftColors = { 'D': '#FFD93D', 'E': '#FF6B9D', 'N': '#4D96FF', 'RG': '#2ecc71', 'RC': '#d5f5e3', 'OFF': '#E8E8E8', '空班': '#E8E8E8', '支援': '#D4AC0D' };
                  const bgColor = shiftColors[type] || '#fff';
                  const isDarkBg = ['D', 'E', 'N', 'RG', '支援'].includes(type);
                  return (
                      <div key={d} style={{ border: isDarkBg ? 'none' : '1px solid #eee', padding:'8px 5px', textAlign:'center', background: bgColor, borderRadius: '8px', boxShadow: '0 2px 4px rgba(0,0,0,0.05)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '60px' }}>
                          <div style={{fontSize:'0.75rem', color: isDarkBg ? 'rgba(255,255,255,0.9)' : '#888', marginBottom:'2px'}}>{d}</div>
                          <div style={{fontWeight:'bold', color: isDarkBg ? 'white' : '#333', fontSize:'1.1rem'}}>{type}</div>
                      </div>
                  )
              })}
          </div>
          <div style={{textAlign:'center', marginTop:'30px'}}>
            <button 
    onClick={handleFinalSubmit} 
    disabled={isProcessing}
    style={{padding:'12px 40px', background: isProcessing ? '#95a5a6' : '#667eea', color:'white', border:'none', borderRadius:'20px', cursor: isProcessing ? 'not-allowed' : 'pointer', fontSize:'1.1rem', fontWeight:'bold', boxShadow:'0 4px 10px rgba(102, 126, 234, 0.4)'}}
>
    {isProcessing ? '⏳ 正在交棒給下一位 (約需10秒)...' : '確認認領'}
</button>
          </div>
        </div>
      )}

      {currentStep === 4 && (
        <div style={{ textAlign: 'center', padding: '4rem 2rem' }}>
          <h2 style={{ color: '#2d3748', fontWeight: '900', fontSize: '2rem', marginBottom: '1rem' }}>🎉 認領成功！</h2>
          <p style={{ color: '#718096', marginBottom: '2rem', fontSize: '1.1rem' }}>您的班表已成功送出，系統已更新。<br/>(您選擇的月份：{targetYear}年 {targetMonth}月)</p>
          <button onClick={() => window.location.reload()} style={{ marginTop: '10px', padding: '15px 40px', background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', color: 'white', border: 'none', borderRadius: '50px', fontSize: '1.2rem', fontWeight: 'bold', cursor: 'pointer', boxShadow: '0 4px 15px rgba(102, 126, 234, 0.4)' }}>回首頁</button>
        </div>
      )}
    </div>
  );
};
// ============================================================================
// 3. NurseSchedulingSystem (主元件)
// ============================================================================
const RequirementsPanel = ({ 
  requirements, setRequirements, 
  bedConfig, setBedConfig, // ★ 接收從雲端與最高層傳來的狀態
  selectedYear, setSelectedYear, selectedMonth, setSelectedMonth,
  onSaveSchedule 
}) => {
 
  // ★ 解構目前的設定值 (若無則給預設值防呆)
  const { bedCount, ratioD, ratioE, ratioN } = bedConfig || { bedCount: 50, ratioD: 10, ratioE: 12, ratioN: 15 };

  const dailyD = Math.ceil(bedCount / ratioD);
  const dailyE = Math.ceil(bedCount / ratioE);
  const dailyN = Math.ceil(bedCount / ratioN);

  // ★ 當病床與護病比變更時，即時更新「人力需求結果」，並準備觸發雲端自動存檔
  useEffect(() => {
    setRequirements({
       D: dailyD, E: dailyE, N: dailyN,
       optimalD: Math.ceil(dailyD * 1.4), optimalE: Math.ceil(dailyE * 1.4), optimalN: Math.ceil(dailyN * 1.4)
    });
  }, [bedCount, ratioD, ratioE, ratioN, setRequirements]);

  // ★ 統一更新 Config 的小幫手
  const updateBedConfig = (field, value) => {
      setBedConfig(prev => ({ ...prev, [field]: value }));
  };

  return (
    <div style={{ background: 'white', borderRadius: '16px', padding: '2rem' }}>
      <h2 style={{ color: 'black', marginBottom: '1.5rem' }}>人力需求與排班設定</h2>
      
      <div style={{ background: '#f8f9fa', padding: '1.5rem', borderRadius: '12px', marginBottom: '2rem' }}>
        <div style={{ marginBottom: '1.5rem' }}>
            <label style={{ fontWeight: 'bold', display: 'block', marginBottom: '0.5rem', color: 'black', fontSize: '1.1rem' }}>
              病床數: <span style={{fontSize:'1.3rem'}}>{bedCount}</span>
            </label>
            <input 
              type="range" min="0" max="100" value={bedCount} 
              onChange={e => updateBedConfig('bedCount', Number(e.target.value))} // ★ 改用新函式
              style={{ width:'100%', cursor: 'pointer' }}
            />
        </div>

        <div style={{ display: 'flex', gap: '1rem', marginTop: '1rem' }}>
            {/* 早班 */}
            <div style={{ flex: 1, background: '#FFD93D', padding: '1rem', borderRadius: '8px', textAlign: 'center', color: 'black', boxShadow:'0 2px 5px rgba(0,0,0,0.1)' }}>
                <div style={{ fontWeight: 'bold', fontSize: '1.5rem', marginBottom:'0.5rem' }}>{dailyD} 人</div>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:'5px', fontSize: '1rem', fontWeight:'bold' }}>
                   <span>早班 1 :</span>
                   <input type="number" value={ratioD} onChange={e => updateBedConfig('ratioD', Number(e.target.value))} style={{ width: '60px', padding: '4px', textAlign: 'center', borderRadius: '6px', border: '1px solid #ccc', color: 'black', background: 'white', fontWeight: 'bold', fontSize:'1rem' }} />
                </div>
            </div>

            {/* 小夜 */}
            <div style={{ flex: 1, background: '#FF6B9D', padding: '1rem', borderRadius: '8px', textAlign: 'center', color: 'black', boxShadow:'0 2px 5px rgba(0,0,0,0.1)' }}>
                <div style={{ fontWeight: 'bold', fontSize: '1.5rem', marginBottom:'0.5rem' }}>{dailyE} 人</div>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:'5px', fontSize: '1rem', fontWeight:'bold' }}>
                   <span>小夜 1 :</span>
                   <input type="number" value={ratioE} onChange={e => updateBedConfig('ratioE', Number(e.target.value))} style={{ width: '60px', padding: '4px', textAlign: 'center', borderRadius: '6px', border: '1px solid #ccc', color: 'black', background: 'white', fontWeight: 'bold', fontSize:'1rem' }} />
                </div>
            </div>

            {/* 大夜 */}
            <div style={{ flex: 1, background: '#4D96FF', padding: '1rem', borderRadius: '8px', textAlign: 'center', color: 'black', boxShadow:'0 2px 5px rgba(0,0,0,0.1)' }}>
                <div style={{ fontWeight: 'bold', fontSize: '1.5rem', marginBottom:'0.5rem' }}>{dailyN} 人</div>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:'5px', fontSize: '1rem', fontWeight:'bold' }}>
                   <span>大夜 1 :</span>
                   <input type="number" value={ratioN} onChange={e => updateBedConfig('ratioN', Number(e.target.value))} style={{ width: '60px', padding: '4px', textAlign: 'center', borderRadius: '6px', border: '1px solid #ccc', color: 'black', background: 'white', fontWeight: 'bold', fontSize:'1rem' }} />
                </div>
            </div>
        </div>
      </div>
    </div>
  );
};
// ============================================================================
// 總班表顯示面板 (精簡版：移除認領清單，專注於 AI 排班工作桌)
// ============================================================================
const SchedulePanel = ({ 
    onSaveSchedule, schedule, setSchedule, staffData, violations, requirements, 
    onGenerateSchedule, selectedYear, selectedMonth, setSelectedYear, setSelectedMonth,
    shiftOptions, setShiftOptions,setFinalizedSchedule, // ★ 接收參數
    // ★★★ 在這裡補上 finalizedSchedule 與 setFinalizedSchedule 的接收 ★★★
    finalizedSchedule, setHistoryYear, setHistoryMonth, setHistorySchedule,historyYear, historyMonth, historySchedule, onManualRefresh
}) => {
  const [geminiMessages, setGeminiMessages] = useState([]); 
  const [geminiInput, setGeminiInput] = useState('');       
  const [showGemini, setShowGemini] = useState(false);      
  const [processing, setProcessing] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState(''); 
  // ★ 新增一個控制客製化視窗的狀態
  const [showOverwriteModal, setShowOverwriteModal] = useState(false);
  const [isBackingUp, setIsBackingUp] = useState(false);
  const [customAiInstruction, setCustomAiInstruction] = useState('');
  const [showInstructionModal, setShowInstructionModal] = useState(false);
  const [showAddOption, setShowAddOption] = useState(false);
  const [newOption, setNewOption] = useState({ code: '', name: '', color: '#cccccc' });

  const messagesEndRef = useRef(null);

  const scrollToBottom = () => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); };
  useEffect(() => { scrollToBottom(); }, [geminiMessages, loadingStatus]);

  const daysInMonth = new Date(selectedYear, selectedMonth, 0).getDate();
  const daysArray = Array.from({length: daysInMonth}, (_,i)=>i+1);

// ★★★ 修改：一鍵清空整張班表 ★★★
  const handleClearAll = () => {
    if (window.confirm(`⚠️ 確定要【清空 ${selectedMonth}月 的所有班表】嗎？\n\n這將刪除目前工作桌上的所有資料，讓您有一張乾淨的空白桌面。\n(此操作不可逆)`)) {
        setSchedule({});
        if (setFinalizedSchedule) setFinalizedSchedule(null); // ★ 關鍵修復 3：連發布區一起殺乾淨
    }
  };

const handleReset = () => {
    // ★★★ 抓取畫面上「最新」的狀態 (包含員工已認領的發布區，或是剛生成的草稿區)
    const targetSchedule = finalizedSchedule || schedule; 
    
    if (!targetSchedule || Object.keys(targetSchedule).length === 0) {
        alert("目前沒有班表可重置。");
        return;
    }
    if (window.confirm("⚠️ 確定要【退回所有認領狀態】嗎？\n\n執行後：\n1. 班表內容將全數保留。\n2. 但所有員工的名字會被拔除，全部變回待認領的虛擬空缺 (Dxxx)。")) {
      const newSchedule = {};
      let index = 1;
      
      Object.keys(targetSchedule).sort().forEach(key => {
          const virtualId = `D${String(index).padStart(3, '0')}`;
          newSchedule[virtualId] = targetSchedule[key];
          index++;
      });
      
      setSchedule(newSchedule); 
      if (setFinalizedSchedule) setFinalizedSchedule(null); // ★★★ 同步清除發布區，防止舊資料干擾
      alert("✅ 系統已重置！所有班次已退回待認領狀態。");
    }
  };

// ★ 這是專屬於 SchedulePanel (排班工作桌) 的簡易版匯出功能
  const handleExportExcel = () => {
    // 抓取草稿或已發布的班表
    const targetSchedule = finalizedSchedule || schedule;
    if (!targetSchedule || Object.keys(targetSchedule).length === 0) return alert("無資料可匯出");
    
    let csv = "\uFEFF工號,姓名,";
    for (let d = 1; d <= daysInMonth; d++) csv += `${d}號,`;
    csv += "\n";

    Object.keys(targetSchedule).sort().forEach(rowId => {
        // 找出員工姓名
        const name = staffData.find(s => s.staff_id === rowId)?.name || "待認領";
        let row = `${rowId},${name},`;
        
        // 填入每日班別
        for (let d = 1; d <= daysInMonth; d++) {
            const cell = targetSchedule[rowId]?.[d];
            const type = (typeof cell === 'object') ? cell.type : (cell || '');
            row += `${type},`;
        }
        csv += row + "\n";
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${selectedYear}年${selectedMonth}月_排班表草稿.csv`;
    link.click();
  };


// --- ★ 升級版的 AI 生成邏輯 ---
// 1. 點擊「生成 AI 班表」時，第一步先跳出要求詢問視窗
  const handleGeminiSolveClick = () => {
      setShowInstructionModal(true); 
  };

  // 1.5 當使用者在詢問視窗輸入完要求，按下「確認並繼續」時的邏輯
  const handleConfirmInstruction = () => {
      setShowInstructionModal(false); // 關閉要求詢問視窗
      
      // 接著檢查畫面上是不是已經有舊班表了？
      if (schedule && Object.keys(schedule).length > 0) {
          setShowOverwriteModal(true); // 如果有資料，跳出覆蓋警告視窗
      } else {
          executeGeminiSolve(); // 如果是空的，直接發送給 AI 開始生成
      }
  };

// 2. 選項 A：先封存至伺服器歷史區，再重新生成
  const handleArchiveThenGenerate = async () => {
      const targetSchedule = finalizedSchedule || schedule;
      
      if (targetSchedule && Object.keys(targetSchedule).length > 0) {
          setIsBackingUp(true); 
          
          try {
              // ★ 動作 1：將原本躺在「歷史區」的班表，精準備份到 archive_reports/YYYY_M
              if (historySchedule && Object.keys(historySchedule).length > 0) {
                  await backupScheduleToArchive(
                      historyYear, 
                      historyMonth, 
                      historySchedule, 
                      "歷史區舊班表被覆蓋前自動歸檔"
                  );
              }

              // ★ 動作 2：將「目前工作桌」的班表也備份一份到對應的月份
              await backupScheduleToArchive(
                  selectedYear, 
                  selectedMonth, 
                  targetSchedule, 
                  "重新生成 AI 班表前自動備份"
              );

              // ★ 動作 3：將目前工作桌的班表，移動並「覆蓋」掉歷史區原本躺著的班表
              if (setHistoryYear) setHistoryYear(selectedYear);
              if (setHistoryMonth) setHistoryMonth(selectedMonth);
              if (setHistorySchedule) setHistorySchedule(targetSchedule);
              
              console.log("✅ 舊班表已成功歸檔至 archive_reports，並完成歷史區替換！");

          } catch (error) {
              console.error("伺服器備份失敗:", error);
              alert("❌ 備份至伺服器失敗，請確認網路！\n(錯誤：" + error.message + ")");
              setIsBackingUp(false);
              return; 
          }
          
          setIsBackingUp(false);
      }
      
      // 3. 確定伺服器備份成功後，關閉視窗並開始生成全新 AI 班表
      setShowOverwriteModal(false);
      executeGeminiSolve();
  };
  // 👇 ★★★ 請把這段遺失的「選項 B」補在這裡！ ★★★ 👇
  const handleDirectOverwrite = () => {
      setShowOverwriteModal(false); // 關閉彈出視窗
      executeGeminiSolve();         // 直接呼叫 AI 重新生成新班表
  };
  // 👆 ★★★ 補上這段就修復了！ ★★★ 👆

  // 4. 真正的 AI 呼叫核心 (原來的 handleGeminiSolve 邏輯移到這裡)
  const executeGeminiSolve = async () => {
    // ★★★ 新增：自動計算本月的週末與國定假日 ★★★
    const weekends = [];
    const natHolidays = [];
    for (let d = 1; d <= daysInMonth; d++) {
        const date = new Date(selectedYear, selectedMonth - 1, d);
        const dayOfWeek = date.getDay();
        const dateStr = `${selectedYear}${String(selectedMonth).padStart(2, '0')}${String(d).padStart(2, '0')}`;
        
        if (dayOfWeek === 0 || dayOfWeek === 6) weekends.push(d);
        if (publicHolidays.includes(dateStr)) natHolidays.push(d);
    }
    
    const calendarContext = `
[本月曆法資訊]
- 週末 (六日) 日期：${weekends.join(', ')} 號
- 國定假日 日期：${natHolidays.length > 0 ? natHolidays.join(', ') + ' 號' : '無'}
    `;
    setShowGemini(true);
    setProcessing(true);
    const dailyNeeded = (requirements.D || 0) + (requirements.E || 0) + (requirements.N || 0);
    const totalShiftsNeeded = dailyNeeded * daysInMonth;
    let estimatedCount = dailyNeeded > 0 ? Math.ceil(totalShiftsNeeded / 22) : 10;
    estimatedCount += 2; 

    setGeminiMessages([{ role: 'assistant', content: `🤖 根據人力需求 (${dailyNeeded}人/日)，正在為 ${selectedMonth}月 生成 ${estimatedCount} 份匿名班表...` }]);

    let currentPrompt = `
[角色定義]
你是一個高階排班演算法引擎，採用「目標規劃法 (Goal Programming)」邏輯。你精通台灣勞動基準法 (Taiwan Labor Standards Act) 與護理人員排班規則。
${calendarContext}
[使用者額外指令]
${customAiInstruction ? `請特別注意以下要求: "${customAiInstruction}"` : "無額外特殊要求，請依照一般最佳化原則排班。"}
[任務目標]
為 ${selectedYear}年${selectedMonth}月 (共 ${daysInMonth} 天) 的護理團隊規劃班表。
目標是將目標函數 Z 的總罰分降至最低： Minimize Z = (W1 * 工作量偏差) + (W2 * 偏好偏差) + (W3 * 班別公平性偏差)。

[輸入資料：員工與限制]
2. 班別定義: D (07-16), E (15-00), N (23-08) 
- 休假班: **RG (例假), RC (休假)**。
- 所有休假必須明確標示為 RG 或 RC。
3. 每日人力需求: 早班(D)至少 ${requirements.D} 人, 小夜(E)至少 ${requirements.E} 人, 大夜(N)至少 ${requirements.N} 人。

[硬性約束 (Hard Constraints) - 必須完全遵守，違反即失敗]
高優先級別-**每個護理人員班表僅能出現一種班別，也就是說第一天出現白班，接下來的排班除休假日外也僅可以出現白班。**
1. **法規底線**: 
   - 任何員工不得連續工作超過 6 天 (勞基法「七休一」)。
   - 輪班間隔必須 >= 11 小時 (例如: 今天 E 班 24:00 下班，明天最早只能接 E 班，不能接 D 班)。
   - 每 7 天週期內，至少要有 1 個 RG (例假) 和 1 個 RC (休假)。
   - RG (例假) 之間間隔不得超過 6 天。
   - 4週內總計至少應有 8 天休假 (4個 RG + 4個 RC)。
2. **24小時無縫覆蓋**: 任何時段護理站都不能空班。
3. **工時制度**: 
   - "Standard" (單週): 每日 8 小時，每週工時 <= 40。
   - "BiWeekly" (雙週變形): 每日可達 10 小時，雙週總工時 <= 80。
4. **夜班限制**: 禁止連續大夜班 (N) 超過44 天 (避免過勞)。

[軟性目標 (Soft Goals) - 盡力達成，做不到則計入罰分]
1. **Goal 1 (工作量公平性)**: 每人每月總班數應介於 22-24 班之間。偏差值越小越好。
2. **Goal 2 (個人偏好)**: 盡量滿足員工「假日休假」與「連續休假」。(若違反，每錯一個罰 10 分)。

[輸出格式 JSON - 極度重要]
為了追求極致的運算速度，請絕對不要輸出複雜的 JSON 物件！
請只輸出一個包含 ${estimatedCount} 個字串的陣列 (Array)。
每個字串代表一個人的整月班表，以「逗號」分隔，剛好 ${daysInMonth} 個班別。

格式範例: 
{ 
  "patterns": [
    "D,D,D,D,D,RG,RC,D,D,D,D,E,E,OFF,OFF...",
    "E,E,E,E,OFF,RC,E,E,E,E,D,D,RG,OFF,OFF..."
  ],
  "summary": "已生成符合勞基法的高效排班陣列。" 
}
`;
    let attempts = 0; const MAX_RETRIES = 3; let isSuccess = false;

    while (attempts < MAX_RETRIES && !isSuccess) {
        try {
            attempts++;
            setLoadingStatus(attempts === 1 ? "🧠 AI 正在計算最佳排班陣列..." : `♻️ 第 ${attempts} 次嘗試...`);
            const token = await auth.currentUser.getIdToken();
            const response = await fetch('/api/gemini', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json',
                           'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ prompt: currentPrompt })
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || "伺服器連線失敗");
            }

            const data = await response.json();
            const text = data.text.replace(/```json|```/g, '').trim();
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (!jsonMatch) throw new Error("JSON 格式錯誤");
            const parsed = JSON.parse(jsonMatch[0]);
            
            if (parsed.patterns && Array.isArray(parsed.patterns)) {
                const virtualSchedule = {};
                
                parsed.patterns.forEach((patternStr, index) => {
                    const virtualId = `D${String(index + 1).padStart(3, '0')}`;
                    const shifts = patternStr.split(',').map(s => s.trim());
                    
                    virtualSchedule[virtualId] = {};
                    
                    shifts.forEach((shiftType, dIndex) => {
                        const dayNum = dIndex + 1;
                        if (dayNum <= daysInMonth) {
                            virtualSchedule[virtualId][dayNum] = { type: shiftType, time: '' }; 
                        }
                    });
                });

                setGeminiMessages(prev => [...prev, { role: 'assistant', content: `✅ **排班成功 (全新產生)**\n\n已為您配置 ${Object.keys(virtualSchedule).length} 位人力！` }]);
                isSuccess = true;
                
                onGenerateSchedule(virtualSchedule);
            } else {
                throw new Error("AI 未回傳正確的 patterns 陣列");
            }
        } catch (e) {
            console.error(e);
            if (attempts >= MAX_RETRIES) {
                setGeminiMessages(prev => [...prev, { role: 'assistant', content: "❌ 系統錯誤: " + e.message }]);
                break;
            }
        }
    }
    setProcessing(false); setLoadingStatus('');
  };

  const handleUserChat = async () => {
      if (!geminiInput.trim()) return;
      const userMsg = geminiInput;
      setGeminiInput(''); setProcessing(true);
      setLoadingStatus("🤖 AI 正在思考回應...");
      setGeminiMessages(prev => [...prev, { role: 'user', content: userMsg }]);
      
      try {
          const token = await auth.currentUser.getIdToken();
          const response = await fetch('/api/gemini', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}` // <--- 加上這行防護罩
               },
              body: JSON.stringify({ prompt: userMsg })
          });
          
          if (!response.ok) throw new Error("伺服器連線失敗");
          
          const data = await response.json();
          setGeminiMessages(prev => [...prev, { role: 'assistant', content: data.text }]);
      } catch (error) {
          setGeminiMessages(prev => [...prev, { role: 'assistant', content: "❌ 錯誤: " + error.message }]);
      } finally { setProcessing(false); setLoadingStatus(''); }
  };

const handleCellChange = (staffId, day, newValue) => {
    // === RG 絕對防護罩 ===
    const currentCell = schedule[staffId]?.[day];
    const currentValue = (typeof currentCell === 'object') ? currentCell?.type : currentCell;
    const workShifts = ['D', 'E', 'N', '支援', 'OT']; 
    if (currentValue === 'RG' && workShifts.some(shift => newValue.includes(shift))) {
        alert('🚨 勞基法天條攔截：\n「例假 (RG)」絕對禁止出勤！\n\n系統已強制阻擋您將 RG 變更為上班班別。');
        return; 
    }
    // ===================

    const newSchedule = JSON.parse(JSON.stringify(schedule));
    if (!newSchedule[staffId]) newSchedule[staffId] = {};
    const oldCell = newSchedule[staffId][day];
    const opt = shiftOptions.find(o => o.code === newValue);
    const defaultTime = opt ? opt.time : '';
    newSchedule[staffId][day] = { ...(typeof oldCell === 'object' ? oldCell : {}), type: newValue, time: defaultTime };
    setSchedule(newSchedule);
  };

  const handleAddOption = () => {
    if (!newOption.code || !newOption.name) return alert("請輸入代號與名稱！");
    if (shiftOptions.find(o => o.code === newOption.code)) return alert("此代號已存在！");
    setShiftOptions([...shiftOptions, { ...newOption, time: '' }]);
    setNewOption({ code: '', name: '', color: '#cccccc' });
  };
  const handleDeleteOption = (code) => {
      if(window.confirm(`確定要刪除班別「${code}」嗎？`)) {
          setShiftOptions(shiftOptions.filter(o => o.code !== code));
      }
  };

  const calculateDailyStats = () => {
      const stats = {};
      for(let d=1; d<=daysInMonth; d++) stats[d] = { D:0, E:0, N:0 };
      if(schedule) {
          Object.values(schedule).forEach(staffSchedule => {
              for(let d=1; d<=daysInMonth; d++) {
                  const cell = staffSchedule[d];
                  const type = (typeof cell === 'object' ? cell.type : cell) || 'OFF';
                  if(['D','E','N'].includes(type)) stats[d][type]++;
              }
          });
      }
      return stats;
  };
  const dailyStats = calculateDailyStats();

 return (
    <div style={{ background: 'white', borderRadius: '16px', padding: '2rem', position: 'relative' }}>
      
      {/* 1. 載入中畫面 */}
      {processing && (
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(255,255,255,0.95)', zIndex: 100, borderRadius: '16px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
          <div className="win7-loader" style={{ border: '5px solid #f3f3f3', borderTop: '5px solid #3498db', borderRadius: '50%', width: '50px', height: '50px', animation: 'spin 1s linear infinite' }}></div>
          <style>{`@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }`}</style>
          <div style={{ marginTop: '20px', fontSize: '1.2rem', fontWeight: 'bold', color: '#2c3e50' }}>AI 正在排班中...</div>
          <div style={{ marginTop: '8px', fontSize: '0.95rem', color: '#7f8c8d' }}>{loadingStatus}</div>
        </div>
      )}
{/* ★★★ 新增的：AI 需求詢問視窗 (Modal) ★★★ */}
      {showInstructionModal && (
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1100, borderRadius: '16px', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
            <div style={{ background: 'white', padding: '2rem', borderRadius: '16px', width: '90%', maxWidth: '500px', boxShadow: '0 10px 30px rgba(0,0,0,0.3)' }}>
                <h3 style={{ marginTop: 0, color: '#8e44ad', display: 'flex', alignItems: 'center', gap: '10px', fontSize: '1.3rem' }}>
                    ✨ 告訴 AI 您的特殊要求
                </h3>
                <p style={{ color: '#555', lineHeight: '1.6', marginBottom: '15px' }}>
                    除了遵守勞基法與基本人力外，您本月還有什麼特別想交代的嗎？<br/>
                    <span style={{fontSize:'0.85rem', color:'#888'}}>(例如：「請盡量讓 N001 都在週末休假」、「大夜班盡量安排給年資高的人」)</span>
                </p>
                
                <textarea 
                    value={customAiInstruction}
                    onChange={(e) => setCustomAiInstruction(e.target.value)}
                    placeholder="請輸入您的特殊要求 (若無特殊要求，可直接留空並點擊繼續)..."
                    style={{ width: '100%', height: '100px', padding: '12px', borderRadius: '8px', border: '1px solid #ccc', resize: 'vertical', marginBottom: '20px', fontSize: '1rem', boxSizing: 'border-box' }}
                />
                
                <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
                    <button onClick={() => setShowInstructionModal(false)} style={{ padding: '10px 20px', background: '#f1f2f6', color: '#555', border: 'none', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}>
                        取消
                    </button>
                    <button onClick={handleConfirmInstruction} style={{ padding: '10px 20px', background: '#8e44ad', color: 'white', border: 'none', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer', boxShadow: '0 4px 6px rgba(142,68,173,0.3)' }}>
                        確認並繼續 🚀
                    </button>
                </div>
            </div>
        </div>
      )}
      {/* ★★★ 需求詢問視窗結束 ★★★ */}
      {/* ★★★ 2. 全新加入的：客製化覆蓋警告視窗 (Modal) ★★★ */}
      {showOverwriteModal && (
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, borderRadius: '16px', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
            <div style={{ background: 'white', padding: '2rem', borderRadius: '16px', width: '90%', maxWidth: '500px', boxShadow: '0 10px 30px rgba(0,0,0,0.3)' }}>
                <h3 style={{ marginTop: 0, color: '#e74c3c', display: 'flex', alignItems: 'center', gap: '10px', fontSize: '1.3rem' }}>
                    ⚠️ 畫面上已經有班表資料！
                </h3>
                <p style={{ color: '#555', lineHeight: '1.6', marginBottom: '20px' }}>
                    為避免「新舊班表疊加」導致人數暴增（產生多餘的幽靈空缺），系統必須清除目前的畫面。<br/><br/>
                    請問您希望如何處理目前的舊班表？
                </p>
                
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <button onClick={handleArchiveThenGenerate} disabled={isBackingUp} style={{ padding: '12px', background: isBackingUp ? '#95a5a6' : '#3498db', color: 'white', border: 'none', borderRadius: '8px', fontWeight: 'bold', cursor: isBackingUp ? 'not-allowed' : 'pointer', fontSize: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>{isBackingUp ? '⏳ 正在備份至伺服器...' : '📂 儲存至伺服器備份後重新生成'}</span>
                <span>→</span>
                </button>
                    
                    <button onClick={handleDirectOverwrite} style={{ padding: '12px', background: '#e74c3c', color: 'white', border: 'none', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer', fontSize: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span>🗑️ 直接清除畫面並覆蓋</span>
                        <span>→</span>
                    </button>

                    <button onClick={() => setShowOverwriteModal(false)} style={{ padding: '12px', background: '#f1f2f6', color: '#555', border: '1px solid #ddd', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer', marginTop: '10px' }}>
                        取消，保留目前畫面
                    </button>
                </div>
            </div>
        </div>
      )}
      {/* ★★★ Modal 結束 ★★★ */}

      {/* 3. 頂部工具列 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1rem', alignItems: 'center', flexWrap:'wrap', gap:'10px' }}>
        <div style={{display:'flex', alignItems:'center', gap:'15px'}}>
            <h2 style={{ color: 'black', fontWeight: 'bold', margin: 0 }}>總班表 (排班工作桌)</h2>
        </div>

       <div style={{ display: 'flex', gap: '8px', alignItems:'center' }}>
           {/* 日期控制區 */}
           <div style={{ display: 'flex', alignItems: 'center', background: '#e3f2fd', padding: '5px 10px', borderRadius: '8px', marginRight:'5px', border:'1px solid #90caf9' }}>
               <input 
                  type="number" value={selectedYear} onChange={(e) => setSelectedYear(Number(e.target.value))}
                  style={{ width: '60px', padding: '5px', borderRadius: '4px', border: '1px solid #ccc', fontWeight: 'bold', textAlign: 'center' }}
               />
               <span style={{margin:'0 5px', color:'#1565c0', fontWeight:'bold'}}>年</span>
               <select 
                  value={selectedMonth} onChange={(e) => setSelectedMonth(Number(e.target.value))}
                  style={{ padding: '5px', borderRadius: '4px', border: '1px solid #ccc', fontWeight: 'bold', cursor:'pointer' }}
               >
                  {Array.from({length:12},(_,i)=>i+1).map(m=><option key={m} value={m}>{m}</option>)}
               </select>
               <span style={{margin:'0 5px', color:'#1565c0', fontWeight:'bold'}}>月</span>
               <span style={{fontSize:'0.85rem', color:'#555', marginLeft:'5px'}}>({daysInMonth}天)</span>
           </div>
           {/* ★★★★ 請把這顆「手動同步按鈕」加在這裡！ ★★★★ */}
           <button 
             onClick={onManualRefresh}
             style={{ padding: '0.5rem 1rem', background: '#3498db', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold', marginLeft: '5px', marginRight: '5px' }}
           >
             🔄 手動同步
           </button>
           <button onClick={() => setShowAddOption(!showAddOption)} style={{ padding: '0.5rem 1rem', background: '#6c757d', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer' }}>➕ 選項</button>
           
           {/* ★ 確保這裡綁定的是 handleGeminiSolveClick */}
           <button id="gemini-trigger-btn" onClick={handleGeminiSolveClick} disabled={processing} style={{ padding: '0.5rem 1rem', background: processing ? '#ccc' : '#8e44ad', color: 'white', border: 'none', borderRadius: '8px', cursor: processing ? 'not-allowed' : 'pointer', fontWeight: 'bold', boxShadow: '0 2px 4px rgba(142,68,173,0.3)' }}>{processing ? '⏳' : '✨ 生成 AI 班表'}</button>
          
           <button onClick={handleClearAll} style={{ padding: '0.5rem 1rem', background: '#e74c3c', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>🗑️ 清空舊班表</button>
           
           <button onClick={handleExportExcel} style={{ padding: '0.5rem 1rem', background: '#27ae60', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>📥 Excel</button>
           <button onClick={onSaveSchedule} style={{ padding: '0.5rem 1rem', background: '#2980b9', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>💾 儲存並發布</button>
        </div>
      </div>

      {/* 4. 新增選項面板 */}
      {showAddOption && (
        <div style={{ marginBottom: '1rem', padding: '1rem', background: '#f1f3f5', borderRadius: '8px', display: 'flex', gap: '10px', alignItems: 'center', flexWrap:'wrap' }}>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginBottom:'10px' }}>
          <input placeholder="代號" value={newOption.code} onChange={e=>setNewOption({...newOption, code: e.target.value})} style={{padding:'5px', width:'80px', color:'black'}} />
          <input placeholder="名稱" value={newOption.name} onChange={e=>setNewOption({...newOption, name: e.target.value})} style={{padding:'5px', width:'120px', color:'black'}} />
          <input type="color" value={newOption.color} onChange={e=>setNewOption({...newOption, color: e.target.value})} style={{border:'none', width:'40px', height:'30px', cursor:'pointer'}} />
          <button onClick={handleAddOption} style={{padding:'5px 15px', background:'#28a745', color:'white', border:'none', borderRadius:'4px', cursor:'pointer'}}>確認新增</button>
        </div>
          <div style={{ display:'flex', flexWrap:'wrap', gap:'10px', paddingTop:'10px', borderTop:'1px solid #ddd', width:'100%' }}>
              {shiftOptions.map(opt => (
                  <div key={opt.code} style={{ background:'white', padding:'4px 8px', borderRadius:'4px', border:'1px solid #ccc', display:'flex', alignItems:'center', gap:'5px', fontSize:'0.85rem' }}>
                      <span style={{width:'12px', height:'12px', background:opt.color, display:'inline-block', borderRadius:'50%'}}></span>
                      <b style={{color: '#000000'}}>{opt.code}</b>
                      <button onClick={() => handleDeleteOption(opt.code)} style={{border:'none', background:'transparent', color:'red', cursor:'pointer', fontWeight:'bold', padding:'0 2px'}}>×</button>
                  </div>
              ))}
          </div>
        </div>
      )}

      {/* 5. AI 對話框 */}
      {showGemini && (
        <div style={{ marginBottom: '1rem', padding: '1rem', background: '#f8f9fa', borderRadius: '12px', border: '1px solid #eee' }}>
            <div style={{ maxHeight: '200px', overflowY: 'auto', marginBottom: '10px' }}>
                {geminiMessages.map((m, i) => (
                    <div key={i} style={{ marginBottom: '0.8rem', textAlign: m.role === 'user' ? 'right' : 'left' }}>
                        <div style={{ display: 'inline-block', padding: '10px 15px', borderRadius: '12px', background: m.role === 'user' ? '#667eea' : 'white', color: m.role === 'user' ? 'white' : '#333', border: m.role === 'assistant' ? '1px solid #ddd' : 'none', maxWidth: '80%', whiteSpace: 'pre-wrap', textAlign: 'left', fontSize: '0.9rem' }}>{m.content}</div>
                    </div>
                ))}
                <div ref={messagesEndRef} />
            </div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
                <input value={geminiInput} onChange={(e) => setGeminiInput(e.target.value)} onKeyPress={(e) => e.key === 'Enter' && handleUserChat()} placeholder="輸入指令..." style={{ flex: 1, padding: '0.8rem', borderRadius: '8px', border: '1px solid #ddd', color:'black' }} disabled={processing} />
                <button onClick={handleUserChat} disabled={processing} style={{ padding: '0 20px', background: processing ? '#ccc' : '#667eea', color: 'white', border: 'none', borderRadius: '8px', cursor: processing ? 'not-allowed' : 'pointer' }}>發送指令</button>
            </div>
        </div>
      )}

      {/* 6. 班表主體 */}
      {schedule && Object.keys(schedule).length > 0 ? (
        <div style={{ overflowX: 'auto', border: '1px solid #eee', borderRadius: '8px' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
                <thead style={{ position: 'sticky', top: 0, zIndex: 10 }}>
                    <tr style={{ background: '#667eea', color: 'white' }}>
                        <th style={{ padding: '8px', minWidth: '80px', position: 'sticky', left: 0, background: '#667eea', zIndex: 10 }}>員工</th>
                        {daysArray.map(d => {
                            const dayOfWeek = new Date(selectedYear, selectedMonth - 1, d).getDay(); 
                            const dayStrs = ['日', '一', '二', '三', '四', '五', '六'];
                            const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
                            
                            return (
                                <th key={d} style={{ padding:'4px', minWidth:'45px', color: isWeekend ? '#ffcccc' : 'white' }}>
                                    <div style={{ fontSize: '1rem' }}>{d}</div>
                                    <div style={{ fontSize: '0.75rem', fontWeight: 'normal' }}>{dayStrs[dayOfWeek]}</div>
                                </th>
                            )
                        })}
                    </tr>
                </thead>
                <tbody>
                   {Object.keys(schedule).sort((a, b) => {
                        const aIsVirtual = a.startsWith('D');
                        const bIsVirtual = b.startsWith('D');
                        if (aIsVirtual && !bIsVirtual) return 1;  // D 永遠墊底
                        if (!aIsVirtual && bIsVirtual) return -1; // 員工永遠置頂
                        return a.localeCompare(b);
                    }).map(rowId => {
                        const isVirtual = rowId.startsWith('D');
                        return (
                            <tr key={rowId} style={{ borderBottom: '1px solid #eee', background: isVirtual ? '#fafafa' : 'white' }}>
                                <td style={{ padding: '8px', borderRight: '1px solid #eee', position: 'sticky', left: 0, background: isVirtual ? '#f9f9f9' : 'white', zIndex: 5 }}>
                                    {isVirtual ? (
                                        <>
                                            <div style={{ color: '#888', fontWeight: 'bold', fontSize: '1rem' }}>🎲 待認領</div>
                                            <div style={{ fontSize: '0.85rem', color: '#aaa', fontWeight: 'bold' }}>{rowId}</div>
                                        </>
                                    ) : (
                                        <>
                                            <div style={{ color: '#2c3e50', fontWeight: 'bold', fontSize: '1rem' }}>{staffData.find(s=>s.staff_id===rowId)?.name || rowId}</div>
                                            <div style={{ fontSize: '0.85rem', color: '#667eea', fontWeight: 'bold' }}>{rowId}</div>
                                        </>
                                    )}
                                </td>
                                {daysArray.map(d => {
                                    const cellData = schedule[rowId]?.[d];
                                    const currentType = (typeof cellData === 'object') ? cellData.type : (cellData || 'OFF');
                                    const optionInfo = shiftOptions.find(o => o.code === currentType) || { color: '#fff', code: currentType };
                                    const isDarkBg = ['N', 'E', 'D', 'RG', '支援'].includes(currentType); 
                                    return (
                                        <td key={d} style={{ padding: 0, borderRight: '1px solid #f0f0f0', height: '40px' }}>
                                            <select value={currentType} onChange={(e) => handleCellChange(rowId, d, e.target.value)} style={{ width: '100%', height: '100%', padding: '0', border: 'none', background: optionInfo.color, color: isDarkBg ? 'white' : '#333', fontWeight: 'bold', textAlignLast: 'center', cursor: 'pointer', appearance: 'none', borderRadius: 0 }}>
                                                {shiftOptions.map(opt => <option key={opt.code} value={opt.code} style={{background:'white', color:'black'}}>{opt.code}</option>)}
                                            </select>
                                        </td>
                                    )
                                })}
                            </tr>
                        );
                    })}
                </tbody>
                
                <tfoot style={{ borderTop: '2px solid #ddd' }}>
                  {['D', 'E', 'N'].map(type => {
                      const req = requirements[type] || 0;
                      return (
                          <tr key={type} style={{ background: '#f8f9fa' }}>
                              <td style={{ padding: '8px', position: 'sticky', left: 0, background: '#f8f9fa', zIndex: 5, fontWeight: 'bold', borderRight: '1px solid #eee',color:'#333' }}>
                                  {type === 'D' ? '早班' : type === 'E' ? '小夜' : '大夜'} 
                                  <span style={{ fontSize: '0.8rem', color: '#666' }}>(需{req})</span>
                              </td>
                              {daysArray.map(d => {
                                  const count = dailyStats[d]?.[type] || 0;
                                  const isOk = count >= req;
                                  return (
                                      <td key={d} style={{ textAlign: 'center', fontWeight: 'bold', color: isOk ? '#27ae60' : '#e74c3c', background: isOk ? '#d4edda' : '#f8d7da', fontSize: '0.9rem', borderRight: '1px solid white' }}>
                                          {count}
                                      </td>
                                  )
                              })}
                          </tr>
                      )
                  })}
                </tfoot>
            </table>
        </div>
      ) : <div style={{textAlign:'center', padding:'3rem', color:'#888', background:'#f8f9fa', borderRadius:'8px', border:'2px dashed #ddd'}}>
          <h3 style={{margin:0, color:'#666'}}>桌面空空如也 🌬️</h3>
          <p>請點擊上方的「✨ 生成 AI 班表」開始排班，或是切換其他月份。</p>
      </div>}
    </div>
 );
  }
// ============================================================================
// 員工管理面板 (更新：加入「重置密碼」功能)
// ============================================================================
const StaffManagementPanel = ({ staffData, setStaffData }) => {
  const [localStaff, setLocalStaff] = useState([]);
  const [isDirty, setIsDirty] = useState(false);

useEffect(() => {
  // ★ 只在「沒有未儲存的修改」時才接受雲端同步的資料
  setIsDirty(prev => {
    if (!prev) {
      setLocalStaff(staffData); // 沒在編輯中才更新
    }
    return prev; // isDirty 狀態保持不變
  });
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

// ★★★ 修正 5：修復刪除員工後可能引發的工號衝突 (Auto-Increment Bug) ★★★
  const handleAddStaff = () => {
    // 找出目前最大工號數字再 +1
    const maxNum = localStaff.reduce((max, s) => {
        const num = parseInt(s.staff_id.replace(/\D/g, '')) || 0;
        return Math.max(max, num);
    }, 0);
    
    // 生成新的不重複工號
    const newId = `N${String(maxNum + 1).padStart(3, '0')}`;
    
 const newStaff = {
      staff_id: newId, name: '新員工', gender: '女', email: '', level: 'N0', tenure_years: 0,
     leave_status: 'None', is_active: true, special_status: 'Standard',
     is_pregnant_or_nursing: false, can_night_shift: true, accumulated_ot: 0, night_shift_balance: 0,
      annual_leave_used: 0, prevMonthLeave: [false, false, false, false, false, false, false]
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

  // ★★★ 新增：批次匯入 CSV 員工資料 ★★★
  const fileInputRef = useRef(null); // 需要在元件頂部 import { useRef } from 'react'，若已引入則直接加這行

  const handleImportCSV = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const csv = event.target.result;
      const lines = csv.split(/\r\n|\n/); // 支援 Windows/Mac 換行
      const newStaffList = [...localStaff]; // 保留原本已有的員工，把新的加進去
      let importedCount = 0;

      // 從第二行開始讀取 (跳過標題列)
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        
        const cols = line.split(',');
        if (cols.length >= 2 && cols[0]) {
           // 檢查是否已有相同工號，避免重複
           if (newStaffList.some(s => s.staff_id === cols[0])) continue;

           newStaffList.push({
              staff_id: cols[0],
              name: cols[1],
              level: cols[2] || 'N0',
              tenure_years: Number(cols[3]) || 0,
              is_leader: cols[4] === '是' || cols[4] === 'true',
              leave_status: cols[5] === '' ? 'None' : cols[5],
              is_active: true,
              special_status: cols[6] === 'BiWeekly' ? 'BiWeekly' : 'Standard',
              can_night_shift: cols[7] !== '否' && cols[7] !== 'false',
              accumulated_ot: Number(cols[8]) || 0,
              night_shift_balance: Number(cols[9]) || 0,
              prevMonthLeave: [false, false, false, false, false, false, false]
           });
           importedCount++;
        }
      }

      setLocalStaff(newStaffList);
      setIsDirty(true);
      alert(`✅ 成功匯入 ${importedCount} 筆員工資料！\n請記得點擊「💾 儲存變更」以上傳至雲端。`);
      
      // 清空 input 讓下次選同一個檔案也能觸發
      if (fileInputRef.current) fileInputRef.current.value = ''; 
    };
    reader.readAsText(file);
  };

  // ★★★ 修改：呼叫後端 API 進行真實密碼重置 ★★★
  const handleResetPassword = async (id, name) => {
      if (!window.confirm(`確定要將員工「${name} (${id})」的登入密碼強制重置為 123456 嗎？\n\n注意：這將直接修改系統通行驗證碼。`)) {
          return;
      }

      try {
          // 1. 取得管理員自己的 Token
          const token = await auth.currentUser.getIdToken();

          // 2. 呼叫我們自己寫的 Vercel 後端 API
          const response = await fetch('/api/reset-password', {
              method: 'POST',
              headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${token}` // 帶上管理員證明
              },
              body: JSON.stringify({ staffId: id })
          });

          const data = await response.json();

          if (!response.ok) {
              throw new Error(data.error || '重置失敗');
          }


          
          // 3. API 執行成功後，只需通知使用者即可，前端不保留密碼狀態
alert(`✅ 成功！員工 ${name} 的登入密碼已重置為 123456。`);
      } catch (error) {
          console.error(error);
          alert(`❌ 重置密碼失敗：${error.message}`);
      }
  };

const handleSave = async () => {
    // 1. 更新前端畫面與觸發 Firestore 存檔 (靠 App.jsx 原本的 debounce 寫入)
    setStaffData(localStaff);
    setIsDirty(false);
    
    // 2. 偷偷在背景呼叫 Vercel API，幫大家建帳號！
    try {
        const response = await fetch('/api/sync-accounts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ staffList: localStaff })
        });
        
        const data = await response.json();
        
        if(response.ok) {
            alert(`✅ 員工資料已成功儲存！\n\n🔑 【系統後台報告】\n- 自動開通新帳號：${data.result.successCount} 人\n- 既有帳號已略過：${data.result.existedCount} 人\n- 發生錯誤：${data.result.errorCount} 人`);
        } else {
            alert(`⚠️ 資料已儲存，但建立登入帳號時發生錯誤：${data.error}`);
        }
    } catch (error) {
        console.error("同步帳號失敗", error);
        alert('✅ 員工資料已儲存！\n(但目前無法連線至自動建帳號系統)');
    }
  };

  const columns = [
    { key: 'staff_id', label: '工號', type: 'text', width: '60px', readOnly: true },
    { key: 'name', label: '姓名', type: 'text', width: '80px' },
    { key: 'gender', label: '性別', type: 'select', options: ['女', '男'], width: '60px' }, // 👈 新增這行
    { key: 'email', label: 'Email信箱', type: 'text', width: '160px' , color:'black'}, // 👈 ★★★ 新增這行 ★★★
    { key: 'level', label: '職級', type: 'select', options: ['N0', 'N1', 'N2', 'N3', 'N4'], width: '70px' },
    { key: 'prevMonthLeave', label: '上月連班天數', type: 'streak_display', width: '80px' },
    { key: 'tenure_years', label: '年資', type: 'number', width: '60px' },
    { key: 'is_leader', label: '組長', type: 'checkbox', width: '50px' },
    { key: 'leave_status', label: '狀態', type: 'select', options: ['None', 'Maternal', 'Student', 'OnLeave'], width: '90px' },
    { key: 'is_active', label: '在職', type: 'checkbox', width: '50px' },
    { key: 'special_status', label: '工時', type: 'select', options: ['Standard', 'BiWeekly'], width: '90px' },
    { key: 'is_pregnant_or_nursing', label: '孕/哺乳', type: 'checkbox', width: '60px' },
    { key: 'can_night_shift', label: '夜班', type: 'checkbox', width: '50px' },
    { key: 'annual_leave_used', label: '已休特休', type: 'number', width: '70px',color:'black'},
    { key: 'accumulated_ot', label: '積假', type: 'number', width: '60px' },
    { key: 'night_shift_balance', label: '夜餘', type: 'number', width: '60px' },
  ];

  return (
    <div style={{ background: 'white', borderRadius: '16px', padding: '2rem', height: '80vh', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <h2 style={{ margin: 0 }}>員工資料管理 ({localStaff.length}人)</h2>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
          {/* ★ 新增：隱藏的檔案選擇器與匯入按鈕 */}
          <input 
            type="file" 
            accept=".csv" 
            ref={fileInputRef} 
            style={{ display: 'none' }} 
            onChange={handleImportCSV} 
          />
          <button onClick={() => fileInputRef.current.click()} style={{ padding: '0.5rem 1rem', background: '#3498db', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>
            📥 匯入 CSV
          </button>

          <button onClick={handleAddStaff} style={{ padding: '0.5rem 1rem', background: '#27ae60', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer' }}>+ 單筆新增</button>
          <button onClick={handleSave} disabled={!isDirty} style={{ padding: '0.5rem 2rem', background: isDirty ? '#e67e22' : '#ccc', color: 'white', border: 'none', borderRadius: '8px', cursor: isDirty ? 'pointer' : 'not-allowed', fontWeight: 'bold', boxShadow: isDirty ? '0 4px 10px rgba(230, 126, 34, 0.4)' : 'none' }}>{isDirty ? '💾 儲存變更' : '已同步'}</button>
        </div>
      </div>

      <div style={{ flex: 1, overflow: 'auto', border: '1px solid #eee', borderRadius: '8px' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '1300px' }}>
          <thead style={{ position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 1 }}>
            <tr>
              {columns.map(col => (
                <th key={col.key} style={{ padding: '12px', textAlign: 'left', borderBottom: '2px solid #ddd', minWidth: col.width, color: 'black', fontWeight: 'bold' }}>
                  {col.label}
                </th>
              ))}
              <th style={{ padding: '12px', borderBottom: '2px solid #ddd', width: '100px', color: 'black', fontWeight: 'bold', textAlign: 'center' }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {localStaff.map((staff) => (
              <tr key={staff.staff_id} style={{ borderBottom: '1px solid #f0f0f0', background: !staff.is_active ? '#fafafa' : 'white', opacity: !staff.is_active ? 0.7 : 1 }}>
                {columns.map(col => (
                  <td key={col.key} style={{ padding: '8px' }}>
                    {col.readOnly ? (
                      <span style={{ color: '#888', fontWeight: 'bold' }}>{staff[col.key]}</span>
                    ) : col.type === 'checkbox' ? (
                      <input type="checkbox" checked={staff[col.key] === true || staff[col.key] === 'True'} onChange={(e) => handleChange(staff.staff_id, col.key, e.target.checked)} style={{ width: '20px', height: '20px', cursor: 'pointer' }} />
                    ) : col.type === 'select' ? (
                      <select value={staff[col.key] || ''} onChange={(e) => handleChange(staff.staff_id, col.key, e.target.value)} style={{ padding: '6px', borderRadius: '4px', border: '1px solid #ddd', width: '100%' }}>{col.options.map(opt => <option key={opt} value={opt}>{opt === 'None' ? '--' : opt}</option>)}</select>
                    ) : col.type === 'streak_display' ? (
                      (() => {
                        // prevMonthLeave 按日期順序儲存：idx0=倒數第7天, idx6=最後一天
                        // 從尾端(最後一天)往前數，遇到休假或沒資料就停止
                        const leaves = staff[col.key];
                        // 沒有 prevMonthLeave 資料（未同步）→ 顯示 0
                        if (!leaves || leaves.length === 0) {
                          return <div style={{ textAlign: 'center', color: '#bbb', fontSize: '0.85rem' }}>—</div>;
                        }
                        let streak = 0;
                        for (let i = 6; i >= 0; i--) {
                          if (leaves[i] !== false) break; // 只有明確 false（上班）才繼續，其餘（true休假/undefined未知）都停止
                          streak++;
                        }
                        const isWarning = streak >= 6;
                        const isAlert = streak >= 5;
                        return (
                          <div style={{ textAlign: 'center' }}>
                            <div style={{
                              display: 'inline-block',
                              padding: '4px 12px',
                              borderRadius: '20px',
                              fontWeight: 'bold',
                              fontSize: '1.1rem',
                              background: isWarning ? '#fdecea' : (isAlert ? '#fff3e0' : '#e8f8f5'),
                              color: isWarning ? '#c0392b' : (isAlert ? '#e67e22' : '#27ae60'),
                              border: `1px solid ${isWarning ? '#f5c6cb' : (isAlert ? '#ffd8a8' : '#a9dfbf')}`
                            }}>
                              {streak}天
                            </div>
                            {isWarning && <div style={{ fontSize: '0.7rem', color: '#e74c3c', marginTop: '2px' }}>⚠️ 達上限</div>}
                          </div>
                        );
                      })()
                    ) : (
                      <input 
                        type={col.type} 
                        value={staff[col.key] ?? ''} 
                        onChange={(e) => handleChange(staff.staff_id, col.key, col.type === 'number' ? parseFloat(e.target.value) : e.target.value)} 
                        style={{ 
                          padding: '6px', borderRadius: '4px', border: '1px solid #ddd', width: '100%', 
                          background: col.key === 'name' ? '#fff' : 'transparent',
                          color: ['name', 'tenure_years', 'accumulated_ot', 'night_shift_balance','email','annual_leave_used'].includes(col.key) ? 'black' : 'inherit',
                          fontWeight: ['name', 'tenure_years', 'accumulated_ot', 'night_shift_balance','annual_leave_used'].includes(col.key) ? 'bold' : 'normal'
                        }} 
                      />
                    )}
                  </td>
                ))}
                
                {/* ★★★ 這裡是操作欄位 ★★★ */}
                <td style={{ padding: '8px', textAlign: 'center', whiteSpace: 'nowrap' }}>
                  {/* 新增：重置密碼按鈕 */}
                  <button onClick={() => handleResetPassword(staff.staff_id, staff.name)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#f39c12', fontSize: '1.3rem', marginRight: '10px' }} title="重置密碼為 1234">🔑</button>
                  {/* 原本：刪除按鈕 */}
                  <button onClick={() => handleDelete(staff.staff_id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#e74c3c', fontSize: '1.3rem' }} title="刪除員工">🗑️</button>
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
// 統計報表面板 (包含優先選班、健康度折線圖，與全新 AI 跨月報表分析)
// ============================================================================
const StatisticsPanel = ({ staffData, priorityConfig, setPriorityConfig, healthStats = [], accumulatedReports, setAccumulatedReports, calculateAndNotifyNextStaff }) => {
// =========================================================
  // ★★★ 新增：衛福部三班護病比大數據監控引擎 ★★★
  const [hospitalLevel, setHospitalLevel] = useState('MedicalCenter');
  const [unitBedCount, setUnitBedCount] = useState(50);

  const RATIO_STANDARDS = {
      MedicalCenter: { name: '醫學中心', D: 6, E: 9, N: 11 },
      Regional: { name: '區域醫院', D: 7, E: 11, N: 13 },
      District: { name: '地區醫院', D: 10, E: 13, N: 15 }
  };

  const calculateLatestRatio = () => {
      if (!accumulatedReports) return null;
      const months = Object.keys(accumulatedReports).sort();
      if (months.length === 0) return null;

      // 抓取最後一個月（最新結算）的大數據
      const latestMonthKey = months[months.length - 1];
      const latestData = accumulatedReports[latestMonthKey];
      if (!latestData) return null;

      let totalD = 0, totalE = 0, totalN = 0;
      let daysInMonth = 30;
      let parsedYear = new Date().getFullYear();
      let parsedMonth = new Date().getMonth() + 1;

      // 解析年月與天數
      const matchEN = latestMonthKey.match(/(\d{4})_(\d{1,2})/);
      if (matchEN) { parsedYear = Number(matchEN[1]); parsedMonth = Number(matchEN[2]); }
      daysInMonth = new Date(parsedYear, parsedMonth, 0).getDate() || 30;

      // ★ 修正版：從歷史班表 JSON 精算 (絕對不跳過 Dxxx 待認領的班)
      if (latestData.schedule_backup) {
          const schedule = latestData.schedule_backup;
          Object.keys(schedule).forEach(staffId => {
              for (let d = 1; d <= daysInMonth; d++) {
                  const cell = schedule[staffId]?.[d];
                  const type = (typeof cell === 'object' ? cell.type : cell) || 'OFF';
                  if (type === 'D') totalD++;
                  if (type === 'E') totalE++;
                  if (type === 'N') totalN++;
              }
          });
      // ★ 備用方案：從 Excel CSV 精算
      } else if (latestData.csv) {
          const lines = latestData.csv.split(/\r\n|\n/);
          for (let i = 1; i < lines.length; i++) {
              const cols = lines[i].split(',');
              if (cols.length >= 2 + daysInMonth) {
                  for(let j = 2; j < 2 + daysInMonth; j++) {
                      if (cols[j] === 'D') totalD++;
                      if (cols[j] === 'E') totalE++;
                      if (cols[j] === 'N') totalN++;
                  }
              }
          }
      } else { return null; }

      const avgD = totalD / daysInMonth;
      const avgE = totalE / daysInMonth;
      const avgN = totalN / daysInMonth;

      return {
          monthKey: latestMonthKey,
          daysInMonth,
          ratioD: avgD > 0 ? (unitBedCount / avgD).toFixed(1) : '∞',
          ratioE: avgE > 0 ? (unitBedCount / avgE).toFixed(1) : '∞',
          ratioN: avgN > 0 ? (unitBedCount / avgN).toFixed(1) : '∞',
          avgD: avgD.toFixed(1),
          avgE: avgE.toFixed(1),
          avgN: avgN.toFixed(1)
      };
  };
  const ratioResult = calculateLatestRatio();
  // =========================================================
  
// ★★★ 1. 把 AI 決策歷史的邏輯插在這裡 ★★★
  const [decisionLogs, setDecisionLogs] = useState([]);

  const fetchDecisionLogs = async () => {
      try {
          const q = query(collection(db, "AI_Decision_Logs"), orderBy("timestamp", "desc"), limit(5));
          const snap = await getDocs(q);
          setDecisionLogs(snap.docs.map(doc => ({ id: doc.id, ...doc.data() })));
      } catch (e) {
          console.error("讀取 AI 日誌失敗:", e);
      }
  };

  useEffect(() => { 
      fetchDecisionLogs(); 
  }, []);
  // 👇👇👇 ★★★ 1. 把你的「雷達監聽與跳過邏輯」貼在這裡 ★★★ 👇👇👇
  const [activeTurn, setActiveTurn] = useState(null);

  // 📡 即時監聽「目前輪到誰選班」
  useEffect(() => {
      const y = Number(localStorage.getItem('selectedYear')) || 2026;
      const m = Number(localStorage.getItem('selectedMonth')) || 2;
      const turnRef = doc(db, "SelectionTurn", `${y}_${m}`);

      const unsub = onSnapshot(turnRef, (docSnap) => {
          if (docSnap.exists()) {
              setActiveTurn(docSnap.data());
          } else {
              setActiveTurn(null);
          }
      });
      return () => unsub();
  }, []);

  // ⏭️ 強制跳過目前卡住的員工
  const handleForceSkip = async () => {
      if (!activeTurn?.active_staff_id) return;
      
      const targetStaffId = activeTurn.active_staff_id;
      const targetName = staffData.find(s => s.staff_id === targetStaffId)?.name || targetStaffId;

      if (!window.confirm(`🚨 確定要「強制跳過」 ${targetName} 嗎？\n\n這將剝奪他本回合的優先選班權，並立刻讓 AI 尋找下一位遞補者寄發 Email！`)) return;

      try {
          const y = Number(localStorage.getItem('selectedYear')) || 2026;
          const m = Number(localStorage.getItem('selectedMonth')) || 2;

          // 1. 將該名員工打入冷宮 (加入已送出黑名單)
          const progressRef = doc(db, "SelectionProgress", `${y}_${m}`);
          await setDoc(progressRef, {
              submitted_staff: arrayUnion(targetStaffId)
          }, { merge: true });

          // 2. 清除雷達畫面
          const turnRef = doc(db, "SelectionTurn", `${y}_${m}`);
          await setDoc(turnRef, { active_staff_id: null, updatedAt: new Date() });

          // 3. 呼叫 AI 找下一個人
          alert(`✅ 已跳過 ${targetName}！系統正在呼叫 AI 尋找下一位...`);
          if (typeof calculateAndNotifyNextStaff === 'function') {
              calculateAndNotifyNextStaff({}, healthStats, y, m);
          }
      } catch (error) {
          console.error("強制跳過失敗:", error);
          alert("❌ 操作失敗，請檢查網路連線。");
      }
  };
  // =========================================================
  // -- ★ AI 分析專用狀態 --
  const loadedMonths = Object.keys(accumulatedReports || {});
  const hasData = loadedMonths.length > 0;
  const [aiMessages, setAiMessages] = useState([{ role: 'assistant', content: '📊 【跨月大數據分析精靈】已就緒！\n只要您曾在「✅ 結算與歷史」面板匯出過 Excel，雲端就會自動記憶。\n您可以直接問我：「比較 2 月和 3 月的加班費差異」或「找出這幾個月請假最多的人」。' }]);
  const [aiInput, setAiInput] = useState('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const chatEndRef = useRef(null);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [aiMessages, isAnalyzing]);

  // -- (1) 計算統計數據 (優先選班用) --
  const calculateStats = (data, key) => {
    const validData = data.map(s => ({ ...s, value: Number(s[key]) || 0 })).sort((a, b) => b.value - a.value);
    const values = validData.map(d => d.value);
    if (values.length === 0) return { avg: 0, median: 0, top5: [], bottom5: [], allRank: [] };
    const sum = values.reduce((acc, curr) => acc + curr, 0);
    const avg = (sum / values.length).toFixed(1);
    const floorValues = values.map(v => Math.floor(v));
    const mid = Math.floor(floorValues.length / 2);
    const median = floorValues.length % 2 !== 0 ? floorValues[mid] : ((floorValues[mid - 1] + floorValues[mid]) / 2).toFixed(1);
    const top5 = [...validData].slice(0, 5); 
    const bottom5 = [...validData].reverse().slice(0, 5);
    return { avg, median, top5, bottom5, allRank: validData };
  };

  const otStats = calculateStats(staffData, 'accumulated_ot');
  const nightStats = calculateStats(staffData, 'night_shift_balance');

  const allowedStaffMap = new Map();
  if (priorityConfig.types.includes('accumulated_ot')) {
      otStats.allRank.slice(0, priorityConfig.count).forEach(s => allowedStaffMap.set(s.staff_id, { ...s, reason: 'OT' }));
  }
  if (priorityConfig.types.includes('night_shift_balance')) {
      nightStats.allRank.slice(0, priorityConfig.count).forEach(s => {
          if(allowedStaffMap.has(s.staff_id)) {
              allowedStaffMap.set(s.staff_id, { ...allowedStaffMap.get(s.staff_id), reason: 'OT & Night' });
          } else {
              allowedStaffMap.set(s.staff_id, { ...s, reason: 'Night' });
          }
      });
  }
  const priorityList = Array.from(allowedStaffMap.values());

  const RankingList = ({ title, data, color }) => (
    <div style={{ flex: 1, minWidth: '140px' }}>
      <div style={{ fontSize: '0.85rem', fontWeight: 'bold', color: '#666', marginBottom: '8px', borderBottom: '1px solid #eee', paddingBottom: '4px' }}>{title}</div>
      {data.map((s, i) => (
        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', marginBottom: '4px' }}>
          <span style={{ color: 'black' }}>{i + 1}. {s.name} <span style={{fontSize:'0.75rem', color:'#333'}}>({s.staff_id})</span></span>
          <span style={{ fontWeight: 'bold', color: color }}>{s.value}</span>
        </div>
      ))}
    </div>
  );

  // -- ★ 清空雲端記憶 --
  const handleClearMemory = async () => {
      if(window.confirm("⚠️ 確定要清空伺服器中的「所有」跨月報表嗎？\n\n這將刪除雲端上收集到的所有月份數據，AI 將會失去過去的記憶。")) {
          try {
              if (setAccumulatedReports) setAccumulatedReports({}); // 優先清空前端畫面
              await clearArchiveReports(); // 呼叫 Firebase 刪除 API
              setAiMessages([{ role: 'assistant', content: '🧹 雲端資料庫已清空！請至歷史面板重新匯出您想分析的月份。' }]);
          } catch (e) {
              alert("刪除失敗：" + e.message);
          }
      }
  };

  

  // -- ★ 呼叫 AI 進行跨月分析 --
  const handleAskAI = async () => {
      if (!aiInput.trim()) return;
      if (!hasData) return alert("⚠️ 雲端尚無任何報表資料！\n請先到「✅ 結算與歷史」匯出至少一個月的 Excel。");

      const userMsg = aiInput;
      setAiInput('');
      setIsAnalyzing(true);
      setAiMessages(prev => [...prev, { role: 'user', content: userMsg }]);

      try {
          const token = await auth.currentUser?.getIdToken();
          const formData = new FormData();
          
let combinedData = "";
          loadedMonths.forEach(month => {
              combinedData += `\n\n========== 【${month} 結算報表】 ==========\n`;
              // ★ 修改這裡，讓 AI 同時支援分析 CSV 與 JSON
              const fileData = accumulatedReports[month];
              if (fileData.csv) {
                  combinedData += fileData.csv;
              } else if (fileData.schedule_backup) {
                  combinedData += "本月尚未結算，以下為班表原始紀錄(JSON)：\n" + JSON.stringify(fileData.schedule_backup);
              }
          });
          // 偷塞底層跨月歷史總結給 AI
          const crossMonthContext = {
              staffAccumulatedHistory: staffData.map(s => ({ 
                  name: s.name, 
                  total_OT_Balance: s.accumulated_ot, 
                  total_Night_Balance: s.night_shift_balance
              })),
              healthTrends: healthStats
          };
          combinedData += `\n\n========== 【系統底層跨月歷史總結庫】 ==========\n${JSON.stringify(crossMonthContext)}`;

          // 偽裝成檔案送給後端
          const fileBlob = new Blob([combinedData], { type: 'text/plain' });
          formData.append('file', fileBlob, 'cross_month_big_data.txt');
          formData.append('prompt', userMsg);

          const response = await fetch('/api/analyze-excel', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${token}` },
              body: formData
          });

          if (!response.ok) throw new Error("伺服器分析失敗");
          const data = await response.json();
          setAiMessages(prev => [...prev, { role: 'assistant', content: data.text }]);

      } catch (error) {
          setAiMessages(prev => [...prev, { role: 'assistant', content: "❌ 錯誤：" + error.message }]);
      } finally {
          setIsAnalyzing(false);
      }
  };

// -- (2) 從 accumulatedReports (雲端大數據 CSV/JSON) 動態解析健康度 --
  const getDynamicHealthStats = () => {
      const stats = [];
      Object.entries(accumulatedReports || {}).forEach(([fileName, fileData]) => {
          if (!fileData) return;

          // 1. 解析年月 (優先使用資料庫自帶的 year/month 欄位，沒有才解析檔名)
          let year = fileData.year;
          let month = fileData.month;
          if (!year || !month) {
              const matchCH = fileName.match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
              const matchEN = fileName.match(/(\d{4})_(\d{1,2})/);
              if (matchCH) { year = Number(matchCH[1]); month = Number(matchCH[2]); } 
              else if (matchEN) { year = Number(matchEN[1]); month = Number(matchEN[2]); } 
              else return;
          }

          const daysInMonth = new Date(year, month, 0).getDate();
          const scores = [];

          // 狀況 A：這份檔案有 CSV 報表 (手動結算匯出的)
          if (fileData.csv && typeof fileData.csv === 'string') {
              const lines = fileData.csv.split(/\r\n|\n/);
              let headerIdx = -1, healthColIdx = -1;
              for (let i = 0; i < lines.length; i++) {
                  if (lines[i].includes('工號') && lines[i].includes('姓名')) {
                      headerIdx = i;
                      healthColIdx = lines[i].split(',').findIndex(c => c.includes('健康度評分'));
                      break;
                  }
              }
              if (headerIdx !== -1 && healthColIdx !== -1) {
                  for (let i = headerIdx + 1; i < lines.length; i++) {
                      const cols = lines[i].split(',');
                      if (cols.length > healthColIdx && cols[0] && !cols[0].startsWith('D')) {
                          const score = Number(cols[healthColIdx]);
                          if (!isNaN(score)) scores.push(score);
                      }
                  }
              }
          }

          // 狀況 B：沒有 CSV，但有 schedule_backup (系統自動備份的排班表)
          if (scores.length === 0 && fileData.schedule_backup) {
              Object.keys(fileData.schedule_backup).forEach(staffId => {
                  if (staffId.startsWith('D')) return; // 略過待認領
                  const staffSchedule = fileData.schedule_backup[staffId];
                  let score = 100;
                  const shifts = [];
                  for (let d = 1; d <= daysInMonth; d++) {
                      shifts.push((typeof staffSchedule[d] === 'object') ? (staffSchedule[d]?.type || 'OFF') : (staffSchedule[d] || 'OFF'));
                  }

                  // 執行核心扣分邏輯
                  const isWork = (s) => ['D', 'E', 'N', '支援'].includes(s) || (s && s.includes('OT'));
                  const isOff = (s) => ['OFF', 'RG', 'RC', '事假', '病假', '特休'].includes(s);

                  for (let i = 0; i < shifts.length - 1; i++) {
                      if ((shifts[i] === 'E' && shifts[i+1] === 'D') || (shifts[i] === 'N' && (shifts[i+1] === 'D' || shifts[i+1] === 'E'))) score -= 20;
                  }
                  let lastWork = null;
                  for (let i = 0; i < shifts.length; i++) {
                      if (isWork(shifts[i])) {
                          if (lastWork === 'N' && shifts[i] === 'E') score -= 10;
                          if (lastWork === 'E' && shifts[i] === 'D') score -= 10;
                          lastWork = shifts[i];
                      }
                  }
                  for (let i = 0; i <= shifts.length - 7; i++) {
                      const window = shifts.slice(i, i + 7);
                      const workTypes = new Set(window.filter(s => ['D', 'E', 'N'].includes(s)));
                      if (workTypes.size === 3) { score -= 15; i += 6; }
                  }
                  let consecutiveN = 0, consecutiveWork = 0;
                  for (let i = 0; i <= shifts.length; i++) {
                      const s = shifts[i];
                      if (s === 'N') consecutiveN++; else { if (consecutiveN >= 4) score -= 5; consecutiveN = 0; }
                      if (s && isWork(s)) consecutiveWork++; else { if (consecutiveWork >= 6) score -= 5; consecutiveWork = 0; }
                  }
                  for (let i = 1; i < shifts.length - 1; i++) {
                      if (isWork(shifts[i-1]) && isOff(shifts[i]) && isWork(shifts[i+1])) {
                          score -= 5;
                          if (shifts[i-1] === 'N') score -= 15;
                      }
                  }
                  let hasFullWeekendOff = false;
                  for (let d = 1; d <= daysInMonth - 1; d++) {
                      const date = new Date(year, month - 1, d);
                      if (date.getDay() === 6) { if (isOff(shifts[d-1]) && isOff(shifts[d])) { hasFullWeekendOff = true; break; } }
                  }
                  if (!hasFullWeekendOff) score -= 5;

                  scores.push(score);
              });
          }

          if (scores.length > 0) {
              const avg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
              scores.sort((a, b) => a - b);
              const mid = Math.floor(scores.length / 2);
              const median = scores.length % 2 !== 0 ? scores[mid] : Math.round((scores[mid - 1] + scores[mid]) / 2);
              stats.push({ year, month, avg, median });
          }
      });

      const uniqueStatsMap = {};
      stats.forEach(s => { uniqueStatsMap[`${s.year}-${s.month}`] = s; });
      const finalStats = Object.values(uniqueStatsMap);
      finalStats.sort((a, b) => (a.year - b.year) || (a.month - b.month));
      return finalStats.slice(-12);
  };

  // -- (3) 繪製健康度折線圖 --
  const renderLineChart = () => {
      // ★ 改由呼叫動態解析器獲取資料
      const dynamicHealthStats = getDynamicHealthStats();

      if (!dynamicHealthStats || dynamicHealthStats.length === 0) {
          return <div style={{ textAlign: 'center', padding: '3rem', color: '#888', background: '#f8f9fa', borderRadius: '12px', border: '2px dashed #ddd' }}>尚無健康度結算紀錄。<br/>只要「✅ 結算與歷史」中有封存班表，系統就會自動繪製！</div>;
      }
      const svgWidth = 800; const svgHeight = 350; const padding = 50;
      const chartWidth = svgWidth - padding * 2; const chartHeight = svgHeight - padding * 2;
      const allScores = dynamicHealthStats.flatMap(d => [d.avg, d.median]);
      const minScore = Math.max(0, Math.floor(Math.min(...allScores) / 5) * 5 - 5); 
      const maxScore = 100;
      const getX = (index) => padding + (index * (chartWidth / Math.max(1, dynamicHealthStats.length - 1)));
      const getY = (value) => padding + chartHeight - ((value - minScore) / (maxScore - minScore)) * chartHeight;

      const avgPoints = dynamicHealthStats.map((d, i) => `${getX(i)},${getY(d.avg)}`).join(' ');
      const medianPoints = dynamicHealthStats.map((d, i) => `${getX(i)},${getY(d.median)}`).join(' ');

      return (
          <svg viewBox={`0 0 ${svgWidth} ${svgHeight}`} style={{ width: '100%', height: 'auto', background: 'white', borderRadius: '12px', border: '1px solid #eee', boxShadow: '0 4px 6px rgba(0,0,0,0.05)' }}>
              {[0, 0.25, 0.5, 0.75, 1].map(ratio => {
                  const y = padding + chartHeight - (chartHeight * ratio);
                  const val = Math.round(minScore + (maxScore - minScore) * ratio);
                  return (
                      <g key={ratio}>
                          <line x1={padding} y1={y} x2={svgWidth - padding} y2={y} stroke="#ecf0f1" strokeDasharray="5 5" strokeWidth="1.5" />
                          <text x={padding - 10} y={y + 4} fontSize="12" fill="#7f8c8d" textAnchor="end">{val}</text>
                      </g>
                  );
              })}
              <polyline points={avgPoints} fill="none" stroke="#3498db" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
              <polyline points={medianPoints} fill="none" stroke="#e74c3c" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
              {dynamicHealthStats.map((d, i) => {
                  const x = getX(i); const yAvg = getY(d.avg); const yMed = getY(d.median);
                  const isAvgHigher = d.avg >= d.median;
                  return (
                      <g key={i}>
                          <circle cx={x} cy={yAvg} r="5" fill="#3498db" stroke="white" strokeWidth="2" />
                          <circle cx={x} cy={yMed} r="5" fill="#e74c3c" stroke="white" strokeWidth="2" />
                          <text x={x} y={svgHeight - padding + 25} fontSize="13" fill="#34495e" textAnchor="middle" fontWeight="bold">{`${d.year}/${d.month}`}</text>
                          {/* ★ 修正重疊問題：如果平均跟中位數一樣，就把紅藍數字上下錯開 */}
                          <text x={x} y={d.avg === d.median ? yAvg - 12 : (isAvgHigher ? yAvg - 12 : yAvg + 20)} fontSize="12" fill="#2980b9" textAnchor="middle" fontWeight="bold">{d.avg}</text>
                          <text x={x} y={d.avg === d.median ? yMed + 16 : (isAvgHigher ? yMed + 20 : yMed - 12)} fontSize="12" fill="#c0392b" textAnchor="middle" fontWeight="bold">{d.median}</text>
                      </g>
                  );
              })}
          </svg>
      );
  };

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:'20px' }}>
{/* ========================================================= */}
      {/* 🌟 1. 全新加入的：衛福部三班護病比寬螢幕面板 */}
      <div style={{ background: 'white', borderRadius: '16px', padding: '2rem', borderTop: '6px solid #e67e22', boxShadow: '0 10px 20px rgba(0,0,0,0.05)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '20px', marginBottom: '20px' }}>
              <div>
                  <h2 style={{ marginTop: 0, color: '#d35400', display: 'flex', alignItems: 'center', gap: '10px', fontSize: '1.6rem', marginBottom: '10px' }}>
                      ⚖️ 衛福部三班護病比法遵監控 
                      <span style={{ fontSize: '0.9rem', background: '#e67e22', color: 'white', padding: '4px 10px', borderRadius: '12px' }}>113年3月1日新制</span>
                  </h2>
                  <p style={{ margin: 0, color: '#7f8c8d', fontSize: '1rem', lineHeight: '1.5', maxWidth: '800px' }}>
                      為解決護理人力荒並留任人員，衛福部以「獎勵先行、逐步推動、引領標竿」三原則推動新制。此面板依據本單位<strong>「最新結算封存之歷史真實班表」</strong>，自動精算每日平均人力，檢測是否合規，協助應對護理全聯會之實施現況調查。
                  </p>
              </div>

              {/* 參數設定區 */}
              <div style={{ background: '#fdf2e9', padding: '15px 20px', borderRadius: '12px', border: '1px solid #fae5d3', display: 'flex', flexDirection: 'column', gap: '10px', minWidth: '250px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <label style={{ fontWeight: 'bold', color: '#d35400' }}>醫院層級：</label>
                      <select value={hospitalLevel} onChange={(e) => setHospitalLevel(e.target.value)} style={{ padding: '6px', borderRadius: '6px', border: '1px solid #e67e22', background: 'white', color: '#d35400', fontWeight: 'bold' }}>
                          <option value="MedicalCenter">醫學中心</option>
                          <option value="Regional">區域醫院</option>
                          <option value="District">地區醫院</option>
                      </select>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <label style={{ fontWeight: 'bold', color: '#d35400' }}>單位總床數：</label>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                          <input type="number" value={unitBedCount} onChange={(e) => setUnitBedCount(Number(e.target.value))} style={{ width: '70px', padding: '6px', borderRadius: '6px', border: '1px solid #e67e22', textAlign: 'center', fontWeight: 'bold' }} />
                          <span style={{ color: '#d35400', fontWeight: 'bold' }}>床</span>
                      </div>
                  </div>
              </div>
          </div>

          {/* 檢測結果區塊 */}
          {!ratioResult ? (
              <div style={{ textAlign: 'center', padding: '30px', color: '#95a5a6', background: '#f1f2f6', borderRadius: '12px', border: '2px dashed #ddd', fontSize: '1.1rem' }}>
                  尚無大數據資料，請先至「✅ 結算與歷史」面板封存至少一個月的班表。
              </div>
          ) : (
              <div>
                  <div style={{ marginBottom: '15px', fontSize: '1.1rem', color: '#2980b9', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '8px' }}>
                      📊 分析樣本：最新雲端報表 ({ratioResult.monthKey.replace('_', '年')}月) 
                  </div>
                  <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
                      {['D', 'E', 'N'].map(shift => {
                          const shiftName = shift === 'D' ? '白班' : shift === 'E' ? '小夜' : '大夜';
                          const avgNurses = ratioResult[`avg${shift}`];
                          const ratioVal = Number(ratioResult[`ratio${shift}`]);
                          const limit = RATIO_STANDARDS[hospitalLevel][shift];
                          
                          // 若超過衛福部規範，或是排班人數為 0，都判定為違規
                          const isViolated = ratioVal > limit || isNaN(ratioVal);

                          return (
                              <div key={shift} style={{ flex: 1, minWidth: '280px', background: isViolated ? '#fff5f5' : '#f0fdf4', border: `2px solid ${isViolated ? '#fc8181' : '#68d391'}`, padding: '20px', borderRadius: '16px', display: 'flex', flexDirection: 'column', alignItems: 'center', position: 'relative', transition: 'all 0.3s' }}>
                                  
                                  <div style={{ fontSize: '1.4rem', fontWeight: 'bold', color: isViolated ? '#c53030' : '#276749', marginBottom: '10px' }}>
                                      {shiftName} 護病比
                                  </div>
                                  
                                  <div style={{ fontSize: '3rem', fontWeight: '900', color: isViolated ? '#e53e3e' : '#38a169', marginBottom: '15px', textShadow: '1px 1px 2px rgba(0,0,0,0.1)' }}>
                                      1 : {ratioResult[`ratio${shift}`]}
                                  </div>
                                  
                                  <div style={{ fontSize: '1rem', color: '#4a5568', marginBottom: '15px', background: 'white', padding: '5px 15px', borderRadius: '20px', border: '1px solid #cbd5e0' }}>
                                      平均每日 <strong>{avgNurses}</strong> 人上班
                                  </div>
                                  
                                  <div style={{ width: '100%', textAlign: 'center', background: isViolated ? '#fed7d7' : '#c6f6d5', color: isViolated ? '#c53030' : '#276749', padding: '12px', borderRadius: '10px', fontSize: '1rem', fontWeight: 'bold' }}>
                                      {isViolated ? `⚠️ 違反新制 (上限 1:${limit})` : `✅ 符合新制 (上限 1:${limit})`}
                                  </div>
                              </div>
                          );
                      })}
                  </div>
              </div>
          )}
      </div>
      {/* ========================================================= */}
      
{/* 👇👇👇 ★★★ 2. 替換這整個區塊 ★★★ 👇👇👇 */}
      {/* 🚀 AI 接力選班監控中心 (含雷達與棄權) */}
      <div style={{ background: 'white', borderRadius: '16px', padding: '1.5rem', borderLeft:'5px solid #2980b9', boxShadow: '0 4px 10px rgba(0,0,0,0.05)' }}>
          <div style={{display:'flex', justifyContent:'space-between', alignItems:'flex-start', flexWrap:'wrap', gap:'20px'}}>
             <div style={{ flex: 1, minWidth: '300px' }}>
                 <h2 style={{ margin: '0 0 10px 0', color: '#2c3e50', fontSize:'1.4rem', display: 'flex', alignItems: 'center', gap: '8px' }}>
                     🚀 AI 接力選班引擎與監控雷達
                 </h2>
                 <p style={{ margin: '0 0 15px 0', color: '#7f8c8d', fontSize:'0.9rem' }}>
                     一鍵啟動自動化接力，AI 將依據大數據自動判斷順位並寄發 Email。<br/>
                     若遇同仁遲遲未認領卡住流程，可使用強制跳過功能。
                 </p>

                 {/* 📡 雷達顯示器 */}
                 <div style={{ background: activeTurn?.active_staff_id ? '#e8f8f5' : '#f8f9fa', border: `1px solid ${activeTurn?.active_staff_id ? '#2ecc71' : '#ddd'}`, padding: '15px', borderRadius: '12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                     <div>
                         <div style={{ fontSize: '0.85rem', color: '#7f8c8d', fontWeight: 'bold', marginBottom: '5px' }}>目前發球權 (Waiting for...)</div>
                         {activeTurn?.active_staff_id ? (
                             <div style={{ fontSize: '1.2rem', color: '#27ae60', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '8px' }}>
                                 <span style={{ animation: 'pulse 2s infinite' }}>⏳</span>
                                 等待 {staffData.find(s => s.staff_id === activeTurn.active_staff_id)?.name || activeTurn.active_staff_id} 認領中...
                             </div>
                         ) : (
                             <div style={{ fontSize: '1.1rem', color: '#95a5a6', fontWeight: 'bold' }}>⏸️ 引擎待機中 / 或已全數選完</div>
                         )}
                     </div>
{/* ⏭️ 強制跳過按鈕 (只有當雷達有人時才顯示) */}
                     {activeTurn?.active_staff_id && (
                         <button onClick={handleForceSkip} style={{ padding: '8px 15px', background: '#fff', color: '#e74c3c', border: '2px solid #e74c3c', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer', transition: 'all 0.2s', boxShadow: '0 2px 4px rgba(231,76,60,0.1)' }}>
                             ⏭️ 逾時強制跳過
                         </button>
                     )}
                 </div>

                 {/* 🧠 新增：給 AI 的客製化指令 */}
                 <div style={{ marginTop: '15px' }}>
                     <label style={{ fontSize: '0.9rem', color: '#2c3e50', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '5px' }}>
                         🧠 給 AI 的選班優先條件 (選填)
                     </label>
                     <input 
                         type="text" 
                         value={priorityConfig?.relayInstruction || ''} 
                         onChange={(e) => setPriorityConfig({...priorityConfig, relayInstruction: e.target.value})}
                         placeholder="例如：女性優先、年資高優先... (若留空則預設找最疲勞者)"
                         style={{ width: '100%', padding: '10px', marginTop: '5px', borderRadius: '8px', border: '1px solid #ddd', boxSizing: 'border-box' }}
                     />
                 </div>
             </div>
             
             <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                 <button 
                    onClick={() => {
                       if(window.confirm("確定要手動啟動第一棒嗎？\n系統將自動發送 Email 給最需要補血的第一位同仁。")) {
                           const y = Number(localStorage.getItem('selectedYear')) || 2026;
                           const m = Number(localStorage.getItem('selectedMonth')) || 2;
                           if (typeof calculateAndNotifyNextStaff === 'function') {
                               calculateAndNotifyNextStaff({}, healthStats, y, m);
                               alert("🚀 引擎已啟動！AI 正在背景運算並發送通知...");
                           }
                       }
                    }} 
                    style={{ padding:'12px 25px', borderRadius:'8px', border:'none', cursor:'pointer', fontWeight:'bold', background: '#3498db', color:'white', fontSize: '1.1rem', boxShadow: '0 4px 6px rgba(52, 152, 219, 0.3)' }}
                 >
                    ▶️ 啟動 / 重啟自動接力
                 </button>
             </div>
          </div>
      </div>
      {/* 👆👆👆 ★★★ 替換結束 ★★★ 👆👆👆 */}
        
        {/* ★★★ 2. 把 AI 決策歷史看板 UI 插在這裡 ★★★ */}
      <div style={{ background: 'white', borderRadius: '16px', padding: '1.5rem', borderLeft: '5px solid #3498db', boxShadow: '0 4px 10px rgba(0,0,0,0.05)' }}>
          <h3 style={{ marginTop: 0, color: '#2c3e50', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '1.3rem' }}>
              <FileText size={20} color="#3498db" /> AI 決策歷史看板 (最近 5 筆)
          </h3>
          <div style={{ display: 'grid', gap: '15px', marginTop: '15px' }}>
              {decisionLogs.length === 0 ? (
                  <div style={{ padding: '20px', textAlign: 'center', color: '#95a5a6', background: '#f8f9fa', borderRadius: '12px' }}>
                      暫無 AI 決策數據
                  </div>
              ) : decisionLogs.map(log => (
                  <div key={log.id} style={{ background: '#fff', border: '1px solid #ecf0f1', padding: '15px', borderRadius: '12px', boxShadow: '0 2px 5px rgba(0,0,0,0.02)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                          <strong style={{ color: '#e67e22' }}>🎯 優先選班者：{log.selected_staff}</strong>
                          <span style={{ fontSize: '0.8rem', color: '#95a5a6' }}>
                              {log.timestamp?.toDate ? log.timestamp.toDate().toLocaleString() : '時間載入中...'}
                          </span>
                      </div>
                      <div style={{ fontSize: '0.9rem', color: '#34495e', lineHeight: '1.5', background: '#f1f2f6', padding: '10px', borderRadius: '8px' }}>
                          <strong>🤖 AI 判斷邏輯：</strong><br/>
                          {log.ai_logic}
                      </div>
                  </div>
              ))}
          </div>
      </div>
     {/* ★★★ 插入結束 ★★★ */}

      {/* ========================================================= */}
      {/* ★★★ 新增：衛福部三班護病比法遵監控面板 ★★★ */}
      <div style={{ background: 'white', borderRadius: '16px', padding: '1.5rem', borderLeft: '5px solid #e67e22', boxShadow: '0 4px 10px rgba(0,0,0,0.05)' }}>
          <h3 style={{ marginTop: 0, color: '#d35400', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '1.3rem' }}>
              ⚖️ 衛福部三班護病比法遵監控 
              <span style={{ fontSize: '0.8rem', background: '#fdf2e9', color: '#e67e22', padding: '4px 8px', borderRadius: '8px', border: '1px solid #fae5d3' }}>113年3月1日新制</span>
          </h3>
          <p style={{ margin: '0 0 15px 0', color: '#7f8c8d', fontSize: '0.9rem', lineHeight: '1.5' }}>
              為解決護理人力荒並留任人員，衛福部以「獎勵先行」、「逐步推動」及「引領標竿」三原則推動新制。此面板將依據本單位<strong>「最近一次結算封存之歷史真實班表」</strong>，自動精算每日平均人力，檢測是否合規，協助應對護理全聯會之實施現況調查。
          </p>

          {/* 參數設定區 */}
          <div style={{ display: 'flex', gap: '15px', marginBottom: '20px', background: '#f8f9fa', padding: '15px', borderRadius: '8px', border: '1px solid #ddd' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <label style={{ fontWeight: 'bold', color: '#2c3e50' }}>醫院層級：</label>
                  <select value={hospitalLevel} onChange={(e) => setHospitalLevel(e.target.value)} style={{ padding: '8px', borderRadius: '6px', border: '1px solid #ccc' }}>
                      <option value="MedicalCenter">醫學中心 (D 1:6 | E 1:9 | N 1:11)</option>
                      <option value="Regional">區域醫院 (D 1:7 | E 1:11 | N 1:13)</option>
                      <option value="District">地區醫院 (D 1:10 | E 1:13 | N 1:15)</option>
                  </select>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <label style={{ fontWeight: 'bold', color: '#2c3e50' }}>單位總床數：</label>
                  <input type="number" value={unitBedCount} onChange={(e) => setUnitBedCount(Number(e.target.value))} style={{ width: '80px', padding: '8px', borderRadius: '6px', border: '1px solid #ccc', textAlign: 'center', fontWeight: 'bold' }} />
                  <span style={{ color: '#7f8c8d' }}>床</span>
              </div>
          </div>

          {/* 檢測結果區 */}
          {!ratioResult ? (
              <div style={{ textAlign: 'center', padding: '20px', color: '#95a5a6', background: '#f1f2f6', borderRadius: '8px' }}>
                  尚無結算資料，請先至「✅ 結算與歷史」面板封存至少一個月的班表。
              </div>
          ) : (
              <div>
                  <div style={{ marginBottom: '10px', fontSize: '0.95rem', color: '#2980b9', fontWeight: 'bold' }}>
                      📊 數據來源：最新結算真實報表 ({ratioResult.monthKey.replace('_', '年')}月) 
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '15px' }}>
                      {['D', 'E', 'N'].map(shift => {
                          const shiftName = shift === 'D' ? '白班' : shift === 'E' ? '小夜' : '大夜';
                          const avgNurses = ratioResult[`avg${shift}`];
                          const ratioVal = Number(ratioResult[`ratio${shift}`]);
                          const limit = RATIO_STANDARDS[hospitalLevel][shift];
                          
                          // 若超過衛福部規範，或是排班人數為 0 (導致比例為 NaN/Infinity)，都判定為違規
                          const isViolated = ratioVal > limit || isNaN(ratioVal);

                          return (
                              <div key={shift} style={{ background: isViolated ? '#fff5f5' : '#f0fdf4', border: `2px solid ${isViolated ? '#fc8181' : '#68d391'}`, padding: '15px', borderRadius: '12px', position: 'relative' }}>
                                  <div style={{ fontSize: '1.1rem', fontWeight: 'bold', color: isViolated ? '#c53030' : '#276749', marginBottom: '5px' }}>
                                      {shiftName} 護病比
                                  </div>
                                  <div style={{ fontSize: '2rem', fontWeight: '900', color: isViolated ? '#e53e3e' : '#38a169', marginBottom: '10px' }}>
                                      1 : {ratioResult[`ratio${shift}`]}
                                  </div>
                                  <div style={{ fontSize: '0.85rem', color: '#4a5568', marginBottom: '10px' }}>
                                      (平均每日 {avgNurses} 人上班)
                                  </div>
                                  
                                  {isViolated ? (
                                      <div style={{ background: '#fed7d7', color: '#c53030', padding: '8px', borderRadius: '6px', fontSize: '0.85rem', fontWeight: 'bold' }}>
                                          ⚠️ 違反衛福部新制<br/>({RATIO_STANDARDS[hospitalLevel].name} 上限 1:{limit})
                                      </div>
                                  ) : (
                                      <div style={{ background: '#c6f6d5', color: '#276749', padding: '8px', borderRadius: '6px', fontSize: '0.85rem', fontWeight: 'bold' }}>
                                          ✅ 符合衛福部新制<br/>(安全上限 1:{limit})
                                      </div>
                                  )}
                              </div>
                          );
                      })}
                  </div>
              </div>
          )}
      </div>
      {/* ========================================================= */}

      {/* 2. 健康度趨勢圖 */}
      <div style={{ background: '#fdfdfd', padding: '1.5rem', borderRadius: '16px', border: '1px solid #e0e0e0', boxShadow: '0 4px 6px rgba(0,0,0,0.02)' }}>
          <h3 style={{ marginTop: 0, color: '#34495e', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '8px' }}>📈 過去 12 個月班表健康度趨勢</h3>
          {renderLineChart()}
      </div>

      {/* 3. ★★★ 全新 AI 跨月報表分析區塊 ★★★ */}
      <div style={{ background: 'white', borderRadius: '16px', padding: '2rem', borderTop: '6px solid #8e44ad', boxShadow: '0 10px 20px rgba(142,68,173,0.1)' }}>
        <h2 style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', color: '#8e44ad', marginTop: 0, marginBottom: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>🤖 AI 跨月數據分析精靈</div>
          {hasData && (
              <button onClick={handleClearMemory} style={{ fontSize:'0.85rem', padding: '6px 15px', background: '#e74c3c', color: 'white', border: 'none', borderRadius: '20px', cursor: 'pointer', fontWeight: 'bold' }}>
                  🧹 清空雲端記憶體
              </button>
          )}
        </h2>

        {/* 多月連線狀態燈號 */}
        <div style={{ background: '#f8f9fa', padding: '15px', borderRadius: '12px', border: '2px dashed #dcdde1', marginBottom: '20px', display: 'flex', alignItems: 'center', gap: '15px' }}>
            {hasData ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '15px', width: '100%' }}>
                    <span style={{ fontSize: '2rem', animation: 'pulse 2s infinite' }}>🟢</span>
                    <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 'bold', color: '#27ae60', fontSize: '1.1rem', marginBottom: '5px' }}>雲端已載入 {loadedMonths.length} 個月份的大數據</div>
                        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                            {loadedMonths.map(m => <span key={m} style={{ background: '#e8f8f5', color: '#16a085', padding: '4px 12px', borderRadius: '12px', fontSize: '0.85rem', fontWeight: 'bold', border: '1px solid #1abc9c' }}>{m}</span>)}
                        </div>
                    </div>
                </div>
            ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <span style={{ fontSize: '1.8rem' }}>🔴</span>
                    <div>
                        <div style={{ fontWeight: 'bold', color: '#e74c3c', fontSize: '1.1rem' }}>雲端尚未取得任何報表</div>
                        <div style={{ fontSize: '0.85rem', color: '#666' }}>請先至「✅ 結算與歷史」面板，切換您要的月份並點擊【📥 匯出 Excel】上傳至雲端。</div>
                    </div>
                </div>
            )}
        </div>

        {/* 對話區 */}
        <div style={{ background: '#f1f2f6', borderRadius: '12px', padding: '15px', border: '1px solid #e1e2e6' }}>
            <div style={{ height: '300px', overflowY: 'auto', marginBottom: '15px', paddingRight: '10px' }}>
                {aiMessages.map((m, i) => (
                    <div key={i} style={{ marginBottom: '1rem', textAlign: m.role === 'user' ? 'right' : 'left' }}>
                        <div style={{ display: 'inline-block', padding: '12px 18px', borderRadius: '12px', background: m.role === 'user' ? '#8e44ad' : 'white', color: m.role === 'user' ? 'white' : '#2c3e50', border: m.role === 'assistant' ? '1px solid #dcdde1' : 'none', maxWidth: '85%', whiteSpace: 'pre-wrap', textAlign: 'left', fontSize: '0.95rem', lineHeight: '1.5', boxShadow: '0 2px 5px rgba(0,0,0,0.05)' }}>
                            {m.content}
                        </div>
                    </div>
                ))}
                {isAnalyzing && (
                    <div style={{ textAlign: 'left', marginBottom: '1rem' }}>
                        <div style={{ display: 'inline-block', padding: '12px 18px', borderRadius: '12px', background: 'white', border: '1px solid #dcdde1', color: '#888', fontStyle: 'italic' }}>
                            ⏳ AI 正在雲端交叉比對這 {loadedMonths.length} 個月的數據...
                        </div>
                    </div>
                )}
                <div ref={chatEndRef} />
            </div>

            {/* 輸入區 */}
            <div style={{ display: 'flex', gap: '10px' }}>
                <input 
                    value={aiInput} 
                    onChange={(e) => setAiInput(e.target.value)} 
                    onKeyPress={(e) => e.key === 'Enter' && handleAskAI()} 
                    placeholder={hasData ? `可以問：「比較 ${loadedMonths[0]} 和另外幾個月的請假狀況」...` : "等待雲端載入資料..."} 
                    disabled={!hasData || isAnalyzing}
                    style={{ flex: 1, padding: '14px', borderRadius: '8px', border: '1px solid #dcdde1', color: 'white', fontSize: '1rem', boxShadow: 'inset 0 1px 3px rgba(253, 247, 247, 0.05)' }} 
                />
                <button 
                    onClick={handleAskAI} 
                    disabled={!hasData || isAnalyzing} 
                    style={{ padding: '0 30px', background: (!hasData || isAnalyzing) ? '#bdc3c7' : '#8e44ad', color: 'white', border: 'none', borderRadius: '8px', cursor: (!hasData || isAnalyzing) ? 'not-allowed' : 'pointer', fontWeight: 'bold', fontSize: '1.05rem', boxShadow: '0 4px 6px rgba(0,0,0,0.1)' }}
                >
                    送出分析
                </button>
            </div>
        </div>
      </div>
      
    </div>
  );
};

// ============================================================================
// ✅ 結算與歷史大帳本面板 (ScheduleReviewPanel)
// ============================================================================
const ScheduleReviewPanel = ({ 
  staffData, setStaffData, 
  shiftOptions, setShiftOptions, 
  publicHolidays = [],
  onUpdateHealthStats,
  // ★ 接收專屬的歷史狀態
  setHistorySchedule,
  historyYear, historyMonth, setHistoryYear, setHistoryMonth,
    historySchedule = {}, 
}) => {
    // ★ 加這兩行防呆，避免 undefined 傳進來導致 NaN crash
  const safeYear  = historyYear  || new Date().getFullYear();
  const safeMonth = historyMonth || (new Date().getMonth() === 0 ? 12 : new Date().getMonth());
  const daysInMonth = new Date(historyYear, historyMonth, 0).getDate();
  const daysArray = Array.from({length: daysInMonth}, (_,i)=>i+1);

  const [showAddOption, setShowAddOption] = useState(false);
  const [newOption, setNewOption] = useState({ code: '', name: '', color: '#cccccc' });
 const [showSettlement, setShowSettlement] = useState(false);



  
  const [baseSalary, setBaseSalary] = useState(() => {
      const saved = localStorage.getItem('globalBaseSalary');
      return saved ? Number(saved) : 40000;
  });

  useEffect(() => { localStorage.setItem('globalBaseSalary', baseSalary); }, [baseSalary]);

  // ★★★ 自動同步：結算月份變更且班表載入後，靜默更新員工 prevMonthLeave ★★★
  // 用 ref 記錄「上次已同步的月份」，避免重複覆蓋
  const lastSyncedMonthRef = useRef(null);

  useEffect(() => {
    if (!historySchedule || Object.keys(historySchedule).length === 0) return;
    if (!setStaffData) return;

    const monthKey = `${historyYear}-${historyMonth}`;
    // 同一個月份已同步過就不重複執行
    if (lastSyncedMonthRef.current === monthKey) return;
    lastSyncedMonthRef.current = monthKey;

    const daysInThisMonth = new Date(historyYear, historyMonth, 0).getDate();
    // 按日期順序存：idx0=倒數第7天, idx6=月底最後一天
    const last7Days = Array.from({ length: 7 }, (_, i) => daysInThisMonth - 6 + i);

    const isLeaveShift = (shift) => {
      if (!shift) return true;
      const s = typeof shift === 'object' ? (shift?.type || 'OFF') : shift;
      return ['OFF', 'RG', 'RC', '事假', '病假', '特休'].includes(s);
    };

    setStaffData(prevData =>
      prevData.map(staff => {
        // Step 1: 先清空（避免舊資料殘留）
        const cleared = { ...staff, prevMonthLeave: null };
        // Step 2: 只有在 historySchedule 裡有這位員工的班表才寫入
        const staffSchedule = historySchedule[staff.staff_id];
        if (!staffSchedule) return cleared;
        const newPrevMonthLeave = last7Days.map(day => isLeaveShift(staffSchedule[day]));
        return { ...cleared, prevMonthLeave: newPrevMonthLeave };
      })
    );
  }, [historySchedule, historyYear, historyMonth]);

  // -- 健康度評分引擎 --
  const calculateHealthScore = (staffSchedule) => {
      let score = 100;
      const deductions = [];
      const shifts = []; 
      for (let d = 1; d <= daysInMonth; d++) {
          const cell = staffSchedule[d];
          shifts.push((typeof cell === 'object') ? (cell?.type || 'OFF') : (cell || 'OFF'));
      }
      const isWork = (s) => ['D', 'E', 'N', '支援'].includes(s) || (s && s.includes('OT'));
      const isOff = (s) => ['OFF', 'RG', 'RC', '事假', '病假', '特休'].includes(s);

      for (let i = 0; i < shifts.length - 1; i++) {
          if ((shifts[i] === 'E' && shifts[i+1] === 'D') || (shifts[i] === 'N' && (shifts[i+1] === 'D' || shifts[i+1] === 'E'))) { score -= 20; deductions.push(`[-20] 短間隔`); }
      }
      let lastWork = null;
      for (let i = 0; i < shifts.length; i++) {
          if (isWork(shifts[i])) {
              if (lastWork === 'N' && shifts[i] === 'E') { score -= 10; deductions.push(`[-10] 逆時鐘 N接E`); }
              if (lastWork === 'E' && shifts[i] === 'D') { score -= 10; deductions.push(`[-10] 逆時鐘 E接D`); }
              lastWork = shifts[i];
          }
      }
      for (let i = 0; i <= shifts.length - 7; i++) {
          const window = shifts.slice(i, i + 7);
          const workTypes = new Set(window.filter(s => ['D', 'E', 'N'].includes(s)));
          if (workTypes.size === 3) { score -= 15; deductions.push(`[-15] 花花班`); i += 6; }
      }
      let consecutiveN = 0, consecutiveWork = 0;
      for (let i = 0; i <= shifts.length; i++) {
          const s = shifts[i];
          if (s === 'N') consecutiveN++; else { if (consecutiveN >= 4) { score -= 5; deductions.push(`[-5] 連續大夜過長`); } consecutiveN = 0; }
          if (s && isWork(s)) consecutiveWork++; else { if (consecutiveWork >= 6) { score -= 5; deductions.push(`[-5] 連六疲勞`); } consecutiveWork = 0; }
      }
      for (let i = 1; i < shifts.length - 1; i++) {
          if (isWork(shifts[i-1]) && isOff(shifts[i]) && isWork(shifts[i+1])) {
              score -= 5; deductions.push(`[-5] 孤立休假`);
              if (shifts[i-1] === 'N') { score -= 15; deductions.push(`[-15] 大夜後無連休`); }
          }
      }
      let hasFullWeekendOff = false;
      for (let d = 1; d <= daysInMonth - 1; d++) {
          const date = new Date(historyYear, historyMonth - 1, d);
          if (date.getDay() === 6) { if (isOff(shifts[d-1]) && isOff(shifts[d])) { hasFullWeekendOff = true; break; } }
      }
      if (!hasFullWeekendOff) { score -= 5; deductions.push(`[-5] 週末零休假`); }

      return { score, deductions };
  };

  const handleOpenSettlement = () => {
      const scores = [];
      Object.keys(historySchedule).forEach(rowId => {
          if (!rowId.startsWith('D')) {
             const { score } = calculateHealthScore(historySchedule[rowId]);
             scores.push(score);
          }
      });
      let avg = 0, median = 0;
      if (scores.length > 0) {
          avg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
          scores.sort((a, b) => a - b);
          const mid = Math.floor(scores.length / 2);
          median = scores.length % 2 !== 0 ? scores[mid] : Math.round((scores[mid - 1] + scores[mid]) / 2);
      }
      if (onUpdateHealthStats) onUpdateHealthStats(historyYear, historyMonth, avg, median);
      setShowSettlement(true);
  };

  const handleAddOption = () => {
    if (!newOption.code || !newOption.name) return alert("請輸入代號與名稱！");
    if (shiftOptions.find(o => o.code === newOption.code)) return alert("此代號已存在！");
    setShiftOptions([...shiftOptions, { ...newOption, time: '' }]);
    setNewOption({ code: '', name: '', color: '#cccccc' });
  };
  
  const handleDeleteOption = (code) => { 
      if(window.confirm(`確定要刪除班別「${code}」嗎？`)) setShiftOptions(shiftOptions.filter(o => o.code !== code)); 
  };
  
const handleCellChange = async (staffId, day, newValue) => {
      // === RG 絕對防護罩 (針對 historySchedule) ===
      const currentCell = historySchedule[staffId]?.[day];
      const currentValue = (typeof currentCell === 'object') ? currentCell?.type : currentCell;
      const workShifts = ['D', 'E', 'N', '支援', 'OT']; 
      if (currentValue === 'RG' && workShifts.some(shift => newValue.includes(shift))) {
          alert('🚨 勞基法天條攔截：\n「例假 (RG)」絕對禁止出勤！\n\n系統已強制阻擋您將 RG 變更為上班班別。');
          return; 
      }
      // =========================================

      const newSchedule = JSON.parse(JSON.stringify(historySchedule));
      if (!newSchedule[staffId]) newSchedule[staffId] = {};
      newSchedule[staffId][day] = { ...(typeof newSchedule[staffId][day] === 'object' ? newSchedule[staffId][day] : {}), type: newValue };
      setHistorySchedule(newSchedule);

      // 同步寫入 Firebase 雲端
      try {
          await updateStaffSchedule(historyYear, historyMonth, newSchedule);
      } catch (e) {
          console.error("同步歷史班表失敗", e);
      }
  };

  // --- 抓取結算數據 ---
  const getSettlementData = () => {
      const data = [];
      const currentBaseSalary = Number(baseSalary) || 0; 
      const dailyWage = Math.round(currentBaseSalary / 30);
      const hourlyWage = Math.round(dailyWage / 8); 

      Object.keys(historySchedule || {}).forEach(rowId => {
          if (rowId.startsWith('D')) return; 
          const staff = staffData.find(s => s.staff_id === rowId);
          const name = (staff && staff.name && staff.name.trim() !== '') ? staff.name : '未知姓名'; 
          
          let workDays = 0, nationalHolidayWorkDays = 0, explicitOtDays = 0; 
          let personalLeaveDays = 0, sickLeaveDays = 0, annualLeaveDays = 0; // ★ 加入 annualLeaveDays
          let nightShiftsCount = 0;

          for (let d = 1; d <= daysInMonth; d++) {
              const cell = historySchedule[rowId]?.[d];
              const type = (typeof cell === 'object') ? cell.type : (cell || 'OFF');
              const dateStr = `${historyYear}${String(historyMonth).padStart(2, '0')}${String(d).padStart(2, '0')}`;
              const isNationalHoliday = publicHolidays.includes(dateStr);

              if (['D', 'E', 'N', '支援'].includes(type)) {
                  workDays++;
                  if (isNationalHoliday) nationalHolidayWorkDays++;
                  if (type === 'N') nightShiftsCount++;
              }
              else if (type.includes('(OT)')) explicitOtDays++;
              else if (type === '事假') personalLeaveDays++;
              else if (type === '病假') sickLeaveDays++;
              else if (type === '特休') annualLeaveDays++; // ★ 結算特休天數
          }

          const nationalHolidayPay = nationalHolidayWorkDays * (hourlyWage * 8);
          const regularWorkDays = workDays - nationalHolidayWorkDays;
          const standardWorkDays = daysInMonth - 8;
          const overStandardDays = Math.max(0, regularWorkDays - standardWorkDays);
          const totalRestOtDays = overStandardDays + explicitOtDays;
          const restDayOtPayPerDay = Math.round((hourlyWage * 1.34 * 2) + (hourlyWage * 1.67 * 6));
const restDayOtPay = totalRestOtDays * restDayOtPayPerDay;
          const totalOtPay = restDayOtPay + nationalHolidayPay;
          const deduction = Math.round((personalLeaveDays * dailyWage) + (sickLeaveDays * dailyWage * 0.5));
          
          // ★★★ 新增：大夜班 40% 加給 (日薪 * 40% * 大夜天數) ★★★
          const nightShiftBonus = Math.round(dailyWage * 0.4 * nightShiftsCount);
          
          // ★ 最終薪水把大夜獎金加進去
          const finalSalary = currentBaseSalary + totalOtPay + nightShiftBonus - deduction;

          data.push({
              staff_id: rowId, name, baseSalary: currentBaseSalary, hourlyWage, dailyWage,
              workDays: workDays + explicitOtDays, standardWorkDays, otDays: totalRestOtDays,
              nightShiftsCount, nightShiftBonus, // 👈 匯出大夜獎金供畫面顯示
              restDayOtPay, nationalHolidayWorkDays, nationalHolidayPay, totalOtPay, 
              personalLeaveDays, sickLeaveDays, deduction, totalSalary: finalSalary
          });
      });
      return data;
  };

  // ★★★ 核心新增：差額帳本寫入引擎 ★★★
  const handleConfirmSettlement = () => {
      if (!window.confirm(`⚠️ 確定要將 ${historyYear}年${historyMonth}月 的數據正式寫入員工帳戶嗎？\n\n系統將自動派發「積假 (OT)」與「夜班結餘」，\n並具備防呆機制，若本月重複結算不會導致無限累加，也不會覆蓋您在員工頁面手動微調的基準值。`)) return;

      const currentSettlement = getSettlementData();
      const monthKey = `${historyYear}-${String(historyMonth).padStart(2, '0')}`; 

      if (setStaffData) {
          setStaffData(prevData => {
              return prevData.map(staff => {
                  const sData = currentSettlement.find(s => s.staff_id === staff.staff_id);
                  if (!sData) return staff; 

            const newHistory = { ...(staff.settlement_history || {}) };
                  const oldRecord = newHistory[monthKey] || { ot: 0, night: 0, annual: 0 };

                  const otDiff = sData.otDays - oldRecord.ot;
                  const nightDiff = sData.nightShiftsCount - oldRecord.night;
                  const annualDiff = (sData.annualLeaveDays || 0) - (oldRecord.annual || 0); // ★ 算出本次結算多請了幾天特休

                  newHistory[monthKey] = {
                      ot: sData.otDays,
                      night: sData.nightShiftsCount,
                      annual: sData.annualLeaveDays || 0 // ★ 紀錄本月扣了幾天
                  };

                  return {
                      ...staff,
                      settlement_history: newHistory,
                      accumulated_ot: (Number(staff.accumulated_ot) || 0) + otDiff,
                      night_shift_balance: (Number(staff.night_shift_balance) || 0) + nightDiff,
                      annual_leave_used: (Number(staff.annual_leave_used) || 0) + annualDiff // ★ 正式扣除特休額度
                  };
              });
          });
      }

      alert(`✅ ${historyYear}年${historyMonth}月 結算完成！\n已成功將 ${currentSettlement.length} 位員工的 OT 與夜班數派發至帳戶餘額。`);
      setShowSettlement(false);
  };

const handleExportExcel = async () => {
    if (!historySchedule || Object.keys(historySchedule).length === 0) return alert("無資料可匯出");
    
    // 1. 先取得當月所有的薪資結算數據
    const settlementData = getSettlementData();
    
    // 2. 新增 Excel 表頭欄位
    let csv = "\uFEFF工號,姓名,";
    for (let d = 1; d <= daysInMonth; d++) csv += `${d}號,`;
    csv += "健康度評分,總工時(天),國定假日出勤(天),夜班總數,總加班費(元),積假派發(天),事假(天),病假(天),扣薪(元),預估總薪資(元)\n"; 

    Object.keys(historySchedule).sort((a, b) => {
        const aIsVirtual = a.startsWith('D'), bIsVirtual = b.startsWith('D');
        if (aIsVirtual && !bIsVirtual) return 1; 
        if (!aIsVirtual && bIsVirtual) return -1;
        return a.localeCompare(b);
    }).forEach(rowId => {
        const realStaff = staffData.find(s => s.staff_id === rowId);
        const name = realStaff ? realStaff.name : "待認領";
        const { score } = calculateHealthScore(historySchedule[rowId]);
        
        let row = `${rowId},${name},`;
        for (let d = 1; d <= daysInMonth; d++) {
            const cell = historySchedule[rowId]?.[d];
            const type = (typeof cell === 'object' ? cell.type : cell) || '';
            row += `${type},`;
        }
        
        // 3. 抓取該員工的對應薪水數據
        let extraCols = ",,,,,,,,,"; 
        if (!rowId.startsWith('D')) {
            const sData = settlementData.find(s => s.staff_id === rowId);
            if (sData) {
                extraCols = `,${sData.workDays},${sData.nationalHolidayWorkDays},${sData.nightShiftsCount},${sData.totalOtPay},${sData.otDays},${sData.personalLeaveDays},${sData.sickLeaveDays},${sData.deduction},${sData.totalSalary}`;
            }
        }

        // 把結算資料接在最後面
        row += `${score}${extraCols}`; 
        csv += row + "\n";
    });

    // 4. 將 CSV 正式上傳至 Firebase 雲端伺服器
    try {
        await saveArchiveReport(historyYear, historyMonth, csv);
    } catch (e) {
        console.error("上傳報表至伺服器失敗:", e);
    }

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${historyYear}年${historyMonth}月_結算歷史班表與薪資.csv`;
    link.click();
    
    alert(`✅ Excel 已下載！\n\n系統已在背景將 ${historyYear}年${historyMonth}月 的數據【永久備份至雲端】。\n即使關閉網頁，AI 日後依然能讀取此月份進行跨月分析！`);
  };
  // ★★★ 新增：針對「歷史紀錄區」專用的法遵與壓力風險計算 ★★★
  const historyViolations = historySchedule && Object.keys(historySchedule).length > 0 ? 
      [...checkLaborLawCompliance(historySchedule, staffData, [], historyYear, historyMonth), ...checkSkillMixSafety(historySchedule, staffData, historyYear, historyMonth)] : [];
      
  const historyRisks = historySchedule && Object.keys(historySchedule).length > 0 ? 
      calculateScheduleRisks(historySchedule, staffData, publicHolidays, historyYear, historyMonth) : [];
        // ★★★ 隱藏版功能：開發者時光機 (手動觸發自動結算 API) ★★★
  const handleTestAutoSettle = async () => {
      const testDate = window.prompt(
          "【開發者時光機測試】\n請輸入您想穿越到的日期 (格式 YYYY-MM-DD)，例如 2026-02-28。\n\n💡 若留空並直接按「確定」，系統將【強制結算】本月班表：", 
          ""
      );
      
      if (testDate === null) return; // 使用者按了取消

      try {
          // 判斷要帶入哪種參數
          const url = testDate.trim() !== '' 
              ? `/api/auto-settle?targetDate=${testDate}` 
              : '/api/auto-settle?force=true';
          
          const response = await fetch(url);
          const data = await response.json();
          
          if (response.ok) {
              alert(`✅ API 執行成功！\n\n伺服器回應：${data.message}`);
          } else {
              alert(`❌ API 執行失敗！\n\n錯誤：${data.error}\n詳細：${data.details || '無'}`);
          }
      } catch (error) {
          alert(`❌ 網路連線異常：${error.message}`);
      }
  };

return (
    <div style={{ display: 'flex', gap: '20px', height: '80vh', flexDirection:'column', position: 'relative' }}>
      
      {/* ▼▼▼ 這是全新替換的頂部區塊 (已拔除下拉選單，改為純文字標籤) ▼▼▼ */}
      <div style={{ background: 'white', borderRadius: '16px', padding: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
           <div style={{display:'flex', alignItems:'center', gap:'15px'}}>
               <h2 style={{ margin: 0, fontSize: '1.5rem', color:'#2c3e50' }}>✅ 結算與歷史大帳本</h2>
               
{/* ★★★ 修改為：可切換年月選項的控制器 ★★★ */}
               <div style={{ display: 'flex', alignItems: 'center', background: '#f8f9fa', padding: '5px 15px', borderRadius: '8px', border:'1px solid #ddd', color: '#34495e', fontWeight: 'bold', fontSize: '1rem' }}>
                   <span style={{ marginRight: '8px' }}>📂 封存檔案：</span>
                   <input 
                       type="number" 
                       value={historyYear} 
                       onChange={(e) => setHistoryYear(Number(e.target.value))}
                       style={{ width: '65px', padding: '4px', borderRadius: '6px', border: '1px solid #ccc', fontWeight: 'bold', textAlign: 'center', color: '#f1f4f8' }}
                   />
                   <span style={{ margin: '0 5px' }}>年</span>
                   <select 
                       value={historyMonth} 
                       onChange={(e) => setHistoryMonth(Number(e.target.value))}
                       style={{ padding: '4px 8px', borderRadius: '6px', border: '1px solid #ccc', fontWeight: 'bold', cursor: 'pointer', color: '#f7f9fc' }}
                   >
                       {Array.from({length: 12}, (_, i) => i + 1).map(m => (
                           <option key={m} value={m}>{m}</option>
                       ))}
                   </select>
                   <span style={{ margin: '0 0 0 5px' }}>月</span>
               </div>
           </div>
           
<div style={{ display:'flex', gap:'10px', alignItems: 'center' }}>
              {/* ★ 找回底薪設定欄位 ★ */}
              <div style={{ background: '#f8f9fa', padding: '4px 10px', borderRadius: '8px', border: '1px solid #ddd', display: 'flex', alignItems: 'center', gap: '5px' }}>
                  <span style={{ fontSize: '0.9rem', fontWeight: 'bold', color: '#34495e' }}>預設底薪:</span>
                  <input 
                      type="number" 
                      value={baseSalary} 
                      onChange={(e) => setBaseSalary(Number(e.target.value))}
                      style={{ width: '80px', padding: '4px', border: '1px solid #ccc', borderRadius: '4px', textAlign: 'center', fontWeight: 'bold' }}
                      title="此底薪將用於計算加班費與請假扣薪"
                  />
              </div>

              <button onClick={() => setShowAddOption(!showAddOption)} style={{ padding: '0.5rem 1rem', background: '#6c757d', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer' }}>➕ 管理班別選項</button>
              <button onClick={handleOpenSettlement} style={{ padding: '0.5rem 1rem', background: '#8e44ad', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>💰 薪資與加班費結算</button>
              <button onClick={handleExportExcel} style={{ padding: '0.5rem 1rem', background: '#27ae60', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>📥 匯出 Excel</button>
              <button onClick={handleTestAutoSettle} style={{ padding: '0.5rem 1rem', background: '#34495e', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold', border: '1px dashed #ccc' }} title="開發者測試專用">⚙️ 測試 API</button>
           </div>
      </div>
      {/* ▲▲▲ 頂部區塊結束 ▲▲▲ */}


      {showSettlement && (
          <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
              <div style={{ background: 'white', padding: '2rem', borderRadius: '16px', width: '95%', maxWidth: '1100px', maxHeight: '85vh', overflowY: 'auto', position: 'relative' }}>
                  <button onClick={() => setShowSettlement(false)} style={{ position: 'absolute', top: '15px', right: '20px', background: 'none', border: 'none', fontSize: '1.5rem', cursor: 'pointer', color: 'black' }}>✖</button>
                  <h2 style={{ margin: '0 0 10px 0', color: '#2c3e50', borderBottom: '2px solid #eee', paddingBottom: '10px' }}>💰 薪資與加班費結算預覽 ({historyYear}年{historyMonth}月)</h2>
                  
                  <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'center', fontSize: '0.9rem', marginTop: '15px' }}>
                      <thead style={{ background: '#34495e', color: 'white' }}>
                          <tr>
                              <th style={{ padding: '10px' }}>員工姓名</th>
                              <th style={{ padding: '10px' }}>上班/國定</th>
                              <th style={{ padding: '10px', background: '#8e44ad' }}>夜班總數</th> 
                              <th style={{ padding: '10px', background: '#e74c3c' }}>加班費 (積假)</th>
                              <th style={{ padding: '10px', background: '#95a5a6' }}>請假 (事/病)</th>
                              <th style={{ padding: '10px', background: '#7f8c8d' }}>扣薪</th>
                              <th style={{ padding: '10px', background: '#27ae60' }}>預估薪資</th>
                          </tr>
                      </thead>
                      <tbody>
                          {getSettlementData().map(row => (
                              <tr key={row.staff_id} style={{ borderBottom: '1px solid #eee' }}>
                                  <td style={{ padding: '10px', fontWeight: 'bold', color: 'black' }}>{row.name} <div style={{fontSize:'0.8rem', color:'#888'}}>({row.staff_id})</div></td>
                                  <td style={{ padding: '10px', color: 'black' }}>
                                      <div>總工時: {row.workDays} 天</div>
                                      {row.nationalHolidayWorkDays > 0 && <div style={{fontSize:'0.8rem', color:'#e67e22'}}>含國定: {row.nationalHolidayWorkDays}天</div>}
                                  </td>
                                  <td style={{ padding: '10px', color: '#8e44ad' }}>
                                      <div style={{ fontSize: '1.2rem', fontWeight: 'bold' }}>{row.nightShiftsCount} 班</div>
                                      {/* ★ 顯示 40% 換算出來的獎金 */ }
                                      {row.nightShiftBonus > 0 && <div style={{ fontSize: '0.85rem', marginTop: '4px', fontWeight: 'bold' }}>津貼: +${row.nightShiftBonus.toLocaleString()}</div>}
                                  </td>
                                  <td style={{ padding: '10px', color: row.totalOtPay > 0 ? '#e74c3c' : '#ccc', fontWeight: 'bold' }}>
                                      NT$ {row.totalOtPay.toLocaleString()}
                                      {row.otDays > 0 && <div style={{fontSize:'0.85rem', color:'#e74c3c', marginTop:'4px'}}>積假派發: +{row.otDays}天</div>}
                                  </td>
                                  <td style={{ padding: '10px', color: (row.personalLeaveDays + row.sickLeaveDays) > 0 ? '#555' : '#ccc' }}>
                                      {row.personalLeaveDays > 0 && <div>事假: {row.personalLeaveDays}天</div>}
                                      {row.sickLeaveDays > 0 && <div>病假: {row.sickLeaveDays}天</div>}
                                      {(row.personalLeaveDays === 0 && row.sickLeaveDays === 0) && '-'}
                                  </td>
                                  <td style={{ padding: '10px', color: row.deduction > 0 ? 'red' : '#ccc' }}>{row.deduction > 0 ? `- $${row.deduction.toLocaleString()}` : '-'}</td>
                                  <td style={{ padding: '10px', fontWeight: 'bold', color: '#27ae60', fontSize: '1.1rem' }}>NT$ {row.totalSalary.toLocaleString()}</td>
                              </tr>
                          ))}
                          {getSettlementData().length === 0 && <tr><td colSpan="7" style={{ padding: '20px', color: '#888' }}>尚無已認領的員工資料</td></tr>}
                      </tbody>
                  </table>

                  <div style={{ marginTop: '20px', textAlign: 'center', background: '#f8f9fa', padding: '15px', borderRadius: '8px', border: '1px dashed #ccc' }}>
                      <div style={{ marginBottom: '10px', fontSize: '0.9rem', color: '#555' }}>確認預覽無誤後，可點擊下方按鈕將數據派發至每位員工的「積假與夜班餘額」中。</div>
                      <button onClick={handleConfirmSettlement} style={{ padding: '12px 30px', background: '#27ae60', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer', fontSize: '1.1rem', fontWeight: 'bold', boxShadow: '0 4px 6px rgba(39, 174, 96, 0.3)' }}>
                          💾 確認無誤，正式寫入員工帳本
                      </button>
                      <div style={{ marginTop: '8px', fontSize: '0.8rem', color: '#e74c3c' }}>⚠️ 智慧防呆：重複點擊只會更新當月差額，不會造成數據無限膨脹或覆蓋您手動微調的基準值。</div>
                  </div>

              </div>
          </div>
      )}

      {showAddOption && (
        <div style={{ padding: '1rem', background: 'white', borderRadius: '16px', border:'1px solid #ddd' }}>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginBottom:'10px' }}>
            <input placeholder="代號" value={newOption.code} onChange={e=>setNewOption({...newOption, code: e.target.value})} style={{padding:'5px', width:'80px', color: 'black'}} />
            <input placeholder="名稱" value={newOption.name} onChange={e=>setNewOption({...newOption, name: e.target.value})} style={{padding:'5px', width:'120px', color: 'black'}} />
            <input type="color" value={newOption.color} onChange={e=>setNewOption({...newOption, color: e.target.value})} style={{border:'none', width:'40px', height:'30px', cursor:'pointer'}} />
            <button onClick={handleAddOption} style={{padding:'5px 15px', background:'#28a745', color:'white', border:'none', borderRadius:'4px', cursor:'pointer'}}>確認新增</button>
          </div>
          <div style={{ display:'flex', flexWrap:'wrap', gap:'10px', paddingTop:'10px', borderTop:'1px solid #eee' }}>
              {shiftOptions.map(opt => (
                  <div key={opt.code} style={{ background:'#f8f9fa', padding:'4px 8px', borderRadius:'4px', border:'1px solid #ddd', display:'flex', alignItems:'center', gap:'5px', fontSize:'0.85rem' }}>
                      <span style={{width:'12px', height:'12px', background:opt.color, display:'inline-block', borderRadius:'50%'}}></span>
                      <b style={{ color: '#000000' }}>{opt.code}</b>
                      <button onClick={() => handleDeleteOption(opt.code)} style={{border:'none', background:'transparent', color:'red', cursor:'pointer', fontWeight:'bold', padding:'0 2px'}}>×</button>
                  </div>
              ))}
          </div>
        </div>
      )}

   <div style={{ display: 'flex', gap: '20px', flex: 1, overflow: 'hidden' }}>
          
          {/* 左側：班表主視窗 (改成 flex: 3 以預留空間給右側) */}
          <div style={{ flex: 3, background: 'white', borderRadius: '16px', padding: '1.5rem', display:'flex', flexDirection:'column', overflow:'hidden' }}>
            <div style={{ flex: 1, overflow: 'auto', border: '1px solid #eee', borderRadius: '8px' }}>
              {historySchedule && Object.keys(historySchedule).length > 0 ? (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                    <thead style={{ position: 'sticky', top: 0, zIndex: 10 }}>
                        <tr style={{ background: '#34495e', color: 'white' }}>
                            <th style={{ padding: '8px', minWidth: '130px', position: 'sticky', left: 0, background: '#34495e', zIndex: 11 }}>員工指派</th>
                            <th style={{ padding: '8px', minWidth: '50px', background: '#2c3e50', zIndex: 10, borderRight: '2px solid #555' }}>健康度</th>
                            {daysArray.map(d => {
                                const dayOfWeek = new Date(historyYear, historyMonth - 1, d).getDay();
                                const dayStrs = ['日', '一', '二', '三', '四', '五', '六'];
                                const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
                                const dateStr = `${historyYear}${String(historyMonth).padStart(2, '0')}${String(d).padStart(2, '0')}`;
                                const isNationalHoliday = publicHolidays.includes(dateStr);
                                return (
                                    <th key={d} style={{ padding:'4px', minWidth:'35px', color: isNationalHoliday ? '#ff7675' : (isWeekend ? '#ffcccc' : 'white'), textAlign: 'center' }}>
                                        <div style={{ fontSize: '0.9rem', lineHeight: '1.2' }}>{d}</div>
                                        <div style={{ fontSize: '0.7rem', fontWeight: 'normal', lineHeight: '1.2' }}>{isNationalHoliday ? '國假' : dayStrs[dayOfWeek]}</div>
                                    </th>
                                )
                            })}
                        </tr>
                    </thead>
                    <tbody>
                        {Object.keys(historySchedule).sort((a, b) => {
                            const aIsVirtual = a.startsWith('D'), bIsVirtual = b.startsWith('D');
                            if (aIsVirtual && !bIsVirtual) return 1; if (!aIsVirtual && bIsVirtual) return -1;
                            return a.localeCompare(b);
                        }).map(rowId => {
                            const isVirtual = rowId.startsWith('D');
                            const { score, deductions } = calculateHealthScore(historySchedule[rowId]);
                            const scoreColor = score >= 90 ? '#27ae60' : (score >= 75 ? '#f39c12' : '#c0392b');

                            return (
                                <tr key={rowId} style={{ borderBottom: '1px solid #eee', background: isVirtual ? '#fafafa' : 'white' }}>
                                    <td style={{ padding: '8px', borderRight: '1px solid #eee', position: 'sticky', left: 0, background: isVirtual ? '#f9f9f9' : 'white', zIndex: 5 }}>
                                       <div style={{fontWeight:'bold', color: isVirtual ? '#888' : '#2c3e50'}}>{isVirtual ? '🎲 待認領' : (staffData.find(s=>s.staff_id===rowId)?.name || rowId)}</div>
                                    </td>
                                    <td style={{ padding: '4px', textAlign: 'center', fontWeight: 'bold', color: scoreColor, borderRight: '2px solid #ddd', cursor: 'help', background: isVirtual ? '#fafafa' : 'white', fontSize: '1.1rem' }} title={deductions.length > 0 ? `扣分明細：\n${deductions.join('\n')}` : '✨ 完美班表！無身心損耗'}>{score}</td>
                                    {daysArray.map(d => {
                                        const cellData = historySchedule[rowId]?.[d];
                                        const type = (typeof cellData === 'object') ? cellData.type : (cellData || '');
                                        const optionInfo = shiftOptions.find(o => o.code === type) || { color: '#fff' };
                                        return (
                                            <td key={d} style={{ padding: 0, borderRight: '1px solid #f0f0f0', height: '40px' }}>
                                                <select value={type} onChange={(e) => handleCellChange(rowId, d, e.target.value)} style={{ width: '100%', height: '100%', padding: 0, border: 'none', background: optionInfo.color, color: 'black', fontWeight: 'bold', textAlignLast: 'center', cursor: 'pointer', appearance: 'none', borderRadius: 0 }}>
                                                    {shiftOptions.map(opt => <option key={opt.code} value={opt.code} style={{background:'white', color:'black'}}>{opt.code}</option>)}
                                                </select>
                                            </td>
                                        )
                                    })}
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
              ) : <div style={{padding:'40px', textAlign:'center', color:'#888'}}>歷史資料庫尚無該月班表資料</div>}
            </div>
          </div>

          {/* ★★★ 新增右側：法遵與壓力風險監控面板 ★★★ */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '15px', overflow: 'hidden' }}>
            {/* ========================================================= */}
             {/* 🏥 衛福部護病比儀表板 (即時運算) */}
             <div style={{ background: 'white', borderRadius: '16px', padding: '1.2rem', display:'flex', flexDirection:'column', borderLeft:'4px solid #8e44ad', boxShadow: '0 4px 6px rgba(0,0,0,0.05)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '15px', fontSize:'0.9rem' }}>
                    <label style={{ color: '#555', fontWeight: 'bold' }}>單位總床數：</label>
                    <input type="number" value={unitBedCount} onChange={(e) => setUnitBedCount(Number(e.target.value))} style={{ width: '60px', padding: '4px', borderRadius: '4px', border: '1px solid #ccc', textAlign: 'center', fontWeight: 'bold' }} />
                </div>

                {ratioResult ? (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px' }}>
                        {['D', 'E', 'N'].map(shift => {
                            const shiftName = shift === 'D' ? '白班' : shift === 'E' ? '小夜' : '大夜';
                            const ratioVal = Number(ratioResult[`ratio${shift}`]);
                            const limit = RATIO_STANDARDS[hospitalLevel][shift];
                            const isViolated = ratioVal > limit || isNaN(ratioVal);

                            return (
                                <div key={shift} style={{ background: isViolated ? '#fff5f5' : '#f0fdf4', border: `1px solid ${isViolated ? '#fc8181' : '#68d391'}`, padding: '10px 5px', borderRadius: '8px', textAlign: 'center' }}>
                                    <div style={{ fontSize: '0.85rem', fontWeight: 'bold', color: isViolated ? '#c53030' : '#276749' }}>{shiftName}</div>
                                    <div style={{ fontSize: '1.2rem', fontWeight: '900', color: isViolated ? '#e53e3e' : '#38a169', margin: '4px 0' }}>1:{ratioResult[`ratio${shift}`]}</div>
                                    <div style={{ fontSize: '0.7rem', color: isViolated ? '#e53e3e' : '#276749', fontWeight: 'bold' }}>法定 1:{limit}</div>
                                </div>
                            );
                        })}
                    </div>
                ) : <div style={{ fontSize:'0.85rem', color:'#888', textAlign:'center' }}>尚無班表資料</div>}
             </div>
             {/* ========================================================= */}
             <div style={{ flex: 1, background: 'white', borderRadius: '16px', padding: '1.5rem', display:'flex', flexDirection:'column', borderLeft:'4px solid #e74c3c', boxShadow: '0 4px 6px rgba(0,0,0,0.05)', overflow: 'hidden' }}>
                <h2 style={{ margin: '0 0 1rem 0', fontSize: '1.1rem', color: '#c0392b' }}>⚖️ 法遵檢查結果</h2>
                <div style={{ flex: 1, overflowY: 'auto' }}>
                   {historyViolations.length === 0 ? <div style={{ color: '#27ae60', textAlign:'center', marginTop:'20px', fontWeight:'bold' }}>✅ 無勞基法違規</div> : historyViolations.map((v, i) => (
                         <div key={i} style={{ padding: '8px', background: '#fff5f5', marginBottom: '8px', borderRadius: '8px', borderLeft: '3px solid #e74c3c', fontSize: '0.85rem' }}>
                           <div style={{fontWeight:'bold', color:'#c0392b'}}>{v.staffName}</div>
                           <div style={{ color: '#444', marginTop: '4px', lineHeight: '1.4' }}>Day {v.day}: {v.message}</div>
                         </div>
                   ))}
                </div>
             </div>
             <div style={{ flex: 1, background: 'white', borderRadius: '16px', padding: '1.5rem', display:'flex', flexDirection:'column', borderLeft:'4px solid #f39c12', boxShadow: '0 4px 6px rgba(0,0,0,0.05)', overflow: 'hidden' }}>
                <h2 style={{ margin: '0 0 1rem 0', fontSize: '1.1rem', color: '#d35400' }}>⚠️ 壓力風險監控</h2>
                <div style={{ flex: 1, overflowY: 'auto' }}>
                   {(!historyRisks || historyRisks.length === 0) ? <div style={{ color: '#f39c12', textAlign:'center', marginTop:'20px', fontWeight:'bold' }}>✨ 團隊負荷平均</div> : historyRisks.map((risk, i) => (
                         <div key={i} style={{ padding: '8px', background: '#fdf8e3', marginBottom: '8px', borderRadius: '8px', fontSize:'0.85rem' }}>
                           <div style={{fontWeight:'bold', color:'#8a6d3b'}}>{risk.staffName}</div>
                           {risk.tags.map((tag, j) => (<div key={j} style={{color:'#666'}}>- {tag.label}</div>))}
                         </div>
                   ))}
                </div>
             </div>
          </div>

      </div>
    </div>
  );
};

// ============================================================================
// 制度模擬工作桌 (What-if Simulation Sandbox)
// ============================================================================
{/*
const SimulationPanel = ({ 
    staffData, requirements, baseSalary, publicHolidays, 
    selectedYear, selectedMonth, shiftOptions 
}) => {
    const [isSimulating, setIsSimulating] = useState(false);
    const [simResult, setSimResult] = useState(null);

    const [simParams, setSimParams] = useState({
        bedCount: 50,
        ratioD: 10,
        ratioE: 12,
        ratioN: 15,
        staffChange: 0, 
        banNightShift: false 
    });

    const daysInMonth = new Date(selectedYear, selectedMonth, 0).getDate();

    const runSimulation = async () => {
        setIsSimulating(true);
        setSimResult(null);

        const dailyD = Math.max(1, simParams.ratioD);
        const dailyE = Math.max(1, simParams.ratioE);
        const dailyN = Math.max(1, simParams.ratioN);
        const ttD = Math.ceil(simParams.bedCount / dailyD);
        const totalNeededPerDay = dailyD + dailyE + dailyN;

        let availableStaffCount = staffData.filter(s => s.is_active).length + simParams.staffChange;
        if (availableStaffCount < 1) availableStaffCount = 1;

        const prompt = `
            [制度模擬測試]
            這是一個壓力測試。請為 ${availableStaffCount} 名護理人員排 ${daysInMonth} 天的班表。
            每日需求：早班 ${dailyD} 人, 小夜 ${dailyE} 人, 大夜 ${dailyN} 人。
            法規限制：盡量符合七休一與輪班間隔11小時。若人力極度不足，請硬排並允許違規，我們會將違規次數作為風險指標。
            請只輸出 ${availableStaffCount} 個字串的陣列 (以逗號分隔班別 D,E,N,OFF)。
            格式範例: {"patterns": ["D,D,D,OFF..."]}
        `;

        try {
            const token = await auth.currentUser?.getIdToken();
            const response = await fetch('/api/gemini', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`  // ★ 補上這行
                 },
                body: JSON.stringify({ prompt: prompt })
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || "伺服器連線失敗");
            }

            const data = await response.json();
            const text = data.text.replace(/```json|```/g, '').trim();
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (!jsonMatch) throw new Error("AI 回傳格式錯誤"); // ★ 補上防呆
            const parsed = JSON.parse(jsonMatch[0]);
            if (!parsed.patterns || !Array.isArray(parsed.patterns)) throw new Error("AI 未回傳 patterns"); 

            const virtualSchedule = {};
            parsed.patterns.forEach((patternStr, index) => {
                const shifts = patternStr.split(',').map(s => s.trim());
                virtualSchedule[`SimStaff_${index}`] = {};
                shifts.forEach((type, dIndex) => {
                    virtualSchedule[`SimStaff_${index}`][dIndex + 1] = { type };
                });
            });

            let totalOTCost = 0;
            let totalViolations = 0;
            let gapDays = 0;
            const hourlyWage = Math.round((Number(baseSalary) || 40000) / 240);

            for (let d = 1; d <= daysInMonth; d++) {
                let countD = 0, countE = 0, countN = 0;
                Object.values(virtualSchedule).forEach(staff => {
                    const t = staff[d]?.type;
                    if (t === 'D') countD++;
                    if (t === 'E') countE++;
                    if (t === 'N') countN++;
                });
                if (countD < dailyD) gapDays += (dailyD - countD);
                if (countE < dailyE) gapDays += (dailyE - countE);
                if (countN < dailyN) gapDays += (dailyN - countN);
            }

            Object.keys(virtualSchedule).forEach(staffId => {
                let workDays = 0;
                let consecutive = 0;
                for (let d = 1; d <= daysInMonth; d++) {
                    const type = virtualSchedule[staffId][d]?.type;
                    if (['D', 'E', 'N'].includes(type)) {
                        workDays++;
                        consecutive++;
                        if (consecutive > 6) totalViolations++; 
                    } else {
                        consecutive = 0;
                    }
                }
                const stdDays = daysInMonth - 8;
                if (workDays > stdDays) {
                    const otDays = workDays - stdDays;
                    const otPayPerDay = Math.round((hourlyWage * 1.34 * 2) + (hourlyWage * 1.67 * 6));
                    totalOTCost += (otDays * otPayPerDay);
                }
            });

            setSimResult({
                staffCount: availableStaffCount,
                dailyNeeded: totalNeededPerDay,
                gapShifts: gapDays,
                violations: totalViolations,
                estExtraCost: totalOTCost
            });

        } catch (e) {
            alert("模擬失敗，請重試：" + e.message);
        } finally {
            setIsSimulating(false);
        }
    };

    return (
        <div style={{ background: 'white', borderRadius: '16px', padding: '2rem', display: 'flex', gap: '20px', flexDirection: 'column' }}>
            <div style={{ borderBottom: '2px solid #eee', paddingBottom: '1rem' }}>
                <h2 style={{ margin: 0, color: '#8e44ad', display: 'flex', alignItems: 'center', gap: '10px' }}>
                    🔮 制度變更模擬器 (What-if Analysis)
                </h2>
                <p style={{ color: '#666', marginTop: '5px' }}>在不影響正式班表的情況下，預測「如果改變管理制度」會對成本與合規性造成什麼衝擊。</p>
            </div>

            <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: '300px', background: '#f8f9fa', padding: '1.5rem', borderRadius: '12px', border: '1px solid #ddd' }}>
                    <h3 style={{ marginTop: 0, color: '#333' }}>🎛️ 調整模擬參數</h3>
                    
                    <div style={{ marginBottom: '15px' }}>
                        <label style={{ fontWeight: 'bold', display: 'block', color: 'black' }}>護病比與病床數 (目前: {simParams.bedCount}床)</label>
                        <input type="range" min="10" max="100" value={simParams.bedCount} onChange={e => setSimParams({...simParams, bedCount: Number(e.target.value)})} style={{ width: '100%' }} />
                        <div style={{ display: 'flex', gap: '10px', marginTop: '10px' }}>
                            <input type="number" value={simParams.ratioD} onChange={e => setSimParams({...simParams, ratioD: Number(e.target.value)})} placeholder="早班比" style={{ width: '33%', padding: '5px' }} />
                            <input type="number" value={simParams.ratioE} onChange={e => setSimParams({...simParams, ratioE: Number(e.target.value)})} placeholder="小夜比" style={{ width: '33%', padding: '5px' }} />
                            <input type="number" value={simParams.ratioN} onChange={e => setSimParams({...simParams, ratioN: Number(e.target.value)})} placeholder="大夜比" style={{ width: '33%', padding: '5px' }} />
                        </div>
                    </div>

                    <div style={{ marginBottom: '15px' }}>
                        <label style={{ fontWeight: 'bold', display: 'block', color: 'black' }}>人員異動模擬 (離職/擴編)</label>
                        <select value={simParams.staffChange} onChange={e => setSimParams({...simParams, staffChange: Number(e.target.value)})} style={{ width: '100%', padding: '8px', marginTop: '5px' }}>
                            <option value={-2}>減少 2 人 (模擬離職潮)</option>
                            <option value={-1}>減少 1 人 (模擬請長假)</option>
                            <option value={0}>維持現狀 ({staffData.length} 人)</option>
                            <option value={1}>增加 1 人 (模擬招募)</option>
                            <option value={2}>增加 2 人</option>
                        </select>
                    </div>

                    <button onClick={runSimulation} disabled={isSimulating} style={{ width: '100%', padding: '12px', background: isSimulating ? '#ccc' : '#8e44ad', color: 'white', border: 'none', borderRadius: '8px', fontWeight: 'bold', cursor: isSimulating ? 'not-allowed' : 'pointer', fontSize: '1.1rem' }}>
                        {isSimulating ? '⏳ AI 正在進行平行時空運算...' : '🚀 執行衝擊模擬'}
                    </button>
                </div>

                <div style={{ flex: 1.5, minWidth: '300px', background: '#fff', padding: '1.5rem', borderRadius: '12px', border: '1px solid #8e44ad', boxShadow: '0 4px 15px rgba(142, 68, 173, 0.1)' }}>
                    <h3 style={{ marginTop: 0, color: '#8e44ad' }}>📊 模擬衝擊報告</h3>
                    
                    {!simResult ? (
                        <div style={{ height: '200px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#999' }}>
                            請調整左側參數並點擊執行，AI 將為您預測結果。
                        </div>
                    ) : (
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
                            <div style={{ background: '#fdf2e9', padding: '15px', borderRadius: '8px', borderLeft: '4px solid #e67e22' }}>
                                <div style={{ fontSize: '0.9rem', color: '#666' }}>預估勞基法違規數</div>
                                <div style={{ fontSize: '2rem', fontWeight: 'bold', color: '#d35400' }}>{simResult.violations} <span style={{fontSize:'1rem'}}>次</span></div>
                                <div style={{ fontSize: '0.8rem', color: '#e67e22' }}>{simResult.violations > 5 ? '⚠️ 法律風險極高' : '✅ 尚在可控範圍'}</div>
                            </div>

                            <div style={{ background: '#fce4ec', padding: '15px', borderRadius: '8px', borderLeft: '4px solid #e91e63' }}>
                                <div style={{ fontSize: '0.9rem', color: '#666' }}>預估人力缺口 (空班數)</div>
                                <div style={{ fontSize: '2rem', fontWeight: 'bold', color: '#c2185b' }}>{simResult.gapShifts} <span style={{fontSize:'1rem'}}>班</span></div>
                                <div style={{ fontSize: '0.8rem', color: '#e91e63' }}>{simResult.gapShifts > 0 ? '⚠️ 需要請求外部支援' : '✅ 人力可順利覆蓋'}</div>
                            </div>

                            <div style={{ background: '#e8f8f5', padding: '15px', borderRadius: '8px', borderLeft: '4px solid #1abc9c', gridColumn: '1 / -1' }}>
                                <div style={{ fontSize: '0.9rem', color: '#666' }}>預估每月額外加班費成本</div>
                                <div style={{ fontSize: '2rem', fontWeight: 'bold', color: '#16a085' }}>NT$ {simResult.estExtraCost.toLocaleString()}</div>
                                <div style={{ fontSize: '0.8rem', color: '#1abc9c' }}>基於底薪 {baseSalary} 元估算休息日加班費</div>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};
*/}
// ============================================================================
// 📢 發布與認領面板 (PublishPanel) - 專供監控本月員工認領進度與單點拔除
// ============================================================================
const PublishPanel = ({ 
    staffData, violations, scheduleRisks, 
    selectedYear, selectedMonth, shiftOptions, setShiftOptions,
    publicHolidays, finalizedSchedule, setFinalizedSchedule,onPushToHistory // 👈 補上這行
}) => {
    const daysInMonth = new Date(selectedYear, selectedMonth, 0).getDate();
    const daysArray = Array.from({length: daysInMonth}, (_,i)=>i+1);
    // ★ 新增：選項管理與儲存邏輯
    const [showAddOption, setShowAddOption] = useState(false);
    const [newOption, setNewOption] = useState({ code: '', name: '', color: '#cccccc' });

    const handleAddOption = () => {
        if (!newOption.code || !newOption.name) return alert("請輸入代號與名稱！");
        if (shiftOptions.find(o => o.code === newOption.code)) return alert("此代號已存在！");
        setShiftOptions([...shiftOptions, { ...newOption, time: '' }]);
        setNewOption({ code: '', name: '', color: '#cccccc' });
    };

    const handleDeleteOption = (code) => {
        if(window.confirm(`確定要刪除班別「${code}」嗎？`)) setShiftOptions(shiftOptions.filter(o => o.code !== code));
    };

        const handleCellChange = async (staffId, day, newValue) => {
        // === RG 絕對防護罩 (針對 finalizedSchedule) ===
        const currentCell = finalizedSchedule[staffId]?.[day];
        const currentValue = (typeof currentCell === 'object') ? currentCell?.type : currentCell;
        const workShifts = ['D', 'E', 'N', '支援', 'OT']; 
        if (currentValue === 'RG' && workShifts.some(shift => newValue.includes(shift))) {
            alert('🚨 勞基法天條攔截：\n「例假 (RG)」絕對禁止出勤！\n\n系統已強制阻擋您將 RG 變更為上班班別。');
            return; 
        }
const newSchedule = JSON.parse(JSON.stringify(finalizedSchedule));
        if (!newSchedule[staffId]) newSchedule[staffId] = {};
        newSchedule[staffId][day] = { ...(typeof newSchedule[staffId][day] === 'object' ? newSchedule[staffId][day] : {}), type: newValue };
        setFinalizedSchedule(newSchedule);
    

      try {
          await updateStaffSchedule(historyYear, historyMonth, newSchedule);
      } catch (e) {
          console.error("同步歷史班表失敗", e);
      }
  };

    // -- 沿用健康度評分引擎 --
    const calculateHealthScore = (staffSchedule) => {
        let score = 100; const deductions = []; const shifts = []; 
        for (let d = 1; d <= daysInMonth; d++) {
            const cell = staffSchedule[d];
            shifts.push((typeof cell === 'object') ? (cell?.type || 'OFF') : (cell || 'OFF'));
        }
        const isWork = (s) => ['D', 'E', 'N', '支援'].includes(s) || (s && s.includes('OT'));
        const isOff = (s) => ['OFF', 'RG', 'RC', '事假', '病假', '特休'].includes(s);

        for (let i = 0; i < shifts.length - 1; i++) {
            if ((shifts[i] === 'E' && shifts[i+1] === 'D') || (shifts[i] === 'N' && (shifts[i+1] === 'D' || shifts[i+1] === 'E'))) { score -= 20; deductions.push(`[-20] 短間隔`); }
        }
        let consecutiveN = 0, consecutiveWork = 0;
        for (let i = 0; i <= shifts.length; i++) {
            const s = shifts[i];
            if (s === 'N') consecutiveN++; else { if (consecutiveN >= 4) { score -= 5; deductions.push(`[-5] 連續大夜`); } consecutiveN = 0; }
            if (s && isWork(s)) consecutiveWork++; else { if (consecutiveWork >= 6) { score -= 5; deductions.push(`[-5] 連六疲勞`); } consecutiveWork = 0; }
        }
        return { score, deductions };
    };

// ★★★ 核心邏輯 1：單點拔除名字，轉回待認領 ★★★
    // 👉 加上 async
    const handleUnassignSingleStaff = async (staffId) => { 
        const staffName = staffData.find(s => s.staff_id === staffId)?.name || staffId;
        if (!window.confirm(`⚠️ 確定要拔除「${staffName}」的班表嗎？\n\n這將把此排班轉為「待認領 (Dxxx)」空缺，\n員工介面會立刻同步釋出，供其他人重新選擇。`)) return;

        const newSchedule = JSON.parse(JSON.stringify(finalizedSchedule));
        
        let vIndex = 1; let newVirtualId = '';
        while (true) {
            newVirtualId = `D${String(vIndex).padStart(3, '0')}`;
            if (!newSchedule[newVirtualId]) break;
            vIndex++;
        }

        newSchedule[newVirtualId] = newSchedule[staffId];
        delete newSchedule[staffId];

        setFinalizedSchedule(newSchedule);

        // 🌟 ★★★ 關鍵修復：強制把拔除後的結果寫入 Firebase 雲端！ ★★★ 🌟
        try {
            await updateStaffSchedule(selectedYear, selectedMonth, newSchedule);
        } catch (error) {
            console.error("拔除失敗:", error);
            alert("❌ 雲端同步失敗，請檢查網路連線！");
        }
    };

    // ★★★ 核心邏輯 2：一鍵拔除所有人 ★★★
    // 👉 加上 async
    const handleUnassignAll = async () => {
        if (!window.confirm(`⚠️ 確定要【拔除所有人】的班表嗎？\n\n這會將目前畫面上所有已認領的班表，全部退回「待認領 (Dxxx)」狀態！\n員工必須重新登入選擇。`)) return;

        const newSchedule = {};
        let vIndex = 1;

        Object.keys(finalizedSchedule).sort().forEach(rowId => {
            const newVirtualId = `D${String(vIndex).padStart(3, '0')}`;
            newSchedule[newVirtualId] = finalizedSchedule[rowId];
            vIndex++;
        });

        setFinalizedSchedule(newSchedule);

        // 🌟 ★★★ 關鍵修復：強制把拔除後的結果寫入 Firebase 雲端！ ★★★ 🌟
        try {
            await updateStaffSchedule(selectedYear, selectedMonth, newSchedule);
            alert("✅ 所有人員已成功拔除並同步至雲端！");
        } catch (error) {
            console.error("拔除失敗:", error);
            alert("❌ 雲端同步失敗，請檢查網路連線！");
        }
    };

 return (
      <div style={{ display: 'flex', gap: '20px', height: '80vh', flexDirection:'column' }}>
        
        {/* ▼▼▼ 這是全新替換的頂部區塊 (包含 Push 封存按鈕) ▼▼▼ */}
        <div style={{ background: 'white', borderRadius: '16px', padding: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderLeft: '5px solid #27ae60' }}>
             <div style={{display:'flex', alignItems:'center', gap:'15px'}}>
                 <h2 style={{ margin: 0, fontSize: '1.5rem', color:'#27ae60' }}>📢 當前發布與認領動態</h2>
                 <span style={{background:'#e8f8f5', padding:'5px 10px', borderRadius:'8px', color:'#27ae60', fontWeight:'bold'}}>{selectedYear}年 {selectedMonth}月</span>
             </div>
             
           <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
                 {/* ★ 新增下拉選單按鈕 */}
                 <button onClick={() => setShowAddOption(!showAddOption)} style={{ padding: '0.5rem 1rem', background: '#6c757d', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer' }}>➕ 管理班別選項</button>
                 <button onClick={handleUnassignAll} style={{ padding: '0.5rem 1rem', background: '#e74c3c', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>⚠️ 全部拔除釋出</button>
                 <button onClick={onPushToHistory} style={{ padding: '10px 20px', background: '#34495e', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold', fontSize: '1rem', boxShadow: '0 4px 6px rgba(0,0,0,0.1)' }}>
                     ➡️ 結算並封存至歷史區
                 </button>
             </div>
        </div>
        {/* ▲▲▲ 頂部區塊結束 ▲▲▲ */}

        {/* ★ 新增：選項管理面板介面 */}
        {showAddOption && (
          <div style={{ padding: '1rem', background: 'white', borderRadius: '16px', border:'1px solid #ddd', marginBottom: '15px' }}>
            <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginBottom:'10px' }}>
              <input placeholder="代號" value={newOption.code} onChange={e=>setNewOption({...newOption, code: e.target.value})} style={{padding:'5px', width:'80px', color: 'black'}} />
              <input placeholder="名稱" value={newOption.name} onChange={e=>setNewOption({...newOption, name: e.target.value})} style={{padding:'5px', width:'120px', color: 'black'}} />
              <input type="color" value={newOption.color} onChange={e=>setNewOption({...newOption, color: e.target.value})} style={{border:'none', width:'40px', height:'30px', cursor:'pointer'}} />
              <button onClick={handleAddOption} style={{padding:'5px 15px', background:'#28a745', color:'white', border:'none', borderRadius:'4px', cursor:'pointer'}}>確認新增</button>
            </div>
            <div style={{ display:'flex', flexWrap:'wrap', gap:'10px', paddingTop:'10px', borderTop:'1px solid #eee' }}>
                {shiftOptions.map(opt => (
                    <div key={opt.code} style={{ background:'#f8f9fa', padding:'4px 8px', borderRadius:'4px', border:'1px solid #ddd', display:'flex', alignItems:'center', gap:'5px', fontSize:'0.85rem' }}>
                        <span style={{width:'12px', height:'12px', background:opt.color, display:'inline-block', borderRadius:'50%'}}></span>
                        <b style={{ color: '#000000' }}>{opt.code}</b>
                        <button onClick={() => handleDeleteOption(opt.code)} style={{border:'none', background:'transparent', color:'red', cursor:'pointer', fontWeight:'bold', padding:'0 2px'}}>×</button>
                    </div>
                ))}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: '20px', flex: 1, overflow: 'hidden' }}>
            {/* ... 下面的左側班表與右側監控，請保持原本的樣子不要動它 ... */}            {/* 左側：班表主視窗 */}
            <div style={{ flex: 3, background: 'white', borderRadius: '16px', padding: '1.5rem', display:'flex', flexDirection:'column', overflow:'hidden' }}>
              <div style={{ flex: 1, overflow: 'auto', border: '1px solid #eee', borderRadius: '8px' }}>
                {!finalizedSchedule || Object.keys(finalizedSchedule).length === 0 ? (
                  <div style={{padding:'40px', textAlign:'center', color:'#888'}}>尚無發布的班表，請先在「排班工作桌」儲存並發布。</div>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                      <thead style={{ position: 'sticky', top: 0, zIndex: 10 }}>
                          <tr style={{ background: '#27ae60', color: 'white' }}>
                              <th style={{ padding: '8px', minWidth: '150px', position: 'sticky', left: 0, background: '#27ae60', zIndex: 11 }}>員工指派 / 操作</th>
                              <th style={{ padding: '8px', minWidth: '50px', background: '#2ecc71', zIndex: 10, borderRight: '2px solid #fff' }}>健康度</th>
                              {daysArray.map(d => (
                                  <th key={d} style={{ padding:'4px', minWidth:'35px', textAlign: 'center' }}>
                                      <div style={{ fontSize: '0.9rem' }}>{d}</div>
                                  </th>
                              ))}
                          </tr>
                      </thead>
                     <tbody>
    {Object.keys(finalizedSchedule).sort((a, b) => {
        const aIsVirtual = a.startsWith('D'), bIsVirtual = b.startsWith('D');
        if (aIsVirtual && !bIsVirtual) return 1; 
        if (!aIsVirtual && bIsVirtual) return -1;
        return a.localeCompare(b); // 讓 D017, D018, D019 乖乖照數字排好
    }).map(rowId => {
                              const isVirtual = rowId.startsWith('D');
                              const { score, deductions } = calculateHealthScore(finalizedSchedule[rowId]);
                              const scoreColor = score >= 90 ? '#27ae60' : (score >= 75 ? '#f39c12' : '#c0392b');

                              return (
                                  <tr key={rowId} style={{ borderBottom: '1px solid #eee', background: isVirtual ? '#fafafa' : 'white' }}>
                                      <td style={{ padding: '8px', borderRight: '1px solid #eee', position: 'sticky', left: 0, background: isVirtual ? '#f9f9f9' : 'white', zIndex: 5, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                          <div>
                                              <div style={{fontWeight:'bold', color: isVirtual ? '#888' : '#2c3e50'}}>{isVirtual ? '🎲 待認領' : (staffData.find(s=>s.staff_id===rowId)?.name || rowId)}</div>
                                              <div style={{fontSize:'0.75rem', color:'#999'}}>{rowId}</div>
                                          </div>
                                          {/* ★ 拔除名字按鈕 */}
                                          {!isVirtual && (
                                              <button onClick={() => handleUnassignSingleStaff(rowId)} style={{ padding: '4px 8px', background: '#ffebee', color: '#c62828', border: '1px solid #ffcdd2', borderRadius: '4px', cursor: 'pointer', fontSize: '0.75rem', fontWeight: 'bold' }}>
                                                  拔除釋出
                                              </button>
                                          )}
                                      </td>
                                      <td style={{ padding: '4px', textAlign: 'center', fontWeight: 'bold', color: scoreColor, borderRight: '2px solid #ddd', cursor: 'help' }} title={deductions.join('\n')}>{score}</td>
                                     {daysArray.map(d => {
                                          const cellData = finalizedSchedule[rowId]?.[d];
                                          const type = (typeof cellData === 'object') ? cellData.type : (cellData || '');
                                          const optionInfo = shiftOptions.find(o => o.code === type) || { color: '#fff' };
                                          return (
                                              <td key={d} style={{ padding: 0, borderRight: '1px solid #f0f0f0', height: '40px' }}>
                                                  <select value={type} onChange={(e) => handleCellChange(rowId, d, e.target.value)} style={{ width: '100%', height: '100%', padding: 0, border: 'none', background: optionInfo.color, color: 'black', fontWeight: 'bold', textAlignLast: 'center', cursor: 'pointer', appearance: 'none', borderRadius: 0 }}>
                                                      {shiftOptions.map(opt => <option key={opt.code} value={opt.code} style={{background:'white', color:'black'}}>{opt.code}</option>)}
                                                  </select>
                                              </td>
                                          )
                                      })}
                                  </tr>
                              );
                          })}
                      </tbody>
                  </table>
                )}
              </div>
            </div>

            {/* 右側：風險與法遵監控 (原封不動從舊版搬過來) */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '15px', overflow: 'hidden' }}>
               <div style={{ flex: 1, background: 'white', borderRadius: '16px', padding: '1.5rem', display:'flex', flexDirection:'column', borderLeft:'4px solid #e74c3c', boxShadow: '0 4px 6px rgba(0,0,0,0.05)', overflow: 'hidden' }}>
                  <h2 style={{ margin: '0 0 1rem 0', fontSize: '1.1rem', color: '#c0392b' }}>⚖️ 法遵檢查結果</h2>
                  <div style={{ flex: 1, overflowY: 'auto' }}>
                     {violations.length === 0 ? <div style={{ color: '#27ae60', textAlign:'center', marginTop:'20px', fontWeight:'bold' }}>✅ 無勞基法違規</div> : violations.map((v, i) => (
                           <div key={i} style={{ padding: '8px', background: '#fff5f5', marginBottom: '8px', borderRadius: '8px', borderLeft: '3px solid #e74c3c', fontSize: '0.85rem' }}>
                             <div style={{fontWeight:'bold', color:'#c0392b'}}>{v.staffName}</div>
                             <div style={{ color: '#444', marginTop: '4px', lineHeight: '1.4' }}>Day {v.day}: {v.message}</div>
                           </div>
                     ))}
                  </div>
               </div>
               <div style={{ flex: 1, background: 'white', borderRadius: '16px', padding: '1.5rem', display:'flex', flexDirection:'column', borderLeft:'4px solid #f39c12', boxShadow: '0 4px 6px rgba(0,0,0,0.05)', overflow: 'hidden' }}>
                  <h2 style={{ margin: '0 0 1rem 0', fontSize: '1.1rem', color: '#d35400' }}>⚠️ 壓力風險監控</h2>
                  <div style={{ flex: 1, overflowY: 'auto' }}>
                     {(!scheduleRisks || scheduleRisks.length === 0) ? <div style={{ color: '#f39c12', textAlign:'center', marginTop:'20px', fontWeight:'bold' }}>✨ 團隊負荷平均</div> : scheduleRisks.map((risk, i) => (
                           <div key={i} style={{ padding: '8px', background: '#fdf8e3', marginBottom: '8px', borderRadius: '8px', fontSize:'0.85rem' }}>
                             <div style={{fontWeight:'bold', color:'#8a6d3b'}}>{risk.staffName}</div>
                             {risk.tags.map((tag, j) => (<div key={j} style={{color:'#666'}}>- {tag.label}</div>))}
                           </div>
                     ))}
                  </div>
               </div>
            </div>
        </div>
      </div>
    );
};

const ManagerInterface = ({
  staffData, setStaffData, historyData, requirements, setRequirements,
  preferences, setPreferences, schedule, violations,
  scheduleRisks,bedConfig, setBedConfig,
  shiftOptions, setShiftOptions, priorityConfig, setPriorityConfig, publicHolidays, 
  selectedYear, setSelectedYear, 
  selectedMonth, setSelectedMonth,
  onGenerateSchedule, onSaveSchedule, setSchedule, 
  finalizedSchedule, 
  setFinalizedSchedule,healthStats, onUpdateHealthStats,historyYear, historyMonth, setHistoryYear, setHistoryMonth, historySchedule, setHistorySchedule,onPushToHistory,accumulatedReports, setAccumulatedReports, onManualRefresh, calculateAndNotifyNextStaff, // 👈 ★ 這裡要接住 // 👈 補上這兩個變數！ // 👈 補上這行
}) => {
  const [activeTab, setActiveTab] = useState('requirements');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      
      <div style={{ background: 'rgba(255,255,255,0.95)', borderRadius: '16px', padding: '1rem', display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
        {['requirements', 'staff', 'schedule', 'publish','review', 'statistics', 'simulation'].map(tab => (
          <button 
            key={tab} 
            onClick={() => setActiveTab(tab)} 
            style={{
              flex: 1, padding: '1rem', border: 'none', borderRadius: '10px', cursor: 'pointer',
              fontWeight: 'bold', transition: 'all 0.2s',
              background: activeTab === tab ? '#667eea' : 'transparent', 
              color: activeTab === tab ? 'white' : '#666',
              boxShadow: activeTab === tab ? '0 4px 6px rgba(102, 126, 234, 0.3)' : 'none'
            }}
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
           
           // 改吃專屬的歷史狀態
           historyYear={historyYear} historyMonth={historyMonth}
           setHistoryYear={setHistoryYear} setHistoryMonth={setHistoryMonth}
           historySchedule={historySchedule} setHistorySchedule={setHistorySchedule}
        />
      )}
      
      {activeTab === 'statistics' && (
        <StatisticsPanel staffData={staffData} priorityConfig={priorityConfig} setPriorityConfig={setPriorityConfig} 
        healthStats={healthStats} // ★ 傳遞歷年數據給報表畫圖
        accumulatedReports={accumulatedReports}       // 👈 補上：把雲端抓下來的報表傳進去
            setAccumulatedReports={setAccumulatedReports} // 👈 補上：讓面板可以清空記憶
            // 🌟 ★★★ 這裡再往下傳給 StatisticsPanel ★★★
            calculateAndNotifyNextStaff={calculateAndNotifyNextStaff}
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
// ============================================================================
// 人力需求設定面板 (含：年月選擇器 + 儲存按鈕)
// ============================================================================
const NurseSchedulingSystem = () => {
  const [currentUser, setCurrentUser] = useState(null);




// --- 1. 雲端狀態宣告 (等待 Firebase 載入) ---
  const [isCloudLoaded, setIsCloudLoaded] = useState(false);
  // ★★★ 新增：Admin 密碼狀態與修改視窗 ★★★

  const [showAdminPwdModal, setShowAdminPwdModal] = useState(false);
  const [adminPwdData, setAdminPwdData] = useState({ old: '', new: '', confirm: '' });
  const [adminPwdMsg, setAdminPwdMsg] = useState({ type: '', text: '' });
  // ★★★ 新增 1：儲存健康度歷史數據的狀態 ★★★
  const [healthStats, setHealthStats] = useState([]); 

  // ★★★ 新增 2：計算並更新當月健康度的函式 ★★★
  const handleUpdateHealthStats = (year, month, avg, median) => {
      setHealthStats(prev => {
          const newData = [...prev];
          const existingIndex = newData.findIndex(d => d.year === year && d.month === month);
          if (existingIndex >= 0) {
              newData[existingIndex] = { year, month, avg, median };
          } else {
              newData.push({ year, month, avg, median });
          }
          // 依照年月排序，並只保留最近 12 個月
          newData.sort((a, b) => (a.year - b.year) || (a.month - b.month));
          return newData.slice(-12); 
      });
  };


  const [shiftOptions, setShiftOptions] = useState([
    { code: 'D', name: '白班', color: '#FFD93D', time: '08:00-16:00' },
    { code: 'E', name: '小夜', color: '#FF6B9D', time: '16:00-24:00' },
    { code: 'N', name: '大夜', color: '#4D96FF', time: '00:00-08:00' },
    { code: 'RG', name: '例假', color: '#2ecc71', time: '例假' }, 
    { code: 'RC', name: '休假', color: '#d5f5e3', time: '休假' },
    { code: 'OFF', name: '空班', color: '#E8E8E8', time: '空班' },
    { code: '支援', name: '支援', color: '#D4AC0D', time: '09:00-18:00' },
    { code: '事假', name: '事假', color: '#95a5a6', time: '扣全薪' }, // ✨ 新增
    { code: '病假', name: '病假', color: '#bdc3c7', time: '扣半薪' }, // ✨ 新增
     { code: '特休', name: '特休', color: '#9af33b', time: '全薪' }, // ✨ 新增

  ]);
  const [priorityConfig, setPriorityConfig] = useState({ types: ['accumulated_ot'], count: 5, isOpenToAll: false });
  const [staffData, setStaffData] = useState([]);
  const [schedule, setSchedule] = useState(null);
  const [finalizedSchedule, setFinalizedSchedule] = useState(null);
  // 修改後（從 localStorage 讀正確的發布月份）
const [publishedDate, setPublishedDate] = useState({ year: 2026, month: 2 });
  // --- 2. 本機暫存狀態 (不需上雲端) ---
  const [historyData, setHistoryData] = useState([]);
const [requirements, setRequirements] = useState({ D: 15, E: 12, N: 8 });
  // ★ 新增這行：把病床與護病比的狀態提升到最高層
  const [bedConfig, setBedConfig] = useState({ bedCount: 50, ratioD: 10, ratioE: 12, ratioN: 15 });
  const [preferences, setPreferences] = useState({});
  const [violations, setViolations] = useState([]);
  const [scheduleRisks, setScheduleRisks] = useState([]); // ★ 新增這行
  const [selectedMonth, setSelectedMonth] = useState(() => Number(localStorage.getItem('selectedMonth')) || 2);
  const [selectedYear, setSelectedYear] = useState(() => Number(localStorage.getItem('selectedYear')) || 2026);
// ★★★ 新增以下這三行：專供「結算與歷史(Tab 3)」使用的獨立狀態 ★★★
  const [historyMonth, setHistoryMonth] = useState(() => {
  const m = Number(localStorage.getItem('selectedMonth')) || new Date().getMonth() + 1;
  return m === 1 ? 12 : m - 1;
});
const [historyYear, setHistoryYear] = useState(() => {
  const m = Number(localStorage.getItem('selectedMonth')) || new Date().getMonth() + 1;
  const y = Number(localStorage.getItem('selectedYear'))  || new Date().getFullYear();
  return m === 1 ? y - 1 : y;
});
  const [historySchedule, setHistorySchedule] = useState({});
  const [accumulatedReports, setAccumulatedReports] = useState({});
  
  useEffect(() => { localStorage.setItem('selectedYear', selectedYear); }, [selectedYear]);
  useEffect(() => { localStorage.setItem('selectedMonth', selectedMonth); }, [selectedMonth]);

  // ★★★ 新增：自動抓取台灣國定假日 API ★★★
  const [publicHolidays, setPublicHolidays] = useState([]);
  
  useEffect(() => {
    const fetchHolidays = async () => {
      try {
        // 使用開源的台灣行事曆 JSON 資料
        const res = await fetch(`https://cdn.jsdelivr.net/gh/ruyut/TaiwanCalendar/data/${selectedYear}.json`);
        const data = await res.json();
        
        // 過濾出「放假」且「有描述 (代表是國定假日或補假，而非一般週休二日)」的日期
        const holidays = data
            .filter(d => d.isHoliday && d.description !== "")
            .map(d => d.date); // 格式為 "YYYYMMDD"
            
        setPublicHolidays(holidays);
      } catch (error) {
        console.error("無法抓取國定假日，使用預設空陣列:", error);
        setPublicHolidays([]);
      }
    };
    fetchHolidays();
  }, [selectedYear]);
    // 🌟 核心修復：當 Firebase 成功把員工名單下載下來後，自動替換掉「載入中...」的假名字
  useEffect(() => {
      if (currentUser && currentUser.role === 'staff' && staffData.length > 0) {
          const realStaff = staffData.find(s => s.staff_id === currentUser.id);
          
          if (realStaff && currentUser.name !== realStaff.name) {
              setCurrentUser(prev => ({ 
                  ...prev, 
                  name: realStaff.name, 
                  rule: realStaff.special_status === 'Standard' ? 'Standard' : 'BiWeekly' 
              }));
          }
      }
  }, [staffData, currentUser]);
  
  // ... 下面保留你原本的 useState 宣告 ...

// ★★★ 法遵檢查、安全防護與風險掃描自動化引擎 ★★★
  useEffect(() => {
    const targetSchedule = finalizedSchedule || schedule; 
    if (targetSchedule && Object.keys(targetSchedule).length > 0) {
      
      // 1. 跑硬性違規檢查 (勞基法紅燈)
      const lawViolations = checkLaborLawCompliance(targetSchedule, staffData, historyData, selectedYear, selectedMonth);
      
      // 2. 跑護理專業安全檢查 (資歷搭配紅燈) ★ 這裡呼叫我們剛寫的引擎
      const mixViolations = checkSkillMixSafety(targetSchedule, staffData, selectedYear, selectedMonth);
      
      // 將兩種警告合併顯示
      setViolations([...lawViolations, ...mixViolations]);
      
      // 3. 跑軟性風險掃描 (壓力與公平性黃燈)
      const newRisks = calculateScheduleRisks(targetSchedule, staffData, publicHolidays, selectedYear, selectedMonth);
      setScheduleRisks(newRisks);
      
    } else {
      setViolations([]);
      setScheduleRisks([]);
    }
  }, [schedule, finalizedSchedule, staffData, selectedYear, selectedMonth, publicHolidays]);
// ☁️ 雲端引擎 1：即時讀取 (使用抽象化 API)
  useEffect(() => {
    // 🌟 1. 核心修復：把安全門加回來！沒有登入的人，絕對不准去要資料！
    if (!currentUser) return; 

    let isSettingsLoaded = false; let isStaffLoaded = false; let isScheduleLoaded = false;
    const checkAllLoaded = () => { if (isSettingsLoaded && isStaffLoaded && isScheduleLoaded) setIsCloudLoaded(true); };

    // 2. 登入成功後，開始安全地下載所有資料
    const unsubSettings = subscribeToSettings((data) => {
      if (data) {
        if (data.shiftOptions) setShiftOptions(data.shiftOptions);
        if (data.priorityConfig) setPriorityConfig(data.priorityConfig);
        if (data.requirements) setRequirements(data.requirements);
        if (data.bedConfig) setBedConfig(data.bedConfig);
        if (data.publishedDate) {
          setPublishedDate(prev => {
            if (prev.year === data.publishedDate.year && prev.month === data.publishedDate.month) return prev;
            return data.publishedDate;
          });
        }
      }
      isSettingsLoaded = true; checkAllLoaded();
    });

    const unsubStaff = subscribeToStaff((data) => {
      if (data) {
        if (data.staffData) setStaffData(data.staffData);
        if (data.healthStats) setHealthStats(data.healthStats);
      }
      isStaffLoaded = true; checkAllLoaded();
    });

    const scheduleYear  = currentUser.role === 'admin' ? selectedYear  : publishedDate.year;
    const scheduleMonth = currentUser.role === 'admin' ? selectedMonth : publishedDate.month;

    const unsubSchedule = subscribeToSchedule(scheduleYear, scheduleMonth, (data) => {
      if (data) {
        setSchedule(data.schedule || {});
        setFinalizedSchedule(data.finalizedSchedule || null); 
      } else {
        setSchedule({}); setFinalizedSchedule(null);
      }
      isScheduleLoaded = true; checkAllLoaded();
    });

    const unsubHistory = subscribeToSchedule(historyYear, historyMonth, (data) => {
        setHistorySchedule(data?.finalizedSchedule || {});
    });
    
    const unsubReports = subscribeToArchiveReports((data) => {
        setAccumulatedReports(data);
    });

    return () => { unsubSettings(); unsubStaff(); unsubSchedule(); unsubHistory(); unsubReports(); setIsCloudLoaded(false); };
    
  }, [selectedYear, selectedMonth, historyYear, historyMonth, currentUser, publishedDate.year, publishedDate.month]);
  // ☁️ 雲端引擎 2：自動寫入 (加入終極安全防護)
  useEffect(() => {
    if (!isCloudLoaded || !currentUser || currentUser.role !== 'admin') return; 

    const timeoutId = setTimeout(() => {
        
        // ★ 核心修復 2：絕對禁止把「空畫面」寫入雲端覆蓋掉別人的心血！
        if (schedule && Object.keys(schedule).length > 0) {
            saveMonthlySchedule(selectedYear, selectedMonth, {
              schedule: schedule
              // ★ 警告：絕對不能在這裡自動寫入 finalizedSchedule，只能由發布按鈕寫入！
            });
        }

        saveGlobalSettings({
          shiftOptions: shiftOptions || [],
          priorityConfig: priorityConfig || {},
          requirements: requirements || { D: 15, E: 12, N: 8 },
          bedConfig: bedConfig || { bedCount: 50, ratioD: 10, ratioE: 12, ratioN: 15 }
          // ★ 警告：絕對不能在這裡寫入 publishedDate，只能由發布按鈕寫入！
        });

        saveGlobalStaff({
          staffData: staffData || [],
          healthStats: healthStats || []
        });
        
    }, 2000); 

    return () => clearTimeout(timeoutId);

  // ★ 核心修復 3：移除了 finalizedSchedule 與 publishedDate 的依賴，徹底打破無限覆蓋迴圈
  }, [shiftOptions, priorityConfig, staffData, schedule, healthStats, isCloudLoaded, currentUser, selectedYear, selectedMonth]);
const handleGenerateSchedule = (providedSchedule = null) => {
    let newSchedule = providedSchedule;
    if (!newSchedule) { return; }
    if (newSchedule) {
        setSchedule(newSchedule);
        setFinalizedSchedule(null); // ★★★ 關鍵修復 1：生成新班表時，連帶把發布區的幽靈資料殺掉
        const newViolations = checkLaborLawCompliance(newSchedule, staffData, historyData, selectedYear, selectedMonth);
        setViolations(newViolations);
    }
  };

const handlePushToHistory = async () => {
    if (!finalizedSchedule || Object.keys(finalizedSchedule).length === 0) {
        alert("目前沒有發布的班表可供封存！");
        return;
    }
    if (!window.confirm(`確定要將 ${selectedYear}年${selectedMonth}月 的班表結算並封存嗎？\n\n⚠️ 執行後：\n1. 此班表將移至「✅ 3. 結算與歷史」\n2. 若歷史區已有舊班表，舊班表將先備份至雲端封存庫\n3. 發布區將被清空\n4. 系統將自動切換至下一個月，準備新的排班`)) return;

// ★ 步驟 1：若歷史區已有舊班表，先將它 archive 到 Firebase 再覆蓋
    if (historySchedule && Object.keys(historySchedule).length > 0) {
        try {
            // 🌟 ★★★ 核心修復：改用智能 JSON 備份，不再產生會覆蓋健康度的笨蛋 CSV ★★★ 🌟
            await backupScheduleToArchive(
                historyYear, 
                historyMonth, 
                historySchedule, 
                "歷史區舊班表被覆蓋前自動歸檔"
            );
            console.log(`✅ 舊班表 ${historyYear}年${historyMonth}月 已成功備份至雲端封存庫`);
        } catch (e) {
            console.error("❌ 舊班表備份失敗:", e);
            // 備份失敗不阻斷主流程
        }
    }

    // ★ 步驟 2：把目前發布的班表放入歷史區（覆蓋舊的）
    setHistoryYear(selectedYear);
    setHistoryMonth(selectedMonth);
    setHistorySchedule(finalizedSchedule);

    // ★ 步驟 3：計算並切換到下個月
    let nextMonth = selectedMonth + 1;
    let nextYear = selectedYear;
    if (nextMonth > 12) { nextMonth = 1; nextYear++; }

    setSelectedYear(nextYear);
    setSelectedMonth(nextMonth);
    const newPubDate = { year: nextYear, month: nextMonth };
    setPublishedDate(newPubDate);
    localStorage.setItem('publishedDate', JSON.stringify(newPubDate));

    // ★ 步驟 4：清空草稿工作桌與發布區
    setSchedule({});
    setFinalizedSchedule(null);

    alert(`✅ 封存成功！\n${selectedYear}年${selectedMonth}月 班表已移至「結算與歷史」。\n系統已為您切換至 ${nextYear}年${nextMonth}月。`);
  };

const handleLogout = () => {
  signOut(auth).then(() => {
    // ★ 核心修復：登出時，把瀏覽器裡面所有記住的髒東西全部炸掉！
    localStorage.clear(); 
    window.location.reload(); // 強制重整網頁，回到最乾淨的狀態
  }).catch((error) => {
    console.error("登出失敗:", error);
  });
};
// ★ 核心功能 1：寄送 Email 的共用小幫手
  const sendSystemEmail = async (toEmail, subject, htmlContent) => {
      try {
          await fetch('/api/sendEmail', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ to: toEmail, subject, html: htmlContent })
          });
      } catch (error) {
          console.error("Email 發送失敗:", error);
      }
  };

  // ★ 核心功能 2：AI 動態決策下一位優先選班者
  const calculateAndNotifyNextStaff = async (currentSchedule, statsData, currentYear, currentMonth) => {
      try {
          // 1. 抓取「已經選過」的黑名單 (已完賽標記)
          const progressRef = doc(db, "SelectionProgress", `${currentYear}_${currentMonth}`);
          const snap = await getDoc(progressRef);
          const submittedList = snap.exists() ? (snap.data().submitted_staff || []) : [];

          // 2. 篩選出「尚未選班」的活躍員工
          const unassignedStaff = staffData.filter(s => s.is_active && !submittedList.includes(s.staff_id));

          // 3. 終止條件：所有人都選完了！
          if (unassignedStaff.length === 0) {
              const adminEmail = staffData.find(s => s.staff_id === 'admin')?.email || 'your-admin-email@hospital.com';
              await sendSystemEmail(adminEmail, `✅ ${currentMonth}月 班表全數認領完畢！`, `<h3>報告護理長：</h3><p>本月所有同仁皆已完成班表選擇，請登入系統進行最終確認與結算。</p>`);
              return;
          }

          // 4. 準備大數據給 AI (給定尚未選班者的歷史健康度、OT、夜班餘額)
          const scores = statsData.map(stat => stat.score || 100);
          const average = scores.length > 0 ? Math.round(scores.reduce((sum, val) => sum + val, 0) / scores.length) : 100;

          let aiPrompt = `【自動接力選班決策】\n團隊歷史平均健康度: ${average}分\n`;
          
          // ★ 新增：如果護理長有設定條件，強制寫入最高指導原則
          if (priorityConfig && priorityConfig.relayInstruction) {
              aiPrompt += `[管理員最高指導原則]：${priorityConfig.relayInstruction}\n\n`;
          }

 aiPrompt += `尚未選班之候選人現況：\n`;
          unassignedStaff.forEach(staff => {
              // 1. 提取所有員工管理面板的特徵
              const historyScore = statsData.find(s => s.staff_id === staff.staff_id)?.score || 100;
              const gender = staff.gender || '女'; 
              const level = staff.level || 'N0';
              const isLeader = (staff.is_leader === true || staff.is_leader === 'True') ? '是' : '否';
              const isPregnant = (staff.is_pregnant_or_nursing === true || staff.is_pregnant_or_nursing === 'True') ? '是' : '否';
              const canNight = (staff.can_night_shift === false || staff.can_night_shift === 'false') ? '否' : '是';
              const workHours = staff.special_status === 'BiWeekly' ? '雙週變形' : '標準';
              const leaveStatus = staff.leave_status === 'None' ? '無' : staff.leave_status;
              
              // 2. 組合成超詳細的 AI 認知字串
             // ✅ 替換為這行：
aiPrompt += `- [${staff.staff_id} ${staff.name}] 性別:${gender} | 職級:${level} | 孕/哺乳:${isPregnant} | 組長:${isLeader} | 可上夜班:${canNight} | 工時制:${workHours} | 特殊狀態:${leaveStatus} | 年資:${staff.tenure_years || 0}年 | 歷史健康度(疲勞值):${historyScore}分 | 積假餘額:${staff.accumulated_ot} | 夜班結餘:${staff.night_shift_balance}\n`;
          });

         aiPrompt += `\n請根據上述數據與原則，選出「最符合條件、最需要優先選班」的 1 位員工。
⚠️ 【最高系統原則】：若名單中有「孕/哺乳:是」的員工，無論其疲勞度為何，【必須】讓她們絕對優先選班，以確保她們能選到合法之日班班表！
若無孕婦且無特殊指導原則，則預設找最疲勞者。
請務必只以 JSON 格式回覆：{"selected_staff_id": "N00X", "reason": "你的判斷理由"}`;
          // 5. 呼叫 Gemini 進行決策
          const token = await auth.currentUser.getIdToken();
          const response = await fetch('/api/gemini', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
              body: JSON.stringify({ prompt: aiPrompt })
          });
          const data = await response.json();
          const text = data.text.replace(/```json|```/g, '').trim();
          const decision = JSON.parse(text);

          // 6. 寫入 AI Data Log 背景紀錄
          await addDoc(collection(db, "AI_Decision_Logs"), {
              timestamp: new Date(), year: currentYear, month: currentMonth,
              selected_staff: decision.selected_staff_id, ai_logic: decision.reason, candidates_data: aiPrompt
          });

          // 7. 更新發球權狀態機
          await setDoc(doc(db, "SelectionTurn", `${currentYear}_${currentMonth}`), {
              active_staff_id: decision.selected_staff_id, updatedAt: new Date()
          });

          // 8. 抓取該員工 Email 並寄出通知
          const targetStaff = staffData.find(s => s.staff_id === decision.selected_staff_id);
          if (targetStaff && targetStaff.email) {
              await sendSystemEmail(
                  targetStaff.email, 
                  `🌟 ${targetStaff.name} 優先選班通知！現在輪到您了！`, 
                  `<h3>親愛的 ${targetStaff.name}：</h3><p>系統已開放您的選班權限！</p><p><strong>🤖 系統判斷讓您先選的理由：</strong><br/>${decision.reason}</p><p>請盡速登入系統完成選班，以利下一位同仁進行，謝謝！</p>`
              );
          }

      } catch (error) {
          console.error("AI 決策接力失敗:", error);
      }
  };
// ★★★ 核心修復：員工認領班表 (解決重複寫入與疊加問題) ★★★
  const handleStaffScheduleUpdate = async (result) => { 
    try {
        // 1. 🛑 寫入前，先向 Firebase 索取「最熱騰騰」的最新班表
        const docRef = doc(db, 'Schedules', `${publishedDate.year}_${publishedDate.month}`);
        const snap = await getDoc(docRef);

        if (!snap.exists()) {
            alert("❌ 找不到該月份的班表資料！");
            return;
        }

        const latestData = snap.data();
        const latestSchedule = latestData.finalizedSchedule || {};

        // 2. 🛑 檢查想要認領的班表，是不是剛剛被別人搶走了？
        const targetVirtualId = result.chosenSchedule?.id;
        if (targetVirtualId && !latestSchedule[targetVirtualId]) {
            alert("⚠️ 慢了一步！這個班表剛剛被別人選走了！\n系統將為您重新整理畫面，請選擇其他班表。");
            window.location.reload(); 
            return;
        }

        // 3. 基於雲端的「最新資料」進行修改：加入新員工
        const next = { ...latestSchedule };
        next[result.staffId] = result.fullMonthData; 
        
        // 4. ★ 最重要的一步：從物件中徹底刪除舊的空缺班表 (例如 D001)
        if (targetVirtualId && next[targetVirtualId]) {
            delete next[targetVirtualId]; 
        } else {
            const fallbackId = Object.keys(next).find(k => k.startsWith('D'));
            if (fallbackId) delete next[fallbackId];
        }

        // 5. 更新本地畫面
        setFinalizedSchedule(next); 

        // 更新員工資料 (維持原樣)
        setStaffData(prevData => {
          const exists = prevData.find(s => s.staff_id === result.staffId);
          if (exists) return prevData;
          return [...prevData, { 
            staff_id: result.staffId, name: result.staffName, 
            special_status: result.shiftType === 'D' ? 'Standard' : 'BiWeekly', 
            is_active: true, accumulated_ot: 0, night_shift_balance: 0,
            prevMonthLeave: [false,false,false,false,false,false,false]
          }];
        });

// 6. 透過剛剛修正過的 API 寫入雲端，徹底覆蓋欄位！
        await updateStaffSchedule(publishedDate.year, publishedDate.month, next);
        
        // 🌟 ★★★ 關鍵修復：把該員工加入黑名單，並觸發 AI 找下一個人 ★★★
        try {
            const progressRef = doc(db, "SelectionProgress", `${publishedDate.year}_${publishedDate.month}`);
            await setDoc(progressRef, {
                submitted_staff: arrayUnion(result.staffId)
            }, { merge: true });
            
            // 背景呼叫 AI，不卡住畫面
            await calculateAndNotifyNextStaff(next, healthStats, publishedDate.year, publishedDate.month);
        } catch (e) {
            console.error("交棒失敗:", e);
        }
        // =========================================================
        // 🌟 關鍵修復：員工送出後，將其鎖定，並立刻觸發接力棒交給下一個人！
        // =========================================================
        try {
            // A. 把這名員工加入本月的「已完賽黑名單」，確保 AI 之後不會再選到他
            const progressRef = doc(db, "SelectionProgress", `${publishedDate.year}_${publishedDate.month}`);
            await setDoc(progressRef, {
                submitted_staff: arrayUnion(result.staffId) 
            }, { merge: true });

            // B. 背景呼叫 AI 決策引擎 (尋找下一位最需要補血的人並寄信)
            if (typeof calculateAndNotifyNextStaff === 'function') {
                calculateAndNotifyNextStaff(next, healthStats, publishedDate.year, publishedDate.month);
            } else {
                console.warn("⚠️ 找不到 calculateAndNotifyNextStaff 函式，無法自動交棒。");
            }
        } catch (e) {
            console.error("交棒處理失敗:", e);
        }
        // =========================================================

        alert(`✅ 認領成功！\n員工 ${result.staffName} 已確認班表，系統正自動計算並通知下一位同仁。`);
        
    } catch (error) {
        console.error("寫入失敗:", error);
        alert("❌ 認領失敗：權限不足或網路異常。");
    }
  } // <-- 這是 handleStaffScheduleUpdate 的結尾

  // 🔄 手動強制同步最新雲端班表
  const handleManualRefresh = async () => {
    try {
      // 顯示讀取中的提示 (可選，讓使用者知道有在跑)
      console.log("🔄 正在向雲端請求最新資料...");
      
      // 直接向 Firebase 請求目前選擇的「年_月」的真實資料
      const docRef = doc(db, 'Schedules', `${selectedYear}_${selectedMonth}`);
      const snap = await getDoc(docRef);

      if (snap.exists()) {
        const data = snap.data();
        setSchedule(data.schedule || {});
        setFinalizedSchedule(data.finalizedSchedule || null);
        alert(`✅ 已成功從雲端同步 ${selectedYear} 年 ${selectedMonth} 月的最新班表！`);
      } else {
        setSchedule({});
        setFinalizedSchedule(null);
        alert(`☁️ 雲端目前沒有 ${selectedYear} 年 ${selectedMonth} 月的班表資料。`);
      }
    } catch (error) {
      console.error("手動同步失敗:", error);
      alert("❌ 同步失敗，請檢查網路連線或權限設定。");
    }
  };

const handleSaveAndPublish = async () => {
    if (!schedule || Object.keys(schedule).length === 0) {
      alert("❌ 目前沒有班表內容，無法儲存！");
      return;
    }

    
    const newFinalized = JSON.parse(JSON.stringify(schedule));

    
    const newPubDate = { year: selectedYear, month: selectedMonth };
    setPublishedDate(newPubDate);
    localStorage.setItem('publishedDate', JSON.stringify(newPubDate));

    // ★★★ 強制立即存檔到雲端，不等待 2 秒防抖機制 ★★★
    try {
        await saveGlobalSettings({
            shiftOptions: shiftOptions || [],
            priorityConfig: priorityConfig || {},
            requirements: requirements || { D: 15, E: 12, N: 8 },
            bedConfig: bedConfig || { bedCount: 50, ratioD: 10, ratioE: 12, ratioN: 15 },
            publishedDate: newPubDate
        });
        await saveMonthlySchedule(selectedYear, selectedMonth, {
            schedule: schedule || {},
            finalizedSchedule: newFinalized
        });
    } catch(e) {
        console.error("發布至雲端失敗:", e);
    }
    
    alert(`✅ 班表已鎖定並發布！\n員工登入後將看到 [${selectedYear}年${selectedMonth}月] 的班表。`);
  };

// ★★★ 安全升級：串接 Firebase Auth 進行管理員密碼修改 ★★★
  const handleAdminPasswordSubmit = async (e) => {
      e.preventDefault();

      // 1. 基本防呆與強度檢查
      if (adminPwdData.new !== adminPwdData.confirm) {
          return setAdminPwdMsg({ type: 'error', text: '兩次輸入的新密碼不一致！' });
      }
      const strongPasswordRegex = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d]{6,}$/;
      if (!strongPasswordRegex.test(adminPwdData.new)) {
          return setAdminPwdMsg({ type: 'error', text: '密碼強度不足：需至少 6 碼，且必須包含英文與數字！' });
      }

      try {
          const user = auth.currentUser;

          if (user) {
              // ★ 核心修補：先用「舊密碼」向 Firebase 進行重新驗證 (防護 Session 劫持)
              const credential = EmailAuthProvider.credential(user.email, adminPwdData.old);
              await reauthenticateWithCredential(user, credential);

              // 驗證通過後，正式更新密碼
              await updatePassword(user, adminPwdData.new);

              setAdminPwdMsg({ type: 'success', text: '✅ 管理員密碼修改成功！下次請使用新密碼登入。' });

              setTimeout(() => {
                  setShowAdminPwdModal(false);
                  setAdminPwdData({ old: '', new: '', confirm: '' });
                  setAdminPwdMsg({ type: '', text: '' });
              }, 2000);
          } else {
              setAdminPwdMsg({ type: 'error', text: '找不到登入狀態，請重新登入。' });
          }
      } catch (error) {
          // 在 Production 環境隱藏詳細錯誤碼，避免資安外洩
          if (import.meta.env.DEV) {
              console.error("修改密碼失敗:", error);
          }

          if (error.code === 'auth/invalid-credential' || error.code === 'auth/wrong-password') {
              setAdminPwdMsg({ type: 'error', text: '❌ 舊密碼輸入錯誤，請重新確認！' });
          } else if (error.code === 'auth/requires-recent-login') {
              setAdminPwdMsg({ type: 'error', text: '⚠️ 基於安全考量，請先「登出再重新登入」後，才能修改密碼。' });
          } else {
              setAdminPwdMsg({ type: 'error', text: '修改失敗：' + error.message });
          }
      }
  };

  if (!currentUser) {
return <LoginPanel onLogin={setCurrentUser} staffData={staffData} />; // ★ 傳入 adminPassword
  }

  return (
    <div style={{ minHeight: '100vh', background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', padding: '2rem', fontFamily: 'sans-serif' }}>
      {/* ★★★ 新增：Admin 修改密碼 Modal ★★★ */}
      {showAdminPwdModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
            <div style={{ background: 'white', padding: '2rem', borderRadius: '16px', width: '90%', maxWidth: '400px', position: 'relative' }}>
                <button onClick={() => setShowAdminPwdModal(false)} style={{ position: 'absolute', top: '10px', right: '15px', background: 'none', border: 'none', fontSize: '1.2rem', cursor: 'pointer', color: '#666' }}>✖</button>
                <h3 style={{ marginTop: 0, color: '#333' }}>⚙️ 修改管理員密碼</h3>
                <form onSubmit={handleAdminPasswordSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '15px', marginTop: '15px' }}>
                    <div>
                        <label style={{ fontSize: '0.85rem', color: '#666', marginBottom: '5px', display: 'block' }}>舊密碼</label>
                        <input type="password" value={adminPwdData.old} onChange={e=>setAdminPwdData({...adminPwdData, old: e.target.value})} required style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid #ddd', boxSizing: 'border-box' }} />
                    </div>
                    <div>
                        <label style={{ fontSize: '0.85rem', color: '#666', marginBottom: '5px', display: 'block' }}>新密碼</label>
                        <input type="password" value={adminPwdData.new} onChange={e=>setAdminPwdData({...adminPwdData, new: e.target.value})} required minLength="4" style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid #ddd', boxSizing: 'border-box' }} />
                    </div>
                    <div>
                        <label style={{ fontSize: '0.85rem', color: '#666', marginBottom: '5px', display: 'block' }}>確認新密碼</label>
                        <input type="password" value={adminPwdData.confirm} onChange={e=>setAdminPwdData({...adminPwdData, confirm: e.target.value})} required minLength="4" style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid #ddd', boxSizing: 'border-box' }} />
                    </div>
                    {adminPwdMsg.text && (
                        <div style={{ color: adminPwdMsg.type === 'error' ? '#e74c3c' : '#27ae60', background: adminPwdMsg.type === 'error' ? '#fdecea' : '#e8f8f5', padding: '10px', borderRadius: '8px', fontSize: '0.9rem' }}>
                            {adminPwdMsg.text}
                        </div>
                    )}
                    <button type="submit" style={{ padding: '12px', background: '#667eea', color: 'white', border: 'none', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer', marginTop: '10px' }}>儲存修改</button>
                </form>
            </div>
        </div>
      )}

      <div style={{ maxWidth: '1400px', margin: '0 auto 2rem', background: 'rgba(255,255,255,0.95)', borderRadius: '16px', padding: '1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <Calendar size={28} color="#667eea" />
            <h1 style={{ margin: 0, fontSize: '1.8rem', color: '#333' }}>智能排班系統</h1>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <span style={{ color: '#555', fontWeight: 'bold' }}>👋 {currentUser.name} {currentUser.role === 'admin' ? '' : ' (護理師)'}</span>
            {/* 就是這裡！判斷如果是 admin 才會顯示這個按鈕 */}
            {currentUser.role === 'admin' && (
                <button onClick={() => setShowAdminPwdModal(true)} style={{ background: '#f8f9fa', border: '1px solid #ddd', padding: '6px 12px', borderRadius: '20px', cursor: 'pointer', fontSize: '0.85rem', color: '#555', fontWeight: 'bold' }}>⚙️ 修改密碼</button>
            )}
            <button onClick={handleLogout} style={{ padding: '0.5rem 1rem', background: '#e74c3c', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer' }}>登出</button>
          </div>
      </div>

      <div style={{ maxWidth: '1400px', margin: '0 auto' }}>
        {currentUser.role === 'admin' ? (
          <ManagerInterface
            staffData={staffData} setStaffData={setStaffData} historyData={historyData}
            requirements={requirements} setRequirements={setRequirements}
            bedConfig={bedConfig} setBedConfig={setBedConfig} // ★ 新增這行傳遞
            preferences={preferences} setPreferences={setPreferences}
            schedule={schedule} violations={violations}
            selectedYear={selectedYear} 
            selectedMonth={selectedMonth}
            onGenerateSchedule={handleGenerateSchedule} 
            setSchedule={setSchedule} setViolations={setViolations}
            setSelectedYear={setSelectedYear}   // <--- 補上這行 (讓子元件能修改年份)
            setSelectedMonth={setSelectedMonth} // <--- 補上這行 (讓子元件能修改月份)
            onSaveSchedule={handleSaveAndPublish}
            shiftOptions={shiftOptions}       // <--- 補上這個
            setShiftOptions={setShiftOptions} // <--- 補上這個
            priorityConfig={priorityConfig}       // <--- 補上
            setPriorityConfig={setPriorityConfig} // <--- 補上
            publicHolidays={publicHolidays} // <--- ★★★ 補上這一行 ★★★
            scheduleRisks={scheduleRisks} // <--- ★★★ 補上這行 ★★★
            finalizedSchedule={finalizedSchedule}       // <--- ★ 補上這行
            setFinalizedSchedule={setFinalizedSchedule} // <--- ★ 補上這行
            healthStats={healthStats}                     // ★★★ 補上這行
            onUpdateHealthStats={handleUpdateHealthStats} // ★★★ 補上這行
            historyYear={historyYear} historyMonth={historyMonth}
            setHistoryYear={setHistoryYear} setHistoryMonth={setHistoryMonth}
            historySchedule={historySchedule} setHistorySchedule={setHistorySchedule}
            onPushToHistory={handlePushToHistory} // 👈 補上這行
            accumulatedReports={accumulatedReports} // 👈 補上這行
            setAccumulatedReports={setAccumulatedReports} // 👈 補上這行，讓面板可以清空記憶
            onManualRefresh={handleManualRefresh}  
            calculateAndNotifyNextStaff={calculateAndNotifyNextStaff}
          />
        ) : (
          <StaffDashboard
          currentUser={currentUser}
            targetYear={publishedDate.year}
  targetMonth={publishedDate.month}
  currentSchedule={finalizedSchedule} 
  onConfirmSchedule={handleStaffScheduleUpdate} 
  staffData={staffData}
  priorityConfig={priorityConfig} // <--- ★★★ 補上這個，用於判斷權限
  setStaffData={setStaffData} // <--- ★★★ 補上這行：讓員工有權限改自己密碼 ★★★
          />
        )}
      </div>
    </div>
  );
};

// ============================================================================
// 子元件區 (ManagerInterface) - 負責管理分頁切換
// ============================================================================
export default NurseSchedulingSystem;