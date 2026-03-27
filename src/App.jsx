import React, { useState, useEffect } from 'react';
import { Calendar, Settings, LogOut, X, Hand, Lock } from 'lucide-react';
import {
  doc, getDoc, setDoc, addDoc, collection,
  query, orderBy, limit, getDocs, arrayUnion, onSnapshot
} from 'firebase/firestore';
import { updatePassword, EmailAuthProvider, reauthenticateWithCredential } from "firebase/auth";
import { signOut } from "firebase/auth";
import { auth, db, subscribeToSettings, subscribeToStaff, subscribeToSchedule, saveGlobalSettings, saveGlobalStaff, saveMonthlySchedule, updateStaffSchedule, subscribeToArchiveReports, backupScheduleToArchive } from './api/database';
import { checkLaborLawCompliance, checkSkillMixSafety, calculateScheduleRisks } from './constants';
import LoginPanel from './components/LoginPanel';
import StaffDashboard from './components/StaffDashboard';
import ManagerInterface from './components/ManagerInterface';
import './App.refactored.css';

const NurseSchedulingSystem = () => {
  const [currentUser, setCurrentUser] = useState(null);

  // ★ 系統連線狀態指示燈 (全端點) ★
  const [endpointStatus, setEndpointStatus] = useState({});




// --- 1. 雲端狀態宣告 (等待 Firebase 載入) ---
  const [isCloudLoaded, setIsCloudLoaded] = useState(false);
  // ★★★ 新增：Admin 密碼狀態與修改視窗 ★★★

  const [showAdminPwdModal, setShowAdminPwdModal] = useState(false);
  const [closingAdminPwdModal, setClosingAdminPwdModal] = useState(false);
  const [adminPwdData, setAdminPwdData] = useState({ old: '', new: '', confirm: '' });
  const [adminPwdMsg, setAdminPwdMsg] = useState({ type: '', text: '' });

  // ★★★ 資安升級：首次登入強制改密碼 ★★★
  const [showForceChangePwd, setShowForceChangePwd] = useState(false);
  const [closingForceChangePwd, setClosingForceChangePwd] = useState(false);
  const [forceChangePwdData, setForceChangePwdData] = useState({ new: '', confirm: '' });
  const [forceChangePwdMsg, setForceChangePwdMsg] = useState({ type: '', text: '' });

  const closeAdminPwdModal = () => {
    setClosingAdminPwdModal(true);
    setTimeout(() => { setShowAdminPwdModal(false); setClosingAdminPwdModal(false); }, 300);
  };
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
  const [baseSalary, setBaseSalary] = useState(40000);
  const [levelBonus, setLevelBonus] = useState({ N0: 0, N1: 1000, N2: 2000, N3: 3200, N4: 5000 });
  const [preferences, setPreferences] = useState({});
  const [violations, setViolations] = useState([]);
  const [scheduleRisks, setScheduleRisks] = useState([]); // ★ 新增這行
  const [selectedMonth, setSelectedMonth] = useState(() => {
    const saved = Number(localStorage.getItem('selectedMonth'));
    if (saved) return saved;
    const next = new Date().getMonth() + 2; // getMonth() is 0-based, +1 for current, +1 for next
    return next > 12 ? 1 : next;
  });
  const [selectedYear, setSelectedYear] = useState(() => {
    const saved = Number(localStorage.getItem('selectedYear'));
    if (saved) return saved;
    const now = new Date();
    return now.getMonth() === 11 ? now.getFullYear() + 1 : now.getFullYear();
  });
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

  const [showStatusDropdown, setShowStatusDropdown] = useState(false);
  const [closingStatusDropdown, setClosingStatusDropdown] = useState(false);
  const [simulateFailMode, setSimulateFailMode] = useState(false);
  const statusTriggerRef = React.useRef(null);

  const handleCloseStatusDropdown = React.useCallback(() => {
    setClosingStatusDropdown(true);
    setTimeout(() => {
      setShowStatusDropdown(false);
      setClosingStatusDropdown(false);
    }, 200);
  }, []);

  // ★ 全端點健康檢查 ★
  const HEALTH_ENDPOINTS = [
    { key: 'firestore', label: 'Firestore', desc: 'Firebase 即時資料庫' },
    { key: 'gemini', label: 'Gemini AI', desc: 'AI 排班與對話引擎', url: '/api/gemini', method: 'POST' },
    { key: 'analyzeExcel', label: 'Excel 分析', desc: 'CSV/Excel Gemini Flash 分析', url: '/api/analyze-excel', method: 'POST' },
    { key: 'sendEmail', label: 'Email 服務', desc: 'Resend 電子郵件發送', url: '/api/sendEmail', method: 'POST' },
    { key: 'syncAccounts', label: '帳號同步', desc: '批次建立 Firebase Auth 帳號', url: '/api/sync-accounts', method: 'POST' },
    { key: 'resetPassword', label: '密碼重設', desc: '管理員重設員工密碼', url: '/api/reset-password', method: 'POST' },
    { key: 'autoSettle', label: '自動結算', desc: '月薪結算引擎', url: '/api/auto-settle?healthCheck=true', method: 'GET' },
    { key: 'cronTimeout', label: 'Cron 逾時', desc: '每日自動推進選班逾時', url: '/api/cron/check-timeout?healthCheck=true', method: 'GET' },
    { key: 'calendar', label: '國定假日', desc: '台灣國定假日 API', url: `https://cdn.jsdelivr.net/gh/ruyut/TaiwanCalendar/data/${selectedYear}.json`, method: 'GET' },
  ];

  useEffect(() => {
    if (!currentUser) return;

    const checkAll = async () => {
      const token = await auth.currentUser?.getIdToken?.().catch(() => null);
      const results = {};

      await Promise.allSettled(HEALTH_ENDPOINTS.map(async (ep) => {
        const t0 = Date.now();
        try {
          if (ep.key === 'firestore') {
            const settingsRef = doc(db, 'NurseApp', 'Settings');
            const snap = await getDoc(settingsRef);
            const ms = Date.now() - t0;
            if (snap.exists()) {
              results[ep.key] = { color: ms < 2000 ? 'green' : ms < 5000 ? 'yellow' : 'red', reason: `Firebase 正常 (${ms}ms)` };
            } else {
              results[ep.key] = { color: 'yellow', reason: `Firebase 無資料 (${ms}ms)` };
            }
            return;
          }
          const controller = new AbortController();
          const tid = setTimeout(() => controller.abort(), 8000);
          const opts = { method: ep.method, signal: controller.signal, headers: {} };
          const isExternal = ep.url.startsWith('http');
          if (token && !isExternal) opts.headers['Authorization'] = `Bearer ${token}`;
          if (ep.method === 'POST') { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify({ healthCheck: true }); }
          const res = await fetch(ep.url, opts);
          clearTimeout(tid);
          const ms = Date.now() - t0;
          if (res.ok) {
            results[ep.key] = { color: ms < 3000 ? 'green' : 'yellow', reason: `${ep.label} 正常 (${ms}ms)` };
          } else {
            const body = await res.json().catch(() => ({}));
            results[ep.key] = { color: 'red', reason: `${ep.label} 異常${body.error ? '：' + body.error : ''} (${ms}ms)` };
          }
        } catch (err) {
          const ms = Date.now() - t0;
          results[ep.key] = { color: 'red', reason: `${ep.label} ${err.name === 'AbortError' ? '逾時' : '失敗'} (${ms}ms)` };
        }
      }));

      setEndpointStatus(results);
    };

    checkAll();
    const interval = setInterval(checkAll, 60000);
    return () => clearInterval(interval);
  }, [currentUser, selectedYear]);

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
        if (data.baseSalary) setBaseSalary(data.baseSalary);
        if (data.levelBonus) setLevelBonus(data.levelBonus);
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
    
    let unsubReports = null;
    if (currentUser?.role === 'admin') {
        unsubReports = subscribeToArchiveReports((data) => {
            setAccumulatedReports(data);
        });
    }

    return () => { unsubSettings(); unsubStaff(); unsubSchedule(); unsubHistory(); unsubReports?.(); setIsCloudLoaded(false); };
    
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
          bedConfig: bedConfig || { bedCount: 50, ratioD: 10, ratioE: 12, ratioN: 15 },
          levelBonus: levelBonus || { N0: 0, N1: 1000, N2: 2000, N3: 3200, N4: 5000 }
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
            if (import.meta.env.DEV) console.log(`✅ 舊班表 ${historyYear}年${historyMonth}月 已成功備份至雲端封存庫`);
        } catch (e) {
            console.error("❌ 舊班表備份失敗:", e);
            // 備份失敗不阻斷主流程
        }
    }

    // ★ 步驟 2：把目前發布的班表放入歷史區（覆蓋舊的），同時寫入封存庫供統計圖表使用
    setHistoryYear(selectedYear);
    setHistoryMonth(selectedMonth);
    setHistorySchedule(finalizedSchedule);

    try {
        await backupScheduleToArchive(
            selectedYear, selectedMonth, finalizedSchedule,
            "封存班表"
        );
        if (import.meta.env.DEV) console.log(`✅ ${selectedYear}年${selectedMonth}月 班表已寫入封存庫`);
    } catch (e) {
        console.error("❌ 封存寫入失敗:", e);
    }

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
  // 1. 動態產生反向蓋板（從上往下滑）
  const cover = document.createElement('div');
  cover.className = 'app__transition-cover--reverse';
  document.body.appendChild(cover);

  // 2. 蓋板完全遮住畫面時 (約 750ms)，執行登出並清除狀態
  setTimeout(() => {
    signOut(auth).then(() => {
      localStorage.clear();
      setCurrentUser(null);
    }).catch((error) => {
      console.error("登出失敗:", error);
    });
  }, 750);

  // 3. 動畫播完後清除 DOM 元素
  setTimeout(() => {
    cover.remove();
  }, 1500);
};
// ★ 核心功能 1：寄送 Email 的共用小幫手
  const sendSystemEmail = async (toEmail, subject, htmlContent) => {
      try {
          const idToken = await auth.currentUser?.getIdToken();
          await fetch('/api/sendEmail', {
              method: 'POST',
              headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${idToken}`
              },
              body: JSON.stringify({ to: toEmail, subject, html: htmlContent })
          });
      } catch (error) {
          console.error("Email 發送失敗:", error);
      }
  };

  // ★ 核心功能 2：AI 動態決策下一位優先選班者
  const calculateAndNotifyNextStaff = async (currentSchedule, statsData, currentYear, currentMonth, finishedStaffId = null) => {
      try {
          const token = await auth.currentUser.getIdToken();
          const response = await fetch('/api/auto-relay', {
              method: 'POST',
              headers: { 
                  'Content-Type': 'application/json', 
                  'Authorization': `Bearer ${token}` 
              },
              body: JSON.stringify({ 
                  year: currentYear, 
                  month: currentMonth, 
                  currentSchedule, 
                  statsData,
                  finishedStaffId
              })
          });

          const data = await response.json();
          if (!response.ok) {
              throw new Error(data.error || 'AI 接力 API 異常');
          }
          
          if (import.meta.env.DEV) console.log("AI 接力成功:", data);

      } catch (error) {
          console.error("AI 決策接力失敗:", error);
          // 通知管理員接力失敗，避免靜默卡住
          try {
              const adminEmail = staffData.find(s => s.staff_id === 'admin')?.email || 'admin@hospital.com';
              await sendSystemEmail(adminEmail, `⚠️ ${currentMonth}月 AI接力選班失敗`, `<h3>報告護理長：</h3><p>AI自動接力選班引擎發生錯誤，請登入系統手動啟動接力或指定下一位選班人員。</p><p><strong>錯誤訊息：</strong>${error.message || error}</p>`);
          } catch (emailErr) {
              console.error("通知管理員失敗:", emailErr);
          }
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
        
        // 🌟 ★★★ 關鍵修復：呼叫後端 API 標記完成並自動找下一個人 ★★★
        try {
            // 背景呼叫 AI，不卡住畫面
            await calculateAndNotifyNextStaff(next, healthStats, publishedDate.year, publishedDate.month, result.staffId);
        } catch (e) {
            console.error("交棒失敗:", e);
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
      if (import.meta.env.DEV) console.log("🔄 正在向雲端請求最新資料...");
      
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
            baseSalary: baseSalary || 40000,
            levelBonus: levelBonus || { N0: 0, N1: 1000, N2: 2000, N3: 3200, N4: 5000 },
            publishedDate: newPubDate
        });
        await saveMonthlySchedule(selectedYear, selectedMonth, {
            schedule: schedule || {},
            finalizedSchedule: newFinalized
        });
    } catch(e) {
        console.error("發布至雲端失敗:", e);
    }
    
    alert(`✅ 班表已鎖定並發布！\n員工登入後將看到 [${selectedYear}年${selectedMonth}月] 的班表。\n\n🚀 系統正在背景啟動 AI 接力選班...`);

    // ★★★ 發布後自動啟動第一棒 AI 接力選班 ★★★
    try {
        await calculateAndNotifyNextStaff(newFinalized, healthStats, selectedYear, selectedMonth);
    } catch (e) {
        console.error("發布後自動接力啟動失敗:", e);
    }
  };

// ★★★ 資安升級：首次登入強制改密碼 Handler ★★★
  const handleForceChangePwd = async (e) => {
      e.preventDefault();
      if (forceChangePwdData.new !== forceChangePwdData.confirm) {
          return setForceChangePwdMsg({ type: 'error', text: '兩次輸入的新密碼不一致！' });
      }
      if (forceChangePwdData.new === '123456') {
          return setForceChangePwdMsg({ type: 'error', text: '新密碼不可與預設密碼相同！' });
      }
      const strongPasswordRegex = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d]{6,}$/;
      if (!strongPasswordRegex.test(forceChangePwdData.new)) {
          return setForceChangePwdMsg({ type: 'error', text: '密碼強度不足：需至少 6 碼，且必須包含英文與數字！' });
      }
      try {
          const user = auth.currentUser;
          if (user) {
              // 用預設密碼重新驗證
              const credential = EmailAuthProvider.credential(user.email, '123456');
              await reauthenticateWithCredential(user, credential);
              await updatePassword(user, forceChangePwdData.new);
              setForceChangePwdMsg({ type: 'success', text: '✅ 密碼修改成功！' });
              // 先顯示成功訊息 1s，再啟動淡出動畫
              setTimeout(() => {
                  setClosingForceChangePwd(true);
                  // 等淡出動畫播完 (0.7s) 再卸載 DOM
                  setTimeout(() => {
                      setShowForceChangePwd(false);
                      setClosingForceChangePwd(false);
                      setForceChangePwdData({ new: '', confirm: '' });
                      setForceChangePwdMsg({ type: '', text: '' });
                      setCurrentUser(prev => ({ ...prev, forcePasswordChange: false }));
                  }, 700);
              }, 1000);
          }
      } catch (error) {
          if (import.meta.env.DEV) console.error("強制改密碼失敗:", error);
          if (error.code === 'auth/requires-recent-login') {
              setForceChangePwdMsg({ type: 'error', text: '⚠️ 登入已過期，請重新登入後再試。' });
          } else {
              setForceChangePwdMsg({ type: 'error', text: '修改失敗，請聯絡系統管理員。' });
          }
      }
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
                  setClosingAdminPwdModal(true);
                  setTimeout(() => {
                    setShowAdminPwdModal(false);
                    setClosingAdminPwdModal(false);
                    setAdminPwdData({ old: '', new: '', confirm: '' });
                    setAdminPwdMsg({ type: '', text: '' });
                  }, 300);
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

  const handleLoginTransition = (user) => {
    // 1. 動態產生一個滿版的 CSS 動畫蓋板
    const cover = document.createElement('div');
    cover.className = 'app__transition-cover';
    document.body.appendChild(cover);

    // 2. 當蓋板完全遮住畫面時 (約 750ms)，切換登入狀態 (背後畫面瞬間替換)
    setTimeout(() => {
      setCurrentUser(user);
      // ★ 資安升級：偵測到預設密碼，強制彈出改密碼視窗
      if (user.forcePasswordChange) {
        setShowForceChangePwd(true);
      }
    }, 750);

    // 3. 等動畫播完 (1500ms)，清除 DOM 元素
    setTimeout(() => {
      cover.remove();
    }, 1500);
  };

  if (!currentUser) {
    return <LoginPanel onLogin={handleLoginTransition} onApiStatus={() => {}} staffData={staffData} />;
  }

  return (
    <div className="app">
      {/* 🌟 背景動畫色塊 (與登入頁面相同) */}
      <div className="app__blob app__blob--1"></div>
      <div className="app__blob app__blob--2"></div>
      <div className="app__blob app__blob--3"></div>

      {/* 🌟 確保所有主要內容都在色塊之上 */}
      <div className="app__wrapper">
      {/* ★★★ 新增：Admin 修改密碼 Modal ★★★ */}
      {showAdminPwdModal && (
        <div className={`app__modal-overlay${closingAdminPwdModal ? ' app__modal-overlay--closing' : ''}`}>
            <div className={`app__modal${closingAdminPwdModal ? ' app__modal--closing' : ''}`}>
                <button onClick={closeAdminPwdModal} className="app__modal-close-btn"><X size={14} /></button>
                <h3 className="app__modal-title"><Settings size={20} /> 修改管理員密碼</h3>
                <form onSubmit={handleAdminPasswordSubmit} className="app__modal-form">
                    <div>
                        <label className="app__modal-label">舊密碼</label>
                        <input type="password" value={adminPwdData.old} onChange={e=>setAdminPwdData({...adminPwdData, old: e.target.value})} required className="app__modal-input" />
                    </div>
                    <div>
                        <label className="app__modal-label">新密碼</label>
                        <input type="password" value={adminPwdData.new} onChange={e=>setAdminPwdData({...adminPwdData, new: e.target.value})} required minLength="4" className="app__modal-input" />
                    </div>
                    <div>
                        <label className="app__modal-label">確認新密碼</label>
                        <input type="password" value={adminPwdData.confirm} onChange={e=>setAdminPwdData({...adminPwdData, confirm: e.target.value})} required minLength="4" className="app__modal-input" />
                    </div>
                    {adminPwdMsg.text && (
                        <div className={`app__modal-msg ${adminPwdMsg.type === 'error' ? 'app__modal-msg--error' : 'app__modal-msg--success'}`}>
                            {adminPwdMsg.text}
                        </div>
                    )}
                    <button type="submit" className="app__modal-submit-btn">儲存修改</button>
                </form>
            </div>
        </div>
      )}

      {/* ★★★ 資安升級：首次登入強制改密碼 Modal (不可關閉) ★★★ */}
      {showForceChangePwd && (
        <div className={`app__modal-overlay app__modal-overlay--force-pwd${closingForceChangePwd ? ' app__modal-overlay--force-pwd-closing' : ''}`}>
            <div className={`app__modal app__modal--force-pwd${closingForceChangePwd ? ' app__modal--force-pwd-closing' : ''}`}>
                <h3 className="app__modal-title"><Lock size={20} /> 首次登入：請修改預設密碼</h3>
                <p className="app__modal--force-pwd-desc">
                    系統偵測到您正在使用預設密碼，為保護帳號安全，請立即設定新密碼。
                </p>
                <form onSubmit={handleForceChangePwd} className="app__modal-form">
                    <div>
                        <label className="app__modal-label">新密碼（至少 6 碼，需含英文與數字）</label>
                        <input type="password" value={forceChangePwdData.new} onChange={e=>setForceChangePwdData({...forceChangePwdData, new: e.target.value})} required minLength="6" className="app__modal-input" autoFocus />
                    </div>
                    <div>
                        <label className="app__modal-label">確認新密碼</label>
                        <input type="password" value={forceChangePwdData.confirm} onChange={e=>setForceChangePwdData({...forceChangePwdData, confirm: e.target.value})} required minLength="6" className="app__modal-input" />
                    </div>
                    {forceChangePwdMsg.text && (
                        <div className={`app__modal-msg ${forceChangePwdMsg.type === 'error' ? 'app__modal-msg--error' : 'app__modal-msg--success'}`}>
                            {forceChangePwdMsg.text}
                        </div>
                    )}
                    <button type="submit" className="app__modal-submit-btn">確認修改密碼</button>
                </form>
            </div>
        </div>
      )}

      <div className="app__header">
          <div className="app__header-left">
            <Calendar size={28} color="#ffffff" />
            <h1 className="app__header-title">智能排班系統</h1>
          </div>
          <div className="app__header-right">
            {/* ★ 系統連線狀態 — 下拉選單 ★ */}
            <div className="app__status-dropdown-wrapper">
              <button ref={statusTriggerRef} className="app__status-trigger" onClick={() => showStatusDropdown ? handleCloseStatusDropdown() : setShowStatusDropdown(true)}>
                {(() => {
                  const colors = simulateFailMode
                    ? ['red', 'red', 'red', 'green', 'yellow', 'green', 'red', 'green', 'green']
                    : HEALTH_ENDPOINTS.map(ep => endpointStatus[ep.key]?.color || 'gray');
                  const overall = colors.includes('red') ? 'red' : colors.includes('yellow') ? 'yellow' : colors.includes('gray') ? 'gray' : 'green';
                  return <span className={`app__status-dot app__status-dot--${overall}`}></span>;
                })()}
                <span className="app__status-label">API</span>
              </button>
              {showStatusDropdown && (
                <>
                  <div className="app__status-backdrop" onClick={handleCloseStatusDropdown} />
                  <div className={`app__status-dropdown${closingStatusDropdown ? ' app__status-dropdown--closing' : ''}`} style={(() => {
                    const rect = statusTriggerRef.current?.getBoundingClientRect();
                    return rect ? { top: rect.bottom + 8, right: window.innerWidth - rect.right } : {};
                  })()}>
                    <div className="app__status-dropdown-title">系統 API 健康狀態</div>
                    {HEALTH_ENDPOINTS.map(ep => {
                      const SIMULATED_STATUS = {
                        firestore: { color: 'red', reason: 'Firebase 異常：PERMISSION_DENIED (142ms)' },
                        gemini: { color: 'red', reason: 'Gemini AI 異常：API key not valid (305ms)' },
                        analyzeExcel: { color: 'red', reason: 'Excel 分析 異常：API key not valid (289ms)' },
                        sendEmail: { color: 'green', reason: 'Email 服務 正常 (198ms)' },
                        syncAccounts: { color: 'yellow', reason: '帳號同步 正常 (3412ms)' },
                        resetPassword: { color: 'green', reason: '密碼重設 正常 (156ms)' },
                        autoSettle: { color: 'red', reason: '自動結算 異常：Firestore connection refused (8001ms)' },
                        cronTimeout: { color: 'green', reason: 'Cron 逾時 正常 (230ms)' },
                        calendar: { color: 'green', reason: '國定假日 正常 (87ms)' },
                      };
                      const s = simulateFailMode ? SIMULATED_STATUS[ep.key] : endpointStatus[ep.key];
                      const color = s ? s.color : 'gray';
                      const reason = s ? s.reason : '檢測中...';
                      return (
                        <div key={ep.key} className="app__status-dropdown-row">
                          <span className={`app__status-dot app__status-dot--${color}`}></span>
                          <div className="app__status-dropdown-info">
                            <span className="app__status-dropdown-label">{ep.label}</span>
                            <span className="app__status-dropdown-desc">{ep.desc}</span>
                          </div>
                          <span className="app__status-dropdown-reason">{reason}</span>
                        </div>
                      );
                    })}
                    {currentUser.role === 'admin' && (
                      <button
                        className="app__status-dropdown-sim-btn"
                        onClick={() => setSimulateFailMode(prev => !prev)}
                      >
                        {simulateFailMode ? '✓ 模擬故障中 — 點擊恢復' : '⚠ 模擬故障測試'}
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
            <span className="app__header-user"><Hand size={18} /> {currentUser.name} {currentUser.role === 'admin' ? '' : ' (護理師)'}</span>
            {currentUser.role === 'admin' && (
                <button onClick={() => setShowAdminPwdModal(true)} className="app__header-pwd-btn"><Settings size={14} /> 修改密碼</button>
            )}
            <button onClick={handleLogout} className="app__header-logout-btn"><LogOut size={14} /> 登出</button>
          </div>
      </div>

      <div className="app__content">
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
            baseSalary={baseSalary} setBaseSalary={setBaseSalary}
            levelBonus={levelBonus} setLevelBonus={setLevelBonus}
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
    </div>
  );
};
// ============================================================================
// 子元件區 (ManagerInterface) - 負責管理分頁切換
// ============================================================================
export default NurseSchedulingSystem;