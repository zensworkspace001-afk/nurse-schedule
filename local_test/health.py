"""
健康度計算 — Python port of PublishPanel.jsx calculateHealthScore

每位護理師起始 100 分，按下列規則扣分：
  -20  E→D 或 N→D 或 N→E（輪班間隔過短，每處）
  -5   連續 4+ 大夜（每段 streak 一次）
  -5   連續 6+ 上班（每段 streak 一次）

回傳 {score, deductions: ["短間隔", ...]}
"""

from typing import Dict, List


WORKING = {"D", "E", "N", "支援"}


def is_work(shift: str) -> bool:
    if not shift:
        return False
    return shift in WORKING or "OT" in shift


def calculate_health_score(shifts: List[str]) -> Dict:
    """
    Args:
      shifts: 整月班表 list，如 ['D', 'D', 'O', 'E', 'N', 'N', 'N', 'N', ...]

    Returns:
      {"score": int, "deductions": [str, ...]}
    """
    score = 100
    deductions = []

    # 規則 A：輪班間隔過短
    for i in range(len(shifts) - 1):
        cur, nxt = shifts[i], shifts[i + 1]
        if (cur == "E" and nxt == "D") or \
           (cur == "N" and nxt in ("D", "E")):
            score -= 20
            deductions.append(f"[-20] {cur}→{nxt} 短間隔 (day {i+1}-{i+2})")

    # 規則 B/C：連續大夜 / 連續上班 streak
    consecutive_n = 0
    consecutive_work = 0
    for i in range(len(shifts) + 1):
        s = shifts[i] if i < len(shifts) else None

        if s == "N":
            consecutive_n += 1
        else:
            if consecutive_n >= 4:
                score -= 5
                deductions.append(f"[-5] 連續大夜 {consecutive_n} 天 (~day {i})")
            consecutive_n = 0

        if s and is_work(s):
            consecutive_work += 1
        else:
            if consecutive_work >= 6:
                score -= 5
                deductions.append(f"[-5] 連六疲勞 {consecutive_work} 天 (~day {i})")
            consecutive_work = 0

    return {"score": score, "deductions": deductions}


def calculate_team_health(schedule: Dict[str, Dict[int, str]], num_days: int) -> Dict:
    """
    把全員班表跑一次健康度，回傳統計摘要。

    Args:
      schedule: {"N001": {1: "D", 2: "O", ...}, ...}
      num_days: 該月天數

    Returns:
      {
        "per_staff": {"N001": {score, deductions}, ...},
        "team_avg": float,
        "team_min": int,
        "team_max": int,
        "below_75": [staff_id, ...],
        "below_90": [staff_id, ...],
      }
    """
    per_staff = {}
    scores = []
    below_75 = []
    below_90 = []

    for staff_id, sched_dict in schedule.items():
        shifts = [sched_dict.get(d, "OFF") for d in range(1, num_days + 1)]
        result = calculate_health_score(shifts)
        per_staff[staff_id] = result
        scores.append(result["score"])
        if result["score"] < 75: below_75.append(staff_id)
        if result["score"] < 90: below_90.append(staff_id)

    return {
        "per_staff": per_staff,
        "team_avg": round(sum(scores) / len(scores), 1) if scores else 0,
        "team_min": min(scores) if scores else 0,
        "team_max": max(scores) if scores else 0,
        "below_75": below_75,
        "below_90": below_90,
    }
