import React, { useState, useEffect, useRef } from 'react';
import { Calendar, Users, Clock, AlertCircle, CheckCircle, Download, Upload, Moon, Sun, Sunset, Search, Filter, Settings, Bell, FileText, TrendingUp, Award, Trash2 } from 'lucide-react';

import { initializeApp } from "firebase/app";
import { getFirestore, doc, setDoc, onSnapshot } from "firebase/firestore";
// ★ 新增：引入 Firebase Auth 功能
import { getAuth, signInWithEmailAndPassword } from "firebase/auth";


// ============================================================================
// Firebase 設定區 (安全升級版：使用環境變數)
// ============================================================================
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID
};
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
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

    // 用來計算每週工時 (以週一為起始)
    let currentWeekHours = 0;
    
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
      }
      
      currentWeekHours += dailyHours;
      
      if (currentWeekHours > 40) {
          // 為了避免同一週每天都報錯，只在剛超過那天報錯，或者顯示累計
          // 這裡簡單處理：只要發現累積 > 40 就提示，通常會發生在第 6 個工作天
          violations.push({
            staffId, staffName: staff?.name, day, type: 'WEEKLY_HOURS',
            message: `⚠️ 每週工時超標：本週已累計 ${currentWeekHours} 小時 (上限 40)`
          });
      }

      // --- C. 統計休假天數 ---
      if (['RG', 'RC', 'OFF'].includes(shiftType)) {
          totalOffDays++;
      }

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
      
      if (dailyHours > 0) lastShiftType = shiftType;
      else lastShiftType = null;
    }

    // --- F. 檢查月休總天數 ---
    if (totalOffDays < 8) {
        violations.push({
            staffId, staffName: staff?.name, day: '整月', type: 'INSUFFICIENT_OFF',
            message: `⚠️ 休假不足：本月僅排休 ${totalOffDays} 天 (標準 8 天)`
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

  const getTop5 = (key) => {
    if (!staffData || staffData.length === 0) return [];
    return [...staffData]
      .map(s => ({ name: s.name, id: s.staff_id, value: Number(s[key]) || 0 })) 
      .sort((a, b) => b.value - a.value) 
      .slice(0, 5); 
  };

  const otTop5 = getTop5('accumulated_ot');
  const nightTop5 = getTop5('night_shift_balance');

  const handleLogin = async (e) => {
    e.preventDefault();
    setError('');
    setIsLoggingIn(true);

    const inputId = employeeId.trim().toLowerCase();
    
    // ★ 系統轉換：將工號 (如 N001 或 admin) 轉換為 Firebase 需要的 Email 格式
    const emailToLogin = `${inputId}@hospital.com`;

    try {
        // ★ 呼叫 Firebase 伺服器進行真實密碼比對！
        await signInWithEmailAndPassword(auth, emailToLogin, password);
        
        // 登入成功後，判斷角色權限
        if (inputId === 'admin') {
            onLogin({ id: 'ADMIN', name: '管理人員', role: 'admin' });
        } else {
            // 從 staffData 中找出這名員工的中文姓名與設定
            const staff = staffData.find(s => s.staff_id.toLowerCase() === inputId);
            if (staff) {
                onLogin({ 
                    id: staff.staff_id, 
                    name: staff.name, 
                    role: 'staff',
                    rule: staff.special_status === 'Standard' ? 'Standard' : 'BiWeekly'
                });
            } else {
                // 如果 Firebase 登入成功，但資料庫沒這個人 (通常是舊測試資料)
                onLogin({ id: inputId.toUpperCase(), name: '未知員工', role: 'staff' });
            }
        }
    } catch (err) {
        console.error("登入錯誤:", err.code);
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

      {staffData.length > 0 && (
        <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap', justifyContent: 'center', width: '100%', maxWidth: '850px' }}>
            <div style={{ flex: 1, minWidth: '300px', background: 'rgba(255,255,255,0.95)', padding: '1.5rem', borderRadius: '16px', boxShadow: '0 4px 15px rgba(0,0,0,0.1)' }}>
                <h3 style={{ margin: '0 0 1rem 0', color: '#e67e22', borderBottom: '2px solid #e67e22', paddingBottom: '0.5rem', fontSize:'1.1rem', display:'flex', alignItems:'center', gap:'8px' }}>🔥 積假 (OT) Top 5</h3>
                {otTop5.map((s, i) => (
                    <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #eee', fontSize:'0.95rem' }}><span style={{fontWeight:'bold', color:'#444'}}>{i+1}. {s.name}</span><span style={{fontWeight:'bold', color:'#e67e22', background:'#fff3e0', padding:'2px 8px', borderRadius:'10px'}}>{s.value}</span></div>
                ))}
            </div>
            <div style={{ flex: 1, minWidth: '300px', background: 'rgba(255,255,255,0.95)', padding: '1.5rem', borderRadius: '16px', boxShadow: '0 4px 15px rgba(0,0,0,0.1)' }}>
                <h3 style={{ margin: '0 0 1rem 0', color: '#8e44ad', borderBottom: '2px solid #8e44ad', paddingBottom: '0.5rem', fontSize:'1.1rem', display:'flex', alignItems:'center', gap:'8px' }}>🌙 夜班 (Night) Top 5</h3>
                {nightTop5.map((s, i) => (
                    <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #eee', fontSize:'0.95rem' }}><span style={{fontWeight:'bold', color:'#444'}}>{i+1}. {s.name}</span><span style={{fontWeight:'bold', color:'#8e44ad', background:'#f3e5f5', padding:'2px 8px', borderRadius:'10px'}}>{s.value}</span></div>
                ))}
            </div>
        </div>
      )}
    </div>
  );
};
// ============================================================================
// 2. StaffDashboard (員工自助介面 - 顯示已認領班表與協調機制 + 修改密碼功能)
// ============================================================================
const StaffDashboard = ({ currentUser, onConfirmSchedule, targetYear = 2026, targetMonth = 2, currentSchedule, staffData = [], setStaffData, priorityConfig }) => {  
  // 1. 基本防呆
  if (!currentUser) return <div style={{ padding: '40px', textAlign: 'center', color: '#666' }}>🔄 正在載入使用者資料...</div>;

  // ★★★ 新增：修改密碼狀態管理 ★★★
  const [showPwdModal, setShowPwdModal] = useState(false);
  const [pwdData, setPwdData] = useState({ old: '', new: '', confirm: '' });
  const [pwdMsg, setPwdMsg] = useState({ type: '', text: '' });

  const handlePasswordSubmit = (e) => {
      e.preventDefault();
      const staff = staffData.find(s => s.staff_id === currentUser.id);
      const currentPwd = staff?.password || '1234'; // 預設 1234

      if (pwdData.old !== currentPwd) {
          return setPwdMsg({ type: 'error', text: '舊密碼輸入錯誤！' });
      }
      if (pwdData.new !== pwdData.confirm) {
          return setPwdMsg({ type: 'error', text: '兩次輸入的新密碼不一致！' });
      }
      if (pwdData.new.length < 4) {
          return setPwdMsg({ type: 'error', text: '新密碼長度至少需 4 碼！' });
      }

      // 更新密碼到 staffData
      setStaffData(prev => prev.map(s => s.staff_id === currentUser.id ? { ...s, password: pwdData.new } : s));
      setPwdMsg({ type: 'success', text: '✅ 密碼修改成功！下次請使用新密碼登入。' });

      // 2秒後自動關閉視窗
      setTimeout(() => {
          setShowPwdModal(false);
          setPwdData({ old: '', new: '', confirm: '' });
          setPwdMsg({ type: '', text: '' });
      }, 2000);
  };

  // 優先選班權限檢查
  if (priorityConfig && !priorityConfig.isOpenToAll) {
      const allowedIds = new Set();
      if (priorityConfig.types.includes('accumulated_ot')) {
          const sortedOT = [...staffData].map(s => ({id: s.staff_id, val: Number(s.accumulated_ot)||0})).sort((a,b)=>b.val-a.val);
          sortedOT.slice(0, priorityConfig.count).forEach(s => allowedIds.add(s.id));
      }
      if (priorityConfig.types.includes('night_shift_balance')) {
          const sortedNight = [...staffData].map(s => ({id: s.staff_id, val: Number(s.night_shift_balance)||0})).sort((a,b)=>b.val-a.val);
          sortedNight.slice(0, priorityConfig.count).forEach(s => allowedIds.add(s.id));
      }

      if (!allowedIds.has(currentUser.id)) {
          return (
            <div style={{ padding: '2rem', maxWidth: '600px', margin: '4rem auto', background: 'white', borderRadius: '16px', boxShadow: '0 4px 20px rgba(0,0,0,0.1)', textAlign: 'center' }}>
                <div style={{ fontSize: '4rem', marginBottom: '1rem' }}>🔒</div>
                <h2 style={{ color: '#2c3e50', fontWeight: 'bold' }}>班表選填暫未開放</h2>
                <p style={{ color: '#7f8c8d', fontSize: '1.1rem', margin: '1.5rem 0' }}>目前為<strong>「優先選班時段」</strong>，僅開放符合以下條件的前 {priorityConfig.count} 位同仁優先選填：</p>
                <div style={{textAlign:'left', background:'#f8f9fa', padding:'15px 30px', borderRadius:'10px', display:'inline-block'}}>
                    {priorityConfig.types.includes('accumulated_ot') && <div style={{color:'#e67e22', fontWeight:'bold'}}>🔥 積借休時數 (OT) 較多者</div>}
                    {priorityConfig.types.includes('night_shift_balance') && <div style={{color:'#8e44ad', fontWeight:'bold', marginTop:'5px'}}>🌙 夜班結餘較多者</div>}
                </div>
                <div style={{ marginTop:'20px', fontSize:'0.9rem', color:'#666' }}>
                    您的數據：OT: <strong>{staffData.find(s=>s.staff_id===currentUser.id)?.accumulated_ot || 0}</strong> / Night: <strong>{staffData.find(s=>s.staff_id===currentUser.id)?.night_shift_balance || 0}</strong><br/>(未達優先門檻)
                </div>
                <button onClick={() => window.location.reload()} style={{ marginTop: '20px', padding: '10px 30px', background: '#667eea', color: 'white', border: 'none', borderRadius: '50px', cursor: 'pointer' }}>重新整理</button>
            </div>
          );
      }
  }

  const [currentStep, setCurrentStep] = useState(1);
  const [selectedShiftType, setSelectedShiftType] = useState('ALL'); 
  const [selectedOption, setSelectedOption] = useState(null);      
  const [aiSlots, setAiSlots] = useState([]);                      
  const [previewSchedule, setPreviewSchedule] = useState({});      
  const [isProcessing, setIsProcessing] = useState(false);

  const getPrevMonthStreak = () => {
    if (!currentUser || !currentUser.id) return 0;
    if (!staffData || staffData.length === 0) return 0;
    const staff = staffData.find(s => s.staff_id === currentUser.id);
    if (!staff || !staff.prevMonthLeave) return 0;
    const leaves = staff.prevMonthLeave; 
    let streak = 0;
    for (let i = 6; i >= 0; i--) { if (leaves[i] === true) break; streak++; }
    return streak;
  };

  const prevStreak = getPrevMonthStreak();

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

  const checkCompliance = (pattern) => {
      let currentStreak = prevStreak;
      for (let i = 0; i < pattern.length; i++) {
          const shift = pattern[i];
          if (shift !== 'OFF' && shift !== 'RG' && shift !== 'RC' && shift !== '空班') currentStreak++;
          else currentStreak = 0;
          if (currentStreak > 6) return { valid: false, reason: `違反七休一 (第${i+1}天連上${currentStreak}天)` };
      }
      return { valid: true };
  };
  
  const filteredOptions = selectedShiftType === 'ALL' ? aiSlots : aiSlots.filter(opt => opt.shift === selectedShiftType);

  const handleSelectType = (type) => { setIsProcessing(true); setTimeout(() => { setSelectedShiftType(type); setCurrentStep(2); setIsProcessing(false); }, 300); };
  const handleSelectOption = (opt) => { setSelectedOption(opt.id); const map = {}; opt.pattern.forEach((s, i) => map[i+1] = s); setPreviewSchedule(map); setCurrentStep(3); };
  const handleFinalSubmit = () => {
      const choice = aiSlots.find(opt => opt.id === selectedOption);
      onConfirmSchedule({ staffId: currentUser.id, staffName: currentUser.name, shiftType: selectedShiftType === 'ALL' ? 'D' : selectedShiftType, chosenSchedule: { id: choice.id, title: choice.title }, fullMonthData: previewSchedule });
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
                        <label style={{ fontSize: '0.85rem', color: '#666', marginBottom: '5px', display: 'block' }}>舊密碼 (預設: 1234)</label>
                        <input type="password" value={pwdData.old} onChange={e=>setPwdData({...pwdData, old: e.target.value})} required style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid #ddd', boxSizing: 'border-box' }} />
                    </div>
                    <div>
                        <label style={{ fontSize: '0.85rem', color: '#666', marginBottom: '5px', display: 'block' }}>新密碼 (至少 4 碼)</label>
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
              <h2 style={{ color: 'black', fontWeight: 'bold', margin: 0 }}>👋 嗨，{currentUser.name}</h2>
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

          <p style={{ marginBottom: '1rem', color: '#666' }}>請選擇您下個月希望認領的班別類型：</p>
          
          {!currentSchedule || Object.keys(currentSchedule).length === 0 ? (
              <div style={{padding:'20px', background:'#fff3cd', color:'#856404', borderRadius:'8px'}}>⚠️ 管理員尚未發布此月份 ({targetMonth}月) 的班表，請稍後再來。</div>
          ) : (
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
          )}
        </div>
      )}

      {currentStep === 2 && (
        <div>
          <button onClick={() => setCurrentStep(1)} style={{ border: 'none', background: '#4a5568', color: 'white', padding: '8px 16px', borderRadius: '8px', cursor: 'pointer', marginBottom: '15px', fontWeight: 'bold', fontSize: '0.95rem', display: 'flex', alignItems: 'center', gap: '5px' }}>← 返回</button>
          <h2 style={{ color: 'black', fontWeight: 'bold' }}>📋 選擇整月方案 ({targetYear}年{targetMonth}月)</h2>
          <div style={{color:'#666', fontSize:'0.9rem', marginBottom:'15px'}}>💡 提示：灰底並標示「鎖頭」的班表代表已被其他人選走。若您極需該班表，請私下與該同仁協調。</div>

          <div style={{ display: 'grid', gap: '20px', maxHeight:'600px', overflowY:'auto', paddingRight:'10px' }}>
            {filteredOptions.length === 0 ? (
              <div style={{padding:'40px', textAlign:'center', color: '#666', background:'#f9f9f9', borderRadius:'12px'}}><h3>無符合條件的推薦方案 😕</h3></div>
            ) : (
              filteredOptions.map(opt => {
                const check = checkCompliance(opt.pattern);
                const isSelectable = !opt.isClaimed && check.valid;
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
             <button onClick={handleFinalSubmit} style={{padding:'12px 40px', background:'#667eea', color:'white', border:'none', borderRadius:'20px', cursor:'pointer', fontSize:'1.1rem', fontWeight:'bold', boxShadow:'0 4px 10px rgba(102, 126, 234, 0.4)'}}>確認認領</button>
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
const NurseSchedulingSystem = () => {
  const [currentUser, setCurrentUser] = useState(null);



// --- 1. 雲端狀態宣告 (等待 Firebase 載入) ---
  const [isCloudLoaded, setIsCloudLoaded] = useState(false);
  // ★★★ 新增：Admin 密碼狀態與修改視窗 ★★★
  const [adminPassword, setAdminPassword] = useState('admin');
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
  const [publishedDate, setPublishedDate] = useState({ year: 2026, month: 2 });

  // --- 2. 本機暫存狀態 (不需上雲端) ---
  const [historyData, setHistoryData] = useState([]);
  const [requirements, setRequirements] = useState({ D: 15, E: 12, N: 8 });
  const [preferences, setPreferences] = useState({});
  const [violations, setViolations] = useState([]);
  const [scheduleRisks, setScheduleRisks] = useState([]); // ★ 新增這行
  const [selectedMonth, setSelectedMonth] = useState(() => Number(localStorage.getItem('selectedMonth')) || 2);
  const [selectedYear, setSelectedYear] = useState(() => Number(localStorage.getItem('selectedYear')) || 2026);

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
// ☁️ 雲端引擎 1：即時讀取 Firestore (OnSnapshot 監聽)
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "NurseApp", "MainData"), (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        if (data.shiftOptions) setShiftOptions(data.shiftOptions);
        if (data.priorityConfig) setPriorityConfig(data.priorityConfig);
        if (data.staffData) setStaffData(data.staffData);
        if (data.schedule) setSchedule(data.schedule);
        if (data.finalizedSchedule) setFinalizedSchedule(data.finalizedSchedule);
        if (data.publishedDate) setPublishedDate(data.publishedDate);
        if (data.adminPassword) setAdminPassword(data.adminPassword); // ★ 補上這行
        if (data.healthStats) setHealthStats(data.healthStats); // ★ 讀取健康度
      }
      setIsCloudLoaded(true); // 標記為：已成功從雲端抓取到資料
    });
    return () => unsub(); // 關閉元件時取消監聽
  }, []);

 // ☁️ 雲端引擎 2：資料變更時，自動寫入 Firestore
  useEffect(() => {
    // 防呆：如果雲端資料還沒載入完畢，不要寫入，以免把雲端資料洗白
    if (!isCloudLoaded) return; 

    // ★★★ 核心修復：移除 { merge: true }，改為「完全覆蓋」 ★★★
    // 這樣當我們把 D021 換成 N001 時，Firebase 才會乖乖把 D021 真正刪除！
    setDoc(doc(db, "NurseApp", "MainData"), {
      shiftOptions: shiftOptions || [],
      priorityConfig: priorityConfig || {},
      staffData: staffData || [],
      schedule: schedule || {},
      finalizedSchedule: finalizedSchedule || null,
      publishedDate: publishedDate || { year: 2026, month: 2 },
      adminPassword: adminPassword || 'admin', // ★ 補上這行
      healthStats: healthStats || []           // ★ 補上這行寫入
    });

  }, [shiftOptions, priorityConfig, staffData, schedule, finalizedSchedule, publishedDate, isCloudLoaded,healthStats]);

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

  const handleExportPreferences = () => {};
  const handleLogout = () => setCurrentUser(null);

// ★★★ 核心修復：員工認領後，只更新「發布版(finalizedSchedule)」，不污染「排班工作桌(schedule)」 ★★★
  const handleStaffScheduleUpdate = (result) => {
    const updateLogic = (prev) => {
      const next = { ...(prev || {}) };
      
      // 1. 新增：將該員工 (Nxxx) 的班表寫入
      next[result.staffId] = result.fullMonthData;
      
      // 2. 刪除：將被選走的那個虛擬代號 (Dxxx) 移除
      const targetVirtualId = result.chosenSchedule?.id;

      if (targetVirtualId && next[targetVirtualId]) {
          delete next[targetVirtualId]; // 精準刪除被選走的那個
      } else {
          // 如果抓不到 ID (防呆)，則刪除第一個找到的 D 開頭空缺
          const fallbackId = Object.keys(next).find(k => k.startsWith('D'));
          if (fallbackId) delete next[fallbackId];
      }
      return next;
    };

    // setSchedule(updateLogic); // ❌ 已經刪除這行！徹底切斷與排班工作桌的連動
    setFinalizedSchedule(updateLogic); // ✅ 只更新發布狀態的班表

    // 更新員工資料 (保持不變)
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

    alert(`✅ 認領成功！\n員工 ${result.staffName} 已確認班表。`);
  };

  const handleSaveAndPublish = () => {
    if (!schedule || Object.keys(schedule).length === 0) {
      alert("❌ 目前沒有班表內容，無法儲存！");
      return;
    }
    setFinalizedSchedule(JSON.parse(JSON.stringify(schedule)));
  const newPubDate = { year: selectedYear, month: selectedMonth };
    setPublishedDate(newPubDate);
    localStorage.setItem('publishedDate', JSON.stringify(newPubDate));
    
    alert(`✅ 班表已鎖定並發布！\n員工登入後將看到 [${selectedYear}年${selectedMonth}月] 的班表。`);
  };
  const handleAdminPasswordSubmit = (e) => {
      e.preventDefault();
      // 允許使用原密碼或緊急密碼來修改
      if (adminPwdData.old !== adminPassword && adminPwdData.old !== 'admin999') {
          return setAdminPwdMsg({ type: 'error', text: '舊密碼輸入錯誤！' });
      }
      if (adminPwdData.new !== adminPwdData.confirm) {
          return setAdminPwdMsg({ type: 'error', text: '兩次輸入的新密碼不一致！' });
      }
      if (adminPwdData.new.length < 4) {
          return setAdminPwdMsg({ type: 'error', text: '新密碼長度至少需 4 碼！' });
      }

      setAdminPassword(adminPwdData.new); // 更新密碼，觸發 useEffect 存入 Firebase
      setAdminPwdMsg({ type: 'success', text: '✅ 管理員密碼修改成功！下次請使用新密碼登入。' });

      setTimeout(() => {
          setShowAdminPwdModal(false);
          setAdminPwdData({ old: '', new: '', confirm: '' });
          setAdminPwdMsg({ type: '', text: '' });
      }, 2000);
  };

  if (!currentUser) {
return <LoginPanel onLogin={setCurrentUser} staffData={staffData} adminPassword={adminPassword} />; // ★ 傳入 adminPassword
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
                        <label style={{ fontSize: '0.85rem', color: '#666', marginBottom: '5px', display: 'block' }}>舊密碼 (預設: admin)</label>
                        <input type="password" value={adminPwdData.old} onChange={e=>setAdminPwdData({...adminPwdData, old: e.target.value})} required style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid #ddd', boxSizing: 'border-box' }} />
                    </div>
                    <div>
                        <label style={{ fontSize: '0.85rem', color: '#666', marginBottom: '5px', display: 'block' }}>新密碼 (至少 4 碼)</label>
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
            preferences={preferences} setPreferences={setPreferences}
            schedule={schedule} violations={violations}
            selectedYear={selectedYear} 
            selectedMonth={selectedMonth}
            onGenerateSchedule={handleGenerateSchedule} onExportPreferences={handleExportPreferences}
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
const ManagerInterface = ({
  staffData, setStaffData, historyData, requirements, setRequirements,
  preferences, setPreferences, schedule, violations,
  scheduleRisks,
  shiftOptions, setShiftOptions, priorityConfig, setPriorityConfig, publicHolidays, 
  selectedYear, setSelectedYear, 
  selectedMonth, setSelectedMonth,
  onGenerateSchedule, onExportPreferences, onSaveSchedule, setSchedule, 
  finalizedSchedule, 
  setFinalizedSchedule,healthStats, onUpdateHealthStats
}) => {
  const [activeTab, setActiveTab] = useState('requirements');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      
      <div style={{ background: 'rgba(255,255,255,0.95)', borderRadius: '16px', padding: '1rem', display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
        {['requirements', 'staff', 'schedule', 'review', 'statistics', 'simulation'].map(tab => (
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
            {tab === 'review' && '✅ 審核與發布'}
            {tab === 'statistics' && '📊 統計報表'}
            {tab === 'simulation' && '🔮 制度模擬'}
          </button>
        ))}
      </div>

      {activeTab === 'requirements' && (
        <RequirementsPanel
          requirements={requirements} setRequirements={setRequirements}
          onGenerateSchedule={onGenerateSchedule} onExportPreferences={onExportPreferences}
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
        />
      )}
      
      {activeTab === 'review' && (
        <ScheduleReviewPanel 
           staffData={staffData}
           violations={violations} scheduleRisks={scheduleRisks} 
           selectedYear={selectedYear} selectedMonth={selectedMonth}
           onSaveSchedule={onSaveSchedule} shiftOptions={shiftOptions} 
           setShiftOptions={setShiftOptions} publicHolidays={publicHolidays}
           schedule={finalizedSchedule || schedule} 
           setSchedule={setFinalizedSchedule}
           setDraftSchedule={setSchedule}              // ★ 傳遞草稿區修改權限給審核頁
           setFinalizedSchedule={setFinalizedSchedule} // ★ 傳遞發布區修改權限給審核頁
           onUpdateHealthStats={onUpdateHealthStats} // ★ 傳遞觸發器
           setStaffData={setStaffData} // ★★★ 核心新增：把員工資料的寫入權限傳給它
        />
      )}
      
      {activeTab === 'statistics' && (
        <StatisticsPanel staffData={staffData} priorityConfig={priorityConfig} setPriorityConfig={setPriorityConfig} 
        healthStats={healthStats} // ★ 傳遞歷年數據給報表畫圖
        />
      )}

      {activeTab === 'simulation' && (
        <SimulationPanel 
            staffData={staffData} requirements={requirements}
            baseSalary={localStorage.getItem('globalBaseSalary') || 40000}
            publicHolidays={publicHolidays} selectedYear={selectedYear}
            selectedMonth={selectedMonth} shiftOptions={shiftOptions}
        />
      )}
    </div>
  );
};
// ============================================================================
// 人力需求設定面板 (含：年月選擇器 + 儲存按鈕)
// ============================================================================
const RequirementsPanel = ({ 
  requirements, setRequirements, 
  selectedYear, setSelectedYear, selectedMonth, setSelectedMonth,
  onSaveSchedule 
}) => {
 
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
      <h2 style={{ color: 'black', marginBottom: '1.5rem' }}>人力需求與排班設定</h2>
      

      <div style={{ background: '#f8f9fa', padding: '1.5rem', borderRadius: '12px', marginBottom: '2rem' }}>
        <div style={{ marginBottom: '1.5rem' }}>
            <label style={{ fontWeight: 'bold', display: 'block', marginBottom: '0.5rem', color: 'black', fontSize: '1.1rem' }}>
              病床數: <span style={{fontSize:'1.3rem'}}>{bedCount}</span>
            </label>
            <input 
              type="range" min="0" max="100" value={bedCount} 
              onChange={e=>setBedCount(Number(e.target.value))} 
              style={{ width:'100%', cursor: 'pointer' }}
            />
        </div>

        <div style={{ display: 'flex', gap: '1rem', marginTop: '1rem' }}>
            {/* 早班 */}
            <div style={{ flex: 1, background: '#FFD93D', padding: '1rem', borderRadius: '8px', textAlign: 'center', color: 'black', boxShadow:'0 2px 5px rgba(0,0,0,0.1)' }}>
                <div style={{ fontWeight: 'bold', fontSize: '1.5rem', marginBottom:'0.5rem' }}>{dailyD} 人</div>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:'5px', fontSize: '1rem', fontWeight:'bold' }}>
                   <span>早班 1 :</span>
                   <input type="number" value={ratioD} onChange={e => setRatioD(Number(e.target.value))} style={{ width: '60px', padding: '4px', textAlign: 'center', borderRadius: '6px', border: '1px solid #ccc', color: 'black', background: 'white', fontWeight: 'bold', fontSize:'1rem' }} />
                </div>
            </div>

            {/* 小夜 */}
            <div style={{ flex: 1, background: '#FF6B9D', padding: '1rem', borderRadius: '8px', textAlign: 'center', color: 'black', boxShadow:'0 2px 5px rgba(0,0,0,0.1)' }}>
                <div style={{ fontWeight: 'bold', fontSize: '1.5rem', marginBottom:'0.5rem' }}>{dailyE} 人</div>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:'5px', fontSize: '1rem', fontWeight:'bold' }}>
                   <span>小夜 1 :</span>
                   <input type="number" value={ratioE} onChange={e => setRatioE(Number(e.target.value))} style={{ width: '60px', padding: '4px', textAlign: 'center', borderRadius: '6px', border: '1px solid #ccc', color: 'black', background: 'white', fontWeight: 'bold', fontSize:'1rem' }} />
                </div>
            </div>

            {/* 大夜 */}
            <div style={{ flex: 1, background: '#4D96FF', padding: '1rem', borderRadius: '8px', textAlign: 'center', color: 'black', boxShadow:'0 2px 5px rgba(0,0,0,0.1)' }}>
                <div style={{ fontWeight: 'bold', fontSize: '1.5rem', marginBottom:'0.5rem' }}>{dailyN} 人</div>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:'5px', fontSize: '1rem', fontWeight:'bold' }}>
                   <span>大夜 1 :</span>
                   <input type="number" value={ratioN} onChange={e => setRatioN(Number(e.target.value))} style={{ width: '60px', padding: '4px', textAlign: 'center', borderRadius: '6px', border: '1px solid #ccc', color: 'black', background: 'white', fontWeight: 'bold', fontSize:'1rem' }} />
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
    shiftOptions, setShiftOptions,setFinalizedSchedule // ★ 接收參數
}) => {
  const [geminiMessages, setGeminiMessages] = useState([]); 
  const [geminiInput, setGeminiInput] = useState('');       
  const [showGemini, setShowGemini] = useState(false);      
  const [processing, setProcessing] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState(''); 
  
  const [customAiInstruction, setCustomAiInstruction] = useState('');
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

  const handleExportExcel = () => {
    if (!schedule) return alert("無資料可匯出");
    let csv = "\uFEFF工號,姓名,";
    for (let d = 1; d <= daysInMonth; d++) csv += `${d}號,`;
    csv += "\n";
    Object.keys(schedule).sort().forEach(rowId => {
        const realStaff = staffData.find(s => s.staff_id === rowId);
        const name = realStaff ? realStaff.name : "待認領";
        let row = `${rowId},${name},`;
        for (let d = 1; d <= daysInMonth; d++) {
            const cell = schedule[rowId]?.[d];
            row += `${(typeof cell === 'object' ? cell.type : cell) || ''},`;
        }
        csv += row + "\n";
    });
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${selectedYear}_${selectedMonth}_班表_工作桌.csv`;
    link.click();
  };

  const handleGeminiSolve = async () => {
    // ★★★ 核心修復：阻斷舊歷史資料的疊加 ★★★
    if (schedule && Object.keys(schedule).length > 0) {
        const confirmOverwrite = window.confirm("⚠️ 畫面上已經有班表資料！\n\n為避免「新舊班表疊加」導致人數暴增（產生多餘的幽靈空缺），系統將會【完全清除】目前的舊資料，再為您產生一份乾淨的 AI 班表。\n\n確定要覆蓋並繼續嗎？");
        if (!confirmOverwrite) return;
    }

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
            const auth = getAuth();
            const token = await auth.currentUser.getIdToken();
            const response = await fetch('/api/gemini', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json',
                  'Authorization': `Bearer ${token}` // <--- 加上這行防護罩
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
                
                // ★★★ 核心修復：直接將最終班表設為 virtualSchedule，不再合併舊有的 currentRealStaffSchedule ★★★
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
        const auth = getAuth();
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
      
      {processing && (
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(255,255,255,0.95)', zIndex: 100, borderRadius: '16px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
          <div className="win7-loader" style={{ border: '5px solid #f3f3f3', borderTop: '5px solid #3498db', borderRadius: '50%', width: '50px', height: '50px', animation: 'spin 1s linear infinite' }}></div>
          <style>{`@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }`}</style>
          <div style={{ marginTop: '20px', fontSize: '1.2rem', fontWeight: 'bold', color: '#2c3e50' }}>AI 正在排班中...</div>
          <div style={{ marginTop: '8px', fontSize: '0.95rem', color: '#7f8c8d' }}>{loadingStatus}</div>
        </div>
      )}

      {/* 頂部工具列 */}
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
           
           <button onClick={() => setShowAddOption(!showAddOption)} style={{ padding: '0.5rem 1rem', background: '#6c757d', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer' }}>➕ 選項</button>
           
           <button id="gemini-trigger-btn" onClick={handleGeminiSolve} disabled={processing} style={{ padding: '0.5rem 1rem', background: processing ? '#ccc' : '#8e44ad', color: 'white', border: 'none', borderRadius: '8px', cursor: processing ? 'not-allowed' : 'pointer', fontWeight: 'bold', boxShadow: '0 2px 4px rgba(142,68,173,0.3)' }}>{processing ? '⏳' : '✨ 生成 AI 班表'}</button>
          
           <button onClick={handleClearAll} style={{ padding: '0.5rem 1rem', background: '#e74c3c', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>🗑️ 清空舊班表</button>
           
           <button onClick={handleExportExcel} style={{ padding: '0.5rem 1rem', background: '#27ae60', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>📥 Excel</button>
           <button onClick={onSaveSchedule} style={{ padding: '0.5rem 1rem', background: '#2980b9', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>💾 儲存並發布</button>
        </div>
      </div>

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
                                  const count = dailyStats[d][type];
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
};
// ============================================================================
// 員工管理面板 (更新：加入「重置密碼」功能)
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
      can_night_shift: true, accumulated_ot: 0, night_shift_balance: 0,
      prevMonthLeave: [false, false, false, false, false, false, false],
      password: '1234' // 預設密碼
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

  // ★★★ 新增：重置密碼功能 ★★★
  const handleResetPassword = (id, name) => {
      if (window.confirm(`確定要將員工「${name} (${id})」的密碼重置為預設值 (1234) 嗎？`)) {
          setLocalStaff(prev => prev.map(staff => {
              if (staff.staff_id === id) {
                  return { ...staff, password: '1234' };
              }
              return staff;
          }));
          setIsDirty(true);
          alert(`✅ 員工 ${name} 密碼已重置為 1234！\n⚠️ 請記得點擊右上角「💾 儲存變更」才會正式生效。`);
      }
  };

  const handleSave = () => {
    setStaffData(localStaff);
    setIsDirty(false);
    alert('✅ 員工資料已儲存！');
  };

  const columns = [
    { key: 'staff_id', label: '工號', type: 'text', width: '60px', readOnly: true },
    { key: 'name', label: '姓名', type: 'text', width: '80px' },
    { key: 'level', label: '職級', type: 'select', options: ['N0', 'N1', 'N2', 'N3', 'N4'], width: '70px' },
    { key: 'prevMonthLeave', label: '上月末休假', type: 'week_picker', width: '220px' },
    { key: 'tenure_years', label: '年資', type: 'number', width: '60px' },
    { key: 'is_leader', label: '組長', type: 'checkbox', width: '50px' },
    { key: 'leave_status', label: '狀態', type: 'select', options: ['None', 'Maternal', 'Student', 'OnLeave'], width: '90px' },
    { key: 'is_active', label: '在職', type: 'checkbox', width: '50px' },
    { key: 'special_status', label: '工時', type: 'select', options: ['Standard', 'BiWeekly'], width: '90px' },
    { key: 'can_night_shift', label: '夜班', type: 'checkbox', width: '50px' },
    { key: 'accumulated_ot', label: '積假', type: 'number', width: '60px' },
    { key: 'night_shift_balance', label: '夜餘', type: 'number', width: '60px' },
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
                    ) : col.type === 'week_picker' ? (
                      <div style={{ display: 'flex', gap: '6px' }}>
                        {['一','二','三','四','五','六','日'].map((day, idx) => (
                          <div key={idx} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                            <span style={{ fontSize: '0.75rem', fontWeight: 'bold', color: '#555', marginBottom: '2px' }}>{day}</span>
                            <input 
                              type="checkbox" 
                              checked={staff[col.key]?.[idx] || false} 
                              onChange={(e) => {
                                const newWeek = [...(staff[col.key] || [false,false,false,false,false,false,false])];
                                newWeek[idx] = e.target.checked;
                                handleChange(staff.staff_id, col.key, newWeek);
                              }}
                              style={{ width: '18px', height: '18px', cursor: 'pointer', margin: 0 }} 
                            />
                          </div>
                        ))}
                      </div>
                    ) : (
                      <input 
                        type={col.type} 
                        value={staff[col.key] ?? ''} 
                        onChange={(e) => handleChange(staff.staff_id, col.key, col.type === 'number' ? parseFloat(e.target.value) : e.target.value)} 
                        style={{ 
                          padding: '6px', borderRadius: '4px', border: '1px solid #ddd', width: '100%', 
                          background: col.key === 'name' ? '#fff' : 'transparent',
                          color: ['name', 'tenure_years', 'accumulated_ot', 'night_shift_balance'].includes(col.key) ? 'black' : 'inherit',
                          fontWeight: ['name', 'tenure_years', 'accumulated_ot', 'night_shift_balance'].includes(col.key) ? 'bold' : 'normal'
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
// 統計報表面板 (包含優先選班與 SVG 班表健康度折線圖)
// ============================================================================
const StatisticsPanel = ({ staffData, priorityConfig, setPriorityConfig, healthStats = [] }) => {
  
  // -- (1) 計算統計數據 (保持原樣) --
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

  // 計算優先名單
  const allowedStaffMap = new Map();
  if (priorityConfig.types.includes('accumulated_ot')) {
      otStats.allRank.slice(0, priorityConfig.count).forEach(s => allowedStaffMap.set(s.staff_id, { ...s, reason: 'OT' }));
  }
  if (priorityConfig.types.includes('night_shift_balance')) {
      nightStats.allRank.slice(0, priorityConfig.count).forEach(s => {
          if(allowedStaffMap.has(s.staff_id)) {
              const existing = allowedStaffMap.get(s.staff_id);
              allowedStaffMap.set(s.staff_id, { ...existing, reason: 'OT & Night' });
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

  // -- (2) 繪製健康度折線圖 --
  const renderLineChart = () => {
      if (!healthStats || healthStats.length === 0) {
          return <div style={{ textAlign: 'center', padding: '3rem', color: '#888', background: '#f8f9fa', borderRadius: '12px', border: '2px dashed #ddd' }}>尚無健康度結算紀錄。<br/>請先至「✅ 審核與發布」按下「💰 薪資與加班費結算」按鈕以產生數據。</div>;
      }

      const svgWidth = 800;
      const svgHeight = 350;
      const padding = 50;
      const chartWidth = svgWidth - padding * 2;
      const chartHeight = svgHeight - padding * 2;

      const allScores = healthStats.flatMap(d => [d.avg, d.median]);
      const minScore = Math.max(0, Math.floor(Math.min(...allScores) / 5) * 5 - 5); 
      const maxScore = 100;

      const getX = (index) => padding + (index * (chartWidth / Math.max(1, healthStats.length - 1)));
      const getY = (value) => padding + chartHeight - ((value - minScore) / (maxScore - minScore)) * chartHeight;

      const avgPoints = healthStats.map((d, i) => `${getX(i)},${getY(d.avg)}`).join(' ');
      const medianPoints = healthStats.map((d, i) => `${getX(i)},${getY(d.median)}`).join(' ');

      return (
          <svg viewBox={`0 0 ${svgWidth} ${svgHeight}`} style={{ width: '100%', height: 'auto', background: 'white', borderRadius: '12px', border: '1px solid #eee', boxShadow: '0 4px 6px rgba(0,0,0,0.05)' }}>
              {/* Y軸背景格線 */}
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
              
              {/* 繪製折線 */}
              <polyline points={avgPoints} fill="none" stroke="#3498db" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
              <polyline points={medianPoints} fill="none" stroke="#e74c3c" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />

              {/* 資料點與標籤 */}
              {healthStats.map((d, i) => {
                  const x = getX(i);
                  const yAvg = getY(d.avg);
                  const yMed = getY(d.median);
                  const isAvgHigher = d.avg >= d.median;

                  return (
                      <g key={i}>
                          <circle cx={x} cy={yAvg} r="5" fill="#3498db" stroke="white" strokeWidth="2" />
                          <circle cx={x} cy={yMed} r="5" fill="#e74c3c" stroke="white" strokeWidth="2" />
                          
                          <text x={x} y={svgHeight - padding + 25} fontSize="13" fill="#34495e" textAnchor="middle" fontWeight="bold">{`${d.year}/${d.month}`}</text>
                          <text x={x} y={isAvgHigher ? yAvg - 12 : yAvg + 20} fontSize="12" fill="#2980b9" textAnchor="middle" fontWeight="bold">{d.avg}</text>
                          <text x={x} y={isAvgHigher ? yMed + 20 : yMed - 12} fontSize="12" fill="#c0392b" textAnchor="middle" fontWeight="bold">{d.median}</text>
                      </g>
                  );
              })}

              {/* 圖例 */}
              <g transform={`translate(${svgWidth / 2 - 120}, ${padding - 20})`}>
                  <line x1="0" y1="0" x2="30" y2="0" stroke="#3498db" strokeWidth="4" strokeLinecap="round" />
                  <text x="40" y="4" fontSize="14" fill="#2c3e50" fontWeight="bold">平均健康度</text>
                  <line x1="150" y1="0" x2="180" y2="0" stroke="#e74c3c" strokeWidth="4" strokeLinecap="round" />
                  <text x="190" y="4" fontSize="14" fill="#2c3e50" fontWeight="bold">中位數</text>
              </g>
          </svg>
      );
  };

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:'20px' }}>
      
      {/* 優先選班控制台 (保持原樣) */}
      <div style={{ background: 'white', borderRadius: '16px', padding: '1.5rem', borderLeft:'5px solid #667eea', boxShadow: '0 4px 10px rgba(0,0,0,0.05)' }}>
          <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap', gap:'20px'}}>
             <div>
                 <h2 style={{ margin: '0 0 5px 0', color: '#2c3e50', fontSize:'1.4rem' }}>🏆 優先選班控制台</h2>
                 <p style={{ margin: 0, color: '#7f8c8d', fontSize:'0.9rem' }}>設定誰可以優先進場認領班表 (滿足任一條件即可)</p>
             </div>
             
             <div style={{ display:'flex', alignItems:'center', gap:'15px', background:'#f8f9fa', padding:'10px 20px', borderRadius:'50px' }}>
                 <span style={{fontWeight:'bold', color:'#333'}}>目前狀態:</span>
                 {priorityConfig.isOpenToAll ? (
                     <span style={{color:'green', fontWeight:'bold', display:'flex', alignItems:'center', gap:'5px'}}>🟢 全面開放 (所有人可選)</span>
                 ) : (
                     <span style={{color:'#e67e22', fontWeight:'bold', display:'flex', alignItems:'center', gap:'5px'}}>🔒 僅限優先人員 ({priorityList.length}人)</span>
                 )}
                 <button onClick={() => setPriorityConfig({...priorityConfig, isOpenToAll: !priorityConfig.isOpenToAll})} style={{ marginLeft:'10px', padding:'5px 15px', borderRadius:'20px', border:'none', cursor:'pointer', fontWeight:'bold', background: priorityConfig.isOpenToAll ? '#e74c3c' : '#27ae60', color:'white' }}>
                    {priorityConfig.isOpenToAll ? '改為限制模式' : '開啟全面開放'}
                 </button>
             </div>
          </div>

          <div style={{ marginTop:'20px', display:'flex', gap:'30px', flexWrap:'wrap' }}>
              <div style={{ flex:1, minWidth:'250px' }}>
                  <label style={{display:'block', fontWeight:'bold', marginBottom:'10px', color: 'black'}}>優先依據指標 (可多選):</label>
                  <div style={{display:'flex', gap:'10px', flexDirection:'column'}}>
                      <label style={{cursor:'pointer', display:'flex', alignItems:'center', gap:'5px', fontSize:'1rem', color: 'black'}}>
                          <input type="checkbox" checked={priorityConfig.types.includes('accumulated_ot')} onChange={e => { const newTypes = e.target.checked ? [...priorityConfig.types, 'accumulated_ot'] : priorityConfig.types.filter(t => t !== 'accumulated_ot'); setPriorityConfig({...priorityConfig, types: newTypes}); }} style={{width:'18px', height:'18px'}} />
                          🔥 積借休時數 (OT) 前 {priorityConfig.count} 名
                      </label>
                      <label style={{cursor:'pointer', display:'flex', alignItems:'center', gap:'5px', fontSize:'1rem', color: 'black'}}>
                          <input type="checkbox" checked={priorityConfig.types.includes('night_shift_balance')} onChange={e => { const newTypes = e.target.checked ? [...priorityConfig.types, 'night_shift_balance'] : priorityConfig.types.filter(t => t !== 'night_shift_balance'); setPriorityConfig({...priorityConfig, types: newTypes}); }} style={{width:'18px', height:'18px'}} />
                          🌙 夜班結餘 (Night) 前 {priorityConfig.count} 名
                      </label>
                  </div>
                  <label style={{display:'block', fontWeight:'bold', marginBottom:'5px', marginTop:'20px', color: 'black'}}>優先入閘人數 (Top N):</label>
                  <input type="number" min="1" max={staffData.length} value={priorityConfig.count} onChange={e => setPriorityConfig({...priorityConfig, count: Number(e.target.value)})} style={{ width:'100%', padding:'8px', borderRadius:'6px', border:'1px solid #ccc', fontSize:'1rem', color: 'black' }} />
              </div>
              <div style={{ flex:2, background:'#f1f3f5', padding:'15px', borderRadius:'8px' }}>
                  <div style={{fontWeight:'bold', marginBottom:'10px', color:'#555'}}>📋 目前符合優先資格名單 ({priorityList.length}人):</div>
                  <div style={{display:'flex', gap:'10px', flexWrap:'wrap'}}>
                      {priorityList.length === 0 ? <span style={{color:'#999'}}>無符合條件人員 (請勾選指標)</span> : priorityList.map(s => (
                          <span key={s.staff_id} style={{background:'white', padding:'4px 12px', borderRadius:'15px', fontSize:'0.9rem', border:'1px solid #ddd', color:'#333', boxShadow:'0 2px 2px rgba(0,0,0,0.05)'}}>
                              {s.name} <span style={{color:'#888', fontSize:'0.8rem'}}>({s.reason})</span>
                          </span>
                      ))}
                  </div>
              </div>
          </div>
      </div>

      {/* ★★★ 新增：健康度歷史趨勢圖 ★★★ */}
      <div style={{ background: '#fdfdfd', padding: '1.5rem', borderRadius: '16px', border: '1px solid #e0e0e0', boxShadow: '0 4px 6px rgba(0,0,0,0.02)' }}>
          <h3 style={{ marginTop: 0, color: '#34495e', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '8px' }}>
              📈 過去 12 個月班表健康度趨勢
          </h3>
          {renderLineChart()}
      </div>

      {/* 統計圖表區塊 */}
      <div style={{ background: 'white', borderRadius: '16px', padding: '2rem' }}>
        <h2 style={{ marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '10px', color: 'black' }}>
          <TrendingUp color="#667eea" /> 團隊人力統計報表
        </h2>
        
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '1.5rem' }}>
          {/* 總人數 */}
          <div style={{ padding: '1.5rem', background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', borderRadius: '16px', color: 'white', boxShadow: '0 10px 20px rgba(102, 126, 234, 0.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}><h3 style={{ margin: 0, opacity: 0.9 }}>總員工數</h3><Users size={24} style={{ opacity: 0.8 }} /></div>
            <div style={{ fontSize: '3.5rem', fontWeight: 'bold', lineHeight: 1 }}>{staffData.length} <span style={{ fontSize: '1rem', fontWeight: 'normal', opacity: 0.8 }}>人</span></div>
            <div style={{ marginTop: '1rem', fontSize: '0.9rem', opacity: 0.8 }}>目前在職率: {Math.round((staffData.filter(s=>s.is_active).length / staffData.length || 1) * 100)}%</div>
          </div>

          {/* OT */}
          <div style={{ padding: '1.5rem', background: 'white', borderRadius: '16px', border: '1px solid #eee', boxShadow: '0 4px 6px rgba(0,0,0,0.02)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '1rem' }}><div style={{ padding: '8px', background: '#e3f2fd', borderRadius: '8px', color: '#1976d2' }}><Clock size={20}/></div><h3 style={{ margin: 0, color: '#444' }}>積借休時數 (OT)</h3></div>
            <div style={{ display: 'flex', gap: '1rem', marginBottom: '1.5rem' }}>
               <div style={{ flex:1, textAlign: 'center', padding: '8px', background: '#f8f9fa', borderRadius: '8px' }}><div style={{ fontSize: '0.75rem', color: '#666' }}>平均</div><div style={{ fontSize: '1.4rem', fontWeight: 'bold', color: '#333' }}>{otStats.avg}</div></div>
               <div style={{ flex:1, textAlign: 'center', padding: '8px', background: '#f8f9fa', borderRadius: '8px' }}><div style={{ fontSize: '0.75rem', color: '#666' }}>中位數</div><div style={{ fontSize: '1.4rem', fontWeight: 'bold', color: '#1976d2' }}>{otStats.median}</div></div>
            </div>
            <div style={{ display: 'flex', gap: '1.5rem' }}><RankingList title="🔥 最高 Top 5" data={otStats.top5} color="#e67e22" /><RankingList title="❄️ 最低 Top 5" data={otStats.bottom5} color="#3498db" /></div>
          </div>

          {/* Night */}
          <div style={{ padding: '1.5rem', background: 'white', borderRadius: '16px', border: '1px solid #eee', boxShadow: '0 4px 6px rgba(0,0,0,0.02)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '1rem' }}><div style={{ padding: '8px', background: '#f3e5f5', borderRadius: '8px', color: '#8e44ad' }}><Moon size={20}/></div><h3 style={{ margin: 0, color: '#444' }}>夜班結餘 (Night)</h3></div>
            <div style={{ display: 'flex', gap: '1rem', marginBottom: '1.5rem' }}>
               <div style={{ flex:1, textAlign: 'center', padding: '8px', background: '#f8f9fa', borderRadius: '8px' }}><div style={{ fontSize: '0.75rem', color: '#666' }}>平均</div><div style={{ fontSize: '1.4rem', fontWeight: 'bold', color: '#333' }}>{nightStats.avg}</div></div>
               <div style={{ flex:1, textAlign: 'center', padding: '8px', background: '#f8f9fa', borderRadius: '8px' }}><div style={{ fontSize: '0.75rem', color: '#666' }}>中位數</div><div style={{ fontSize: '1.4rem', fontWeight: 'bold', color: '#8e44ad' }}>{nightStats.median}</div></div>
            </div>
            <div style={{ display: 'flex', gap: '1.5rem' }}><RankingList title="🌙 最高 Top 5" data={nightStats.top5} color="#8e44ad" /><RankingList title="☀️ 最低 Top 5" data={nightStats.bottom5} color="#95a5a6" /></div>
          </div>
        </div>
      </div>
    </div>
  );
};
// ============================================================================
// 班表審核與發布面板 - 已加入「科學化班表健康度評分」與「差額帳本結算引擎」
// ============================================================================
const ScheduleReviewPanel = ({ 
  schedule, setSchedule, 
  staffData, setStaffData, // ★ 接收寫入權限
  violations, 
  selectedYear, selectedMonth, onSaveSchedule,
  shiftOptions, setShiftOptions, scheduleRisks,
  publicHolidays = [],
  setDraftSchedule, setFinalizedSchedule,
  onUpdateHealthStats 
}) => {
  
  const daysInMonth = new Date(selectedYear, selectedMonth, 0).getDate();
  const daysArray = Array.from({length: daysInMonth}, (_,i)=>i+1);

  const [showAddOption, setShowAddOption] = useState(false);
  const [newOption, setNewOption] = useState({ code: '', name: '', color: '#cccccc' });
  const [showSettlement, setShowSettlement] = useState(false);

  const [baseSalary, setBaseSalary] = useState(() => {
      const saved = localStorage.getItem('globalBaseSalary');
      return saved ? Number(saved) : 40000;
  });

  useEffect(() => { localStorage.setItem('globalBaseSalary', baseSalary); }, [baseSalary]);

  // -- 健康度評分引擎 (保持不變) --
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
          const date = new Date(selectedYear, selectedMonth - 1, d);
          if (date.getDay() === 6) { if (isOff(shifts[d-1]) && isOff(shifts[d])) { hasFullWeekendOff = true; break; } }
      }
      if (!hasFullWeekendOff) { score -= 5; deductions.push(`[-5] 週末零休假`); }

      return { score, deductions };
  };

  const handleOpenSettlement = () => {
      const scores = [];
      Object.keys(schedule).forEach(rowId => {
          if (!rowId.startsWith('D')) {
             const { score } = calculateHealthScore(schedule[rowId]);
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
      if (onUpdateHealthStats) onUpdateHealthStats(selectedYear, selectedMonth, avg, median);
      setShowSettlement(true);
  };

  const handleReset = () => {
    if (!schedule || Object.keys(schedule).length === 0) return alert("目前沒有班表可重置。");
    if (window.confirm("⚠️ 確定要【退回所有認領狀態】嗎？")) {
      const newSchedule = {}; let index = 1;
      Object.keys(schedule).sort((a, b) => {
          const aIsVirtual = a.startsWith('D'), bIsVirtual = b.startsWith('D');
          if (aIsVirtual && !bIsVirtual) return 1; if (!aIsVirtual && bIsVirtual) return -1;
          return a.localeCompare(b);
      }).forEach(key => { newSchedule[`D${String(index).padStart(3, '0')}`] = schedule[key]; index++; });
      if (setDraftSchedule) setDraftSchedule(newSchedule);
      if (setFinalizedSchedule) setFinalizedSchedule(null); 
      alert("✅ 系統已重置！");
    }
  };

  const handleAddOption = () => {
    if (!newOption.code || !newOption.name) return alert("請輸入代號與名稱！");
    if (shiftOptions.find(o => o.code === newOption.code)) return alert("此代號已存在！");
    setShiftOptions([...shiftOptions, { ...newOption, time: '' }]);
    setNewOption({ code: '', name: '', color: '#cccccc' });
  };
  const handleDeleteOption = (code) => { if(window.confirm(`確定要刪除班別「${code}」嗎？`)) setShiftOptions(shiftOptions.filter(o => o.code !== code)); };
  const handleCellChange = (staffId, day, newValue) => {
    const newSchedule = JSON.parse(JSON.stringify(schedule));
    if (!newSchedule[staffId]) newSchedule[staffId] = {};
    newSchedule[staffId][day] = { ...(typeof newSchedule[staffId][day] === 'object' ? newSchedule[staffId][day] : {}), type: newValue };
    setSchedule(newSchedule);
  };
  const handleStaffChange = (oldRowId, newStaffId) => {
      if (oldRowId === newStaffId) return; 
      const newSchedule = JSON.parse(JSON.stringify(schedule));
      if (newStaffId === 'UNASSIGN') {
          let vIndex = 1, newVirtualId = '';
          while(true) { newVirtualId = `D${String(vIndex).padStart(3, '0')}`; if (!newSchedule[newVirtualId]) break; vIndex++; }
          newSchedule[newVirtualId] = newSchedule[oldRowId]; delete newSchedule[oldRowId];
          setSchedule(newSchedule); return;
      }
      if (newSchedule[newStaffId]) return alert(`⚠️ 此員工已經在班表中！`);
      newSchedule[newStaffId] = newSchedule[oldRowId]; delete newSchedule[oldRowId];
      setSchedule(newSchedule);
  };

  // --- 抓取結算數據 (加入夜班次數) ---
  const getSettlementData = () => {
      const data = [];
      const currentBaseSalary = Number(baseSalary) || 0; 
      const dailyWage = Math.round(currentBaseSalary / 30);
      const hourlyWage = Math.round(dailyWage / 8); 

      Object.keys(schedule).forEach(rowId => {
          if (rowId.startsWith('D')) return; 
          const staff = staffData.find(s => s.staff_id === rowId);
          const name = (staff && staff.name && staff.name.trim() !== '') ? staff.name : '未知姓名'; 
          
          let workDays = 0, nationalHolidayWorkDays = 0, explicitOtDays = 0; 
          let personalLeaveDays = 0, sickLeaveDays = 0;     
          let nightShiftsCount = 0; // ★ 新增：計算夜班

          for (let d = 1; d <= daysInMonth; d++) {
              const cell = schedule[rowId]?.[d];
              const type = (typeof cell === 'object') ? cell.type : (cell || 'OFF');
              const dateStr = `${selectedYear}${String(selectedMonth).padStart(2, '0')}${String(d).padStart(2, '0')}`;
              const isNationalHoliday = publicHolidays.includes(dateStr);

              if (['D', 'E', 'N', '支援'].includes(type)) {
                  workDays++;
                  if (isNationalHoliday) nationalHolidayWorkDays++;
                  if (type === 'N') nightShiftsCount++; // ★ 累加夜班
              }
              else if (type.includes('(OT)')) explicitOtDays++;
              else if (type === '事假') personalLeaveDays++;
              else if (type === '病假') sickLeaveDays++;
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
          const finalSalary = currentBaseSalary + totalOtPay - deduction;

          data.push({
              staff_id: rowId, name, baseSalary: currentBaseSalary, hourlyWage, dailyWage,
              workDays: workDays + explicitOtDays, standardWorkDays, otDays: totalRestOtDays,
              nightShiftsCount, // ★ 回傳夜班數
              restDayOtPay, nationalHolidayWorkDays, nationalHolidayPay, totalOtPay, 
              personalLeaveDays, sickLeaveDays, deduction, totalSalary: finalSalary
          });
      });
      return data;
  };

  // ★★★ 核心新增：差額帳本寫入引擎 (Delta Update Ledger) ★★★
  const handleConfirmSettlement = () => {
      if (!window.confirm(`⚠️ 確定要將 ${selectedYear}年${selectedMonth}月 的數據正式寫入員工帳戶嗎？\n\n系統將自動派發「積假 (OT)」與「夜班結餘」，\n並具備防呆機制，若本月重複結算不會導致無限累加，也不會覆蓋您在員工頁面手動微調的基準值。`)) return;

      const currentSettlement = getSettlementData();
      const monthKey = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}`; // 例如: "2026-02"

      if (setStaffData) {
          setStaffData(prevData => {
              return prevData.map(staff => {
                  const sData = currentSettlement.find(s => s.staff_id === staff.staff_id);
                  if (!sData) return staff; // 這個月沒上班的人就跳過

                  // 1. 讀取該員工的歷史帳本
                  const newHistory = { ...(staff.settlement_history || {}) };
                  const oldRecord = newHistory[monthKey] || { ot: 0, night: 0 };

                  // 2. 計算本次結算與「上次結算」的差額 (Delta)
                  const otDiff = sData.otDays - oldRecord.ot;
                  const nightDiff = sData.nightShiftsCount - oldRecord.night;

                  // 3. 將最新的本月數據寫入帳本
                  newHistory[monthKey] = {
                      ot: sData.otDays,
                      night: sData.nightShiftsCount
                  };

                  // 4. 疊加差額到總餘額
                  return {
                      ...staff,
                      settlement_history: newHistory,
                      accumulated_ot: (Number(staff.accumulated_ot) || 0) + otDiff,
                      night_shift_balance: (Number(staff.night_shift_balance) || 0) + nightDiff
                  };
              });
          });
      }

      alert(`✅ ${selectedYear}年${selectedMonth}月 結算完成！\n已成功將 ${currentSettlement.length} 位員工的 OT 與夜班數派發至帳戶餘額。`);
      setShowSettlement(false);
  };

  const handleExportExcel = () => { /* 保持不變 */ };
  const currentHourlyWage = Math.round((Number(baseSalary) || 0) / 240);

  return (
    <div style={{ display: 'flex', gap: '20px', height: '80vh', flexDirection:'column', position: 'relative' }}>
      
      <div style={{ background: 'white', borderRadius: '16px', padding: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
           <div style={{display:'flex', alignItems:'center', gap:'15px'}}>
               <h2 style={{ margin: 0, fontSize: '1.5rem', color:'#2c3e50' }}>📋 班表審核與微調</h2>
               <span style={{background:'#e3f2fd', padding:'5px 10px', borderRadius:'8px', color:'#1565c0', fontWeight:'bold'}}>{selectedYear}年 {selectedMonth}月</span>
           </div>
           <div style={{ display:'flex', gap:'10px' }}>
              <button onClick={() => setShowAddOption(!showAddOption)} style={{ padding: '0.5rem 1rem', background: '#6c757d', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer' }}>➕ 管理班別選項</button>
              <button onClick={handleReset} style={{ padding: '0.5rem 1rem', background: '#f39c12', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>🔄 拔除名字</button>
              <button onClick={handleOpenSettlement} style={{ padding: '0.5rem 1rem', background: '#8e44ad', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>💰 薪資與加班費結算</button>
              <button onClick={handleExportExcel} style={{ padding: '0.5rem 1rem', background: '#27ae60', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>📥 匯出 Excel</button>
           </div>
      </div>

      {showSettlement && (
          <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
              <div style={{ background: 'white', padding: '2rem', borderRadius: '16px', width: '95%', maxWidth: '1100px', maxHeight: '85vh', overflowY: 'auto', position: 'relative' }}>
                  <button onClick={() => setShowSettlement(false)} style={{ position: 'absolute', top: '15px', right: '20px', background: 'none', border: 'none', fontSize: '1.5rem', cursor: 'pointer', color: 'black' }}>✖</button>
                  <h2 style={{ margin: '0 0 10px 0', color: '#2c3e50', borderBottom: '2px solid #eee', paddingBottom: '10px' }}>💰 薪資與加班費結算預覽 ({selectedYear}年{selectedMonth}月)</h2>
                  
                  <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'center', fontSize: '0.9rem', marginTop: '15px' }}>
                      <thead style={{ background: '#34495e', color: 'white' }}>
                          <tr>
                              <th style={{ padding: '10px' }}>員工姓名</th>
                              <th style={{ padding: '10px' }}>上班/國定</th>
                              <th style={{ padding: '10px', background: '#8e44ad' }}>夜班總數</th> {/* ★ 新增欄位 */}
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
                                  {/* ★ 顯示夜班數 */}
                                  <td style={{ padding: '10px', fontWeight: 'bold', color: '#8e44ad', fontSize: '1.2rem' }}>
                                      {row.nightShiftsCount}
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

                  {/* ★★★ 寫入帳本的控制區 ★★★ */}
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

      {/* 以下原有的 AddOption 與 Table 保持不變... */}
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
          <div style={{ flex: 3, background: 'white', borderRadius: '16px', padding: '1.5rem', display:'flex', flexDirection:'column', overflow:'hidden' }}>
            <div style={{ flex: 1, overflow: 'auto', border: '1px solid #eee', borderRadius: '8px' }}>
              {schedule ? (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                    <thead style={{ position: 'sticky', top: 0, zIndex: 10 }}>
                        <tr style={{ background: '#34495e', color: 'white' }}>
                            <th style={{ padding: '8px', minWidth: '130px', position: 'sticky', left: 0, background: '#34495e', zIndex: 11 }}>員工指派</th>
                            <th style={{ padding: '8px', minWidth: '50px', background: '#2c3e50', zIndex: 10, borderRight: '2px solid #555' }}>健康度</th>
                            {daysArray.map(d => {
                                const dayOfWeek = new Date(selectedYear, selectedMonth - 1, d).getDay();
                                const dayStrs = ['日', '一', '二', '三', '四', '五', '六'];
                                const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
                                const dateStr = `${selectedYear}${String(selectedMonth).padStart(2, '0')}${String(d).padStart(2, '0')}`;
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
                        {Object.keys(schedule).sort((a, b) => {
                            const aIsVirtual = a.startsWith('D'), bIsVirtual = b.startsWith('D');
                            if (aIsVirtual && !bIsVirtual) return 1; if (!aIsVirtual && bIsVirtual) return -1;
                            return a.localeCompare(b);
                        }).map(rowId => {
                            const isVirtual = rowId.startsWith('D');
                            const { score, deductions } = calculateHealthScore(schedule[rowId]);
                            const scoreColor = score >= 90 ? '#27ae60' : (score >= 75 ? '#f39c12' : '#c0392b');

                            return (
                                <tr key={rowId} style={{ borderBottom: '1px solid #eee', background: isVirtual ? '#fafafa' : 'white' }}>
                                    <td style={{ padding: '8px', borderRight: '1px solid #eee', position: 'sticky', left: 0, background: isVirtual ? '#f9f9f9' : 'white', zIndex: 5 }}>
                                        <select value={rowId} onChange={(e) => handleStaffChange(rowId, e.target.value)} style={{ width: '100%', padding: '6px 4px', borderRadius: '6px', border: '1px solid #ccc', background: isVirtual ? '#f8f9fa' : '#e3f2fd', color: isVirtual ? '#888' : '#1565c0', fontWeight: 'bold', cursor: 'pointer', outline: 'none' }}>
                                            {isVirtual && <option value={rowId}>🎲 待認領 ({rowId})</option>}
                                            {!isVirtual && <option value="UNASSIGN">🔄 退回待認領...</option>}
                                            <optgroup label="護理人員名單">
                                                {staffData.filter(s => s.staff_id === rowId || !schedule[s.staff_id]).map(s => (
                                                    <option key={s.staff_id} value={s.staff_id} style={{ background: 'white', color: 'black' }}>{s.name} ({s.staff_id})</option>
                                                ))}
                                            </optgroup>
                                        </select>
                                    </td>
                                    <td style={{ padding: '4px', textAlign: 'center', fontWeight: 'bold', color: scoreColor, borderRight: '2px solid #ddd', cursor: 'help', background: isVirtual ? '#fafafa' : 'white', fontSize: '1.1rem' }} title={deductions.length > 0 ? `扣分明細：\n${deductions.join('\n')}` : '✨ 完美班表！無身心損耗'}>{score}</td>
                                    {daysArray.map(d => {
                                        const cellData = schedule[rowId]?.[d];
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
              ) : <div style={{padding:'20px', textAlign:'center', color:'#888'}}>尚無班表資料</div>}
            </div>
          </div>

          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '15px', overflow: 'hidden' }}>
             <div style={{ flex: 1, background: 'white', borderRadius: '16px', padding: '1.5rem', display:'flex', flexDirection:'column', borderLeft:'4px solid #e74c3c', boxShadow: '0 4px 6px rgba(0,0,0,0.05)', overflow: 'hidden' }}>
                <h2 style={{ margin: '0 0 1rem 0', fontSize: '1.1rem', color: '#c0392b', display:'flex', alignItems:'center', gap:'10px' }}>⚖️ 法遵檢查結果<span style={{ fontSize:'0.9rem', background:'#e74c3c', color:'white', padding:'2px 8px', borderRadius:'12px' }}>{violations.length}</span></h2>
                <div style={{ flex: 1, overflowY: 'auto', paddingRight:'5px' }}>
                   {violations.length === 0 ? <div style={{ color: '#27ae60', textAlign:'center', marginTop:'20px', fontSize:'1rem', fontWeight:'bold' }}>✅ 完美！無勞基法違規</div> : violations.map((v, i) => (
                         <div key={i} style={{ padding: '10px', background: '#fff5f5', marginBottom: '8px', borderRadius: '8px', borderLeft: '3px solid #e74c3c', fontSize: '0.9rem' }}>
                           <div style={{fontWeight:'bold', color:'#c0392b', marginBottom:'4px'}}>{v.staffName || `待認領(${v.staffId})`} <span style={{color:'#666', fontSize:'0.8rem'}}>({v.staffId})</span></div>
                           <div style={{color:'#333'}}>Day {v.day}: {v.message}</div>
                         </div>
                   ))}
                </div>
             </div>

             <div style={{ flex: 1.2, background: 'white', borderRadius: '16px', padding: '1.5rem', display:'flex', flexDirection:'column', borderLeft:'4px solid #f39c12', boxShadow: '0 4px 6px rgba(0,0,0,0.05)', overflow: 'hidden' }}>
                <div style={{ marginBottom: '1rem' }}><h2 style={{ margin: 0, fontSize: '1.1rem', color: '#d35400', display:'flex', alignItems:'center', gap:'10px' }}>⚠️ 排班壓力與公平風險<span style={{ fontSize:'0.9rem', background:'#f39c12', color:'white', padding:'2px 8px', borderRadius:'12px' }}>{scheduleRisks?.length || 0}</span></h2></div>
                <div style={{ flex: 1, overflowY: 'auto', paddingRight:'5px' }}>
                   {(!scheduleRisks || scheduleRisks.length === 0) ? <div style={{ color: '#f39c12', textAlign:'center', marginTop:'20px', fontSize:'1rem', fontWeight:'bold' }}>✨ 團隊班表負荷平均</div> : scheduleRisks.map((risk, i) => (
                         <div key={i} style={{ padding: '12px', background: '#fdf8e3', marginBottom: '10px', borderRadius: '8px', border: '1px solid #faebcc' }}>
                           <div style={{fontWeight:'bold', color:'#8a6d3b', marginBottom:'8px', fontSize:'0.95rem'}}>{risk.staffName} <span style={{color:'#999', fontSize:'0.8rem'}}>({risk.staffId})</span></div>
                           <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', flexDirection: 'column' }}>
                               {risk.tags.map((tag, j) => (<div key={j}><span style={{ display: 'inline-block', background: '#f39c12', color: 'white', fontSize: '0.75rem', padding: '2px 6px', borderRadius: '4px', fontWeight: 'bold', marginBottom: '4px' }}>{tag.label}</span><div style={{ fontSize: '0.85rem', color: '#666', marginLeft: '2px' }}>{tag.desc}</div></div>))}
                           </div>
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

        const dailyD = Math.ceil(simParams.bedCount / simParams.ratioD);
        const dailyE = Math.ceil(simParams.bedCount / simParams.ratioE);
        const dailyN = simParams.banNightShift ? 0 : Math.ceil(simParams.bedCount / simParams.ratioN);
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
            const response = await fetch('/api/gemini', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: prompt })
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || "伺服器連線失敗");
            }

            const data = await response.json();
            const text = data.text.replace(/```json|```/g, '').trim();
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            const parsed = JSON.parse(jsonMatch[0]);

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

export default NurseSchedulingSystem;