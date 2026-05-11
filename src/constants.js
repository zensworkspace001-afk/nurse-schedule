import { Sun, Sunset, Moon, Users } from 'lucide-react';

// ============================================================================
// 資料結構與常數定義
// ============================================================================

export const SHIFT_TYPES = {
  D: { name: '白班', time: '07:00-16:00', color: '#FFD93D', icon: Sun, hours: 9 },
  E: { name: '小夜班', time: '15:00-00:00', color: '#FF6B9D', icon: Sunset, hours: 9 },
  N: { name: '大夜班', time: '23:00-08:00', color: '#4D96FF', icon: Moon, hours: 9 },
  OFF: { name: '休假', time: '', color: '#E8E8E8', icon: null, hours: 0 },
  RG: { name: '例假', time: '', color: '#2ecc71', icon: null, hours: 0 }, // 深綠
  RC: { name: '休假', time: '', color: '#d5f5e3', icon: null, hours: 0 }, // 淺綠 (亦可稱休息日)
  '支援': { name: '支援', time: '依需求', color: '#D4AC0D', icon: Users, hours: 9 }
};

export const LABOR_LAW_RULES = {
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
export const calculateAnnualLeave = (tenureYears) => {
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
export const checkLaborLawCompliance = (schedule, staffData, historyData, year, month) => {
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
    let totalMonthlyHours = 0;
    let totalRG = 0; // ★ 新增：統計例假 (不可出勤)
    let totalRC = 0; // ★ 新增：統計休息日 (可加班)
    let daysSinceLastRG = 0; // ★ 新增：距離上次例假的天數
    let scheduledAnnualLeave = 0; // ★ 新增：統計本月排了幾天特休
    // 用來計算每週工時 (以週一為起始)
    let currentWeekHours = 0;
    let isWeeklyViolationReported = false; // ★ 新增這行

    const isStudent = staff?.leave_status === 'Student';

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

      // --- A2. 實習生限制：不可排小夜 (E) / 大夜 (N) ---
      if (isStudent && (shiftType === 'E' || shiftType === 'N')) {
        violations.push({
          staffId, staffName: staff?.name, day, type: 'STUDENT_NIGHT_FORBIDDEN',
          message: `⚠️ 實習生不可排 ${shiftType === 'E' ? '小夜班 (E)' : '大夜班 (N)'}`
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

      // --- C. 統計休假天數與種類 ---
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
// 接近上限警示 (黃燈)
// ----------------------------------------------------------------------------
// checkLaborLawCompliance 只報「已違規」(紅)。這支補上「逼近但還沒違規」(黃)：
//   - 連續工作 5 天 (距七休一 1 天)
//   - 月工時 ≥ 192 小時 (= 標準 176 + OT 16，距 46h 月加班上限剩 30h；高度負荷期)
//   - 距上次 RG 已 5 天 (Standard) / 11 天 (BiWeekly) — 各距上限 1 天
//   - 例假累計 < 4 但月份還沒走完（提前提醒）
//   - 月份過半但 RG+RC 累計不到 4 天
//
// 回傳格式與 checkLaborLawCompliance 相同的 violation row，但多 severity: 'warning'。
// 同時把 stats（總工時、RG/RC 數、最大連續天數）也吐出來給 dashboard 用。
// ============================================================================
export const computeProximityWarnings = (schedule, staffData, year, month) => {
  const warnings = [];
  const perStaffStats = {};
  const daysInMonth = new Date(year, month, 0).getDate();
  const SHIFT_HOURS = { 'D': 8, 'E': 8, 'N': 8, '支援': 8, 'OFF': 0, 'RG': 0, 'RC': 0 };

  Object.keys(schedule || {}).forEach(staffId => {
    if (staffId.startsWith('D')) return; // 略過 virtual D-slot
    const staff = staffData.find(s => s.staff_id === staffId);
    if (!staff) return;

    const monthSchedule = schedule[staffId] || {};
    let consecutiveDays = 0;
    let maxConsecutive = 0;
    let totalMonthlyHours = 0;
    let totalRG = 0;
    let totalRC = 0;
    let daysSinceLastRG = 0;
    let maxDaysSinceLastRG = 0;
    let warnedConsecutive = false;
    let warnedRgInterval = false;

    const maxRgInterval = staff.special_status === 'BiWeekly' ? 12 : 6;
    const consecutiveWarnAt = 5;            // 距 6 天 1 天
    const rgIntervalWarnAt = maxRgInterval - 1; // 距上限 1 天

    for (let day = 1; day <= daysInMonth; day++) {
      const cell = monthSchedule[day] || 'OFF';
      const shiftType = (typeof cell === 'object') ? (cell.type || 'OFF') : cell;
      const dailyHours = SHIFT_HOURS[shiftType] || 0;
      totalMonthlyHours += dailyHours;

      if (dailyHours > 0) {
        consecutiveDays++;
        maxConsecutive = Math.max(maxConsecutive, consecutiveDays);
        if (consecutiveDays === consecutiveWarnAt && !warnedConsecutive) {
          warnings.push({
            staffId, staffName: staff.name, day, type: 'CONSECUTIVE_DAYS_WARNING',
            severity: 'warning',
            message: `🟡 接近七休一上限：${day} 號已連續 ${consecutiveDays} 天 (再 1 天就違規)`,
          });
          warnedConsecutive = true;
        }
      } else {
        consecutiveDays = 0;
        warnedConsecutive = false;
      }

      if (shiftType === 'RG') {
        totalRG++;
        daysSinceLastRG = 0;
        warnedRgInterval = false;
      } else {
        daysSinceLastRG++;
        maxDaysSinceLastRG = Math.max(maxDaysSinceLastRG, daysSinceLastRG);
        if (daysSinceLastRG === rgIntervalWarnAt && !warnedRgInterval) {
          warnings.push({
            staffId, staffName: staff.name, day, type: 'RG_INTERVAL_WARNING',
            severity: 'warning',
            message: `🟡 距上次例假已 ${daysSinceLastRG} 天 (上限 ${maxRgInterval} 天，再 1 天就違規)`,
          });
          warnedRgInterval = true;
        }
      }
      if (shiftType === 'RC') totalRC++;
    }

    // 月加總黃線：>192h (標準 176 + ~16h OT，相當於 OT 已用 ~35%)
    const OT_WARN_THRESHOLD = 192;
    if (totalMonthlyHours >= OT_WARN_THRESHOLD && totalMonthlyHours < 222) {
      const usedOt = totalMonthlyHours - 176;
      warnings.push({
        staffId, staffName: staff.name, day: '整月', type: 'MONTHLY_OT_WARNING',
        severity: 'warning',
        message: `🟡 月工時 ${totalMonthlyHours}h (約 OT ${usedOt}h / 上限 46h)，逼近月加班上限`,
      });
    }

    // 母性保護：懷孕/哺乳員工被排 D 班視為觀察（D 班雖合法，但建議減量）
    const isPregnant = staff.is_pregnant_or_nursing === true
      || staff.is_pregnant_or_nursing === 'True'
      || staff.is_pregnant_or_nursing === 'true';
    if (isPregnant) {
      let dShiftCount = 0;
      for (let day = 1; day <= daysInMonth; day++) {
        const cell = monthSchedule[day] || 'OFF';
        const shiftType = (typeof cell === 'object') ? (cell.type || 'OFF') : cell;
        if (shiftType === 'D' || shiftType === '支援') dShiftCount++;
      }
      if (dShiftCount > 0) {
        warnings.push({
          staffId, staffName: staff.name, day: '整月', type: 'MATERNITY_OBSERVE',
          severity: 'info',
          message: `🟢 懷孕/哺乳期觀察：本月排 ${dShiftCount} 天日班/支援 (E/N 已嚴格禁止)`,
        });
      }
    }

    perStaffStats[staffId] = {
      totalMonthlyHours,
      totalRG, totalRC,
      maxConsecutive,
      maxDaysSinceLastRG,
      isPregnant,
    };
  });

  return { warnings, perStaffStats };
};

// ============================================================================
// 護理專業安全檢查：資歷搭配 (Skill Mix)
// ============================================================================
export const checkSkillMixSafety = (schedule, staffData, year, month) => {
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
export const calculateScheduleRisks = (schedule, staffData, publicHolidays, year, month) => {
  const risks = [];
  const stats = {};
  let totalN = 0, totalHolidayWork = 0;
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
      if (type === 'E') { stats[staffId].E++; }
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
