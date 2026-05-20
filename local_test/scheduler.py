"""
SA 排班引擎 — 純函式版（本機測試用）

從 main1.py 的 generate_schedule 抽出，剝除 FastAPI / Firebase auth / rate limit / Pydantic。
回傳格式不變，方便 run_demo.py 直接驗證。
"""

import math
import random
import copy
import calendar
from typing import List, Dict, Tuple
from collections import defaultdict
from time import time


PENALTY = {
    "consecutive_work_7":  2000,    # 連續上班 > 6 天（七休一）
    "consecutive_night_4": 1000,    # 連續大夜 > 3 天
    "forbidden_n_d":       1000,    # N→D 違反 11h 輪班間隔
    "forbidden_n_e":       1000,    # N→E
    "forbidden_e_d":       1000,    # E→D
    "isolated_off":          50,    # 孤立休假（軟限制）
    "protected_on_en":   500000,    # 保護名單上 E/N（接近天譴）
    "custom_rule_violation": 1000000,  # FORCE_OFF / FORCE_WORK 違反
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

    # 初始化四個細胞膜
    m_mem = {d: [] for d in range(1, num_days + 1)}
    e_mem = {d: [] for d in range(1, num_days + 1)}
    n_mem = {d: [] for d in range(1, num_days + 1)}
    o_mem = {d: [] for d in range(1, num_days + 1)}

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
        o_mem[d].extend(pool_for_d)

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

    def get_sched(nid: str, mm, em, nm) -> List[str]:
        sched = []
        for d in range(1, num_days + 1):
            if nid in mm[d]:   sched.append("D")
            elif nid in em[d]: sched.append("E")
            elif nid in nm[d]: sched.append("N")
            else:              sched.append("O")
        return sched

    def evaluate(mm, em, nm) -> Tuple[int, Dict[str, int]]:
        total = 0
        breakdown = defaultdict(int)
        for nid in nurses:
            sched = get_sched(nid, mm, em, nm)
            c_work = 0
            c_night = 0
            for d in range(num_days):
                if sched[d] != "O":
                    c_work += 1
                    c_night = c_night + 1 if sched[d] == "N" else 0
                else:
                    c_work, c_night = 0, 0
                if c_work > 6:
                    total += PENALTY["consecutive_work_7"]
                    breakdown["consecutive_work_7"] += 1
                if c_night > 3:
                    total += PENALTY["consecutive_night_4"]
                    breakdown["consecutive_night_4"] += 1
                if nid in protected_ids and sched[d] in ("E", "N"):
                    total += PENALTY["protected_on_en"]
                    breakdown["protected_on_en"] += 1

            for d in range(num_days - 1):
                if sched[d] == "N" and sched[d + 1] == "D":
                    total += PENALTY["forbidden_n_d"]; breakdown["forbidden_n_d"] += 1
                if sched[d] == "N" and sched[d + 1] == "E":
                    total += PENALTY["forbidden_n_e"]; breakdown["forbidden_n_e"] += 1
                if sched[d] == "E" and sched[d + 1] == "D":
                    total += PENALTY["forbidden_e_d"]; breakdown["forbidden_e_d"] += 1

            for d in range(1, num_days - 1):
                if sched[d - 1] != "O" and sched[d] == "O" and sched[d + 1] != "O":
                    total += PENALTY["isolated_off"]
                    breakdown["isolated_off"] += 1

        sched_cache = {nid: get_sched(nid, mm, em, nm) for nid in nurses}
        for (nid, d) in force_off:
            if sched_cache[nid][d - 1] != "O":
                total += PENALTY["custom_rule_violation"]
                breakdown["custom_rule_violation"] += 1
        for (nid, d, sh) in force_work:
            if sched_cache[nid][d - 1] != sh:
                total += PENALTY["custom_rule_violation"]
                breakdown["custom_rule_violation"] += 1

        return total, dict(breakdown)

    def antiport(day, mm, em, nm, om):
        mems = [mm, em, nm, om]
        a, b = random.sample(mems, 2)
        if a[day] and b[day]:
            x = random.choice(a[day])
            y = random.choice(b[day])
            a[day].remove(x); a[day].append(y)
            b[day].remove(y); b[day].append(x)

    def block_antiport(mm, em, nm, om, block=3):
        if num_days < block:
            return
        start = random.randint(1, num_days - block + 1)
        x, y = random.sample(nurses, 2)
        for d in range(start, start + block):
            sx, sy = None, None
            for mem in (mm, em, nm, om):
                if x in mem[d]: sx = mem
                if y in mem[d]: sy = mem
            if sx is not None and sy is not None and sx is not sy:
                sx[d].remove(x); sx[d].append(y)
                sy[d].remove(y); sy[d].append(x)

    current_p, _ = evaluate(m_mem, e_mem, n_mem)
    best_p = current_p
    best_breakdown = {}
    best_m = copy.deepcopy(m_mem)
    best_e = copy.deepcopy(e_mem)
    best_n = copy.deepcopy(n_mem)
    best_o = copy.deepcopy(o_mem)
    best_iter = 0

    accepted_worse = 0
    rejected = 0

    for i in range(max_iterations):
        snap_m = copy.deepcopy(m_mem)
        snap_e = copy.deepcopy(e_mem)
        snap_n = copy.deepcopy(n_mem)
        snap_o = copy.deepcopy(o_mem)

        if random.random() < 0.3:
            block_antiport(m_mem, e_mem, n_mem, o_mem, block=3)
        else:
            antiport(random.randint(1, num_days), m_mem, e_mem, n_mem, o_mem)

        new_p, new_breakdown = evaluate(m_mem, e_mem, n_mem)
        T = max(0.1, 1000 * (1 - i / max_iterations))

        if new_p <= current_p:
            current_p = new_p
            if current_p < best_p:
                best_p = current_p
                best_breakdown = new_breakdown
                best_m = copy.deepcopy(m_mem)
                best_e = copy.deepcopy(e_mem)
                best_n = copy.deepcopy(n_mem)
                best_o = copy.deepcopy(o_mem)
                best_iter = i
        else:
            delta = new_p - current_p
            if random.random() < math.exp(-delta / T):
                current_p = new_p
                accepted_worse += 1
            else:
                m_mem, e_mem, n_mem, o_mem = snap_m, snap_e, snap_n, snap_o
                rejected += 1

        if current_p == 0:
            break

    elapsed = time() - t_start

    result = []
    for nid in nurses:
        sched = get_sched(nid, best_m, best_e, best_n)
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
        },
    }
