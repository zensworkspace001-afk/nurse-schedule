"""
CP-SAT × SA 混合排班（概念驗證）

階段 1 — CP-SAT：硬約束（勞基法 + 每日覆蓋 + 母性/實習生保護 + 健康底線 + 週內不花花班）寫成
         「不可違反」的約束；軟約束（休假志願、夜班、孤立休、週末上班、換班別、連六）
         寫成加權懲罰。CP-SAT 回傳 FEASIBLE/OPTIMAL 即在數學上保證 0 硬違規 ——
         這是純 SA（main1.py）做不到的保證。
階段 2 — SA polish：只在「硬約束維持 0」的鄰域內移動（不合法的移動直接拒絕），
         打磨 CP-SAT 在時間限制內沒收斂完的軟目標（含公平性 max 項）。

目標函數（越小越好）：
    Σ_n  m_n · d_n   +   λ · max_n d_n
    d_n = Σ_k W_k · f_{n,k}         （第 n 位護理師的「不滿度」）
    W_k = 各軟約束權重（由 learning.py 從滿意度回饋學出來）
    m_n = 個人補償乘數（上個月被犧牲越多 → 這個月越優先）
    λ   = 公平性權重（壓低最不滿那個人的不滿度）

硬約束刻意與 local_test/compliance.py（= src/constants.js checkLaborLawCompliance）
對齊，最後再用 compliance.py 獨立驗證一次。
"""

import calendar
import logging
import math
import random
from dataclasses import dataclass, field
from time import time
from typing import Dict, List, Optional, Set

from ortools.sat.python import cp_model


SHIFTS = ["D", "E", "N", "RG", "RC"]
WORK = ("D", "E", "N")
REST = ("RG", "RC")
FORBIDDEN = [("E", "D"), ("N", "D"), ("N", "E")]   # 輪班間隔 < 11h

MAX_CONSEC_WORK = 6     # 七休一（法定上限）
HEALTH_CONSEC_WORK = 5  # 健康上限：連上 6 天健康度就扣 5 分 → 預設最多連上 5 天
MAX_RG_GAP = 6          # 兩 RG 間最多 6 個工作日（勞動部 105.10.07 函）
# —— 輪班工效學（研究依據）——
# Knauth P, Hornberger S. Preventive and compensatory measures for shift workers.
#   Occup Med (Lond). 2003;53(2):109-116. → 連續大夜以 2-3 晚為限、大夜後要有足夠恢復休息
# Czeisler CA, Moore-Ede MC, Coleman RM. Rotating shift work schedules that disrupt sleep
#   are improved by applying circadian principles. Science. 1982;217(4558):460-463.
#   → 順向輪班（D→E→N）比逆向（N→E→D）容易適應；後續研究效果中等 → 只當軟約束
MAX_CONSEC_N = 3        # 連續大夜 ≤ 3（Knauth & Hornberger 2003；連 4+ 也會被健康度扣分）
POST_NIGHT_REST = 2     # 大夜段結束後至少連休 2 天（Knauth & Hornberger 2003）
SHIFT_ORDER = {"D": 0, "E": 1, "N": 2}
MAX_OVERSTAFF = 2       # 每班可比最低需求多 1~2 人（多排人力分擔沒關係）
BACKWARD_MAX_GAP = 4    # 兩個工作日之間隔 ≤ 4 天休假仍算同一輪替；更長的休假視為重新開始
MIN_RG = 4
MIN_REST = 8            # RG + RC
MAX_MONTH_WORK = 27     # (176 + 46) / 8 = 27.75
MIN_MONTH_WORK = 20     # 每人每月至少上班 20 天（院方要求，避免人力閒置 / 工時不足）

FEATURES = [
    "wish_high_miss", "wish_normal_miss", "nights",
    "isolated_off", "weekend_work", "shift_switch", "streak6",
]
SENIOR_LEVELS = ("N2", "N3", "N4")         # 資深職級（與前端 checkSkillMixSafety 一致）


FEATURE_LABELS = {
    "wish_high_miss":   "高優先志願落空",
    "wish_normal_miss": "一般志願落空",
    "nights":           "大夜班數",
    "isolated_off":     "孤立休（上一休一）",
    "weekend_work":     "週末上班",
    "shift_switch":     "連續上班換班別",
    "streak6":          "連上 6 天",
}


@dataclass
class Problem:
    year: int
    month: int
    staff: List[Dict]
    reqs: Dict[str, int]                        # {"D": 3, "E": 2, "N": 2}
    wishes: Dict[str, Dict[str, Set[int]]]      # {sid: {"high": {day0,...}, "normal": {...}}}，day 0-indexed
    reqs_max: Dict[str, int] = field(default=None)
    one_shift_per_week: bool = True             # 週內不花花班：同一日曆週只能上一種工作班別
    post_night_rest: int = POST_NIGHT_REST       # 硬：大夜段結束後連休天數（0 = 不檢查）
    backward_weight: float = 2.0                 # 軟：每次逆向輪班的不滿度（約等於 2 天一般志願落空）
    max_consec_work: int = HEALTH_CONSEC_WORK    # 硬：最多連上幾天（不得超過法定 6；夜班另受 MAX_CONSEC_N = 3 限制）
    min_work_days: int = MIN_MONTH_WORK          # 硬：每人每月至少上班天數（0 = 不限制）
    mix2_weight: float = 1.0                     # 軟：整月混 2 種工作班別的不滿度
    mix3_weight: float = 3.0                     # 軟：整月混 3 種（D/E/N 全上）— 比 2 種重
    senior_weight: float = 0.0                   # 軟：某天某班沒有資深人員（N2+ 或組長）坐鎮，每班次的不滿度
                                                 #     （對齊前端 checkSkillMixSafety；0 = 不考慮）

    def __post_init__(self):
        _, self.num_days = calendar.monthrange(self.year, self.month)
        if self.reqs_max is None:
            self.reqs_max = {s: r + MAX_OVERSTAFF for s, r in self.reqs.items()}
        self.weekend = {d for d in range(self.num_days)
                        if calendar.weekday(self.year, self.month, d + 1) >= 5}
        # 日曆週（週一重置，與 compliance.py 一致）：[(start0, end0_inclusive), ...]
        self.weeks = []
        start = 0
        for d in range(self.num_days):
            if d > 0 and calendar.weekday(self.year, self.month, d + 1) == 0:
                self.weeks.append((start, d - 1))
                start = d
        self.weeks.append((start, self.num_days - 1))
        self.ids = [s["staff_id"] for s in self.staff]

    def is_protected(self, s: Dict) -> bool:
        return bool(s.get("is_pregnant_or_nursing")) or s.get("leave_status") == "Student"

    def is_senior(self, s: Dict) -> bool:
        return s.get("is_leader") in (True, "True", "true") or s.get("level") in SENIOR_LEVELS

    def weekly_cap(self, s: Dict) -> int:
        return 6 if s.get("special_status") == "BiWeekly" else 5   # 48h / 40h


# ============================================================
# Python 端：硬約束檢查 + 軟特徵（polish 與報告用；與 CP-SAT 模型一一對應）
# ============================================================
def hard_violations(shifts: List[str], s: Dict, prob: Problem) -> int:
    v = 0
    work = [x in WORK for x in shifts]
    if prob.is_protected(s):
        v += sum(1 for x in shifts if x in ("E", "N"))
    for a, b in zip(shifts, shifts[1:]):
        if (a, b) in FORBIDDEN:
            v += 1
    run = n_run = gap = 0
    for x, w in zip(shifts, work):
        run = run + 1 if w else 0
        n_run = n_run + 1 if x == "N" else 0
        if x == "RG":
            gap = 0
        elif w:
            gap += 1
        v += (run > min(MAX_CONSEC_WORK, prob.max_consec_work)) + (n_run > MAX_CONSEC_N) + (gap > MAX_RG_GAP)
    cap = prob.weekly_cap(s)
    week_work = [sum(work[a:b + 1]) for a, b in prob.weeks]
    v += sum(1 for w in week_work if w > cap)
    if s.get("special_status") == "BiWeekly":
        v += sum(1 for w1, w2 in zip(week_work, week_work[1:]) if w1 + w2 > 10)   # 雙週 ≤ 80h
    n_rg = shifts.count("RG")
    v += (n_rg < MIN_RG) + (n_rg + shifts.count("RC") < MIN_REST) + (sum(work) > MAX_MONTH_WORK)
    v += sum(work) < prob.min_work_days
    if prob.one_shift_per_week:
        v += sum(1 for a, b in prob.weeks if len({x for x in shifts[a:b + 1] if x in WORK}) > 1)
    k = prob.post_night_rest
    for d in range(len(shifts) - 1):
        if shifts[d] == "N" and shifts[d + 1] != "N":
            v += sum(1 for t in range(d + 1, min(d + 1 + k, len(shifts))) if shifts[t] not in REST)
    return v


def backward_rotations(shifts: List[str]) -> int:
    """逆向輪班次數：相鄰兩個工作日（中間休 ≤ BACKWARD_MAX_GAP 天）班別往回走（N→E、N→D、E→D）"""
    n = 0
    last, gap = None, 0
    for x in shifts:
        if x in WORK:
            if last is not None and gap <= BACKWARD_MAX_GAP and SHIFT_ORDER[x] < SHIFT_ORDER[last]:
                n += 1
            last, gap = x, 0
        else:
            gap += 1
    return n


def person_cost(shifts: List[str], sid: str, prob: Problem, W: Dict[str, float]) -> float:
    """個人不滿度 = 加權軟特徵 + 逆向輪班；CP-SAT 的 d_exprs 與 polish 都用這個定義"""
    n_types = len({x for x in shifts if x in WORK})
    mix = prob.mix3_weight if n_types >= 3 else prob.mix2_weight if n_types == 2 else 0.0
    return dissat(features(shifts, sid, prob), W) + prob.backward_weight * backward_rotations(shifts) + mix


def coverage_ok(schedule: Dict[str, List[str]], prob: Problem) -> bool:
    for d in range(prob.num_days):
        for sh in WORK:
            c = sum(1 for sid in prob.ids if schedule[sid][d] == sh)
            if not (prob.reqs[sh] <= c <= prob.reqs_max[sh]):
                return False
    return True


def _week_coverable(prob: Problem, L: int, caps_by_sid: Dict[str, int]) -> bool:
    """給定每位非保護人員本週可上天數上限，能否把人分給 D/E/N 蓋滿本週需求（精確搜尋）"""
    from functools import lru_cache
    prot_cap = sum(min(prob.weekly_cap(s), L) for s in prob.staff if prob.is_protected(s))
    caps = tuple(sorted(caps_by_sid.values(), reverse=True))
    need = (max(0, prob.reqs["D"] * L - prot_cap), prob.reqs["E"] * L, prob.reqs["N"] * L)

    @lru_cache(maxsize=None)
    def ok(i, d, e, n):
        if d <= 0 and e <= 0 and n <= 0:
            return True
        if i == len(caps):
            return False
        c = caps[i]
        return ok(i + 1, d - c, e, n) or ok(i + 1, d, e - c, n) or ok(i + 1, d, e, n - c) or ok(i + 1, d, e, n)

    return ok(0, *need)


def monthly_workday_shortfall(prob: Problem) -> List[str]:
    """每人「理論上最多能上幾天」（週工時上限、月休 ≥ 8、月上限 27）低於 min_work_days → 必然無解"""
    reasons = []
    for s in prob.staff:
        cap = prob.weekly_cap(s)
        week_max = sum(min(cap, b - a + 1) for a, b in prob.weeks)
        if s.get("special_status") == "BiWeekly":   # 相鄰兩週合計 ≤ 10
            caps = [min(cap, b - a + 1) for a, b in prob.weeks]
            for i in range(1, len(caps)):
                caps[i] = min(caps[i], 10 - caps[i - 1])
            week_max = sum(caps)
        best = min(week_max, prob.num_days - MIN_REST, MAX_MONTH_WORK)
        if best < prob.min_work_days:
            reasons.append(f"{s['staff_id']}：本月週工時上限下最多只能上 {best} 天，達不到每月至少 {prob.min_work_days} 天")
    return reasons


def staffing_range(year: int, month: int, reqs: Dict[str, int], base_staff: List[Dict],
                   max_extra: int = 15, check_time: float = 30.0, wish_slack: int = 4,
                   deadline: Optional[float] = None, workers: int = 8, resume: Optional[Dict] = None) -> Dict:
    """
    人力試算：在目前團隊組成（base_staff 的保護名單、雙週人員）下，每日需求 reqs 需要幾人。

    回傳：
      min      — 最少人數：預檢通過且 CP-SAT 證明有合法解（全部硬約束）
      max      — 最多人數：每人至少 min_work_days 天，但每班最多超編 MAX_OVERSTAFF 人，
                 人太多會「班不夠分」→ floor(Σ(需求+超編上限) × 天數 / 最少上班天數)
      comfort  — 建議人數：≥ min 且每天預假配額（人數 − 每日最低需求）≥ wish_slack
      gray     — 時限內既沒證明有解、也沒證明無解（UNKNOWN）的人數：可能排得出來但很難，不建議
      checks   — 每個試過的人數與結果（預檢無解 / INFEASIBLE / FEASIBLE / UNKNOWN / TIMEOUT）
      timed_out — 到了 deadline（time() 絕對時間）還沒找到 min 就停止；這種結果不該被快取
    resume: 上一次 timed_out 的結果 → 沿用已檢查過的人數，從下一個人數接著試（每次重試都會往前推進）
    人數不足時以「一般護理師」補位（不改動既有人員的身分）；人數過多時從尾端移除一般護理師。
    """
    nd = calendar.monthrange(year, month)[1]
    demand = sum(reqs.values())
    prot = [s for s in base_staff if s.get("is_pregnant_or_nursing") or s.get("leave_status") == "Student"]
    others = [s for s in base_staff if s not in prot]

    def team(n: int) -> List[Dict]:
        k = n - len(prot)
        if k < 0:
            return []
        kept = others[:k]
        extra = [{"staff_id": f"X{i + 1:02d}", "name": f"補{i + 1}", "tenure_years": 3,
                  "special_status": "Standard", "is_pregnant_or_nursing": False, "leave_status": "None"}
                 for i in range(max(0, k - len(others)))]
        return prot + kept + extra

    hi = max_headcount(reqs, nd)
    checks = [c for c in (resume or {}).get("checks", []) if c[1] != "TIMEOUT"]
    done = {c[0] for c in checks}
    n_min = None
    approx = False
    timed_out = False

    def run(n, cap=check_time):
        """檢查 n 人排不排得出來 → 狀態字串；'STOP' = 時間不夠"""
        staff = team(n)
        ids = [s["staff_id"] for s in staff]
        prob = Problem(year, month, staff, reqs, {i: {"high": set(), "normal": set()} for i in ids},
                       backward_weight=0, mix2_weight=0, mix3_weight=0)
        why = monthly_workday_shortfall(prob) or weekly_staffing_shortfall(prob)
        if why:
            checks.append((n, "預檢無解", why[0]))
            return "預檢無解"
        limit = cap
        if deadline is not None:
            limit = min(cap, deadline - time() - 2)
            if limit < 3:
                checks.append((n, "TIMEOUT", ""))
                return "STOP"
        r = solve_cpsat(prob, {k: 0.0 for k in FEATURES}, {i: 1.0 for i in ids}, 0.0, time_limit=limit,
                        workers=workers)
        st = "FEASIBLE" if r["schedule"] is not None else r["status"]
        checks.append((n, st, ""))
        return st

    lo = max(demand, len(prot) + 1)
    top = min(len(base_staff) + max_extra, hi)        # 超過 hi 必然「班不夠分」，不用試
    n0 = min(max(len(base_staff), lo), top)
    prior = {c[0]: c[1] for c in checks}
    # 1) 先問「目前這組人排不排得出來」— 護理長真正要的答案；往上找只在排不出來時才做
    st0 = prior.get(n0) or run(n0, cap=max(check_time, 45.0))   # 最重要的一題，給多一點時間
    if st0 == "STOP":
        timed_out = True
    elif st0 == "FEASIBLE":
        # 2) 目前人數可行 → 剩餘時間往下找最少人數；遇到無法判定（UNKNOWN）就停，標為約略值
        n_min = n0
        for n in range(n0 - 1, lo - 1, -1):
            st = prior.get(n) or run(n)
            if st == "FEASIBLE":
                n_min = n
                continue
            approx = st in ("UNKNOWN", "STOP")
            break
    else:
        # 3) 目前人數排不出來 → 往上加人找最少需要幾人（中止時保留進度，下次接著試）
        for n in range(n0 + 1, top + 1):
            if n in done:
                if prior[n] == "FEASIBLE":
                    n_min = n
                    break
                continue
            st = run(n)
            if st == "STOP":
                timed_out = True
                break
            if st == "FEASIBLE":
                n_min = n
                break
    checks.sort(key=lambda c: c[0])
    comfort = None if n_min is None else max(n_min, demand + wish_slack)
    gray = [n for n, st, _ in checks if st == "UNKNOWN"]
    return {"min": n_min, "max": hi, "comfort": comfort, "gray": gray, "demand": demand, "days": nd,
            "protected": len(prot), "checks": checks, "timed_out": timed_out, "approx": approx}


def max_headcount(reqs: Dict[str, int], num_days: int) -> int:
    """最多人數：每人至少 MIN_MONTH_WORK 天，但每班最多超編 MAX_OVERSTAFF 人 → 人再多就「班不夠分」"""
    return (sum(r + MAX_OVERSTAFF for r in reqs.values()) * num_days) // max(1, MIN_MONTH_WORK)


def _proven_lower_bound(rng: Dict) -> Optional[int]:
    """從最小人數開始、連續被證明排不出來的那一段 + 1；中間夾著無法判定的就停（人太多造成的不可行不算）"""
    lb = None
    for n, st, _ in sorted(rng.get("checks") or [], key=lambda c: c[0]):
        if st not in ("預檢無解", "INFEASIBLE"):
            break
        lb = n + 1
    return lb


log = logging.getLogger(__name__)


def adjust_headcount(staff: List[Dict], rng: Dict, keep_ids=()) -> Dict:
    """
    依試算結果決定這次參與排班的人：
      人數 < min  → 不能排（回傳缺幾人；不自動虛構員工）
      人數 > max  → 從尾端移除一般護理師到 max（保護名單、雙週人員優先保留）
      其餘        → 全員參與
    """
    n = len(staff)
    if rng["min"] is None and rng.get("timed_out"):
        lb = _proven_lower_bound(rng)
        known = f"已確認 {lb - 1} 人以下排不出來；" if lb else ""
        return {"ok": False, "staff": staff,
                "note": f"人力試算超過時間上限而中止（{known}目前 {n} 人）。請稍後再試，或降低每日需求"}
    if rng["min"] is None:
        # 試算範圍內都沒找到合法解：下限取「已證明無解的最大人數 + 1」，不要把 None 印給使用者
        checks = rng.get("checks") or []
        tried = max((c[0] for c in checks), default=n)
        lb = _proven_lower_bound(rng) or n + 1
        return {"ok": False, "staff": staff,
                "note": f"人力不足：至少需要 {lb} 人以上（試算到 {tried} 人仍無法確認排得出來），目前 {n} 人，請增補人力或降低每日需求"}
    if n < rng["min"]:
        return {"ok": False, "staff": staff, "note": f"人力不足：至少需要 {rng['min']} 人，目前 {n} 人，請增補人力或降低每日需求"}
    if n > rng["max"]:
        # 已登記預假（保證休假）的人也優先保留，否則被排除等於預假失效
        keep_first = [s for s in staff if s.get("is_pregnant_or_nursing") or s.get("leave_status") == "Student"
                      or s.get("special_status") == "BiWeekly" or s["staff_id"] in keep_ids]
        rest = [s for s in staff if s not in keep_first]
        kept = keep_first + rest[:rng["max"] - len(keep_first)]
        dropped = [s["staff_id"] for s in staff if s not in kept]
        return {"ok": True, "staff": kept,
                "note": f"人力過剩：最多 {rng['max']} 人（每人至少 {MIN_MONTH_WORK} 天會班不夠分），本次不排 {dropped}"}
    least = f"不超過 {rng['min']}" if rng.get("approx") else f"{rng['min']}"   # 往下找時遇到無法判定就停
    return {"ok": True, "staff": staff, "note": f"人力適中（最少 {least}、建議 ≥ {rng['comfort']}、最多 {rng['max']}）"}


def check_wishes_feasible(prob: Problem, wishes: Dict[str, List[int]], time_limit: float = 20.0,
                          workers: int = 8) -> Dict:
    """
    預假可行性檢查：把 wishes（{sid: [day0, ...]}，0-indexed）全部當「必休」硬約束，問 CP-SAT 有沒有合法班表。
      feasible=True  → 這組預假全部保證能滿足
      feasible=False → 不可行（reason 說明）；時限內無法判定（UNKNOWN）也保守地當不可行
    純可行性（目標為 0），通常 1~2 秒。
    """
    reasons = monthly_workday_shortfall(prob) or (weekly_staffing_shortfall(prob) if prob.one_shift_per_week else [])
    if reasons:
        return {"feasible": False, "status": "INFEASIBLE", "reason": reasons[0]}

    def pin(m, x, pr, wy):
        for sid, days in wishes.items():
            if sid not in pr.ids:
                continue
            for d in days:
                m.add(sum(x[sid, d, r] for r in REST) == 1)
        return 0

    zero = Problem(prob.year, prob.month, prob.staff, prob.reqs,
                   {i: {"high": set(), "normal": set()} for i in prob.ids}, reqs_max=prob.reqs_max,
                   one_shift_per_week=prob.one_shift_per_week, post_night_rest=prob.post_night_rest,
                   backward_weight=0, max_consec_work=prob.max_consec_work, min_work_days=prob.min_work_days,
                   mix2_weight=0, mix3_weight=0)
    r = solve_cpsat(zero, {k: 0.0 for k in FEATURES}, {i: 1.0 for i in prob.ids}, 0.0,
                    time_limit=time_limit, workers=workers, extra=pin)
    if r["schedule"] is not None:
        return {"feasible": True, "status": r["status"], "reason": ""}
    if r["status"] == "INFEASIBLE":
        return {"feasible": False, "status": "INFEASIBLE",
                "reason": "加上已登記的預假後，勞基法與人力需求無法同時滿足（例如同一週可上夜班的人不夠）"}
    return {"feasible": False, "status": r["status"],
            "reason": "系統無法在時限內確認這組預假可行，請改選其他日期"}


def weekly_staffing_shortfall(prob: Problem) -> List[str]:
    """
    「週內不花花班」下的人力必要條件（快速預檢）。

    每人每週只能上一種工作班別、最多 cap 天（標準 5 / 雙週 6），所以每週要把非保護人員
    分給 D/E/N（保護名單只能上 D），看產能蓋不蓋得住。雙週變形另外檢查「相鄰兩週合計 ≤ 10 天」
    —— 雙週人員不能每週都上 6 天。
    只是必要條件（過了不保證有解），但不過就一定無解；CP-SAT 自己證明無解可能要跑很久
    （人員對稱性太高），所以先擋下來。
    """
    from itertools import product
    reasons = []
    nonprot = [s for s in prob.staff if not prob.is_protected(s)]

    def caps_for(L, bw_caps=None):
        return {s["staff_id"]: min((bw_caps or {}).get(s["staff_id"], prob.weekly_cap(s)), L) for s in nonprot}

    def label(a, b):
        return f"{a + 1}-{b + 1} 日"

    for a, b in prob.weeks:
        if not _week_coverable(prob, b - a + 1, caps_for(b - a + 1)):
            reasons.append(f"{label(a, b)}這週：每人每週只能上一種班別，{len(nonprot)} 名可排夜班人員分配不出 "
                           f"D{prob.reqs['D']}/E{prob.reqs['E']}/N{prob.reqs['N']} 的每日需求")
    if reasons:
        return reasons

    bw = [s["staff_id"] for s in nonprot if s.get("special_status") == "BiWeekly"]
    if bw and len(bw) <= 6:
        for (a1, b1), (a2, b2) in zip(prob.weeks, prob.weeks[1:]):
            L1, L2 = b1 - a1 + 1, b2 - a2 + 1
            feasible = False
            for split in product(range(0, min(6, L1) + 1), repeat=len(bw)):
                c1 = dict(zip(bw, split))
                c2 = {sid: min(10 - c, 6) for sid, c in c1.items()}   # caps_for 會再夾到 L2
                if _week_coverable(prob, L1, caps_for(L1, c1)) and _week_coverable(prob, L2, caps_for(L2, c2)):
                    feasible = True
                    break
            if not feasible:
                reasons.append(f"{label(a1, b1)} + {label(a2, b2)}：雙週變形人員兩週合計最多 10 天，"
                               f"不能每週都上 6 天補位 → 每人每週只上一種班別時人力不足")
    return reasons


def features(shifts: List[str], sid: str, prob: Problem) -> Dict[str, int]:
    work = [x in WORK for x in shifts]
    nd = prob.num_days
    w = prob.wishes.get(sid, {"high": set(), "normal": set()})
    return {
        "wish_high_miss":   sum(1 for d in w["high"] if work[d]),
        "wish_normal_miss": sum(1 for d in w["normal"] if work[d]),
        "nights":           shifts.count("N"),
        "isolated_off":     sum(1 for d in range(1, nd - 1) if work[d - 1] and not work[d] and work[d + 1]),
        "weekend_work":     sum(1 for d in prob.weekend if work[d]),
        "shift_switch":     sum(1 for d in range(nd - 1)
                                if work[d] and work[d + 1] and shifts[d] != shifts[d + 1]),
        "streak6":          sum(1 for d in range(nd - 5) if all(work[d:d + 6])),
    }


def dissat(feat: Dict[str, int], W: Dict[str, float]) -> float:
    return sum(W[k] * feat[k] for k in FEATURES)


def objective(schedule, prob, W, mult, fairness) -> float:
    ds = {sid: person_cost(schedule[sid], sid, prob, W) for sid in prob.ids}
    return sum(mult[sid] * ds[sid] for sid in prob.ids) + fairness * max(ds.values())


# ============================================================
# 階段 1：CP-SAT
# ============================================================
def solve_cpsat(prob: Problem, W: Dict[str, float], mult: Dict[str, float],
                fairness: float, time_limit: float = 10.0, seed: int = 0, workers: int = 8,
                extra=None, hint: Dict[str, List[str]] = None) -> Dict:
    """
    extra(m, x, prob, week_y) → 額外目標項（可順便加約束）；給實驗腳本客製「完美班表」標準用
    hint: 起始班表 {sid: [31 個班別]}（例如 LLM 排的）。合法的話會成為第一個解，CP-SAT 只會往更好的方向找；
          不合法的部分 CP-SAT 會自己修（repair_hint）。
    """
    reasons = monthly_workday_shortfall(prob)
    if not reasons and prob.one_shift_per_week:
        reasons = weekly_staffing_shortfall(prob)
    if reasons:
        return {"status": "INFEASIBLE", "schedule": None, "elapsed": 0.0, "reasons": reasons}

    m = cp_model.CpModel()
    nd = prob.num_days
    week_y = {}
    x = {(sid, d, sh): m.new_bool_var(f"x_{sid}_{d}_{sh}")
         for sid in prob.ids for d in range(nd) for sh in SHIFTS}

    def work(sid, d):
        return sum(x[sid, d, sh] for sh in WORK)

    # —— 每人每天恰一個班別 ——
    for sid in prob.ids:
        for d in range(nd):
            m.add_exactly_one(x[sid, d, sh] for sh in SHIFTS)

    # —— 每日覆蓋：req ≤ 人數 ≤ req_max ——
    for d in range(nd):
        for sh in WORK:
            cnt = sum(x[sid, d, sh] for sid in prob.ids)
            m.add(cnt >= prob.reqs[sh])
            m.add(cnt <= prob.reqs_max[sh])

    Wi = {k: int(round(W[k] * 10)) for k in FEATURES}
    d_exprs = {}
    obj_terms = []
    # 純可行性（人力試算、預假可行性檢查）：所有偏好權重都是 0 → 不建偏好變數，找到第一個合法解即可。
    # 這些變數乘上 0 仍會拖慢求解（Cloud Run 2 vCPU 上試算每個人數都跑滿時限仍 UNKNOWN）。
    feas_only = (not any(Wi.values()) and not fairness and not prob.backward_weight
                 and not prob.mix2_weight and not prob.mix3_weight and not prob.senior_weight)

    for s in prob.staff:
        sid = s["staff_id"]
        # 母性保護 / 實習生：禁 E/N
        if prob.is_protected(s):
            for d in range(nd):
                m.add(x[sid, d, "E"] == 0)
                m.add(x[sid, d, "N"] == 0)
        # 輪班間隔 11h
        for d in range(nd - 1):
            for a, b in FORBIDDEN:
                m.add(x[sid, d, a] + x[sid, d + 1, b] <= 1)
        # 連續上班上限：七休一（法定 6）與健康上限（預設 5）取小
        cw = min(MAX_CONSEC_WORK, prob.max_consec_work)
        for d in range(nd - cw):
            m.add(sum(work(sid, t) for t in range(d, d + cw + 1)) <= cw)
        # 連續大夜 ≤ 3
        for d in range(nd - MAX_CONSEC_N):
            m.add(sum(x[sid, t, "N"] for t in range(d, d + MAX_CONSEC_N + 1)) <= MAX_CONSEC_N)
        # 大夜段結束（今天 N、明天不是 N）→ 接下來 post_night_rest 天都要休
        for d in range(nd - 1):
            end_n = x[sid, d, "N"] - x[sid, d + 1, "N"]
            for k in range(1, prob.post_night_rest + 1):
                if d + k < nd:
                    m.add(sum(x[sid, d + k, r] for r in REST) >= end_n)
        # 兩 RG 間 ≤ 6 工作日：任何不含 RG 的區間，工作日 ≤ 6（RC 不重置計數）
        for a in range(nd):
            for b in range(a + MAX_RG_GAP, nd):
                L = b - a + 1
                m.add(sum(work(sid, t) for t in range(a, b + 1))
                      <= MAX_RG_GAP + L * sum(x[sid, t, "RG"] for t in range(a, b + 1)))
        # 週工時（日曆週，週一重置）
        cap = prob.weekly_cap(s)
        week_sums = [sum(work(sid, t) for t in range(a, b + 1)) for a, b in prob.weeks]
        for ws in week_sums:
            m.add(ws <= cap)
        if s.get("special_status") == "BiWeekly":
            for w1, w2 in zip(week_sums, week_sums[1:]):
                m.add(w1 + w2 <= 10)
        # 週內不花花班：每個日曆週選定一種工作班別 y，該週只能上那一種
        if prob.one_shift_per_week:
            for wi, (a, b) in enumerate(prob.weeks):
                y = {sh: m.new_bool_var(f"y_{sid}_{wi}_{sh}") for sh in WORK}
                week_y[sid, wi] = (y, min(cap, b - a + 1))
                m.add(sum(y.values()) <= 1)
                for t in range(a, b + 1):
                    for sh in WORK:
                        m.add(x[sid, t, sh] <= y[sh])
        # 月總量
        m.add(sum(x[sid, d, "RG"] for d in range(nd)) >= MIN_RG)
        m.add(sum(x[sid, d, r] for d in range(nd) for r in REST) >= MIN_REST)
        m.add(sum(work(sid, d) for d in range(nd)) <= MAX_MONTH_WORK)
        m.add(sum(work(sid, d) for d in range(nd)) >= prob.min_work_days)
        if feas_only:
            d_exprs[sid] = 0
            continue

        # —— 軟特徵（線性化） ——
        w = prob.wishes.get(sid, {"high": set(), "normal": set()})
        f = {
            "wish_high_miss":   sum(work(sid, d) for d in w["high"]),
            "wish_normal_miss": sum(work(sid, d) for d in w["normal"]),
            "nights":           sum(x[sid, d, "N"] for d in range(nd)),
            "weekend_work":     sum(work(sid, d) for d in prob.weekend),
        }
        iso = []
        for d in range(1, nd - 1):
            b = m.new_bool_var("")
            m.add(b >= work(sid, d - 1) + (1 - work(sid, d)) + work(sid, d + 1) - 2)
            iso.append(b)
        f["isolated_off"] = sum(iso)
        sw = []
        for d in range(nd - 1):
            b = m.new_bool_var("")
            for a in WORK:
                for c in WORK:
                    if a != c:
                        m.add(b >= x[sid, d, a] + x[sid, d + 1, c] - 1)
            sw.append(b)
        f["shift_switch"] = sum(sw)
        st = []
        for d in range(nd - 5):
            b = m.new_bool_var("")
            m.add(b >= sum(work(sid, t) for t in range(d, d + 6)) - 5)
            st.append(b)
        f["streak6"] = sum(st)

        # 逆向輪班：工作日 d 與 d+g+1 之間全休（g ≤ BACKWARD_MAX_GAP），且班別往回走
        back = []
        if prob.backward_weight:
            for d in range(nd - 1):
                for g in range(0, BACKWARD_MAX_GAP + 1):
                    e = d + g + 1
                    if e >= nd:
                        break
                    between = sum(work(sid, t) for t in range(d + 1, e))
                    b = m.new_bool_var("")
                    for a in WORK:
                        for c in WORK:
                            if SHIFT_ORDER[c] < SHIFT_ORDER[a]:
                                m.add(b >= x[sid, d, a] + x[sid, e, c] - 1 - between)
                    back.append(b)
        bw = int(round(prob.backward_weight * 10))
        # 整月班別種類：1 種 0、2 種 mix2、3 種 mix3
        used = []
        for sh in WORK:
            u = m.new_bool_var("")
            for d in range(nd):
                m.add(u >= x[sid, d, sh])
            used.append(u)
        t2 = m.new_bool_var(""); t3 = m.new_bool_var("")
        # 混 2 種以上：任兩種都用到就成立（不能寫 t2 ≥ Σused − 1 — 三種都上時右邊是 2，
        # 布林變數不可能成立，等於把「混 3 種」變成禁止，而不是設計上的扣分）
        for i in range(len(used)):
            for j in range(i + 1, len(used)):
                m.add(t2 >= used[i] + used[j] - 1)
        m.add(t3 >= sum(used) - 2)
        mix_expr = int(round(prob.mix2_weight * 10)) * t2 + int(round((prob.mix3_weight - prob.mix2_weight) * 10)) * t3
        d_exprs[sid] = sum(Wi[k] * f[k] for k in FEATURES) + bw * sum(back) + mix_expr
        obj_terms.append(int(round(mult[sid] * 10)) * d_exprs[sid])

    # 冗餘約束（不改變解集，只幫 CP-SAT 剪枝）：每週選某班別的人，產能總和要蓋得住該班需求
    if prob.one_shift_per_week:
        for wi, (a, b) in enumerate(prob.weeks):
            for sh in WORK:
                m.add(sum(c * y[sh] for sid in prob.ids for (y, c) in [week_y[sid, wi]])
                      >= prob.reqs[sh] * (b - a + 1))

    # 每班至少一位資深（N2+ 或組長）坐鎮：軟約束（硬約束會讓資深不足的團隊整個排不出來，
    # 也會讓預假送出時的可行性檢查失準），權重夠高時只要排得出來就會滿足
    senior_gaps = []
    if prob.senior_weight:
        seniors = [s["staff_id"] for s in prob.staff if prob.is_senior(s)]
        for d in range(nd):
            for sh in WORK:
                if prob.reqs[sh] <= 0:
                    continue
                g = m.new_bool_var("")
                m.add(sum(x[sid, d, sh] for sid in seniors) + g >= 1)
                senior_gaps.append(g)

    max_d = m.new_int_var(0, 10 ** 7, "max_dissat")
    for sid in prob.ids:
        m.add(max_d >= d_exprs[sid])
    extra_obj = extra(m, x, prob, week_y) if extra else 0
    obj_expr = (sum(obj_terms) + int(round(fairness * 10)) * max_d + extra_obj
                + int(round(prob.senior_weight * 10)) * sum(senior_gaps))
    # 資深坐鎮優先：先單獨求「最少資深缺口」並鎖住上限，再在此前提下最佳化其餘偏好。
    # 只放進加權目標時，平行搜尋在時限內常停在還有缺口的解（實測 14 人樣本有時剩 2 個）。
    # 有起始班表就從它出發；找到的解取代起始班表，下面的 hint 流程保證結果不比它差。
    if senior_gaps:
        if hint:
            for (sid, d, sh), v in x.items():
                m.add_hint(v, 1 if hint[sid][d] == sh else 0)
        m.minimize(sum(senior_gaps))
        s0 = cp_model.CpSolver()
        s0.parameters.max_time_in_seconds = max(3.0, time_limit / 5)
        s0.parameters.num_workers = workers
        s0.parameters.random_seed = seed
        st0 = s0.solve(m)
        m.clear_hints()
        if hint and st0 not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            log.warning("資深坐鎮階段連起始班表都沒採用（%s）— 起始班表可能違反完整模型的硬約束", s0.status_name(st0))
        if st0 in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            m.add(sum(senior_gaps) <= int(round(s0.objective_value)))
            hint = {sid: [next(sh for sh in SHIFTS if s0.value(x[sid, d, sh])) for d in range(nd)]
                    for sid in prob.ids}
        time_limit = max(1.0, time_limit - s0.wall_time)
    m.minimize(obj_expr)

    # —— 起始班表（hint）：保證結果不比它差 ——
    # 只對 x 下 hint 不夠：輔助變數（孤立休、逆向輪班、混班…）沒值，平行搜尋常常根本沒用上起點。
    # 做法：(1) 用 assumption 把 x 釘在 hint 上，解出完整解與它的精確分數；
    #       (2) 把完整解（含所有輔助變數）當 hint，並加上「目標 ≤ hint 分數」再正式搜尋；
    #       (3) 正式搜尋若沒找到更好的，直接回傳 hint。
    hint_value = None
    hint_used = False
    hint_rejected = False
    if hint:
        pin = m.new_bool_var("pin_hint")
        for sid in prob.ids:
            for d in range(nd):
                for sh in SHIFTS:
                    m.add(x[sid, d, sh] == (1 if hint[sid][d] == sh else 0)).only_enforce_if(pin)
        m.add_assumptions([pin])
        s1 = cp_model.CpSolver()
        s1.parameters.max_time_in_seconds = max(5.0, time_limit / 4)
        s1.parameters.num_workers = workers
        st1 = s1.solve(m)
        m.clear_assumptions()
        if st1 == cp_model.INFEASIBLE:
            # 起始班表在完整模型裡不合法：通常代表它和產生它的模型硬約束不一致（例如舊的混 3 種班 bug），是 bug 不是常態
            hint_rejected = True
            log.warning("起始班表固定後不可行（完整模型與產生起點的模型硬約束不一致？）")
        if st1 in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            hint_value = int(round(s1.objective_value))
            for i in range(len(m.proto.variables)):
                v = m.get_int_var_from_proto_index(i)
                m.add_hint(v, s1.value(v))
            m.add(obj_expr <= hint_value)
            time_limit = max(1.0, time_limit - s1.wall_time)

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = time_limit
    solver.parameters.num_workers = workers
    solver.parameters.random_seed = seed
    if hint:
        solver.parameters.repair_hint = True
    t0 = time()
    status = solver.solve(m)
    status_name = solver.status_name(status)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        if hint_value is not None:   # 沒找到比起點更好的 → 起點本身就是答案
            return {"status": "HINT_KEPT", "schedule": {sid: list(hint[sid]) for sid in prob.ids},
                    "elapsed": round(time() - t0, 2), "gap": 0.0, "hint_value": hint_value, "objective": hint_value,
                    "hint_rejected": hint_rejected}
        return {"status": status_name, "schedule": None, "elapsed": round(time() - t0, 2), "hint_rejected": hint_rejected}

    schedule = {sid: [next(sh for sh in SHIFTS if solver.value(x[sid, d, sh])) for d in range(nd)]
                for sid in prob.ids}
    return {
        "status": status_name,
        "schedule": schedule,
        "elapsed": round(time() - t0, 2),
        "gap": (solver.objective_value - solver.best_objective_bound) / max(1.0, solver.objective_value),
        "objective": int(round(solver.objective_value)),
        "hint_value": hint_value,
        "hint_rejected": hint_rejected,
    }


# ============================================================
# 階段 2：可行域內 SA polish
# ============================================================
def sa_polish(prob: Problem, schedule: Dict[str, List[str]], W, mult, fairness,
              iters: int = 20000, seed: int = 0, t0: float = 3.0, t1: float = 0.05) -> Dict:
    """
    兩種移動，皆只在「硬約束 0 + 覆蓋合法」時才可能被接受：
      swap     — 同一天兩人交換班別（覆蓋人數不變）
      reassign — 一人改班別（覆蓋人數仍需在 [req, req_max]）
    """
    rng = random.Random(seed)
    staff_by_id = {s["staff_id"]: s for s in prob.staff}
    cur = {sid: list(v) for sid, v in schedule.items()}
    ds = {sid: person_cost(cur[sid], sid, prob, W) for sid in prob.ids}
    cov = [{sh: sum(1 for sid in prob.ids if cur[sid][d] == sh) for sh in WORK} for d in range(prob.num_days)]

    def total(dmap):
        return sum(mult[s] * dmap[s] for s in prob.ids) + fairness * max(dmap.values())

    cur_obj = total(ds)
    start_obj = cur_obj
    best_obj, best = cur_obj, {sid: list(v) for sid, v in cur.items()}
    accepted = 0

    for it in range(iters):
        T = t0 * (t1 / t0) ** (it / max(1, iters - 1))
        d = rng.randrange(prob.num_days)
        if rng.random() < 0.6:
            a, b = rng.sample(prob.ids, 2)
            if cur[a][d] == cur[b][d]:
                continue
            changes = {a: cur[b][d], b: cur[a][d]}
        else:
            a = rng.choice(prob.ids)
            old = cur[a][d]
            new = rng.choice([sh for sh in SHIFTS if sh != old])
            if old in WORK and cov[d][old] - 1 < prob.reqs[old]:
                continue
            if new in WORK and cov[d][new] + 1 > prob.reqs_max[new]:
                continue
            changes = {a: new}

        olds = {sid: cur[sid][d] for sid in changes}
        for sid, sh in changes.items():
            cur[sid][d] = sh
        if any(hard_violations(cur[sid], staff_by_id[sid], prob) for sid in changes):
            for sid, sh in olds.items():
                cur[sid][d] = sh
            continue

        new_ds = dict(ds)
        for sid in changes:
            new_ds[sid] = person_cost(cur[sid], sid, prob, W)
        new_obj = total(new_ds)
        delta = new_obj - cur_obj
        if delta <= 0 or rng.random() < math.exp(-delta / T):
            ds, cur_obj = new_ds, new_obj
            for sid in changes:
                if olds[sid] in WORK:
                    cov[d][olds[sid]] -= 1
                if changes[sid] in WORK:
                    cov[d][changes[sid]] += 1
            accepted += 1
            if cur_obj < best_obj - 1e-9:
                best_obj, best = cur_obj, {sid: list(v) for sid, v in cur.items()}
        else:
            for sid, sh in olds.items():
                cur[sid][d] = sh

    return {"schedule": best, "start_obj": start_obj, "best_obj": best_obj, "accepted": accepted}


def senior_gap_count(prob: Problem, schedule: Dict[str, List[str]]) -> int:
    """有幾個（日, 班別）完全沒有資深人員（N2+ 或組長）— 對應前端 checkSkillMixSafety 的警告數"""
    seniors = [s["staff_id"] for s in prob.staff if prob.is_senior(s)]
    return sum(1 for d in range(prob.num_days) for sh in WORK
               if prob.reqs[sh] > 0 and not any(schedule[sid][d] == sh for sid in seniors))
