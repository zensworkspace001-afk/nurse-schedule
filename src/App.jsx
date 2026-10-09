import React, { useState, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom';
import { Calendar, Settings, LogOut, X, Hand, Zap, ZapOff } from 'lucide-react';
import { usePerformanceMode } from './hooks/usePerformanceMode';
import { authApi, audit, health, calendar, getScheduleOnce, subscribeToSettings, subscribeToStaff, subscribeToStaffPublic, subscribeToMyStaffPrivate, subscribeToSchedule, subscribeToSchedulePublic, saveGlobalSettings, saveGlobalStaff, saveMonthlySchedule, subscribeToArchiveReports, backupScheduleToArchive, subscribeToAnnouncement } from '@backend';
import { useFeatures } from './backend/useFeatures';
import { checkLaborLawCompliance, checkSkillMixSafety, calculateScheduleRisks } from './constants';
import LoginPanel from './components/LoginPanel';
import StaffDashboard from './components/StaffDashboard';
import ManagerInterface from './components/ManagerInterface';
import ProfileWizard from './components/ProfileWizard';
import ForcedPasswordChange from './components/ForcedPasswordChange';
import ParticleBackground from './components/ParticleBackground';
import WeatherClockWidget from './components/WeatherClockWidget';
import ConnectionStatusBanner from './components/ConnectionStatusBanner';
import './App.refactored.css';
import PdpaReconsent from './components/PdpaReconsent';
import { PDPA_NOTICE_VERSION } from '../shared/policy.js';

// 物件內容指紋（key 排序後 JSON），用來判斷自動存檔前後內容是否真的有變
const stableKey = (v) => JSON.stringify(v, (_k, val) =>
  val && typeof val === 'object' && !Array.isArray(val)
    ? Object.keys(val).sort().reduce((o, k) => { o[k] = val[k]; return o; }, {})
    : val);

// 自動存檔寫進 NurseApp/Settings 的欄位（快照指紋與自動存檔共用同一組預設值）
const settingsPayload = (d) => ({
  shiftOptions: d.shiftOptions || [],
  priorityConfig: d.priorityConfig || {},
  requirements: d.requirements || { D: 15, E: 12, N: 8 },
  bedConfig: d.bedConfig || { bedCount: 50, ratioD: 10, ratioE: 12, ratioN: 15, hospitalLevel: 'MedicalCenter' },
  levelBonus: d.levelBonus || { N0: 0, N1: 1000, N2: 2000, N3: 3200, N4: 5000 },
});

const NurseSchedulingSystem = () => {
  const [currentUser, setCurrentUser] = useState(null);

  // 開機時還原 Firebase 持久化的登入狀態（這才是「記住我」真正生效的地方）。
  // 「記住我」勾選 → token 存 localStorage（跨瀏覽器存活）；不勾 → sessionStorage（關閉即逝）。
  // 但光有 token 不夠：React 的 currentUser 仍是 null，畫面照樣停在登入頁。
  // 所以這裡掛一次性的 onAuthStateChanged，把持久化的 session 還原成 currentUser。
  // 只處理「開機首次」那一發：之後的登入仍由 LoginPanel 驅動（含轉場動畫），登出由 handleLogout 驅動，
  // 避免 onAuthStateChanged 在表單登入時搶先設值、打斷 LoginPanel 的 750ms 蓋板動畫。
  const [authChecked, setAuthChecked] = useState(false);
  const initialAuthHandled = useRef(false);
  // 自動存檔的「雲端目前內容」指紋：快照進來或寫完就更新；內容沒變就不寫
  // （以前光是瀏覽管理分頁，快照設進 state 就觸發 2 秒自動存檔把同樣的資料寫回去，一次 10 多筆）
  const lastSyncedRef = useRef({ settings: null, staff: null, schedule: {} });
  // 自動存檔失敗時把指紋退回原值並遞增，讓自動存檔 effect 5 秒後再跑一次（否則網路暫時出錯就悄悄沒存到）
  const [autosaveRetry, setAutosaveRetry] = useState(0);
  useEffect(() => {
    const unsub = authApi.onAuthStateChanged((user) => {
      if (initialAuthHandled.current) return; // 只認開機第一發
      initialAuthHandled.current = true;
      if (user) setCurrentUser(user);   // 後端介面已轉成 currentUser 形狀（與 LoginPanel 同一套）
      setAuthChecked(true);
    });
    return () => unsub();
  }, []);

  // 省電模式：關閉 ParticleBackground (Three.js + aurora shader) 與所有 backdrop-filter，
  // 讓低階顯卡 / 內顯筆電也能順跑。可由使用者手動切換，或跟隨 prefers-reduced-motion。
  const [perfMode, { toggle: togglePerfMode }] = usePerformanceMode();
  const feat = useFeatures();

  // ★ 系統連線狀態指示燈 (全端點) ★
  const [endpointStatus, setEndpointStatus] = useState({});




// --- 1. 雲端狀態宣告 (等待 Firebase 載入) ---
  const [isCloudLoaded, setIsCloudLoaded] = useState(false);
  // ★★★ 新增：Admin 密碼狀態與修改視窗 ★★★

  const [showAdminPwdModal, setShowAdminPwdModal] = useState(false);
  const [closingAdminPwdModal, setClosingAdminPwdModal] = useState(false);
  const [adminPwdData, setAdminPwdData] = useState({ old: '', new: '', confirm: '' });
  const [adminPwdMsg, setAdminPwdMsg] = useState({ type: '', text: '' });
  const [isAdminPwdSubmitting, setIsAdminPwdSubmitting] = useState(false);

  const closeAdminPwdModal = () => {
    setClosingAdminPwdModal(true);
    setTimeout(() => { setShowAdminPwdModal(false); setClosingAdminPwdModal(false); }, 300);
  };
  // ★★★ 新增 1：儲存健康度歷史數據的狀態 ★★★
  const [healthStats, setHealthStats] = useState([]);

  // 系統公告（全員可讀；admin 在 RequirementsPanel 編輯）
  const [announcement, setAnnouncement] = useState(null);

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
  // 員工角色額外訂閱自己的私有 row（含 leave_status、is_pregnant_or_nursing 等敏感欄位）。
  // admin 角色 myStaffRow 永遠是 null，因為 admin 直接從完整 staffData 取。
  const [myStaffRow, setMyStaffRow] = useState(null);
  const [schedule, setSchedule] = useState(null);
  const [finalizedSchedule, setFinalizedSchedule] = useState(null);
  // 修改後（從 localStorage 讀正確的發布月份）
const [publishedDate, setPublishedDate] = useState({ year: 2026, month: 2 });
  // 預假開關（Settings.leaveWish）：{ open, year, month, reqs, quota, days_per_person }
  const [leaveWish, setLeaveWish] = useState(null);
  // --- 2. 本機暫存狀態 (不需上雲端) ---
  const [historyData] = useState([]);
const [requirements, setRequirements] = useState({ D: 15, E: 12, N: 8 });
  // ★ 新增這行：把病床與護病比的狀態提升到最高層
  const [bedConfig, setBedConfig] = useState({ bedCount: 50, ratioD: 10, ratioE: 12, ratioN: 15, hospitalLevel: 'MedicalCenter' });
  // baseSalary：null = 已加密尚未解鎖；數字 = 已解鎖明文
  // baseSalaryEnc：來自雲端的密文 blob {ct, iv, tag, v}（遷移後格式）
  const [baseSalary, setBaseSalary] = useState(null);
  const [baseSalaryEnc, setBaseSalaryEnc] = useState(null);
  const [levelBonus, setLevelBonus] = useState({ N0: 0, N1: 1000, N2: 2000, N3: 3200, N4: 5000 });
  const [preferences, setPreferences] = useState({});
  const [violations, setViolations] = useState([]);
  const [scheduleRisks, setScheduleRisks] = useState([]); // ★ 新增這行
  // selectedMonth/Year 預設邏輯：
  //   - 初始用「本月」當佔位
  //   - publishedDate 從雲端載完後，一次性 sync 到「正在被排班的月份」
  //   - admin 在 session 內手動切月份後不會被覆蓋（用 ref 鎖住）
  //   - 不存 localStorage：每次重整 / 重登都重新對齊 publishedDate
  const [selectedMonth, setSelectedMonth] = useState(new Date().getMonth() + 1);
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());
  const initialNoSavedMonthRef = React.useRef(true);
  // 防止「publishedDate 還沒從雲端載入時就用 hardcoded 初始值同步」— 必須等 cloud 真的給值才動
  const publishedDateLoadedRef = React.useRef(false);
  // 結算與歷史 panel 的月份狀態 — 同 selectedMonth/Year 邏輯
  //（每次重整都重新對齊 publishedDate；session 內手動切換不會被覆蓋）
  const [historyMonth, setHistoryMonth] = useState(new Date().getMonth() + 1);
  const [historyYear, setHistoryYear] = useState(new Date().getFullYear());
  const initialNoSavedHistoryRef = React.useRef(true);
  const [historySchedule, setHistorySchedule] = useState({});
  const [accumulatedReports, setAccumulatedReports] = useState({});
  
  // 順手清掉舊版遺留的 localStorage key（之前曾用 selectedMonth/Year/historyMonth/Year
  // 這幾個 key 持久化月份，現在不存了。沒清的話對使用者沒實際影響，但乾淨點）
  useEffect(() => {
    localStorage.removeItem('selectedMonth');
    localStorage.removeItem('selectedYear');
    localStorage.removeItem('historyMonth');
    localStorage.removeItem('historyYear');
  }, []);

  // 雲端 publishedDate 載入後，把 selectedMonth/Year + historyMonth/Year 一次性同步到
  // publishedDate（「正在被排班的那個月份」）。
  // 兩道閘門：
  //   1. publishedDateLoadedRef.current  — 防止 hardcoded 初始值就觸發同步
  //   2. initialNoSavedMonthRef.current  — 防止 admin 手動切月份後又被自動覆蓋
  useEffect(() => {
    if (!publishedDateLoadedRef.current) return;  // 等雲端真的載入
    if (!publishedDate?.month || !publishedDate?.year) return;
    if (initialNoSavedMonthRef.current) {
      // 工作月份：有開放中的預假 → 那個月；最後發布的月份已過 → 下個月；否則沿用最後發布的月份。
      // （以前一律用 publishedDate，正式資料停在 2026/3 時，排班工作桌一按 CP-SAT 就是在排半年前的 3 月）
      let wy = Number(publishedDate.year), wm = Number(publishedDate.month);
      const now = new Date();
      if (leaveWish?.open && leaveWish.year && leaveWish.month) {
        wy = Number(leaveWish.year); wm = Number(leaveWish.month);
      } else if (wy * 12 + wm < now.getFullYear() * 12 + now.getMonth() + 1) {
        wm = now.getMonth() + 2; wy = now.getFullYear();
        if (wm > 12) { wm = 1; wy++; }
      }
      setSelectedMonth(wm);
      setSelectedYear(wy);
      initialNoSavedMonthRef.current = false;
    }
    if (initialNoSavedHistoryRef.current) {
      setHistoryMonth(publishedDate.month);
      setHistoryYear(publishedDate.year);
      initialNoSavedHistoryRef.current = false;
    }
  }, [publishedDate, leaveWish]);

  const [showStatusDropdown, setShowStatusDropdown] = useState(false);
  const [closingStatusDropdown, setClosingStatusDropdown] = useState(false);
  const statusTriggerRef = React.useRef(null);

  const handleCloseStatusDropdown = React.useCallback(() => {
    setClosingStatusDropdown(true);
    setTimeout(() => {
      setShowStatusDropdown(false);
      setClosingStatusDropdown(false);
    }, 200);
  }, []);

  // ★ 全端點健康檢查 ★
  // 要檢查的端點依後端而定（Firebase / Vercel，或地端 Aegis.Api）
  const HEALTH_ENDPOINTS = health.endpoints(selectedYear);

  useEffect(() => {
    if (!currentUser) return;

    const checkAll = async () => {
      const token = await authApi.getIdToken().catch(() => null);
      const results = {};

      await Promise.allSettled(HEALTH_ENDPOINTS.map(async (ep) => {
        const t0 = Date.now();
        try {
          if (ep.check) {   // 資料庫連線：由後端介面自己檢查（回傳 null = 正常，字串 = 警告原因）
            const warn = await ep.check();
            const ms = Date.now() - t0;
            results[ep.key] = warn
              ? { color: 'yellow', reason: `${ep.label} ${warn} (${ms}ms)` }
              : { color: ms < 2000 ? 'green' : ms < 5000 ? 'yellow' : 'red', reason: `${ep.label} 正常 (${ms}ms)` };
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
        const res = await fetch(calendar.holidaysUrl(selectedYear));
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
  }, [schedule, finalizedSchedule, staffData, selectedYear, selectedMonth, publicHolidays, historyData]);
// ☁️ 雲端引擎 1：即時讀取 (使用抽象化 API)
  // ☁️ 雲端訂閱拆成三條獨立 useEffect，避免月份切換時把 6 條 listener 一次拆光重建
  // 之前遇過 Firebase 12.9.0 在 listener churn 太快時拋 INTERNAL ASSERTION FAILED (b815/ca9)
  //
  // useEffect 1：身份相關訂閱（Settings + Staff/Public + MyPrivate + Reports）
  //              只跟 currentUser 綁，跨月不會拆
  // useEffect 2：當前月份班表訂閱（admin → selectedYear/Month；staff → publishedDate）
  // useEffect 3：歷史月份班表訂閱（historyYear/Month，給結算頁用）

  // ----- 訂閱 1：身份相關（一次性，登入登出才 churn） -----
  useEffect(() => {
    if (!currentUser) return;

    const unsubSettings = subscribeToSettings((data) => {
      if (!data) return;
      lastSyncedRef.current.settings = stableKey(settingsPayload(data));
      if (data.shiftOptions) setShiftOptions(data.shiftOptions);
      if (data.priorityConfig) setPriorityConfig(data.priorityConfig);
      if (data.requirements) setRequirements(data.requirements);
      if (data.bedConfig) setBedConfig(data.bedConfig);
      if (data.baseSalary !== undefined && data.baseSalary !== null) {
        const v = data.baseSalary;
        const isCipher = v && typeof v === 'object' && typeof v.ct === 'string' && typeof v.iv === 'string';
        if (isCipher) {
          setBaseSalaryEnc(v);
        } else {
          setBaseSalary(Number(v) || 40000);
          setBaseSalaryEnc(null);
        }
      }
      if (data.levelBonus) setLevelBonus(data.levelBonus);
      setLeaveWish(data.leaveWish || null);
      if (data.publishedDate) {
        publishedDateLoadedRef.current = true;
        setPublishedDate(prev => {
          if (prev.year === data.publishedDate.year && prev.month === data.publishedDate.month) return prev;
          return data.publishedDate;
        });
      }
    });

    let unsubStaff;
    let unsubMyPrivate = null;
    if (currentUser.role === 'admin') {
      // 個資法 §27 稽核：admin 訂閱含全院 §6 特種個資（孕哺 / leave_status /
      // 加密 PII 密文）的 Staff doc，每個 session 留一筆「誰、何時、從哪」軌跡。
      // fire-and-forget — 寫 log 失敗不阻擋業務。
      (async () => {
        try {
          await audit.logAdminRead({ source: 'App.subscribeToStaff', subscription: 'onSnapshot' });
        } catch (e) {
          console.warn('admin-read 稽核寫入失敗（不阻擋）:', e.message);
        }
      })();

      unsubStaff = subscribeToStaff((data) => {
        if (data) {
          lastSyncedRef.current.staff = stableKey({ staffData: data.staffData || [], healthStats: data.healthStats || [] });
          if (data.staffData) setStaffData(data.staffData);
          if (data.healthStats) setHealthStats(data.healthStats);
        }
      });
    } else {
      unsubStaff = subscribeToStaffPublic((data) => {
        if (data && data.staffData) setStaffData(data.staffData);
      });
      unsubMyPrivate = subscribeToMyStaffPrivate(currentUser.id, (data) => {
        setMyStaffRow(data || null);
      });
    }

    let unsubReports = null;
    if (currentUser.role === 'admin') {
      unsubReports = subscribeToArchiveReports((data) => setAccumulatedReports(data));
    }

    // 全員都訂閱系統公告 — Firestore rule 允許所有 authed user 讀
    const unsubAnnouncement = subscribeToAnnouncement((data) => setAnnouncement(data));

    // 身份訂閱建立後即視為「身份資料就緒」— 班表 listener 那條會自己 setIsCloudLoaded
    setIsCloudLoaded(true);

    return () => {
      unsubSettings();
      unsubStaff?.();
      unsubMyPrivate?.();
      unsubReports?.();
      unsubAnnouncement?.();
      setMyStaffRow(null);
      setIsCloudLoaded(false);
    };
  }, [currentUser]);

  // ----- 訂閱 2：當月班表（admin 用 selectedYear/Month；staff 用 publishedDate） -----
  useEffect(() => {
    if (!currentUser) return;
    const isAdmin = currentUser.role === 'admin';
    const y = isAdmin ? selectedYear  : publishedDate.year;
    const m = isAdmin ? selectedMonth : publishedDate.month;
    if (!y || !m) return;

    const unsub = isAdmin
      ? subscribeToSchedule(y, m, (data) => {
          lastSyncedRef.current.schedule[`${y}_${m}`] = stableKey((data && data.schedule) || {});
          if (data) {
            setSchedule(data.schedule || {});
            setFinalizedSchedule(data.finalizedSchedule || null);
          } else {
            setSchedule({}); setFinalizedSchedule(null);
          }
        })
      : subscribeToSchedulePublic(y, m, (data) => {
          setSchedule({});
          setFinalizedSchedule(data?.finalizedSchedule || null);
        });
    return () => unsub();
  }, [currentUser, selectedYear, selectedMonth, publishedDate.year, publishedDate.month]);

  // ----- 訂閱 3：歷史月班表（給結算頁用，僅 admin 可讀） -----
  // 歷史月份的 Schedules/{ym} 完整 doc 在 firestore.rules 是 admin-only，
  // staff 角色訂閱會被 rules 擋下噴 "Missing or insufficient permissions"。
  // 結算頁本身也只有 admin 路由能看到，所以 staff 不需要這條訂閱。
  useEffect(() => {
    if (!currentUser || currentUser.role !== 'admin') return;
    if (!historyYear || !historyMonth) return;
    const unsub = subscribeToSchedule(historyYear, historyMonth, (data) => {
      setHistorySchedule(data?.finalizedSchedule || {});
    });
    return () => unsub();
  }, [currentUser, historyYear, historyMonth]);
  // ☁️ 雲端引擎 2：自動寫入 (加入終極安全防護)
  useEffect(() => {
    if (!isCloudLoaded || !currentUser || currentUser.role !== 'admin') return; 

    // 先把指紋標成「已同步」避免重複送出；寫入失敗就退回原值並排定重試
    const sendOnce = (key, getter, setter, write, label) => {
      const prev = getter();
      setter(key);
      write().catch(err => {
        console.error(`自動存檔${label}失敗，5 秒後重試:`, err);
        if (getter() === key) setter(prev);
        setTimeout(() => setAutosaveRetry(n => n + 1), 5000);
      });
    };

    const timeoutId = setTimeout(() => {
        
        // ★ 核心修復 2：絕對禁止把「空畫面」寫入雲端覆蓋掉別人的心血！
        const ym = `${selectedYear}_${selectedMonth}`;
        if (schedule && Object.keys(schedule).length > 0 && stableKey(schedule) !== lastSyncedRef.current.schedule[ym]) {
            const y = selectedYear, m = selectedMonth;
            sendOnce(stableKey(schedule), () => lastSyncedRef.current.schedule[ym], v => { lastSyncedRef.current.schedule[ym] = v; },
              // ★ 警告：絕對不能在這裡自動寫入 finalizedSchedule，只能由發布按鈕寫入！
              () => saveMonthlySchedule(y, m, { schedule }), '班表草稿');
        }

        // ★ 注意：baseSalary 不在自動存檔範圍 — 它是加密欄位，由
        //   ScheduleReviewPanel 的「💾 儲存底薪」明確走 /api/secure-field 加密後寫入。
        //   若這裡也順手寫，會把密文蓋成明文 0/40000，整個加密就破功了。
        const settings = settingsPayload({ shiftOptions, priorityConfig, requirements, bedConfig, levelBonus });
        if (stableKey(settings) !== lastSyncedRef.current.settings) {
          sendOnce(stableKey(settings), () => lastSyncedRef.current.settings, v => { lastSyncedRef.current.settings = v; },
            () => saveGlobalSettings(settings), '設定');
        }

        // ★ 與 schedule 的「不寫空」guard 同款：staffData 從 useState([]) 起步，
        //   subscribeToStaff 的 snapshot 若比 2s timeout 慢回來，這裡會把
        //   [] 寫進雲端，瞬間清空整個 NurseApp/Staff 與 StaffPublic（StaffPrivate
        //   doc 因為 saveGlobalStaff 的 for loop 不會跑空陣列所以倖存）。
        //   只在 staffData 至少有一筆時才寫，初次 wipe 過 staffData 的場景請從
        //   StaffPrivate/* 跑 scripts/restore-staff-from-private.js 還原。
        const staffPayload = { staffData, healthStats: healthStats || [] };
        if (Array.isArray(staffData) && staffData.length > 0 && stableKey(staffPayload) !== lastSyncedRef.current.staff) {
          sendOnce(stableKey(staffPayload), () => lastSyncedRef.current.staff, v => { lastSyncedRef.current.staff = v; },
            () => saveGlobalStaff(staffPayload), '員工資料');
        }

    }, 2000);

    return () => clearTimeout(timeoutId);

  // ★ 核心修復 3：移除了 finalizedSchedule 與 publishedDate 的依賴，徹底打破無限覆蓋迴圈
  }, [shiftOptions, priorityConfig, staffData, schedule, healthStats, isCloudLoaded, currentUser, selectedYear, selectedMonth, requirements, bedConfig, levelBonus, autosaveRetry]);
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
    authApi.signOut().then(() => {
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

  // 🔄 手動強制同步最新雲端班表
  const handleManualRefresh = async () => {
    try {
      // 顯示讀取中的提示 (可選，讓使用者知道有在跑)
      if (import.meta.env.DEV) console.log("🔄 正在向雲端請求最新資料...");
      
      // 直接向 Firebase 請求目前選擇的「年_月」的真實資料
      const data = await getScheduleOnce(selectedYear, selectedMonth);

      if (data) {
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

    // 班表由 CP-SAT 直接指派到每位員工，發布後員工只能檢視（認領流程已移除）
    const newPubDate = { year: selectedYear, month: selectedMonth };

    // ★★★ 強制立即存檔到雲端，不等待 2 秒防抖機制 ★★★
    // ★ baseSalary 排除：加密欄位由 ScheduleReviewPanel 自行存
    try {
        await saveGlobalSettings({
            shiftOptions: shiftOptions || [],
            priorityConfig: priorityConfig || {},
            requirements: requirements || { D: 15, E: 12, N: 8 },
            bedConfig: bedConfig || { bedCount: 50, ratioD: 10, ratioE: 12, ratioN: 15, hospitalLevel: 'MedicalCenter' },
            levelBonus: levelBonus || { N0: 0, N1: 1000, N2: 2000, N3: 3200, N4: 5000 },
            publishedDate: newPubDate
        });
        await saveMonthlySchedule(selectedYear, selectedMonth, {
            schedule: schedule || {},
            finalizedSchedule: newFinalized
        });
    } catch(e) {
        console.error("發布至雲端失敗:", e);
        alert(`❌ 發布失敗：${e.message || e}\n班表沒有存到雲端，請檢查網路後再按一次「儲存並發布」。`);
        return;
    }
    // 雲端存檔成功後才更新本機的「已發布月份」（以前先更新，存檔失敗時畫面會以為已經發布）
    setPublishedDate(newPubDate);
    localStorage.setItem('publishedDate', JSON.stringify(newPubDate));

    alert(`✅ 班表已發布！\n員工登入後可檢視自己 [${selectedYear}年${selectedMonth}月] 的班表。`);
  };

// ★★★ 安全升級：串接 Firebase Auth 進行管理員密碼修改 ★★★
  const handleAdminPasswordSubmit = async (e) => {
      e.preventDefault();

      if (adminPwdData.new !== adminPwdData.confirm) {
          return setAdminPwdMsg({ type: 'error', text: '兩次輸入的新密碼不一致！' });
      }
      const strongPasswordRegex = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d]{6,}$/;
      if (!strongPasswordRegex.test(adminPwdData.new)) {
          return setAdminPwdMsg({ type: 'error', text: '密碼強度不足：需至少 6 碼，且必須包含英文與數字！' });
      }

      setIsAdminPwdSubmitting(true);
      try {
          if (authApi.isSignedIn()) {
              await authApi.changePassword(adminPwdData.old, adminPwdData.new);   // 先驗目前密碼再改

              setIsAdminPwdSubmitting(false);
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
      } finally {
          setIsAdminPwdSubmitting(false);
      }
  };

  if (!currentUser) {
    // 還在還原持久化 session（onAuthStateChanged 尚未回報）→ 先只畫背景，
    // 避免「已記住」的使用者開機時閃一下登入畫面再跳進系統。
    if (!authChecked) {
      return <>{!perfMode && <ParticleBackground />}</>;
    }
    // 登入轉場由 LoginPanel 內部負責建立 .app__transition-cover 蓋板
    // 跟 handleLogout 是對稱的（同一個 glassFadeIn 動畫，只差 background 色相）
    return (
      <>
        {!perfMode && <ParticleBackground />}
        <LoginPanel onLogin={setCurrentUser} onApiStatus={() => {}} staffData={staffData} />
      </>
    );
  }

  // 員工用「忘記密碼」拿到的暫時密碼登入 → 強制改密，擋下主畫面。
  // 後端在發暫時密碼時設了 must_change_password；改密成功後旗標清除，myStaffRow
  // 訂閱更新 → 此 gate 自動放行。放在 profile gate 之前（安全優先）。
  if (currentUser.role === 'staff' && myStaffRow && myStaffRow.must_change_password === true) {
    return <ForcedPasswordChange currentUser={currentUser} onLogout={handleLogout} />;
  }

  // 員工首次登入若尚未完善個人資料 → 顯示精靈，擋下主畫面。
  // 條件：staff 角色 + 自己的 private row 已載入 + profile_completed 顯式為 false。
  //   - 用 === false（而非 !== true）是為了不打擾既有員工：他們的 row 沒這個欄位，視為 undefined，跳過精靈。
  //   - 只有透過 sync-accounts 新建的員工 / admin 在 StaffManagementPanel 新增的列才會被標記為 false。
  if (currentUser.role === 'staff' && myStaffRow && myStaffRow.profile_completed === false) {
    return <ProfileWizard staffRow={myStaffRow} currentUser={currentUser} />;
  }

  // 個資告知升版（shared/policy.js PDPA_NOTICE_VERSION）→ 同意過舊版的員工必須重新同意才能繼續。
  // 只攔「有同意紀錄但版本舊」的人；從未留下同意紀錄的舊帳號（精靈上線前建立的）暫不攔。
  if (currentUser.role === 'staff' && myStaffRow && myStaffRow.pdpa_notice_version
      && myStaffRow.pdpa_notice_version !== PDPA_NOTICE_VERSION) {
    return <PdpaReconsent currentUser={currentUser} hadConsentedBefore />;
  }


  return (
    <>
    <ConnectionStatusBanner />
    {/* AnnouncementBanner 只顯示在登入頁（LoginPanel 自己 subscribe）— dashboard 上不再呈現，
        留給 admin 自己在 RequirementsPanel 的編輯器看到「目前正在顯示」狀態徽章 */}
    <div className="app">
      {/* 🌟 Canvas 粒子動態背景 — 省電模式跳過，省下 Three.js WebGL 場景 + aurora shader */}
      {!perfMode && <ParticleBackground />}
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
                    <button type="submit" disabled={isAdminPwdSubmitting} className={`app__modal-submit-btn${isAdminPwdSubmitting ? ' app__modal-submit-btn--loading' : ''}`}>
                        {isAdminPwdSubmitting ? <><span className="app__modal-spinner" /> 驗證中...</> : '儲存修改'}
                    </button>
                </form>
            </div>
        </div>
      )}

      <div className="app__header">
          <div className="app__header-left">
            <Calendar size={28} color="#ffffff" />
            <h1 className="app__header-title">排班系統</h1>
          </div>
          <div className="app__header-right">
            {/* 天氣 + 時鐘 widget — header 嵌入式 pill 樣式 */}
            {feat.weather && <WeatherClockWidget inline />}
            {/* 省電 / 視覺模式切換 — 關掉粒子背景與 backdrop-filter，給低階顯卡 / 內顯機器用 */}
            <button
              type="button"
              onClick={togglePerfMode}
              className="app__perf-toggle"
              title={perfMode ? '目前為省電模式 — 點此恢復視覺特效' : '目前為視覺模式 — 點此切換省電模式（關閉粒子背景與毛玻璃模糊）'}
              aria-label="切換省電 / 視覺模式"
              aria-pressed={perfMode}
            >
              {perfMode ? <ZapOff size={14} /> : <Zap size={14} />}
              <span className="app__perf-toggle-label">{perfMode ? '省電' : '視覺'}</span>
            </button>
            {/* ★ 系統連線狀態 — 下拉選單 ★ */}
            <div className="app__status-dropdown-wrapper">
              <button ref={statusTriggerRef} className="app__status-trigger" title="系統連線狀態（各 API 是否正常）" aria-label="系統連線狀態" onClick={() => showStatusDropdown ? handleCloseStatusDropdown() : setShowStatusDropdown(true)}>
                {(() => {
                  const colors = HEALTH_ENDPOINTS.map(ep => endpointStatus[ep.key]?.color || 'gray');
                  const overall = colors.includes('red') ? 'red' : colors.includes('yellow') ? 'yellow' : colors.includes('gray') ? 'gray' : 'green';
                  return <span className={`app__status-dot app__status-dot--${overall}`}></span>;
                })()}
                <span className="app__status-label">API</span>
              </button>
              {showStatusDropdown && ReactDOM.createPortal(
                <>
                  <div className="app__status-backdrop" onClick={handleCloseStatusDropdown} />
                  <div className={`app__status-dropdown${closingStatusDropdown ? ' app__status-dropdown--closing' : ''}`} style={(() => {
                    const rect = statusTriggerRef.current?.getBoundingClientRect();
                    return rect ? { top: rect.bottom + 8, right: window.innerWidth - rect.right } : {};
                  })()}>
                    {HEALTH_ENDPOINTS.map(ep => {
                      const s = endpointStatus[ep.key];
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
                  </div>
                </>,
                document.body
              )}
            </div>
            <span className="app__header-user"><Hand size={18} /> {currentUser.name} {currentUser.role === 'admin' ? '' : ' (護理師)'}</span>
            {/* 窄螢幕只留圖示（文字藏在 app__btn-text，title 當提示），header 永遠一行不換行 */}
            {currentUser.role === 'admin' && (
                <button onClick={() => setShowAdminPwdModal(true)} className="app__header-pwd-btn" title="修改密碼">
                  <Settings size={14} /><span className="app__btn-text">修改密碼</span>
                </button>
            )}
            <button onClick={handleLogout} className="app__header-logout-btn" title="登出">
              <LogOut size={14} /><span className="app__btn-text">登出</span>
            </button>
          </div>
      </div>

      <div className="app__content">
        {currentUser.role === 'admin' ? (
          <ManagerInterface
            currentUser={currentUser}
            announcement={announcement}
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
            baseSalary={baseSalary} setBaseSalary={setBaseSalary}
            baseSalaryEnc={baseSalaryEnc} setBaseSalaryEnc={setBaseSalaryEnc}
            levelBonus={levelBonus} setLevelBonus={setLevelBonus}
            leaveWish={leaveWish}
            publishedDate={publishedDate}
          />
        ) : (
          <StaffDashboard
            currentUser={currentUser}
            myStaffRow={myStaffRow}
            targetYear={publishedDate.year}
            targetMonth={publishedDate.month}
            currentSchedule={finalizedSchedule}
            isStale={Number(publishedDate.year) * 12 + Number(publishedDate.month) < new Date().getFullYear() * 12 + new Date().getMonth() + 1}
            leaveWish={leaveWish}
          />
        )}
        </div>
      </div>
    </div>
    </>
  );
};
// ============================================================================
// 子元件區 (ManagerInterface) - 負責管理分頁切換
// ============================================================================
export default NurseSchedulingSystem;