import React, { useState, useEffect, useRef } from 'react';
import { FileText } from 'lucide-react';
import { doc, collection, query, orderBy, limit, getDocs, onSnapshot, setDoc, arrayUnion } from 'firebase/firestore';
import { auth, db, clearArchiveReports } from '../api/database';
import './StatisticsPanel.css';

const StatisticsPanel = ({
    staffData, priorityConfig, setPriorityConfig, healthStats = [],
    accumulatedReports, setAccumulatedReports, calculateAndNotifyNextStaff, bedConfig,
    schedule, finalizedSchedule, selectedYear, selectedMonth
}) => {
  // =========================================================
  // ★★★ 新增：衛福部三班護病比大數據監控引擎 ★★★
  const [hospitalLevel, setHospitalLevel] = useState('MedicalCenter');
  const unitBedCount = bedConfig?.bedCount || 50;

  // ★★★ 新增：下拉選單狀態 (預設看即時草稿) ★★★
  const [selectedReportMonth, setSelectedReportMonth] = useState('current_draft');
const [trendToggles, setTrendToggles] = useState({ health: true, ratioD: false, ratioE: false, ratioN: false });
  const RATIO_STANDARDS = {
      MedicalCenter: { name: '醫學中心', D: 6, E: 9, N: 11 },
      Regional: { name: '區域醫院', D: 7, E: 11, N: 13 },
      District: { name: '地區醫院', D: 10, E: 13, N: 15 }
  };

  const calculateSelectedRatio = () => {
      // --- 模式 A：看即時工作桌草稿 ---
      if (selectedReportMonth === 'current_draft') {
          const targetSchedule = finalizedSchedule || schedule;
          if (!targetSchedule || Object.keys(targetSchedule).length === 0) return null;

          let totalD = 0, totalE = 0, totalN = 0;
          const daysInMonth = new Date(selectedYear, selectedMonth, 0).getDate() || 30;

          Object.keys(targetSchedule).forEach(staffId => {
              // 工作桌包含 Dxxx 待認領空缺，全部都要算進單位戰力
              for (let d = 1; d <= daysInMonth; d++) {
                  const cell = targetSchedule[staffId]?.[d];
                  const type = (typeof cell === 'object' ? cell.type : cell) || 'OFF';
                  if (type === 'D') totalD++;
                  if (type === 'E') totalE++;
                  if (type === 'N') totalN++;
              }
          });

          const avgD = totalD / daysInMonth;
          const avgE = totalE / daysInMonth;
          const avgN = totalN / daysInMonth;

          return {
              monthKey: `${selectedYear} 年 ${selectedMonth} 月 (工作桌即時排班)`,
              daysInMonth,
              ratioD: avgD > 0 ? (unitBedCount / avgD).toFixed(1) : '∞',
              ratioE: avgE > 0 ? (unitBedCount / avgE).toFixed(1) : '∞',
              ratioN: avgN > 0 ? (unitBedCount / avgN).toFixed(1) : '∞',
              avgD: avgD.toFixed(1),
              avgE: avgE.toFixed(1),
              avgN: avgN.toFixed(1)
          };
      }

      // --- 模式 B：看過去的雲端歷史報表 ---
      if (!accumulatedReports) return null;
      const targetData = accumulatedReports[selectedReportMonth];
      if (!targetData) return null;

      let totalD = 0, totalE = 0, totalN = 0;
      let daysInMonth = 30;
      let parsedYear = new Date().getFullYear();
      let parsedMonth = new Date().getMonth() + 1;

      const matchEN = selectedReportMonth.match(/(\d{4})_(\d{1,2})/);
      if (matchEN) { parsedYear = Number(matchEN[1]); parsedMonth = Number(matchEN[2]); }
      daysInMonth = new Date(parsedYear, parsedMonth, 0).getDate() || 30;

      if (targetData.schedule_backup) {
          const sched = targetData.schedule_backup;
          Object.keys(sched).forEach(staffId => {
              for (let d = 1; d <= daysInMonth; d++) {
                  const cell = sched[staffId]?.[d];
                  const type = (typeof cell === 'object' ? cell.type : cell) || 'OFF';
                  if (type === 'D') totalD++;
                  if (type === 'E') totalE++;
                  if (type === 'N') totalN++;
              }
          });
      } else if (targetData.csv) {
          const lines = targetData.csv.split(/\r\n|\n/);
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
          monthKey: `${parsedYear} 年 ${parsedMonth} 月 (已結算歷史)`,
          daysInMonth,
          ratioD: avgD > 0 ? (unitBedCount / avgD).toFixed(1) : '∞',
          ratioE: avgE > 0 ? (unitBedCount / avgE).toFixed(1) : '∞',
          ratioN: avgN > 0 ? (unitBedCount / avgN).toFixed(1) : '∞',
          avgD: avgD.toFixed(1),
          avgE: avgE.toFixed(1),
          avgN: avgN.toFixed(1)
      };
  };
  const ratioResult = calculateSelectedRatio(); // ★ 改呼叫新的函式
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

  // 📡 即時監聽「目前輪到誰選班」(使用 props 的 selectedYear/Month，與員工端一致)
  useEffect(() => {
      const turnRef = doc(db, "SelectionTurn", `${selectedYear}_${selectedMonth}`);

      const unsub = onSnapshot(turnRef, (docSnap) => {
          if (docSnap.exists()) {
              setActiveTurn(docSnap.data());
          } else {
              setActiveTurn(null);
          }
      });
      return () => unsub();
  }, [selectedYear, selectedMonth]);

  // ⏭️ 強制跳過目前卡住的員工
  const handleForceSkip = async () => {
      if (!activeTurn?.active_staff_id) return;

      const targetStaffId = activeTurn.active_staff_id;
      const targetName = staffData.find(s => s.staff_id === targetStaffId)?.name || targetStaffId;

      if (!window.confirm(`🚨 確定要「強制跳過」 ${targetName} 嗎？\n\n這將剝奪他本回合的優先選班權，並立刻讓 AI 尋找下一位遞補者寄發 Email！`)) return;

      try {
          // 1. 將該名員工打入冷宮 (加入已送出黑名單)
          const progressRef = doc(db, "SelectionProgress", `${selectedYear}_${selectedMonth}`);
          await setDoc(progressRef, {
              submitted_staff: arrayUnion(targetStaffId)
          }, { merge: true });

          // 2. 清除雷達畫面
          const turnRef = doc(db, "SelectionTurn", `${selectedYear}_${selectedMonth}`);
          await setDoc(turnRef, { active_staff_id: null, updatedAt: new Date() });

          // 3. 呼叫 AI 找下一個人
          alert(`✅ 已跳過 ${targetName}！系統正在呼叫 AI 尋找下一位...`);
          if (typeof calculateAndNotifyNextStaff === 'function') {
              await calculateAndNotifyNextStaff(finalizedSchedule || {}, healthStats, selectedYear, selectedMonth);
          }
      } catch (error) {
          console.error("強制跳過失敗:", error);
          alert("❌ 操作失敗，請檢查網路連線。");
      }
  };
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
    <div className="statistics__ranking">
      <div className="statistics__ranking-title">{title}</div>
      {data.map((s, i) => (
        <div key={i} className="statistics__ranking-row">
          <span className="statistics__ranking-name">{i + 1}. {s.name} <span className="statistics__ranking-id">({s.staff_id})</span></span>
          <span className="statistics__ranking-value" style={{ color: color }}>{s.value}</span>
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

// -- (2) 從 accumulatedReports 動態解析健康度與三班護病比 --
  const getDynamicHealthStats = () => {
      const stats = [];
      Object.entries(accumulatedReports || {}).forEach(([fileName, fileData]) => {
          if (!fileData) return;

          let year = fileData.year;
          let month = fileData.month;
          if (!year || !month) {
              const matchCH = fileName.match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
              const matchEN = fileName.match(/(\d{4})_(\d{1,2})/);
              if (matchCH) { year = Number(matchCH[1]); month = Number(matchCH[2]); }
              else if (matchEN) { year = Number(matchEN[1]); month = Number(matchEN[2]); }
              else return;
          }

          const daysInMonth = new Date(year, month, 0).getDate() || 30;
          const scores = [];
          let totalD = 0, totalE = 0, totalN = 0;

          if (fileData.csv && typeof fileData.csv === 'string') {
              const lines = fileData.csv.split(/\r\n|\n/);
              let headerIdx = -1, healthColIdx = -1;
              for (let i = 0; i < lines.length; i++) {
                  if (lines[i].includes('工號') && lines[i].includes('姓名')) {
                      headerIdx = i; healthColIdx = lines[i].split(',').findIndex(c => c.includes('健康度評分')); break;
                  }
              }
              if (headerIdx !== -1 && healthColIdx !== -1) {
                  for (let i = headerIdx + 1; i < lines.length; i++) {
                      const cols = lines[i].split(',');
                      if (cols.length > healthColIdx) {
                          const score = Number(cols[healthColIdx]);
                          if (!isNaN(score)) scores.push(score);
                          // 統計護病比：所有人都要算 (含 Dxxx 空缺)
                          if (cols.length >= 2 + daysInMonth) {
                              for(let j = 2; j < 2 + daysInMonth; j++) {
                                  if (cols[j] === 'D') totalD++;
                                  if (cols[j] === 'E') totalE++;
                                  if (cols[j] === 'N') totalN++;
                              }
                          }
                      }
                  }
              }
          }

          if (scores.length === 0 && fileData.schedule_backup) {
              Object.keys(fileData.schedule_backup).forEach(staffId => {
                  const staffSchedule = fileData.schedule_backup[staffId];
                  // 統計護病比：所有人都要算
                  for (let d = 1; d <= daysInMonth; d++) {
                      const cell = staffSchedule[d];
                      const type = (typeof cell === 'object' ? cell.type : cell) || 'OFF';
                      if (type === 'D') totalD++;
                      if (type === 'E') totalE++;
                      if (type === 'N') totalN++;
                  }
                  // 健康度：含空缺佔位一起計算
                  let score = 100; const shifts = [];
                  for (let d = 1; d <= daysInMonth; d++) shifts.push((typeof staffSchedule[d] === 'object') ? (staffSchedule[d]?.type || 'OFF') : (staffSchedule[d] || 'OFF'));
                  const isWork = (s) => ['D', 'E', 'N', '支援'].includes(s) || (s && s.includes('OT'));
                  const isOff = (s) => ['OFF', 'RG', 'RC', '事假', '病假', '特休'].includes(s);

                  for (let i = 0; i < shifts.length - 1; i++) { if ((shifts[i] === 'E' && shifts[i+1] === 'D') || (shifts[i] === 'N' && (shifts[i+1] === 'D' || shifts[i+1] === 'E'))) score -= 20; }
                  let lastWork = null;
                  for (let i = 0; i < shifts.length; i++) { if (isWork(shifts[i])) { if (lastWork === 'N' && shifts[i] === 'E') score -= 10; if (lastWork === 'E' && shifts[i] === 'D') score -= 10; lastWork = shifts[i]; } }
                  for (let i = 0; i <= shifts.length - 7; i++) { const window = shifts.slice(i, i + 7); const workTypes = new Set(window.filter(s => ['D', 'E', 'N'].includes(s))); if (workTypes.size === 3) { score -= 15; i += 6; } }
                  let consecutiveN = 0, consecutiveWork = 0;
                  for (let i = 0; i <= shifts.length; i++) { const s = shifts[i]; if (s === 'N') consecutiveN++; else { if (consecutiveN >= 4) score -= 5; consecutiveN = 0; } if (s && isWork(s)) consecutiveWork++; else { if (consecutiveWork >= 6) score -= 5; consecutiveWork = 0; } }
                  for (let i = 1; i < shifts.length - 1; i++) { if (isWork(shifts[i-1]) && isOff(shifts[i]) && isWork(shifts[i+1])) { score -= 5; if (shifts[i-1] === 'N') score -= 15; } }
                  let hasFullWeekendOff = false;
                  for (let d = 1; d <= daysInMonth - 1; d++) { const date = new Date(year, month - 1, d); if (date.getDay() === 6) { if (isOff(shifts[d-1]) && isOff(shifts[d])) { hasFullWeekendOff = true; break; } } }
                  if (!hasFullWeekendOff) score -= 5;
                  scores.push(score);
              });
          }

          const hasRatio = totalD > 0 || totalE > 0 || totalN > 0;
          if (scores.length > 0 || hasRatio) {
              const avg = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
              let median = null;
              if (scores.length > 0) {
                  scores.sort((a, b) => a - b);
                  const mid = Math.floor(scores.length / 2);
                  median = scores.length % 2 !== 0 ? scores[mid] : Math.round((scores[mid - 1] + scores[mid]) / 2);
              }

              const avgD = totalD / daysInMonth;
              const avgE = totalE / daysInMonth;
              const avgN = totalN / daysInMonth;

              stats.push({
                  year, month, avg, median,
                  ratioD: avgD > 0 ? (unitBedCount / avgD).toFixed(1) : 0,
                  ratioE: avgE > 0 ? (unitBedCount / avgE).toFixed(1) : 0,
                  ratioN: avgN > 0 ? (unitBedCount / avgN).toFixed(1) : 0
              });
          }
      });

      const uniqueStatsMap = {};
      stats.forEach(s => { uniqueStatsMap[`${s.year}-${s.month}`] = s; });
      const finalStats = Object.values(uniqueStatsMap);
      finalStats.sort((a, b) => (a.year - b.year) || (a.month - b.month));
      return finalStats.slice(-12);
  };

// -- (3) 繪製健康度與護病比動態折線圖 --
  const renderLineChart = () => {
      const dynamicHealthStats = getDynamicHealthStats();

      if (!dynamicHealthStats || dynamicHealthStats.length === 0) {
          return <div className="statistics__chart-empty">尚無結算紀錄。<br/>只要「✅ 結算與歷史」中有封存班表，系統就會自動繪製！</div>;
      }

      const svgWidth = 850; const svgHeight = 400; const padding = 50; const paddingRight = 60;
      const chartWidth = svgWidth - padding - paddingRight; const chartHeight = svgHeight - padding * 2;

      const allScores = dynamicHealthStats.flatMap(d => [d.avg, d.median]).filter(v => v !== null);
      const minScore = allScores.length > 0 ? Math.max(0, Math.floor(Math.min(...allScores) / 5) * 5 - 5) : 0;
      const maxScore = 100;

      const minRatio = 0; const maxRatio = 20; // 護病比的右側 Y 軸範圍 (0 到 1:20)

      const getX = (index) => padding + (index * (chartWidth / Math.max(1, dynamicHealthStats.length - 1)));
      const getYHealth = (value) => padding + chartHeight - ((value - minScore) / (maxScore - minScore)) * chartHeight;
      const getYRatio = (value) => padding + chartHeight - ((value - minRatio) / (maxRatio - minRatio)) * chartHeight;

      const avgPoints = dynamicHealthStats.filter(d => d.avg !== null).map((d, i) => `${getX(dynamicHealthStats.indexOf(d))},${getYHealth(d.avg)}`).join(' ');
      const ratioDPoints = dynamicHealthStats.map((d, i) => `${getX(i)},${getYRatio(Number(d.ratioD))}`).join(' ');
      const ratioEPoints = dynamicHealthStats.map((d, i) => `${getX(i)},${getYRatio(Number(d.ratioE))}`).join(' ');
      const ratioNPoints = dynamicHealthStats.map((d, i) => `${getX(i)},${getYRatio(Number(d.ratioN))}`).join(' ');

      return (
          <div className="statistics__chart-wrapper">
              {/* 控制面板 (勾選框) */}
              <div className="statistics__chart-toggles">
                  <label className={`statistics__chart-toggle ${trendToggles.health ? 'statistics__chart-toggle--health' : 'statistics__chart-toggle--health-off'}`}>
                      <input type="checkbox" checked={trendToggles.health} onChange={(e) => setTrendToggles({...trendToggles, health: e.target.checked})} className="statistics__chart-toggle-checkbox" />
                      <span className={`statistics__chart-toggle-label ${trendToggles.health ? 'statistics__chart-toggle-label--health' : 'statistics__chart-toggle-label--health-off'}`}>❤️ 健康度 (左軸)</span>
                  </label>
                  <label className={`statistics__chart-toggle ${trendToggles.ratioD ? 'statistics__chart-toggle--ratioD' : 'statistics__chart-toggle--ratioD-off'}`}>
                      <input type="checkbox" checked={trendToggles.ratioD} onChange={(e) => setTrendToggles({...trendToggles, ratioD: e.target.checked})} className="statistics__chart-toggle-checkbox" />
                      <span className={`statistics__chart-toggle-label ${trendToggles.ratioD ? 'statistics__chart-toggle-label--ratioD' : 'statistics__chart-toggle-label--ratioD-off'}`}>☀️ 白班比 1:N (右軸)</span>
                  </label>
                  <label className={`statistics__chart-toggle ${trendToggles.ratioE ? 'statistics__chart-toggle--ratioE' : 'statistics__chart-toggle--ratioE-off'}`}>
                      <input type="checkbox" checked={trendToggles.ratioE} onChange={(e) => setTrendToggles({...trendToggles, ratioE: e.target.checked})} className="statistics__chart-toggle-checkbox" />
                      <span className={`statistics__chart-toggle-label ${trendToggles.ratioE ? 'statistics__chart-toggle-label--ratioE' : 'statistics__chart-toggle-label--ratioE-off'}`}>🌇 小夜比 1:N (右軸)</span>
                  </label>
                  <label className={`statistics__chart-toggle ${trendToggles.ratioN ? 'statistics__chart-toggle--ratioN' : 'statistics__chart-toggle--ratioN-off'}`}>
                      <input type="checkbox" checked={trendToggles.ratioN} onChange={(e) => setTrendToggles({...trendToggles, ratioN: e.target.checked})} className="statistics__chart-toggle-checkbox" />
                      <span className={`statistics__chart-toggle-label ${trendToggles.ratioN ? 'statistics__chart-toggle-label--ratioN' : 'statistics__chart-toggle-label--ratioN-off'}`}>🌙 大夜比 1:N (右軸)</span>
                  </label>
              </div>

              <svg viewBox={`0 0 ${svgWidth} ${svgHeight}`} className="statistics__chart-svg">

                  {/* 背景格線與雙 Y 軸數字 */}
                  {[0, 0.25, 0.5, 0.75, 1].map(ratio => {
                      const y = padding + chartHeight - (chartHeight * ratio);
                      const valHealth = Math.round(minScore + (maxScore - minScore) * ratio);
                      const valRatio = Math.round(minRatio + (maxRatio - minRatio) * ratio);
                      return (
                          <g key={ratio}>
                              <line x1={padding} y1={y} x2={svgWidth - paddingRight} y2={y} stroke="#ecf0f1" strokeDasharray="5 5" strokeWidth="1.5" />
                              <text x={padding - 10} y={y + 4} fontSize="12" fill="#3498db" textAnchor="end" className={trendToggles.health ? 'statistics__axis-label--visible' : 'statistics__axis-label--dimmed'}>{valHealth} 分</text>
                              <text x={svgWidth - paddingRight + 10} y={y + 4} fontSize="12" fill="#7f8c8d" textAnchor="start" className={(trendToggles.ratioD || trendToggles.ratioE || trendToggles.ratioN) ? 'statistics__axis-label--visible' : 'statistics__axis-label--dimmed'}>1 : {valRatio}</text>
                          </g>
                      );
                  })}

                  {/* 1. 健康度曲線 (平均與中位數) */}
                  <g className="statistics__chart-anim" style={{ opacity: trendToggles.health ? 1 : 0, transform: trendToggles.health ? 'translateY(0)' : 'translateY(-15px)' }}>
                      <polyline points={avgPoints} fill="none" stroke="#3498db" strokeWidth="3" strokeLinejoin="round" />
                  </g>

                  {/* 2. 白班護病比曲線 */}
                  <g className="statistics__chart-anim" style={{ opacity: trendToggles.ratioD ? 1 : 0, transform: trendToggles.ratioD ? 'translateY(0)' : 'translateY(15px)' }}>
                      <polyline points={ratioDPoints} fill="none" stroke="#f1c40f" strokeWidth="4" strokeLinejoin="round" />
                  </g>

                  {/* 3. 小夜護病比曲線 */}
                  <g className="statistics__chart-anim" style={{ opacity: trendToggles.ratioE ? 1 : 0, transform: trendToggles.ratioE ? 'translateY(0)' : 'translateY(15px)' }}>
                      <polyline points={ratioEPoints} fill="none" stroke="#e84393" strokeWidth="4" strokeLinejoin="round" />
                  </g>

                  {/* 4. 大夜護病比曲線 */}
                  <g className="statistics__chart-anim" style={{ opacity: trendToggles.ratioN ? 1 : 0, transform: trendToggles.ratioN ? 'translateY(0)' : 'translateY(15px)' }}>
                      <polyline points={ratioNPoints} fill="none" stroke="#34495e" strokeWidth="4" strokeLinejoin="round" />
                  </g>

                  {/* X軸標籤與各點數值 (Hover 或常駐顯示) */}
                  {dynamicHealthStats.map((d, i) => {
                      const x = getX(i);
                      const yAvg = d.avg !== null ? getYHealth(d.avg) : null;
                      const yRD = getYRatio(Number(d.ratioD));
                      const yRE = getYRatio(Number(d.ratioE));
                      const yRN = getYRatio(Number(d.ratioN));

                      return (
                          <g key={i}>
                              <text x={x} y={svgHeight - padding + 25} fontSize="13" fill="#34495e" textAnchor="middle" fontWeight="bold">{`${d.year}/${d.month}`}</text>

                              {yAvg !== null && <g className="statistics__chart-anim" style={{ opacity: trendToggles.health ? 1 : 0 }}>
                                  <circle cx={x} cy={yAvg} r="5" fill="#3498db" stroke="white" strokeWidth="2" />
                                  <text x={x} y={yAvg - 12} fontSize="12" fill="#2980b9" textAnchor="middle" fontWeight="bold">{d.avg}</text>
                              </g>}

                              <g className="statistics__chart-anim" style={{ opacity: trendToggles.ratioD ? 1 : 0 }}>
                                  <circle cx={x} cy={yRD} r="6" fill="#f1c40f" stroke="white" strokeWidth="2" />
                                  <text x={x} y={yRD + 18} fontSize="11" fill="#d4ac0d" textAnchor="middle" fontWeight="bold">{d.ratioD}</text>
                              </g>

                              <g className="statistics__chart-anim" style={{ opacity: trendToggles.ratioE ? 1 : 0 }}>
                                  <circle cx={x} cy={yRE} r="6" fill="#e84393" stroke="white" strokeWidth="2" />
                                  <text x={x} y={yRE + 18} fontSize="11" fill="#d81b60" textAnchor="middle" fontWeight="bold">{d.ratioE}</text>
                              </g>

                              <g className="statistics__chart-anim" style={{ opacity: trendToggles.ratioN ? 1 : 0 }}>
                                  <circle cx={x} cy={yRN} r="6" fill="#34495e" stroke="white" strokeWidth="2" />
                                  <text x={x} y={yRN + 18} fontSize="11" fill="#2c3e50" textAnchor="middle" fontWeight="bold">{d.ratioN}</text>
                              </g>
                          </g>
                      );
                  })}
              </svg>
          </div>
      );
  };

  return (
    <div className="statistics">
{/* ========================================================= */}
      {/* 🌟 1. 全新加入的：衛福部三班護病比寬螢幕面板 */}
      <div className="statistics__ratio-panel">
          <div className="statistics__ratio-header">
              <div>
                  <h2 className="statistics__ratio-title">
                      ⚖️ 衛福部三班護病比法遵監控
                      <span className="statistics__ratio-badge">113年3月1日新制</span>
                  </h2>
                  <p className="statistics__ratio-desc">
                      為解決護理人力荒並留任人員，衛福部以「獎勵先行、逐步推動、引領標竿」三原則推動新制。此面板依據本單位<strong>「最新結算封存之歷史真實班表」</strong>，自動精算每日平均人力，檢測是否合規，協助應對護理全聯會之實施現況調查。
                  </p>
              </div>

              {/* 參數設定區 */}
              <div className="statistics__ratio-settings">
                  <div className="statistics__ratio-settings-row">
                      <label className="statistics__ratio-settings-label">醫院層級：</label>
                      <select value={hospitalLevel} onChange={(e) => setHospitalLevel(e.target.value)} className="statistics__ratio-settings-select">
                          <option value="MedicalCenter">醫學中心</option>
                          <option value="Regional">區域醫院</option>
                          <option value="District">地區醫院</option>
                      </select>
                  </div>
                  <div className="statistics__ratio-bed-row">
    <label className="statistics__ratio-bed-label">單位總床數：</label>
    <span className="statistics__ratio-bed-count">{unitBedCount} 床</span>
    <span className="statistics__ratio-bed-hint">(由人力需求面板統一設定)</span>
</div>
              </div>
          </div>

{/* 檢測結果區塊 */}
          {!ratioResult ? (
              <div className="statistics__ratio-empty">
                  <div className="statistics__ratio-selector statistics__ratio-selector--centered">
                      📊 選擇分析樣本：
                      <select
                          value={selectedReportMonth}
                          onChange={(e) => setSelectedReportMonth(e.target.value)}
                          className="statistics__ratio-select"
                      >
                          <option value="current_draft">✨ 目前工作桌即時草稿 ({selectedYear}年{selectedMonth}月)</option>
                          {Object.keys(accumulatedReports || {}).sort().reverse().map(m => (
                              <option key={m} value={m}>📂 {m.replace('_', ' 年 ')} 月 (已結算歷史)</option>
                          ))}
                      </select>
                  </div>
                  尚無此月份班表資料，請先至「🛠️ 排班工作桌」生成，或至「✅ 結算與歷史」封存。
              </div>
          ) : (
              <div>
                  <div className="statistics__ratio-selector">
                      📊 選擇分析樣本：
                      <select
                          value={selectedReportMonth}
                          onChange={(e) => setSelectedReportMonth(e.target.value)}
                          className="statistics__ratio-select statistics__ratio-select--shadow"
                      >
                          <option value="current_draft">✨ 目前工作桌即時草稿 ({selectedYear}年{selectedMonth}月)</option>
                          {Object.keys(accumulatedReports || {}).sort().reverse().map(m => (
                              <option key={m} value={m}>📂 {m.replace('_', ' 年 ')} 月 (已結算歷史)</option>
                          ))}
                      </select>
                      <span className="statistics__ratio-current">
                          目前顯示：{ratioResult.monthKey}
                      </span>
                  </div>
                  <div className="statistics__ratio-cards">
                      {['D', 'E', 'N'].map(shift => {
                          const shiftName = shift === 'D' ? '白班' : shift === 'E' ? '小夜' : '大夜';
                          const avgNurses = ratioResult[`avg${shift}`];
                          const ratioVal = Number(ratioResult[`ratio${shift}`]);
                          const limit = RATIO_STANDARDS[hospitalLevel][shift];

                          const isViolated = ratioVal > limit || isNaN(ratioVal);

                          return (
                              <div key={shift} className={`statistics__ratio-card ${isViolated ? 'statistics__ratio-card--violated' : 'statistics__ratio-card--pass'}`}>
                                  <div className={`statistics__ratio-card-title ${isViolated ? 'statistics__ratio-card-title--violated' : 'statistics__ratio-card-title--pass'}`}>
                                      {shiftName} 護病比
                                  </div>
                                  <div className={`statistics__ratio-card-value ${isViolated ? 'statistics__ratio-card-value--violated' : 'statistics__ratio-card-value--pass'}`}>
                                      1 : {ratioResult[`ratio${shift}`]}
                                  </div>
                                  <div className="statistics__ratio-card-avg">
                                      平均每日 <strong>{avgNurses}</strong> 人上班
                                  </div>
                                  <div className={`statistics__ratio-card-status ${isViolated ? 'statistics__ratio-card-status--violated' : 'statistics__ratio-card-status--pass'}`}>
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
      {/* 📈 過去 12 個月動態趨勢圖 (緊貼在護病比面板下方) */}
      <div className="statistics__chart">
          <h3 className="statistics__chart-title">📈 過去 12 個月班表健康度與護病比趨勢</h3>
          {renderLineChart()}
      </div>

      {/* ========================================================= */}
      {/* 🧠 全新整合：智能 AI 決策與分析中心 */}
      <div className="statistics__ai-center">
          <h2 className="statistics__ai-center-title">
              🧠 智能 AI 決策與分析中心
          </h2>

          <div className="statistics__ai-center-grid">

              {/* === 左欄：接力排班雷達與決策歷史 (行動層) === */}
              <div className="statistics__ai-left">

                  {/* 1. 雷達與引擎 */}
                  <div className="statistics__radar">
                      <div className="statistics__radar-layout">
                         <div className="statistics__radar-info">
                             <h3 className="statistics__radar-title">
                                 🚀 AI 選班雷達與接力引擎
                             </h3>
                             <p className="statistics__radar-subtitle">
                                 自動判斷順位並發通知，遇卡關可強制跳過。
                             </p>

                             {/* 雷達顯示器 */}
                             <div className={`statistics__radar-display ${activeTurn?.active_staff_id ? 'statistics__radar-display--active' : 'statistics__radar-display--idle'}`}>
                                 <div>
                                     <div className="statistics__radar-waiting-label">目前發球權 (Waiting for)</div>
                                     {activeTurn?.active_staff_id ? (
                                         <div className="statistics__radar-waiting-name">
                                             <span className="statistics__radar-waiting-pulse">⏳</span>
                                             等待 {staffData.find(s => s.staff_id === activeTurn.active_staff_id)?.name || activeTurn.active_staff_id}
                                         </div>
                                     ) : (
                                         <div className="statistics__radar-idle-text">⏸️ 引擎待機中</div>
                                     )}
                                 </div>
                                 {activeTurn?.active_staff_id && (
                                     <button onClick={handleForceSkip} className="statistics__radar-skip-btn">
                                         ⏭️ 強制跳過
                                     </button>
                                 )}
                             </div>

                             {/* 客製化指令 */}
                             <div className="statistics__radar-instruction">
                                 <label className="statistics__radar-instruction-label">🧠 優先條件指令 (選填)</label>
                                 <input
                                     type="text"
                                     value={priorityConfig?.relayInstruction || ''}
                                     onChange={(e) => setPriorityConfig({...priorityConfig, relayInstruction: e.target.value})}
                                     placeholder="例：女性優先... (預設找最疲勞者)"
                                     className="statistics__radar-instruction-input"
                                 />
                             </div>
                         </div>

                         <div className="statistics__radar-actions">
                             <button
                                onClick={async () => {
                                   if(window.confirm("確定要手動啟動第一棒嗎？\n系統將自動發送 Email 給最需要補血的第一位同仁。")) {
                                       if (typeof calculateAndNotifyNextStaff !== 'function') {
                                           alert("❌ 接力功能未就緒，請重新整理頁面後再試。");
                                           return;
                                       }
                                       try {
                                           alert("🚀 引擎已啟動！AI 正在背景運算並發送通知...");
                                           await calculateAndNotifyNextStaff(finalizedSchedule || {}, healthStats, selectedYear, selectedMonth);
                                           alert("✅ AI 接力啟動成功！已通知第一位選班人員。");
                                       } catch (err) {
                                           console.error("啟動接力失敗:", err);
                                           alert(`❌ 啟動失敗：${err.message || err}\n\n請確認網路連線正常且已登入。`);
                                       }
                                   }
                                }}
                                className="statistics__radar-launch-btn"
                             >
                                ▶️ 啟動自動接力
                             </button>
                         </div>
                      </div>
                  </div>

                  {/* 2. AI 決策歷史看板 */}
                  <div className="statistics__decision-history">
                      <h3 className="statistics__decision-history-title">
                          <FileText size={18} color="#2980b9" /> 決策歷史 (最近 5 筆)
                      </h3>
                      <div className="statistics__decision-history-list">
                          {decisionLogs.length === 0 ? (
                              <div className="statistics__decision-history-empty">
                                  暫無 AI 決策數據
                              </div>
                          ) : decisionLogs.map(log => (
                              <div key={log.id} className="statistics__decision-history-item">
                                  <div className="statistics__decision-history-item-header">
                                      <strong className="statistics__decision-history-item-staff">🎯 {log.selected_staff}</strong>
                                      <span className="statistics__decision-history-item-time">
                                          {log.timestamp?.toDate ? log.timestamp.toDate().toLocaleString() : '...'}
                                      </span>
                                  </div>
                                  <div className="statistics__decision-history-item-logic">
                                      {log.ai_logic}
                                  </div>
                              </div>
                          ))}
                      </div>
                  </div>
              </div>

              {/* === 右欄：跨月分析精靈 (洞察層) === */}
              <div className="statistics__chat">
                  <div className="statistics__chat-header">
                      <h3 className="statistics__chat-title">
                          🤖 跨月數據分析精靈
                      </h3>
                      {hasData && (
                          <button onClick={handleClearMemory} className="statistics__chat-clear-btn">
                              🧹 清空記憶
                          </button>
                      )}
                  </div>

                  {/* 狀態燈號縮小版 */}
                  <div className="statistics__chat-status">
                      {hasData ? (
                          <>
                              <span className="statistics__chat-status-icon statistics__chat-status-icon--pulse">🟢</span>
                              <div className="statistics__chat-status-text--active">已載入 {loadedMonths.length} 個月大數據</div>
                          </>
                      ) : (
                          <>
                              <span className="statistics__chat-status-icon">🔴</span>
                              <div className="statistics__chat-status-text--inactive">尚未載入報表</div>
                          </>
                      )}
                  </div>

                  {/* 對話區 */}
                  <div className="statistics__chat-conversation">
                      <div className="statistics__chat-messages">
                          {aiMessages.map((m, i) => (
                              <div key={i} className={`statistics__chat-msg ${m.role === 'user' ? 'statistics__chat-msg--user' : 'statistics__chat-msg--assistant'}`}>
                                  <div className={`statistics__chat-msg-bubble ${m.role === 'user' ? 'statistics__chat-msg-bubble--user' : 'statistics__chat-msg-bubble--assistant'}`}>
                                      {m.content}
                                  </div>
                              </div>
                          ))}
                          {isAnalyzing && (
                              <div className="statistics__chat-msg statistics__chat-msg--assistant">
                                  <div className="statistics__chat-msg-bubble statistics__chat-msg-bubble--analyzing">
                                      ⏳ 正在交叉比對數據...
                                  </div>
                              </div>
                          )}
                          <div ref={chatEndRef} />
                      </div>

                      {/* 輸入區 */}
                      <div className="statistics__chat-input-row">
                          <input
                              value={aiInput}
                              onChange={(e) => setAiInput(e.target.value)}
                              onKeyPress={(e) => e.key === 'Enter' && handleAskAI()}
                              placeholder={hasData ? "問我請假趨勢..." : "等待資料..."}
                              disabled={!hasData || isAnalyzing}
                              className="statistics__chat-input"
                          />
                          <button
                              onClick={handleAskAI}
                              disabled={!hasData || isAnalyzing}
                              className={`statistics__chat-send-btn ${(!hasData || isAnalyzing) ? 'statistics__chat-send-btn--disabled' : 'statistics__chat-send-btn--enabled'}`}
                          >
                              送出
                          </button>
                      </div>
                  </div>
              </div>

          </div>
      </div>
      {/* ========================================================= */}
    </div>
  );
};

export default StatisticsPanel;
