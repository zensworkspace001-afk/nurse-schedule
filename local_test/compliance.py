"""
法遵檢查 — Python port of src/constants.js checkLaborLawCompliance

跟前端 JS 邏輯一比一對齊，方便交叉驗證 SA 輸出。

SA 輸出只有 'O' 一種休假類型，而 JS 端有 RG（例假）與 RC（休息日）的分別。
本檔在處理時把 'O' 當成「萬用休假」—— 對 RG_INTERVAL 視為例假（重置計數器），
對 INSUFFICIENT_RG / INSUFFICIENT_OFF 也都當成有效休假。實際部署時若要嚴格
區分，需要在 SA 上加標籤。
"""

import calendar
from typing import List, Dict, Any
from collections import defaultdict


SHIFT_HOURS = {
    "D": 8, "E": 8, "N": 8, "支援": 8,
    "O": 0, "OFF": 0, "RG": 0, "RC": 0,
    "事假": 0, "病假": 0, "特休": 0,
}

WORKING_SHIFTS = {"D", "E", "N", "支援"}
REST_SHIFTS_AS_RG = {"O", "OFF", "RG"}  # SA 輸出的 'O' 對等於 RG（重置計數）

# 禁止輪班序列（11h 間隔規則）
ILLEGAL_SEQUENCES = [("E", "D"), ("N", "D"), ("N", "E")]


def calculate_annual_leave(tenure_years: float) -> int:
    """勞基法 §38 特休年資階梯"""
    if tenure_years < 0.5: return 0
    if tenure_years < 1:   return 3
    if tenure_years < 2:   return 7
    if tenure_years < 3:   return 10
    if tenure_years < 5:   return 14
    if tenure_years < 10:  return 15
    return min(30, 15 + int(tenure_years - 9))


def _is_forbidden_sequence(prev: str, curr: str) -> bool:
    return (prev, curr) in ILLEGAL_SEQUENCES


def check_labor_law_compliance(
    schedule: Dict[str, Dict[int, str]],
    staff_data: List[Dict[str, Any]],
    year: int,
    month: int,
) -> List[Dict[str, Any]]:
    """
    跟 JS 版同樣的回傳格式：
    [{staffId, staffName, day, type, message}, ...]

    schedule 結構：
      { "N001": {1: "D", 2: "E", ...}, "N002": {...} }
    """
    violations = []
    _, days_in_month = calendar.monthrange(year, month)

    for staff_id, sched in schedule.items():
        staff = next((s for s in staff_data if s.get("staff_id") == staff_id), None)
        if not staff:
            continue

        name = staff.get("name", staff_id)
        is_student = staff.get("leave_status") == "Student"
        is_pregnant = staff.get("is_pregnant_or_nursing") in (True, "True", "true")
        special = staff.get("special_status", "Standard")

        consecutive_days = 0
        last_shift = None
        total_monthly_hours = 0
        total_rg = 0
        total_rc = 0
        days_since_last_rg = 0
        scheduled_annual_leave = 0
        current_week_hours = 0
        weekly_violation_reported = False

        for day in range(1, days_in_month + 1):
            cell = sched.get(day, "OFF")
            shift = cell if isinstance(cell, str) else cell.get("type", "OFF")
            daily_hours = SHIFT_HOURS.get(shift, 0)
            total_monthly_hours += daily_hours

            # A. 每日工時
            if daily_hours > 8:
                violations.append({
                    "staffId": staff_id, "staffName": name, "day": day,
                    "type": "DAILY_HOURS",
                    "message": f"每日工時超標：{daily_hours} 小時 (上限 8)",
                })

            # A2. 實習生禁排小夜/大夜
            if is_student and shift in ("E", "N"):
                violations.append({
                    "staffId": staff_id, "staffName": name, "day": day,
                    "type": "STUDENT_NIGHT_FORBIDDEN",
                    "message": f"實習生不可排 {'小夜班 (E)' if shift == 'E' else '大夜班 (N)'}",
                })

            # B. 每週工時（週一重置）
            dow = calendar.weekday(year, month, day)  # 0=Mon
            if dow == 0:
                current_week_hours = 0
                weekly_violation_reported = False
            current_week_hours += daily_hours

            max_weekly = 48 if special == "BiWeekly" else 40
            if current_week_hours > max_weekly and not weekly_violation_reported:
                violations.append({
                    "staffId": staff_id, "staffName": name, "day": day,
                    "type": "WEEKLY_HOURS",
                    "message": f"每週工時超標：本週累計 {current_week_hours}h (上限 {max_weekly})",
                })
                weekly_violation_reported = True

            # C. 特休統計 + RG_INTERVAL
            if shift == "特休":
                scheduled_annual_leave += 1
            if shift in REST_SHIFTS_AS_RG:
                total_rg += 1
                days_since_last_rg = 0
            elif daily_hours > 0:
                days_since_last_rg += 1
                max_rg_interval = 6  # 標準與雙週同樣 6 工作日
                if days_since_last_rg > max_rg_interval:
                    violations.append({
                        "staffId": staff_id, "staffName": name, "day": day,
                        "type": "RG_INTERVAL",
                        "message": f"自上個 RG 後累計 {days_since_last_rg} 個工作日未排例假 (上限 {max_rg_interval})",
                    })
                    days_since_last_rg = 0

            if shift == "RC":
                total_rc += 1

            # D. 連續工作天數
            if daily_hours > 0:
                consecutive_days += 1
                if consecutive_days > 6:
                    violations.append({
                        "staffId": staff_id, "staffName": name, "day": day,
                        "type": "CONSECUTIVE_DAYS",
                        "message": f"違反七休一：連續工作已達 {consecutive_days} 天",
                    })
            else:
                consecutive_days = 0

            # E. 輪班間隔
            if last_shift and daily_hours > 0 and SHIFT_HOURS.get(last_shift, 0) > 0:
                if _is_forbidden_sequence(last_shift, shift):
                    violations.append({
                        "staffId": staff_id, "staffName": name, "day": day,
                        "type": "SHIFT_INTERVAL",
                        "message": f"輪班間隔不足：{last_shift} 接 {shift} (休息 < 11小時)",
                    })

            # H. 母性保護
            if is_pregnant and shift in ("E", "N"):
                violations.append({
                    "staffId": staff_id, "staffName": name, "day": day,
                    "type": "MATERNITY_PROTECTION",
                    "message": f"違反母性保護：懷孕/哺乳期禁止夜間出勤 ({shift}班)",
                })

            last_shift = shift if daily_hours > 0 else None

        # 整月匯總
        total_annual_leave = calculate_annual_leave(staff.get("tenure_years", 0))
        remaining_leave = total_annual_leave - staff.get("annual_leave_used", 0)
        if scheduled_annual_leave > remaining_leave:
            violations.append({
                "staffId": staff_id, "staffName": name, "day": "整月",
                "type": "ANNUAL_LEAVE_EXCEEDED",
                "message": f"特休超休：本月排 {scheduled_annual_leave} 天 (剩餘 {remaining_leave})",
            })

        if total_rg < 4:
            violations.append({
                "staffId": staff_id, "staffName": name, "day": "整月",
                "type": "INSUFFICIENT_RG",
                "message": f"例假嚴重不足：本月僅 {total_rg} 天 (依法至少 4 天)",
            })
        if (total_rg + total_rc) < 8:
            violations.append({
                "staffId": staff_id, "staffName": name, "day": "整月",
                "type": "INSUFFICIENT_OFF",
                "message": f"總休假不足：本月 RG+RC 僅 {total_rg + total_rc} 天 (法定約 8 天)",
            })

        monthly_limit = 176 + 46
        if total_monthly_hours > monthly_limit:
            violations.append({
                "staffId": staff_id, "staffName": name, "day": "整月",
                "type": "MONTHLY_OT",
                "message": f"加班超標：本月總工時 {total_monthly_hours}h (上限 {monthly_limit})",
            })

    return violations


def summarize_violations(violations: List[Dict]) -> Dict[str, int]:
    """把違規清單按 type 分組計數，方便顯示報告"""
    counts = defaultdict(int)
    for v in violations:
        counts[v["type"]] += 1
    return dict(counts)
