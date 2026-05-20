"""
SA 排班引擎 — 純函式版（本機測試用）

從 main1.py 的 generate_schedule 抽出，剝除 FastAPI / Firebase auth / rate limit / Pydantic。
回傳格式不變，方便 run_demo.py 直接驗證。
"""

import math
import random
import copy
import calendar
import sys
import os
from typing import List, Dict, Tuple
from collections import defaultdict
from time import time

# 確保跑 `python local_test/scheduler.py` 或被別處 import 時都能找到 health module
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from health import calculate_health_score


PENALTY = {
    # —— 原有規則 ——
    "consecutive_work_7":  2000,    # 連續上班 > 6 天（七休一）
    "consecutive_night_4": 1000,    # 連續大夜 > 3 天
    "forbidden_n_d":       1000,    # N→D 違反 11h 輪班間隔
    "forbidden_n_e":       1000,    # N→E
    "forbidden_e_d":       1000,    # E→D
    "isolated_off":          50,    # 孤立休假（軟限制）
    "protected_on_en":   500000,    # 保護名單上 E/N（接近天譴）
    "custom_rule_violation": 1000000,  # FORCE_OFF / FORCE_WORK 違反

    # —— 新增：對齊 JS 端 checkLaborLawCompliance 的 5 條規則 ——
    "weekly_hours_over_40":  800,   # 每週 > 40h（簡化版，未區分 BiWeekly 48h）
    "monthly_hours_over_222":1200,  # 月總工時 > 176 + 46
    "insufficient_rg":      1500,   # 月 RG (O) < 4 天
    "insufficient_off":      800,   # 月 RG+RC < 8 天
    "rg_interval_over_6":   1000,   # 兩 RG 之間 > 6 工作日

    # —— 健康度移植（health.py calculate_health_score 的 SA 化）——
    # Level 1：團隊整體健康度當軟提示。每位員工 (100 - 健康分數) × 5
    #          鼓勵 SA 找出 health score 高的方案，跟硬規則互補。
    "health_deficit_per_point": 5,
    # Level 2：個人健康分數 < 70（deficit > 30）視為過勞，接近天譴罰分。
    #          照 main2.py / TLPS 原始設計，保證沒有單一員工被排到極端。
    "health_floor_breach":  50000,
}

# JS 違規類型 → SA penalty key 的對照表，給 run_sa_with_feedback() 用
JS_TO_SA_MAP = {
    "WEEKLY_HOURS":            "weekly_hours_over_40",
    "MONTHLY_OT":              "monthly_hours_over_222",
    "INSUFFICIENT_RG":         "insufficient_rg",
    "INSUFFICIENT_OFF":        "insufficient_off",
    "RG_INTERVAL":             "rg_interval_over_6",
    "CONSECUTIVE_DAYS":        "consecutive_work_7",
    "MATERNITY_PROTECTION":    "protected_on_en",
    "STUDENT_NIGHT_FORBIDDEN": "protected_on_en",
    # SHIFT_INTERVAL 對應 3 個 forbidden_* — 全部一起加重
    "SHIFT_INTERVAL":          ["forbidden_n_d", "forbidden_n_e", "forbidden_e_d"],
    # 以下 SA 模型本來就不處理，無對應
    "DAILY_HOURS":             None,
    "ANNUAL_LEAVE_EXCEEDED":   None,
}


def run_sa(
    year: int,
    month: int,
    nurses: List[str],
    protected_indices: List[int] = None,
    daily_reqs: Dict[int, int] = None,
    custom_rules: List[Dict] = None,
    max_iterations: int = 20000,
    seed: int = None,
    weight_overrides: Dict[str, int] = None,
) -> Dict:
    """
    執行 TLPS 模擬退火排班。

    Args:
      year, month: 排班月份
      nurses: 員工 ID 清單
      protected_indices: 受保護的員工 index（孕婦/實習生，禁排 E/N）
      daily_reqs: {1: D 人數, 2: E 人數, 3: N 人數}
      custom_rules: [{date, action, nurse_id, shift?}] FORCE_OFF/FORCE_WORK
      max_iterations: SA 最大迭代次數
      seed: 固定隨機種子（測試用）

    Returns:
      {
        "status": "success",
        "solver_status": "OPTIMAL" | "FEASIBLE",
        "elapsed_seconds": float,
        "schedule": [{"nurse_id", "date", "shift"}, ...],
        "stats": { final_penalty, best_iteration, max_iterations,
                   accepted_worse_swaps, rejected_swaps,
                   violation_breakdown, num_days, num_nurses }
      }

    Raises:
      ValueError: 人力顯然不足或保護名單過多
    """
    if seed is not None:
        random.seed(seed)

    protected_indices = protected_indices or []
    daily_reqs = daily_reqs or {}
    custom_rules = custom_rules or []

    # 動態權重 — feedback loop 用來加重特定罰分；沒給就用 PENALTY 預設
    weight_overrides = weight_overrides or {}
    W = {**PENALTY, **weight_overrides}

    protected = set(protected_indices)

    def _req(code: int) -> int:
        return int(daily_reqs.get(code, daily_reqs.get(str(code), 0)))

    req_D, req_E, req_N = _req(1), _req(2), _req(3)
    daily_demand = req_D + req_E + req_N

    _, num_days = calendar.monthrange(year, month)
    num_nurses = len(nurses)
    protected_ids = {nurses[i] for i in protected}

    # Pre-flight
    if num_nurses < daily_demand:
        raise ValueError(
            f"人力顯然不足：每天需 {daily_demand} 人 (D{req_D}+E{req_E}+N{req_N})，"
            f"但只有 {num_nurses} 名員工。"
        )
    non_protected = num_nurses - len(protected)
    if non_protected < req_E + req_N:
        raise ValueError(
            f"保護名單過多：{len(protected)} 人受保護，"
            f"剩餘 {non_protected} 人不足以填每日 E({req_E})+N({req_N})。"
        )

    t_start = time()

    # ==========================================
    # 初始化五個細胞膜（D/E/N/RG/RC）
    # ==========================================
    # 為什麼把 o_mem 拆成 rg_mem + rc_mem：
    #   RG (例假) 是勞基法 §36 強制不可出勤的休假日，每月必須 ≥ 4 天且兩 RG 之間
    #   最多 6 工作日；RC (休息日) 是另一種休假，可付加班費後出勤。SA 之前用單一
    #   'O' 代表所有休假等於放棄了「兩個 RG 之間 ≤ 6 工作日」這條法定要求的精度。
    #   拆開後 SA 能精準對齊 JS 端 checkLaborLawCompliance 的判定。
    m_mem  = {d: [] for d in range(1, num_days + 1)}
    e_mem  = {d: [] for d in range(1, num_days + 1)}
    n_mem  = {d: [] for d in range(1, num_days + 1)}
    rg_mem = {d: [] for d in range(1, num_days + 1)}
    rc_mem = {d: [] for d in range(1, num_days + 1)}

    for d in range(1, num_days + 1):
        non_prot = [nid for nid in nurses if nid not in protected_ids]
        prot = list(protected_ids)
        random.shuffle(non_prot)
        random.shuffle(prot)
        for _ in range(req_E): e_mem[d].append(non_prot.pop())
        for _ in range(req_N): n_mem[d].append(non_prot.pop())
        pool_for_d = non_prot + prot
        random.shuffle(pool_for_d)
        for _ in range(req_D): m_mem[d].append(pool_for_d.pop())
        # 剩下的人均分到 RG / RC（50/50；SA penalty 會調整到符合月度配額）
        rest_pool = pool_for_d
        random.shuffle(rest_pool)
        half = len(rest_pool) // 2
        rg_mem[d].extend(rest_pool[:half])
        rc_mem[d].extend(rest_pool[half:])

    # 解析 custom_rules
    force_off: List[Tuple[str, int]] = []
    force_work: List[Tuple[str, int, str]] = []
    for rule in custom_rules:
        try:
            d = int(str(rule.get("date", "")).split("-")[2])
            if d < 1 or d > num_days:
                continue
        except Exception:
            continue
        action = rule.get("action")
        nid = rule.get("nurse_id")
        if action == "FORCE_OFF" and nid in nurses:
            force_off.append((nid, d))
        elif action == "FORCE_WORK" and nid in nurses:
            sh = rule.get("shift")
            if sh in ("D", "E", "N"):
                force_work.append((nid, d, sh))

    def get_sched(nid: str, mm, em, nm, rgm, rcm) -> List[str]:
        sched = []
        for d in range(1, num_days + 1):
            if nid in mm[d]:    sched.append("D")
            elif nid in em[d]:  sched.append("E")
            elif nid in nm[d]:  sched.append("N")
            elif nid in rgm[d]: sched.append("RG")
            elif nid in rcm[d]: sched.append("RC")
            else:               sched.append("O")  # 理論上不該發生
        return sched

    def evaluate(mm, em, nm, rgm, rcm) -> Tuple[int, Dict[str, int]]:
        total = 0
        breakdown = defaultdict(int)
        REST = {"RG", "RC"}
        WORK = {"D", "E", "N"}
        for nid in nurses:
            sched = get_sched(nid, mm, em, nm, rgm, rcm)
            c_work = 0
            c_night = 0
            days_since_rg = 0   # 兩 RG 之間累計工作日（RC 不重置也不累加）

            for d in range(num_days):
                shift = sched[d]
                if shift in WORK:
                    c_work += 1
                    c_night = c_night + 1 if shift == "N" else 0
                    days_since_rg += 1
                elif shift == "RG":
                    c_work, c_night = 0, 0
                    days_since_rg = 0
                else:  # RC — 重置連續工作 / 夜班，但 RG 間隔仍累計（RC 不算 RG）
                    c_work, c_night = 0, 0
                    # days_since_rg 不變
                if c_work > 6:
                    total += W["consecutive_work_7"]
                    breakdown["consecutive_work_7"] += 1
                if c_night > 3:
                    total += W["consecutive_night_4"]
                    breakdown["consecutive_night_4"] += 1
                if nid in protected_ids and shift in ("E", "N"):
                    total += W["protected_on_en"]
                    breakdown["protected_on_en"] += 1
                if days_since_rg > 6:
                    total += W["rg_interval_over_6"]
                    breakdown["rg_interval_over_6"] += 1
                    days_since_rg = 0  # 報錯後重置，避免同一段重複洗版

            for d in range(num_days - 1):
                if sched[d] == "N" and sched[d + 1] == "D":
                    total += W["forbidden_n_d"]; breakdown["forbidden_n_d"] += 1
                if sched[d] == "N" and sched[d + 1] == "E":
                    total += W["forbidden_n_e"]; breakdown["forbidden_n_e"] += 1
                if sched[d] == "E" and sched[d + 1] == "D":
                    total += W["forbidden_e_d"]; breakdown["forbidden_e_d"] += 1

            for d in range(1, num_days - 1):
                # 孤立休假：任何 rest（RG 或 RC）夾在兩個工作日之間
                if sched[d - 1] in WORK and sched[d] in REST and sched[d + 1] in WORK:
                    total += W["isolated_off"]
                    breakdown["isolated_off"] += 1

            # 【健康度移植 Level 1+2】 — 詳見前述註解
            hr = calculate_health_score(sched)
            deficit = 100 - hr["score"]
            if deficit > 0:
                total += deficit * W["health_deficit_per_point"]
                breakdown["health_deficit_per_point"] += deficit
            if deficit > 30:
                total += W["health_floor_breach"]
                breakdown["health_floor_breach"] += 1

            # 每週工時 40h 上限
            for week_start in range(0, num_days, 7):
                work_h = sum(8 for s in sched[week_start:week_start + 7] if s in WORK)
                if work_h > 40:
                    total += W["weekly_hours_over_40"]
                    breakdown["weekly_hours_over_40"] += 1

            # 月總工時 ≤ 222h
            total_work_h = sum(8 for s in sched if s in WORK)
            if total_work_h > 222:
                total += W["monthly_hours_over_222"]
                breakdown["monthly_hours_over_222"] += 1

            # 月例假 ≥ 4 天（只算 RG！）
            rg_count = sum(1 for s in sched if s == "RG")
            rc_count = sum(1 for s in sched if s == "RC")
            if rg_count < 4:
                total += W["insufficient_rg"]
                breakdown["insufficient_rg"] += 1
            # 月 RG + RC ≥ 8 天
            if (rg_count + rc_count) < 8:
                total += W["insufficient_off"]
                breakdown["insufficient_off"] += 1

        sched_cache = {nid: get_sched(nid, mm, em, nm, rgm, rcm) for nid in nurses}
        for (nid, d) in force_off:
            # FORCE_OFF 跟原本一樣，允許 RG 或 RC（兩者皆視為「不出勤」）
            if sched_cache[nid][d - 1] not in ("RG", "RC"):
                total += W["custom_rule_violation"]
                breakdown["custom_rule_violation"] += 1
        for (nid, d, sh) in force_work:
            if sched_cache[nid][d - 1] != sh:
                total += W["custom_rule_violation"]
                breakdown["custom_rule_violation"] += 1

        return total, dict(breakdown)

    def antiport(day, mm, em, nm, rgm, rcm):
        # 5 個 membrane 之間任選 2 個 swap；RG↔RC 的 swap 等於「換鋪別但不換工作」
        mems = [mm, em, nm, rgm, rcm]
        a, b = random.sample(mems, 2)
        if a[day] and b[day]:
            x = random.choice(a[day])
            y = random.choice(b[day])
            a[day].remove(x); a[day].append(y)
            b[day].remove(y); b[day].append(x)

    def block_antiport(mm, em, nm, rgm, rcm, block=3):
        if num_days < block:
            return
        start = random.randint(1, num_days - block + 1)
        x, y = random.sample(nurses, 2)
        for d in range(start, start + block):
            sx, sy = None, None
            for mem in (mm, em, nm, rgm, rcm):
                if x in mem[d]: sx = mem
                if y in mem[d]: sy = mem
            if sx is not None and sy is not None and sx is not sy:
                sx[d].remove(x); sx[d].append(y)
                sy[d].remove(y); sy[d].append(x)

    current_p, _ = evaluate(m_mem, e_mem, n_mem, rg_mem, rc_mem)
    best_p = current_p
    best_breakdown = {}
    best_m  = copy.deepcopy(m_mem)
    best_e  = copy.deepcopy(e_mem)
    best_n  = copy.deepcopy(n_mem)
    best_rg = copy.deepcopy(rg_mem)
    best_rc = copy.deepcopy(rc_mem)
    best_iter = 0

    accepted_worse = 0
    rejected = 0

    for i in range(max_iterations):
        snap_m  = copy.deepcopy(m_mem)
        snap_e  = copy.deepcopy(e_mem)
        snap_n  = copy.deepcopy(n_mem)
        snap_rg = copy.deepcopy(rg_mem)
        snap_rc = copy.deepcopy(rc_mem)

        if random.random() < 0.3:
            block_antiport(m_mem, e_mem, n_mem, rg_mem, rc_mem, block=3)
        else:
            antiport(random.randint(1, num_days), m_mem, e_mem, n_mem, rg_mem, rc_mem)

        new_p, new_breakdown = evaluate(m_mem, e_mem, n_mem, rg_mem, rc_mem)
        T = max(0.1, 1000 * (1 - i / max_iterations))

        if new_p <= current_p:
            current_p = new_p
            if current_p < best_p:
                best_p = current_p
                best_breakdown = new_breakdown
                best_m  = copy.deepcopy(m_mem)
                best_e  = copy.deepcopy(e_mem)
                best_n  = copy.deepcopy(n_mem)
                best_rg = copy.deepcopy(rg_mem)
                best_rc = copy.deepcopy(rc_mem)
                best_iter = i
        else:
            delta = new_p - current_p
            if random.random() < math.exp(-delta / T):
                current_p = new_p
                accepted_worse += 1
            else:
                m_mem, e_mem, n_mem, rg_mem, rc_mem = snap_m, snap_e, snap_n, snap_rg, snap_rc
                rejected += 1

        if current_p == 0:
            break

    elapsed = time() - t_start

    result = []
    for nid in nurses:
        sched = get_sched(nid, best_m, best_e, best_n, best_rg, best_rc)
        for d in range(num_days):
            result.append({
                "nurse_id": nid,
                "date": f"{year}-{month:02d}-{d + 1:02d}",
                "shift": sched[d],
            })

    return {
        "status": "success",
        "solver_status": "OPTIMAL" if best_p == 0 else "FEASIBLE",
        "elapsed_seconds": round(elapsed, 2),
        "schedule": result,
        "stats": {
            "final_penalty": best_p,
            "best_iteration": best_iter,
            "max_iterations": max_iterations,
            "accepted_worse_swaps": accepted_worse,
            "rejected_swaps": rejected,
            "violation_breakdown": best_breakdown,
            "num_days": num_days,
            "num_nurses": num_nurses,
            "weight_overrides": weight_overrides,
        },
    }


# ============================================================
# Auto-tighten feedback loop
# ============================================================
def run_sa_with_feedback(
    year: int,
    month: int,
    nurses: List[str],
    staff_data: List[Dict],
    protected_indices: List[int] = None,
    daily_reqs: Dict[int, int] = None,
    custom_rules: List[Dict] = None,
    max_iterations: int = 10000,
    seed: int = None,
    max_rounds: int = 3,
    multiplier: float = 1.5,
    initial_weight_overrides: Dict[str, int] = None,
) -> Dict:
    """
    跑 SA → 用 JS 端 check_labor_law_compliance 驗證 → 若有違規，把對應 SA 罰分
    權重加重後重跑。最多 max_rounds 輪。

    Args:
      staff_data: 完整員工 list（含 name / leave_status / is_pregnant_or_nursing
                  等屬性），餵給 check_labor_law_compliance。
      max_rounds: 上限輪數
      multiplier: 每輪把違規類別權重乘以這個倍率

    Returns:
      原本 run_sa 的 result，外加 stats["feedback_rounds"]：
        [{round, weight_overrides, final_penalty, js_violations, top_violations}, ...]
    """
    # 為避免循環引用，在這裡才 import compliance（同層 module）
    from compliance import check_labor_law_compliance
    from collections import Counter

    # 起手 overrides — 通常用來灌進健康度開關（health_deficit_per_point=0 等於停用）。
    # auto-tighten 後續加重時會疊加在這之上。
    weight_overrides: Dict[str, int] = dict(initial_weight_overrides or {})
    history = []
    result = None

    for round_i in range(1, max_rounds + 1):
        result = run_sa(
            year=year, month=month, nurses=nurses,
            protected_indices=protected_indices,
            daily_reqs=daily_reqs, custom_rules=custom_rules,
            max_iterations=max_iterations, seed=seed,
            weight_overrides=weight_overrides,
        )

        # 把 result["schedule"] 轉成 {nurse_id: {day: shift}} 餵給 JS check
        sched_dict: Dict[str, Dict[int, str]] = defaultdict(dict)
        for cell in result["schedule"]:
            d = int(cell["date"].split("-")[2])
            sched_dict[cell["nurse_id"]][d] = cell["shift"]
        sched_dict = dict(sched_dict)

        violations = check_labor_law_compliance(sched_dict, staff_data, year, month)
        type_counts = Counter(v["type"] for v in violations).most_common()

        history.append({
            "round": round_i,
            "weight_overrides": dict(weight_overrides),
            "final_penalty": result["stats"]["final_penalty"],
            "js_violations": len(violations),
            "top_violations": type_counts[:5],
        })

        # 完美收斂 → 結束
        if not violations:
            break
        # 最後一輪不用再調權重了
        if round_i == max_rounds:
            break

        # 把違規最多前 3 類對應的 SA 罰分權重乘以 multiplier
        for js_type, _count in type_counts[:3]:
            sa_keys = JS_TO_SA_MAP.get(js_type)
            if sa_keys is None:
                continue
            if isinstance(sa_keys, str):
                sa_keys = [sa_keys]
            for key in sa_keys:
                current = weight_overrides.get(key, PENALTY.get(key, 0))
                weight_overrides[key] = int(current * multiplier)

    result["stats"]["feedback_rounds"] = history
    return result
