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
from typing import List, Dict, Tuple, Optional, Set
from collections import defaultdict, deque
from time import time

# 確保跑 `python local_test/scheduler.py` 或被別處 import 時都能找到 health module
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from health import calculate_health_score


# ============================================================
# 人力試算（Pre-flight）— 跑 SA 之前先回答「這組需求至少要幾個人」
# ============================================================
def estimate_required_staff(
    num_days: int,
    daily_reqs: Dict[int, int],
    protected_count: int = 0,
    rg_range=(4, 4),
    rc_range=(4, 4),
    work_days_range=None,  # 若給 (lo, hi)，覆蓋 RG/RC 算出來的 rest range
) -> Dict:
    """
    根據規則限制反推所需的最少 / 最多員工數。給 dashboard 用，跑前驗證合理性。

    邏輯：
      每位護理師每月 rest ∈ [rg_min + rc_min, rg_max + rc_max] 天
      所以每位護理師月工作天數 ∈ [num_days - rest_max, num_days - rest_min]
      若另外有「工作天數嚴格範圍」（自訂規則），用該範圍覆蓋。

      每種班別的最少員工 = ceil(daily_req × num_days / work_max_per_nurse)
      每種班別的最多員工 = ceil(daily_req × num_days / work_min_per_nurse)
      落在這個區間，SA 才有解；超出區間，penalty 永遠下不來。

      保護名單（孕婦/實習生）一律分到 D，所以 D pool 至少要等於保護人數。
    """
    rg_min, rg_max = rg_range
    rc_min, rc_max = rc_range
    rest_min = rg_min + rc_min
    rest_max = rg_max + rc_max
    if work_days_range is not None:
        work_min, work_max = work_days_range
        # 反推 rest 範圍以便回報
        rest_min = num_days - work_max
        rest_max = num_days - work_min
    else:
        work_max = num_days - rest_min   # 最多工作天數（休最少）
        work_min = num_days - rest_max   # 最少工作天數（休最多）

    if work_max <= 0:
        return {"error": f"休息下限 {rest_min} ≥ 月天數 {num_days}，無法工作"}
    if work_min < 0:
        work_min = 0

    def _req(c):
        return int(daily_reqs.get(c, daily_reqs.get(str(c), 0)))

    req_D, req_E, req_N = _req(1), _req(2), _req(3)
    person_days = {"D": req_D * num_days, "E": req_E * num_days, "N": req_N * num_days}

    def _ceil(x, y): return -(-x // y) if y else 0
    min_d = _ceil(person_days["D"], work_max) if req_D > 0 else 0
    min_e = _ceil(person_days["E"], work_max) if req_E > 0 else 0
    min_n = _ceil(person_days["N"], work_max) if req_N > 0 else 0

    # 嚴格 work_days 範圍時：每個 type pool 必須有「足夠大讓人均 ≤ work_max」
    # 且「足夠小讓人均 ≥ work_min」的整數人數。若 work range 太窄，可能沒整數
    # 解。例：D=3、work∈[22,23] → N ∈ [4.04, 4.23] → 沒整數，infeasible。
    def _max_pool(person_days_t, work_min):
        if work_min <= 0 or person_days_t == 0:
            return min_d  # placeholder
        # max pool 滿足 work_avg ≥ work_min ⇔ pool ≤ person_days / work_min
        return person_days_t // work_min
    max_d = _max_pool(person_days["D"], work_min) if req_D > 0 else min_d
    max_e = _max_pool(person_days["E"], work_min) if req_E > 0 else min_e
    max_n = _max_pool(person_days["N"], work_min) if req_N > 0 else min_n

    # D pool 也必須 >= 保護人數
    min_d_eff = max(min_d, protected_count)

    # 偵測 infeasibility — 各 type min > max 代表沒整數人數能讓人均工時落進區間
    infeasible_types = []
    if req_D > 0 and min_d > max_d: infeasible_types.append(f"D (人均工時要 {work_min}-{work_max} 但需 {min_d}+ 人卻只能放 {max_d}- 人)")
    if req_E > 0 and min_e > max_e: infeasible_types.append(f"E (同理：需 {min_e}+ 但只能放 {max_e}- )")
    if req_N > 0 and min_n > max_n: infeasible_types.append(f"N (同理：需 {min_n}+ 但只能放 {max_n}- )")

    return {
        "min_d": min_d, "min_e": min_e, "min_n": min_n,
        "min_d_with_protected": min_d_eff,
        "max_d": max_d, "max_e": max_e, "max_n": max_n,
        "total_min": min_d_eff + min_e + min_n,
        "total_max": max_d + max_e + max_n,
        "work_range_per_nurse": (work_min, work_max),
        "rest_range_per_nurse": (rest_min, rest_max),
        "person_days": person_days,
        "protected_count": protected_count,
        "infeasible_types": infeasible_types,
    }


# 視為「已達成可接受最佳」的罰分上限。
# 0    = 嚴格要求完全合規（先前預設）。
# 1000 = 容忍極少軟限制違規 — 例如 20 處 isolated_off (×50)，或一條
#        forbidden_*/insufficient_*/consecutive_night_4 (×1000)。
# 影響兩個地方：
#   1) 早停條件：current_p < OPTIMAL_THRESHOLD 就 break，不浪費剩餘迭代
#   2) solver_status：< 門檻 → 'OPTIMAL'，>= 門檻 → 'FEASIBLE'
OPTIMAL_THRESHOLD = 1000


PENALTY = {
    # —— 原有規則 ——
    "consecutive_work_7":  2000,    # 連續上班 > 6 天（七休一）
    "consecutive_night_4": 1000,    # 連續大夜 > 3 天
    # 大夜後連休 2 天：d=N、d+1≠N → d+1 與 d+2 必為 RG/RC，否則每違規日 +2000。
    # 對齊 main.py / main1.py 新模型（生理時鐘恢復需 2 天）。
    "post_night_not_off_2":2000,
    "forbidden_n_d":       1000,    # N→D 違反 11h 輪班間隔
    "forbidden_n_e":       1000,    # N→E
    "forbidden_e_d":       1000,    # E→D
    "isolated_off":           0,    # （已棄用，由 isolated_off_n / isolated_off_de 取代）
    # —— 班別敏感的孤立休假懲罰 ——
    # 「孤立休假 = 工-休-工」對大夜後恢復特別不利（需要連休 2 天才能調整生理時鐘），
    # 對白班/小夜傷害較小。所以分兩種權重：
    "isolated_off_n":       100,    # 至少一側是 N → 重罰
    "isolated_off_de":       10,    # 兩側都是 D 或 E → 輕罰
    # —— 連續休假加分（事實上是加罰，但語意是「整段休假連在一起應該特別標記」）——
    # 任何工作班別後接 2+ 天連續 RG/RC，每次出現 +20。
    # 為什麼有這條：避免 SA 把 8 天休假全黏成一塊（前 8 天連休、後 23 天連工），
    # 雖然分散度由 consecutive_work_pair 處理，這條額外鎖「rest cluster 後接太多」。
    "consecutive_rest_after_work": 20,
    "protected_on_en":   500000,    # 保護名單上 E/N（接近天譴）
    "custom_rule_violation": 1000000,  # FORCE_OFF / FORCE_WORK 違反

    # —— 新增：對齊 JS 端 checkLaborLawCompliance 的 5 條規則 ——
    "weekly_hours_over_40":  800,   # 每週 > 40h（簡化版，未區分 BiWeekly 48h）
    "monthly_hours_over_222":1200,  # 月總工時 > 176 + 46
    "insufficient_rg":      1500,   # 月 RG (O) < 4 天
    "insufficient_off":        0,   # 已棄用，由 total_rest_below_8 / total_rest_above_9 取代
    # —— 月 RG+RC 總和應在 [8, 11]（變數名沿用 8/9 是早期版本，實際範圍由
    # check 邏輯 < 8 / > 11 決定）——
    # 之前是 50000「天譴」權重，造成 SA 在 1 day off-target 直接 +50k，
    # gradient cliff 讓 multi-start 多次跑都跨不過去。
    # 因為 total_rest 就是 rg+rc，組件已由 excess_rg/excess_rc/insufficient_rg/_rc
    # （皆 1500）控制，aggregate 用 1500 同階即可（每天差距 +1500，曲線平滑）。
    "total_rest_below_8":   1500,   # RG+RC < 8
    "total_rest_above_9":   1500,   # RG+RC > 11（變數名沿用早期，threshold 由邏輯決定）
    "rg_interval_over_6":   1000,   # 兩 RG 之間 > 6 工作日

    # —— 健康度移植（health.py calculate_health_score 的 SA 化）——
    # Level 1：團隊整體健康度當軟提示。每位員工 (100 - 健康分數) × 5
    #          鼓勵 SA 找出 health score 高的方案，跟硬規則互補。
    "health_deficit_per_point": 5,
    # Level 2：個人健康分數 < 70（deficit > 30）視為過勞，接近天譴罰分。
    #          照 main2.py / TLPS 原始設計，保證沒有單一員工被排到極端。
    "health_floor_breach":  50000,

    # —— 客製化規則（比勞基法嚴）——
    # 每月 RG 必須恰好 4~5 天（已有 < 4 觸發 insufficient_rg；補 > 5 上限）
    "excess_rg":            1500,   # RG > 5
    # 每月 RC 必須恰好 4~5 天（insufficient_off 只看 RG+RC 總量，這條獨立控 RC）
    "insufficient_rc":      1500,   # RC < 4
    "excess_rc":            1500,   # RC > 5
    # 同一位護理師整月班表只能出現一種工作班別（D / E / N 三選一）
    # 對應 Gemini prompt 內的「每個護理人員班表僅能出現一種班別」設定。
    "mixed_work_shifts":    5000,

    # —— 每週節律：每 7 天區間內必須各有 ≥ 1 個 RG 與 1 個 RC ——
    # 比月度總量 [4,5] 還嚴：強制 RG/RC 平均分散在每週，避免「前 2 週全工作、
    # 後 2 週全休假」這種數字過得了月度但人會崩潰的班型。
    "week_missing_rg":      1000,
    "week_missing_rc":      1000,

    # —— 每人月工作天數嚴格範圍 [num_days-9, num_days-8] ——
    # 5/31 → work ∈ [22, 23]、rest ∈ [8, 9]。比 RG/RC 各 [4,5] 再嚴一階：
    # 拒絕「5 RG + 5 RC = 10 天休假」這種臨界值班型，強制每人月上滿至少 22 天。
    "work_days_below_22":   1200,   # work < num_days - 9（休太多）
    "work_days_above_23":   1200,   # work > num_days - 8（休太少）

    # —— 過長工作 streak 懲罰（B 方案：只罰 4+ 天）——
    # 改 semantic：streak 第 1-3 天免罰，第 4 天起每天 +10。
    # 連 N 天工作 → max(0, N-3) 個 penalty。
    # 跟健康度規則精神一致（連 6+ 工作才開始扣分），但更早一階（第 4 天就警告）。
    # key 名稱沿用 consecutive_work_pair 以維持向下相容；實質語意已變。
    "consecutive_work_pair": 10,

    # —— 連續第 6 天起算加班（OT），每天 +500 ——
    # 第 6 天還沒違反七休一（>6 才違規），但實務上算 OT、要付加班費，視為成本。
    # 連 6 → 1 次罰；連 7 → 2 次罰 + 也觸發 consecutive_work_7(2000)；以此類推。
    "overtime_6th_day_pay":  500,

    # —— 每日各班別人數需在 [req_min, req_max] 區間 ——
    # 當前 antiport 是 1↔1 swap，永遠不會破壞 daily count；這條是「防衛性」檢查。
    # 未來若加入非對稱 mutation（從 rest 拉人到 work 但不立即補位），這條才會觸發。
    "daily_demand_unmet":   3000,   # 某日某 type count < req_min
    "daily_demand_exceeded":1500,   # 某日某 type count > req_max

    # —— 衛福部三班護病比法定下限（硬底線，防禦深度第 2 層）——
    # min_daily_reqs 由前端依床數 + 醫院等級算出（src/constants.js legalDailyFloor）。
    # 即使 daily_reqs 被誤設成低於法定護病比，這條也會把不合規班表罰到極高，
    # 確保 SA 永遠不會交出「某班人數低於法定護病比」的解。權重高於一般 unmet。
    "ratio_below_legal":  200000,
}


# ============================================================
# 兩階段 TLPS（Sharif et al. 2026）：硬約束 vs 軟約束的分界
# ============================================================
# 論文把每位護理師的整月排班模式分三類：
#   禁止模式 (Prohibited)   — 違反「硬約束」(法規 / 醫院安全底線)，絕不允許
#   不理想模式 (Undesirable) — 合法但未滿足「軟約束」，會累積較高罰分
#   理想模式 (Desirable, DP) — 硬、軟約束皆滿足，TLPS 竭力最大化其數量
#
# SA 因此分兩階段跑：
#   1) 可行性階段 (Feasibility) — 只追硬約束罰分歸零，先消滅所有禁止模式
#   2) 優化階段 (Optimization)  — 鎖死硬約束=0，再壓低軟約束，把不理想升級為理想
#
# HARD_PENALTY_KEYS 精準對齊 JS 端 checkLaborLawCompliance 會抓的法定違規
# （見 compliance.py / JS_TO_SA_MAP）+ 三項營運硬底線（覆蓋、護病比、admin 強制）。
# 不在此集合者一律視為軟約束（比勞基法更嚴的客製規則 + 個人偏好）。
HARD_PENALTY_KEYS = frozenset({
    # —— 對齊 JS checkLaborLawCompliance 的法定違規（禁止模式）——
    "weekly_hours_over_40",     # WEEKLY_HOURS  §30 每週工時
    "monthly_hours_over_222",   # MONTHLY_OT    §32 月加班上限
    "insufficient_rg",          # INSUFFICIENT_RG §36 月例假 < 4
    "total_rest_below_8",       # INSUFFICIENT_OFF §36 RG+RC < 8
    "rg_interval_over_6",       # RG_INTERVAL   §36 兩 RG 之間 > 6 工作日
    "consecutive_work_7",       # CONSECUTIVE_DAYS §36 七休一
    "forbidden_n_d",            # SHIFT_INTERVAL §34 11h 輪班間隔
    "forbidden_n_e",
    "forbidden_e_d",
    "protected_on_en",          # MATERNITY/STUDENT §49 孕哺 / 實習禁夜
    # —— 營運硬底線（非 JS per-staff 檢查，但同屬「禁止」）——
    "daily_demand_unmet",       # 某班沒排滿 → 醫療覆蓋破口
    "ratio_below_legal",        # 衛福部三班護病比法定下限
    "custom_rule_violation",    # FORCE_OFF / FORCE_WORK（admin 硬指令）
})


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
    daily_reqs_max: Dict[int, int] = None,
    min_daily_reqs: Dict[int, int] = None,
    custom_rules: List[Dict] = None,
    max_iterations: int = 20000,
    seed: int = None,
    weight_overrides: Dict[str, int] = None,
    # —— L3 Focused SA 參數 ——
    focused_mode: bool = True,        # 啟用 freeze + targeted mutation
    freeze_threshold: int = 500,      # nurse 個人罰分 < 此 → 凍結為「綠燈」
    reclassify_every: int = 200,      # 每 N iter 重新分類綠/紅燈
    tabu_size: int = 50,              # tabu list 長度（記住最近 K 次 swap 反向）
    stagnation_thaw: int = 800,       # 連續 N iter 沒進步 → 強制亂數攪局
    # —— DP-aware polish 參數（最大化理想模式數量）——
    dp_aware: bool = True,            # 優化階段啟用「把近理想護理師推成 DP」的對症 mutation
    dp_polish_prob: float = 0.35,     # focused 分支內、優化階段嘗試 dp_polish 的機率
    dp_polish_pool: int = 5,          # 從軟罰分最低的前 N 位近理想護理師隨機挑一位
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

    # —— 每日各班別人數上限：未指定就是 min + 1（允許每天彈性 1 人）——
    daily_reqs_max = daily_reqs_max or {}
    def _req_max(code: int, fallback: int) -> int:
        v = daily_reqs_max.get(code, daily_reqs_max.get(str(code)))
        return int(v) if v is not None else fallback + 1
    req_D_max = _req_max(1, req_D)
    req_E_max = _req_max(2, req_E)
    req_N_max = _req_max(3, req_N)

    # —— 護病比法定下限（每班最少護理師數）；None 表示呼叫端沒傳就不啟用第 2 層檢查 ——
    min_daily_reqs = min_daily_reqs or {}
    if min_daily_reqs:
        def _minreq(code: int) -> int:
            return int(min_daily_reqs.get(code, min_daily_reqs.get(str(code), 0)))
        min_daily_floor = {"D": _minreq(1), "E": _minreq(2), "N": _minreq(3)}
    else:
        min_daily_floor = None

    _, num_days = calendar.monthrange(year, month)
    num_nurses = len(nurses)
    protected_ids = {nurses[i] for i in protected}

    # —— Calendar-aware 週切分 ——
    # 之前用 range(0, num_days, 7) 把 day 1-7 當「第一週」，
    # 完全沒考慮 day 1 是星期幾。若 5/1 是週五，前 3 天才算頭一個 partial week，
    # 真正的第 1 週應從 5/4（週一）開始。
    # 這個 helper 算出每個「週一到週日」區塊（day_start, day_end, is_full_week）。
    # is_full_week=False 表示是月頭或月尾的 partial 週，只剩 3-6 天。
    def _calendar_weeks():
        weeks = []
        day1_wd = calendar.weekday(year, month, 1)  # 0=Mon, 6=Sun
        current = 1 - day1_wd                       # 可能是負值（代表上個月的週一）
        while current <= num_days:
            start = max(current, 1)
            end = min(current + 6, num_days)
            is_full = (end - start + 1) == 7
            weeks.append((start, end, is_full))
            current += 7
        return weeks
    weeks_info = _calendar_weeks()

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

    # —— 對齊「mixed_work_shifts」規則：預先把每位護理師指派到一種工作班別 ——
    # 隨機 init 會讓同一個人在 D/E/N 三個 mem 之間散亂，mixed_work_shifts 罰分
    # 在 round 0 就大爆。先依需求比例切人，給 SA 一個合法起點。
    non_prot_list = [nid for nid in nurses if nid not in protected_ids]
    random.shuffle(non_prot_list)
    total_demand = max(1, req_D + req_E + req_N)
    target_d = max(req_D, round(num_nurses * req_D / total_demand))
    target_e = max(req_E, round(num_nurses * req_E / total_demand))
    target_n = max(req_N, round(num_nurses * req_N / total_demand))
    # 調整總和到 num_nurses（多就削最大、少就補 D）
    while target_d + target_e + target_n > num_nurses:
        if target_d >= max(target_e, target_n) and target_d > req_D: target_d -= 1
        elif target_e >= target_n and target_e > req_E: target_e -= 1
        elif target_n > req_N: target_n -= 1
        else: break  # 三個都剛好等於 req，無法再削（人力極緊，後面會自動處理）
    while target_d + target_e + target_n < num_nurses:
        target_d += 1  # 多餘人手都當 D

    # 保護名單一律分到 D
    d_pool = list(protected_ids)
    remaining_d = max(0, target_d - len(d_pool))
    idx = 0
    d_pool.extend(non_prot_list[idx:idx + remaining_d]); idx += remaining_d
    e_pool = non_prot_list[idx:idx + target_e]; idx += target_e
    n_pool = non_prot_list[idx:idx + target_n]; idx += target_n
    if idx < len(non_prot_list):
        d_pool.extend(non_prot_list[idx:])

    if len(e_pool) < req_E or len(n_pool) < req_N:
        raise ValueError(
            f"班別專一性 + 人力配置不可解："
            f"E pool {len(e_pool)} 人 < req_E {req_E}，"
            f"或 N pool {len(n_pool)} 人 < req_N {req_N}。"
            "需要：放寬保護名單、降低 E/N 人力需求、或增加員工人數。"
        )

    # 記住每位護理師的「主班別」— 給 mutation 用，確保 swap 不會跨類型
    nurse_home_type: Dict[str, str] = {}
    for nid in d_pool: nurse_home_type[nid] = "D"
    for nid in e_pool: nurse_home_type[nid] = "E"
    for nid in n_pool: nurse_home_type[nid] = "N"
    nurses_by_type = {
        "D": list(d_pool),
        "E": list(e_pool),
        "N": list(n_pool),
    }

    # —— 貪婪 rotation init（取代原 cycle-based 版本）——
    # 為何放棄 cycle: `cycle[(d-1-i) % P]` 會把「多出來」那一天永遠壓在位置 0 的
    # nurse 身上。例如 P=4 / R=3 / 31 天，總工作 = 31×3 = 93 person-days，每人均分
    # 23.25。Cycle 給位置 0 的 nurse 24 天工作 + 7 天 rest（觸發 total_rest_below_8
    # ×50000），其他 3 人 23 工 + 8 rest。差距全在位置 0。
    #
    # 貪婪版每天挑「目前 work_count 最少」的 R 個人去工作，剩下 rest。當 R/P 為非
    # 整數時，工作天差距會均勻散佈（24/23/23/23 vs 23/24/23/23 vs ...）而非全壓
    # 一人。最少差 1 天，但「中籤」的人輪流變化。
    #
    # ⚠️ 注意：此 init 在「P×R 整除 num_days」時跟 cycle 等價；非整除時把痛點散
    # 開但不消除（總工作 person-days 是定量）。要真正消痛點，必須擴充 pool size，
    # 不是改 init。
    def _rotation_init(pool: List[str], daily_req: int):
        P = len(pool)
        R = daily_req
        result = {d: {"work": [], "rg": [], "rc": []} for d in range(1, num_days + 1)}
        if P == 0:
            return result
        if R >= P:
            # pool 全員每天都得上 — 沒 rest 可分配，全進 work
            for d in range(1, num_days + 1):
                result[d]["work"] = list(pool)
            return result

        work_count = {nid: 0 for nid in pool}
        rest_count = {nid: 0 for nid in pool}
        # tiebreak_offset：當多人 work_count 相同時，輪流誰先被選
        # 避免「字母排序最前的 nurse 永遠先 selected」造成另一種偏差。
        tiebreak_offset = 0

        for d in range(1, num_days + 1):
            # 排序鍵：(work_count 升冪, 該 nurse 的 day-1 索引 + offset mod P)
            # work_count 少的優先工作；同 count 時依輪換偏移選人。
            ranked = sorted(
                enumerate(pool),
                key=lambda x: (work_count[x[1]], (x[0] + tiebreak_offset) % P),
            )
            for rank, (i, nid) in enumerate(ranked):
                if rank < R:
                    result[d]["work"].append(nid)
                    work_count[nid] += 1
                else:
                    # 偶數順序放 RG、奇數放 RC（per-nurse 交替）
                    if rest_count[nid] % 2 == 0:
                        result[d]["rg"].append(nid)
                    else:
                        result[d]["rc"].append(nid)
                    rest_count[nid] += 1
            tiebreak_offset = (tiebreak_offset + 1) % P
        return result

    d_rot = _rotation_init(d_pool, req_D)
    e_rot = _rotation_init(e_pool, req_E)
    n_rot = _rotation_init(n_pool, req_N)

    for d in range(1, num_days + 1):
        m_mem[d] = list(d_rot[d]["work"])
        e_mem[d] = list(e_rot[d]["work"])
        n_mem[d] = list(n_rot[d]["work"])
        # RG / RC 各 type pool 的 rest 合併到全域 rg_mem / rc_mem
        rg_mem[d] = list(d_rot[d]["rg"]) + list(e_rot[d]["rg"]) + list(n_rot[d]["rg"])
        rc_mem[d] = list(d_rot[d]["rc"]) + list(e_rot[d]["rc"]) + list(n_rot[d]["rc"])

    # —— 解析 custom_rules 並同時建構 per-day 需求對照表 ——
    # target_reqs_per_day / target_reqs_max_per_day 預設為均一（沿用 req_D/E/N 與
    # req_D_max/E_max/N_max），UPDATE_DEMAND 規則可逐日覆寫。之後的 daily_demand
    # 檢查改讀這份 per-day 對照（取代原本固定的 req_D/req_E/req_N），讓 SA 能順著
    # LLM/前端傳來的「某日某班特殊需求」收斂。
    target_reqs_per_day: Dict[int, Dict[str, int]] = {
        d: {"D": req_D, "E": req_E, "N": req_N} for d in range(1, num_days + 1)
    }
    target_reqs_max_per_day: Dict[int, Dict[str, int]] = {
        d: {"D": req_D_max, "E": req_E_max, "N": req_N_max} for d in range(1, num_days + 1)
    }
    SHIFT_INT_TO_LETTER = {1: "D", 2: "E", 3: "N"}
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
        if action == "UPDATE_DEMAND":
            sh = rule.get("shift")
            if isinstance(sh, int):
                sh = SHIFT_INT_TO_LETTER.get(sh)
            new_val = rule.get("new_value")
            if sh in ("D", "E", "N") and isinstance(new_val, (int, float)) and 0 <= int(new_val) <= num_nurses:
                v = int(new_val)
                target_reqs_per_day[d][sh] = v
                # 維持「彈性 1 人」與其他天一致；若原本 max 更高（呼叫端有設）就保留
                target_reqs_max_per_day[d][sh] = max(target_reqs_max_per_day[d][sh], v + 1)
            continue
        nid = rule.get("nurse_id")
        if action == "FORCE_OFF" and nid in nurses:
            force_off.append((nid, d))
        elif action == "FORCE_WORK" and nid in nurses:
            sh = rule.get("shift")
            if sh in ("D", "E", "N"):
                force_work.append((nid, d, sh))

    def get_sched(nid: str, mm, em, nm, rgm, rcm) -> List[str]:
        # 班別只有 D/E/N/RG/RC 五種；不再有 OFF。若 nurse 沒被歸到任何 mem 是
        # init / mutation bug，直接 raise 比靜默掉漏好除錯。
        sched = []
        for d in range(1, num_days + 1):
            if nid in mm[d]:    sched.append("D")
            elif nid in em[d]:  sched.append("E")
            elif nid in nm[d]:  sched.append("N")
            elif nid in rgm[d]: sched.append("RG")
            elif nid in rcm[d]: sched.append("RC")
            else:
                raise RuntimeError(f"Day {d} 護理師 {nid} 不在任何膜中 — 違反 init 不變式")
        return sched

    def evaluate(mm, em, nm, rgm, rcm) -> Tuple[int, Dict[str, int], Dict[str, Dict[str, int]]]:
        """
        Returns:
          total: 整月總罰分
          breakdown: {rule_key: count} — 全域累計各規則違規次數
          per_nurse: {nid: {rule_key: count}} — 每位 nurse 各規則違規次數
                     給 Focused SA 分類綠/紅燈用。
                     注意：跨 nurse 的規則（daily_demand）不會出現在 per_nurse。
        """
        total = 0
        breakdown = defaultdict(int)
        per_nurse: Dict[str, Dict[str, int]] = {nid: defaultdict(int) for nid in nurses}
        REST = {"RG", "RC"}
        WORK = {"D", "E", "N"}

        def _add(nid, key, count=1):
            """同步寫 total / breakdown / per_nurse[nid]，減少重複代碼。"""
            nonlocal total
            total += W[key] * count
            breakdown[key] += count
            per_nurse[nid][key] += count

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
                if c_work > 3:
                    _add(nid, "consecutive_work_pair")
                if c_work >= 6:
                    _add(nid, "overtime_6th_day_pay")
                if c_work > 6:
                    _add(nid, "consecutive_work_7")
                if c_night > 3:
                    _add(nid, "consecutive_night_4")
                if nid in protected_ids and shift in ("E", "N"):
                    _add(nid, "protected_on_en")
                if days_since_rg > 6:
                    _add(nid, "rg_interval_over_6")
                    days_since_rg = 0  # 報錯後重置，避免同一段重複洗版

            for d in range(num_days - 1):
                if sched[d] == "N" and sched[d + 1] == "D":
                    _add(nid, "forbidden_n_d")
                if sched[d] == "N" and sched[d + 1] == "E":
                    _add(nid, "forbidden_n_e")
                if sched[d] == "E" and sched[d + 1] == "D":
                    _add(nid, "forbidden_e_d")

            # —— 大夜後連休 2 天：d=N、d+1≠N → d+1 必為 RG/RC、d+2 也必為 RG/RC ——
            # 對齊 main.py 新模型（生理時鐘恢復需 2 天）。scheduler.py 把 OFF 拆成
            # RG/RC，所以判定用 "in REST"（{"RG","RC"}）而非 main1.py 那邊的 "==O"。
            for d in range(num_days - 1):
                if sched[d] == "N" and sched[d + 1] != "N":
                    if sched[d + 1] not in REST:
                        _add(nid, "post_night_not_off_2")
                    if d + 2 < num_days and sched[d + 2] not in REST:
                        _add(nid, "post_night_not_off_2")

            for d in range(1, num_days - 1):
                # 孤立休假（工-休-工）分兩級：N 敏感、D/E 不敏感
                if sched[d - 1] in WORK and sched[d] in REST and sched[d + 1] in WORK:
                    if sched[d - 1] == "N" or sched[d + 1] == "N":
                        _add(nid, "isolated_off_n")
                    else:
                        _add(nid, "isolated_off_de")

            # 連續 RG/RC 加分：工作班後接 2+ 連續休假 → +20（所有班別同等）
            for d in range(num_days - 2):
                if sched[d] in WORK and sched[d + 1] in REST and sched[d + 2] in REST:
                    _add(nid, "consecutive_rest_after_work")

            # 【健康度移植 Level 1+2】
            hr = calculate_health_score(sched)
            deficit = 100 - hr["score"]
            if deficit > 0:
                _add(nid, "health_deficit_per_point", count=deficit)
            if deficit > 30:
                _add(nid, "health_floor_breach")

            # 每週工時 + 每週 RG/RC 檢查 — 用 calendar-aware 週切分（Mon-Sun）
            for week_start_day, week_end_day, is_full in weeks_info:
                week = sched[week_start_day - 1:week_end_day]
                work_h = sum(8 for s in week if s in WORK)
                if work_h > 40:
                    _add(nid, "weekly_hours_over_40")
                if is_full:
                    if "RG" not in week:
                        _add(nid, "week_missing_rg")
                    if "RC" not in week:
                        _add(nid, "week_missing_rc")

            # 月總工時 ≤ 222h + 月工作天數嚴格範圍
            total_work_days = sum(1 for s in sched if s in WORK)
            total_work_h = total_work_days * 8
            if total_work_h > 222:
                _add(nid, "monthly_hours_over_222")
            if total_work_days < num_days - 11:
                _add(nid, "work_days_below_22")
            if total_work_days > num_days - 7:
                _add(nid, "work_days_above_23")

            # 月例假 RG / 月休息日 RC 範圍 [4, 5]
            rg_count = sum(1 for s in sched if s == "RG")
            rc_count = sum(1 for s in sched if s == "RC")
            if rg_count < 4:  _add(nid, "insufficient_rg")
            if rg_count > 5:  _add(nid, "excess_rg")
            if rc_count < 4:  _add(nid, "insufficient_rc")
            if rc_count > 5:  _add(nid, "excess_rc")
            total_rest = rg_count + rc_count
            if total_rest < 8:  _add(nid, "total_rest_below_8")
            if total_rest > 11: _add(nid, "total_rest_above_9")

            # 班別專一性：同一位整月只能出現一種工作班別
            work_types_used = set(s for s in sched if s in WORK)
            if len(work_types_used) > 1:
                _add(nid, "mixed_work_shifts")

        # —— 每日各班別人數需 ∈ [req_min, req_max]（含 UPDATE_DEMAND 覆寫感知）——
        # 改讀 target_reqs_per_day / target_reqs_max_per_day（custom_rules 的
        # UPDATE_DEMAND 會逐日覆寫）。1↔1 swap mutation 不破壞每日總人數，但 init
        # 用均一 req 配額時，UPDATE_DEMAND 覆寫的日子第 0 round 就會 unmet/exceeded，
        # 由 SA 透過跨日 mutation（block_antiport）逐步調整。
        # 不歸屬任何單一 nurse → 不寫 per_nurse，只計入 total + breakdown。
        for d in range(1, num_days + 1):
            d_count = len(mm[d])
            e_count = len(em[d])
            n_count = len(nm[d])
            tr = target_reqs_per_day[d]
            trm = target_reqs_max_per_day[d]
            for sh_letter, cnt in (("D", d_count), ("E", e_count), ("N", n_count)):
                if cnt < tr[sh_letter]:
                    shortfall = tr[sh_letter] - cnt
                    total += W["daily_demand_unmet"] * shortfall
                    breakdown["daily_demand_unmet"] += shortfall
                if cnt > trm[sh_letter]:
                    excess = cnt - trm[sh_letter]
                    total += W["daily_demand_exceeded"] * excess
                    breakdown["daily_demand_exceeded"] += excess

        # —— 護病比法定下限（防禦深度第 2 層）：每班 count < 衛福部下限 = 重罰 ——
        if min_daily_floor:
            for d in range(1, num_days + 1):
                for sh_letter, mem in (("D", mm), ("E", em), ("N", nm)):
                    floor_v = min_daily_floor.get(sh_letter, 0)
                    cnt = len(mem[d])
                    if cnt < floor_v:
                        short = floor_v - cnt
                        total += W["ratio_below_legal"] * short
                        breakdown["ratio_below_legal"] += short

        # FORCE_OFF / FORCE_WORK — 歸屬到指定 nurse
        sched_cache = {nid: get_sched(nid, mm, em, nm, rgm, rcm) for nid in nurses}
        for (nid, d) in force_off:
            if sched_cache[nid][d - 1] not in ("RG", "RC"):
                _add(nid, "custom_rule_violation")
        for (nid, d, sh) in force_work:
            if sched_cache[nid][d - 1] != sh:
                _add(nid, "custom_rule_violation")

        per_nurse_plain = {nid: dict(v) for nid, v in per_nurse.items()}
        return total, dict(breakdown), per_nurse_plain

    work_mem_of = {"D": m_mem, "E": e_mem, "N": n_mem}

    def antiport(day, mm, em, nm, rgm, rcm):
        # 班別專一性版本：只在同類型內 swap。流程：
        #   1. 隨機挑一個 type（D/E/N）
        #   2. 從該 type pool 抽 2 個護理師
        #   3. 兩人目前所在的 mem 必須在 {該 type 的 work_mem, RG, RC} 三選一
        #   4. 若兩人在不同 mem，swap；同 mem 則跳過
        home = random.choice(("D", "E", "N"))
        same_type = nurses_by_type[home]
        if len(same_type) < 2:
            return
        n1, n2 = random.sample(same_type, 2)
        work_mem = work_mem_of[home]
        candidates = (work_mem, rgm, rcm)
        m1 = next((m for m in candidates if n1 in m[day]), None)
        m2 = next((m for m in candidates if n2 in m[day]), None)
        if m1 is None or m2 is None or m1 is m2:
            return
        m1[day].remove(n1); m1[day].append(n2)
        m2[day].remove(n2); m2[day].append(n1)

    def block_antiport(mm, em, nm, rgm, rcm, block=3):
        # 同邏輯但跨連續多天
        if num_days < block:
            return
        start = random.randint(1, num_days - block + 1)
        home = random.choice(("D", "E", "N"))
        same_type = nurses_by_type[home]
        if len(same_type) < 2:
            return
        n1, n2 = random.sample(same_type, 2)
        work_mem = work_mem_of[home]
        candidates = (work_mem, rgm, rcm)
        for d in range(start, start + block):
            m1 = next((m for m in candidates if n1 in m[d]), None)
            m2 = next((m for m in candidates if n2 in m[d]), None)
            if m1 is None or m2 is None or m1 is m2:
                continue
            m1[d].remove(n1); m1[d].append(n2)
            m2[d].remove(n2); m2[d].append(n1)

    def month_swap(mm, em, nm, rgm, rcm):
        """跨員工 swap 整月配置：兩個同類型員工互換整月模式（block=num_days）。
        效果：n1 變成 n2 的工作天分布，反之亦然。可以一次大幅跳出局部最佳。"""
        home = random.choice(("D", "E", "N"))
        same_type = nurses_by_type[home]
        if len(same_type) < 2:
            return
        n1, n2 = random.sample(same_type, 2)
        work_mem = work_mem_of[home]
        candidates = (work_mem, rgm, rcm)
        for d in range(1, num_days + 1):
            m1 = next((m for m in candidates if n1 in m[d]), None)
            m2 = next((m for m in candidates if n2 in m[d]), None)
            if m1 is None or m2 is None or m1 is m2:
                continue
            m1[d].remove(n1); m1[d].append(n2)
            m2[d].remove(n2); m2[d].append(n1)

    def week_rotation(mm, em, nm, rgm, rcm):
        """挑一週 + 一位護理師，把該員在這週的工作/休假分布循環位移 1 格。
        實作為「該週前 6 天的 mem 配置往後挪、第 7 天的配置接到第 1 天」。
        其他員工不動 → 每天的人頭數可能不平衡，由 SA penalty 自然處理。"""
        if num_days < 7:
            return
        nid = random.choice(nurses)
        home = nurse_home_type[nid]
        work_mem = work_mem_of[home]
        candidates = (work_mem, rgm, rcm)
        week_start = random.randint(1, num_days - 6)
        days = list(range(week_start, week_start + 7))

        # 取出 nid 在這 7 天分別處於哪個 mem
        nid_locations = []
        for d in days:
            m = next((mem for mem in candidates if nid in mem[d]), None)
            if m is None:
                return  # invariant 壞了，放棄
            nid_locations.append(m)

        # rotate 1：第 7 天的 mem 變成第 1 天的，其他往後挪
        rotated = [nid_locations[-1]] + nid_locations[:-1]
        if rotated == nid_locations:
            return  # 全週都同 mem，rotate 沒效果

        # 為了維持「每天每 mem 人頭數不變」，nid 移走的同時要找替身補上
        # 簡化：直接搬 nid，daily req 不變式由 SA penalty 維護（會觸發 shortfall）
        # 注意這會打破 daily demand —— 若不希望，這個 mutation 應跳過
        for d, (old_m, new_m) in zip(days, zip(nid_locations, rotated)):
            if old_m is new_m:
                continue
            old_m[d].remove(nid)
            new_m[d].append(nid)

    # ==========================================
    # L3 Focused SA：分類器 + tabu + 對症 mutation
    # ==========================================
    # tabu list — 記住最近 K 次 swap 的 (n_sorted, day) tuple，防止立刻反向操作
    # 反向 swap 會把剛剛改的 day 還原，等於白做工。tabu 強制 SA 短期不重複動同一處。
    tabu: deque = deque(maxlen=tabu_size)

    def _tabu_key(n1: str, n2: str, day: int) -> Tuple:
        a, b = sorted([n1, n2])
        return (a, b, day)

    def _classify_nurses(per_nurse: Dict[str, Dict[str, int]]) -> Tuple[Set[str], Set[str], Dict[str, str], Dict[str, int]]:
        """
        把每位 nurse 依照個人罰分分成綠燈（凍結）／紅燈（active）。
        Returns:
          red_set: 個人罰分 ≥ threshold 的 nurse 集合（mutation 主角必須來自這裡）
          green_set: 其餘 nurse
          dominant: {nid: 主要違規類型 key}，找不到違規時為 None
          totals: {nid: 個人總罰分}
        """
        totals: Dict[str, int] = {}
        dominant: Dict[str, Optional[str]] = {}
        for nid in nurses:
            contribs = per_nurse.get(nid, {})
            t = sum(W[k] * c for k, c in contribs.items() if k in W)
            totals[nid] = t
            if contribs:
                dom_key = max(contribs.items(), key=lambda kv: W.get(kv[0], 0) * kv[1])[0]
                dominant[nid] = dom_key
            else:
                dominant[nid] = None
        red = {nid for nid, t in totals.items() if t >= freeze_threshold}
        green = {nid for nid in nurses if nid not in red}
        return red, green, dominant, totals

    def _swap_two(n1: str, n2: str, day: int, mm, em, nm, rgm, rcm) -> bool:
        """工具函式：在 day 把 n1/n2 交換所在的 mem。tabu 過則拒絕。回傳是否成功。
        要求 n1 / n2 同 work_type（同 home），swap 對象限該 type 的 work_mem + RG/RC。"""
        if _tabu_key(n1, n2, day) in tabu:
            return False
        home = nurse_home_type.get(n1)
        if home != nurse_home_type.get(n2):
            return False  # 不同 home，禁止跨 type swap
        work_mem = work_mem_of[home]
        candidates = (work_mem, rgm, rcm)
        m1 = next((m for m in candidates if n1 in m[day]), None)
        m2 = next((m for m in candidates if n2 in m[day]), None)
        if m1 is None or m2 is None or m1 is m2:
            return False
        m1[day].remove(n1); m1[day].append(n2)
        m2[day].remove(n2); m2[day].append(n1)
        tabu.append(_tabu_key(n1, n2, day))
        return True

    def antiport_focused(red_set: Set[str], mm, em, nm, rgm, rcm) -> bool:
        """單天 antiport，但主角必為紅燈。配角從同 type 任意挑。"""
        home = random.choice(("D", "E", "N"))
        same_type = nurses_by_type[home]
        if len(same_type) < 2:
            return False
        red_in = [n for n in same_type if n in red_set]
        if not red_in:
            return False
        n1 = random.choice(red_in)
        n2 = random.choice([n for n in same_type if n != n1])
        day = random.randint(1, num_days)
        return _swap_two(n1, n2, day, mm, em, nm, rgm, rcm)

    def block_antiport_focused(red_set: Set[str], mm, em, nm, rgm, rcm, block: int = 3) -> bool:
        """跨 block 天 antiport（主角紅燈）。每天獨立判 tabu。"""
        if num_days < block:
            return False
        home = random.choice(("D", "E", "N"))
        same_type = nurses_by_type[home]
        if len(same_type) < 2:
            return False
        red_in = [n for n in same_type if n in red_set]
        if not red_in:
            return False
        n1 = random.choice(red_in)
        n2 = random.choice([n for n in same_type if n != n1])
        start = random.randint(1, num_days - block + 1)
        any_swapped = False
        for d in range(start, start + block):
            if _swap_two(n1, n2, d, mm, em, nm, rgm, rcm):
                any_swapped = True
        return any_swapped

    # ==========================================
    # L2 對症 mutation — 根據紅燈 nurse 的主要違規類型挑修復動作
    # ==========================================
    def fix_excess_rg(red_set, dominant, mm, em, nm, rgm, rcm) -> bool:
        """主角 RG 太多 → 找他某天的 RG，跟同 type 一位 work 中的 nurse swap。
        效果：主角 RG -1、work +1；對方 RG +1、work -1。"""
        cands = [n for n in red_set if dominant.get(n) in ("excess_rg", "total_rest_above_9")]
        if not cands:
            return False
        actor = random.choice(cands)
        home = nurse_home_type[actor]
        work_mem = work_mem_of[home]
        days_in_rg = [d for d in range(1, num_days + 1) if actor in rgm[d]]
        if not days_in_rg:
            return False
        day = random.choice(days_in_rg)
        partners = [n for n in nurses_by_type[home] if n != actor and n in work_mem[day]]
        if not partners:
            return False
        partner = random.choice(partners)
        return _swap_two(actor, partner, day, mm, em, nm, rgm, rcm)

    def fix_excess_rc(red_set, dominant, mm, em, nm, rgm, rcm) -> bool:
        """主角 RC 太多 → 跟同 type 一位 work 中的 nurse 在 RC 那天 swap。"""
        cands = [n for n in red_set if dominant.get(n) in ("excess_rc", "total_rest_above_9")]
        if not cands:
            return False
        actor = random.choice(cands)
        home = nurse_home_type[actor]
        work_mem = work_mem_of[home]
        days_in_rc = [d for d in range(1, num_days + 1) if actor in rcm[d]]
        if not days_in_rc:
            return False
        day = random.choice(days_in_rc)
        partners = [n for n in nurses_by_type[home] if n != actor and n in work_mem[day]]
        if not partners:
            return False
        partner = random.choice(partners)
        return _swap_two(actor, partner, day, mm, em, nm, rgm, rcm)

    def fix_insufficient_rest(red_set, dominant, mm, em, nm, rgm, rcm) -> bool:
        """主角 work 太多（或 RG/RC 不足）→ 跟同 type 在 RG/RC 的 nurse swap。"""
        targets = ("work_days_above_23", "insufficient_rg", "insufficient_rc", "total_rest_below_8")
        cands = [n for n in red_set if dominant.get(n) in targets]
        if not cands:
            return False
        actor = random.choice(cands)
        home = nurse_home_type[actor]
        work_mem = work_mem_of[home]
        days_at_work = [d for d in range(1, num_days + 1) if actor in work_mem[d]]
        if not days_at_work:
            return False
        day = random.choice(days_at_work)
        rest_mem = random.choice((rgm, rcm))
        partners = [n for n in nurses_by_type[home] if n != actor and n in rest_mem[day]]
        if not partners:
            # 試另一個 rest mem
            rest_mem = rcm if rest_mem is rgm else rgm
            partners = [n for n in nurses_by_type[home] if n != actor and n in rest_mem[day]]
        if not partners:
            return False
        partner = random.choice(partners)
        return _swap_two(actor, partner, day, mm, em, nm, rgm, rcm)

    def fix_consecutive_work(red_set, dominant, mm, em, nm, rgm, rcm) -> bool:
        """主角連工太久 → 在 streak 中段插入一天休息，跟休息 nurse swap。"""
        targets = ("consecutive_work_7", "consecutive_work_pair", "overtime_6th_day_pay", "consecutive_night_4")
        cands = [n for n in red_set if dominant.get(n) in targets]
        if not cands:
            return False
        actor = random.choice(cands)
        home = nurse_home_type[actor]
        work_mem = work_mem_of[home]
        # 找最長 streak 的中段
        sched = get_sched(actor, mm, em, nm, rgm, rcm)
        WORK = {"D", "E", "N"}
        best_start = -1
        best_len = 0
        cur_start = -1
        cur_len = 0
        for d, s in enumerate(sched):
            if s in WORK:
                if cur_len == 0:
                    cur_start = d
                cur_len += 1
                if cur_len > best_len:
                    best_len = cur_len
                    best_start = cur_start
            else:
                cur_len = 0
        if best_len < 4:
            return False
        mid = best_start + best_len // 2
        day = mid + 1  # 0-indexed → 1-indexed
        rest_mem = random.choice((rgm, rcm))
        partners = [n for n in nurses_by_type[home] if n != actor and n in rest_mem[day]]
        if not partners:
            rest_mem = rcm if rest_mem is rgm else rgm
            partners = [n for n in nurses_by_type[home] if n != actor and n in rest_mem[day]]
        if not partners:
            return False
        partner = random.choice(partners)
        return _swap_two(actor, partner, day, mm, em, nm, rgm, rcm)

    def fix_isolated_off(red_set, dominant, mm, em, nm, rgm, rcm) -> bool:
        """主角有「工-休-工」→ 把休息那天前後一天也試圖換成休息（與 partner swap）。"""
        cands = [n for n in red_set if dominant.get(n) in ("isolated_off_n", "isolated_off_de")]
        if not cands:
            return False
        actor = random.choice(cands)
        home = nurse_home_type[actor]
        work_mem = work_mem_of[home]
        sched = get_sched(actor, mm, em, nm, rgm, rcm)
        WORK = {"D", "E", "N"}
        REST = {"RG", "RC"}
        iso_days = []
        for d in range(1, len(sched) - 1):
            if sched[d - 1] in WORK and sched[d] in REST and sched[d + 1] in WORK:
                iso_days.append(d)
        if not iso_days:
            return False
        iso_d = random.choice(iso_days)
        # 試把 iso_d - 1 或 iso_d + 1 由 work 換成 rest（跟 rest 中的 partner swap）
        adj_day_idx = random.choice((iso_d - 1, iso_d + 1))
        day = adj_day_idx + 1  # 1-indexed
        if day < 1 or day > num_days:
            return False
        rest_mem = rgm if sched[iso_d] == "RG" else rcm
        partners = [n for n in nurses_by_type[home] if n != actor and n in rest_mem[day]]
        if not partners:
            return False
        partner = random.choice(partners)
        return _swap_two(actor, partner, day, mm, em, nm, rgm, rcm)

    def fix_consecutive_rest(red_set, dominant, mm, em, nm, rgm, rcm) -> bool:
        """主角有「工-休-休」連續休假叢集 → 把第 2 個休假日換成工作（與工作中 partner swap），打散叢集。
        consecutive_rest_after_work 是優化階段最頑固的殘留軟違規之一，先前沒有對症 fix，
        紅燈 / DP-polish 都只能退回隨機 antiport — 補上這條讓它能被定向消除。"""
        cands = [n for n in red_set if dominant.get(n) == "consecutive_rest_after_work"]
        if not cands:
            return False
        actor = random.choice(cands)
        home = nurse_home_type[actor]
        work_mem = work_mem_of[home]
        sched = get_sched(actor, mm, em, nm, rgm, rcm)
        WORK = {"D", "E", "N"}
        REST = {"RG", "RC"}
        triples = [d for d in range(num_days - 2)
                   if sched[d] in WORK and sched[d + 1] in REST and sched[d + 2] in REST]
        if not triples:
            return False
        base = random.choice(triples)
        day = base + 3  # 第 2 個休假日 (0-indexed base+2) → 1-indexed
        if day > num_days:
            return False
        rest_mem = rgm if sched[base + 2] == "RG" else rcm
        # actor 此日在 rest_mem，找同 type 在 work_mem 的 partner 對調 → 叢集第 2 天變工作
        partners = [n for n in nurses_by_type[home] if n != actor and n in work_mem[day]]
        if not partners:
            return False
        partner = random.choice(partners)
        return _swap_two(actor, partner, day, mm, em, nm, rgm, rcm)

    # 對症 mutation 路由表：dominant_key → fix function
    TARGETED_FIX = {
        "excess_rg":             fix_excess_rg,
        "excess_rc":             fix_excess_rc,
        "total_rest_above_9":    fix_excess_rg,           # 同方向，先試 RG
        "work_days_above_23":    fix_insufficient_rest,
        "insufficient_rg":       fix_insufficient_rest,
        "insufficient_rc":       fix_insufficient_rest,
        "total_rest_below_8":    fix_insufficient_rest,
        "work_days_below_22":    fix_excess_rg,           # work 不足 → 換 RG 為 work
        "consecutive_work_7":    fix_consecutive_work,
        "consecutive_work_pair": fix_consecutive_work,
        "consecutive_night_4":   fix_consecutive_work,
        "overtime_6th_day_pay":  fix_consecutive_work,
        "isolated_off_n":        fix_isolated_off,
        "isolated_off_de":       fix_isolated_off,
        "consecutive_rest_after_work": fix_consecutive_rest,
    }

    def targeted_mutation(red_set, dominant, mm, em, nm, rgm, rcm) -> bool:
        """從紅燈 nurse 抽一位，依其主要違規路由到對症 fix；fix 失敗就退回 focused antiport。"""
        if not red_set:
            return False
        actor = random.choice(list(red_set))
        dom = dominant.get(actor)
        fix = TARGETED_FIX.get(dom)
        if fix is not None and fix(red_set, dominant, mm, em, nm, rgm, rcm):
            return True
        return antiport_focused(red_set, mm, em, nm, rgm, rcm)

    # ==========================================
    # DP-aware polish — 把「最接近理想」的護理師推成理想模式 (Desirable Pattern)
    # ==========================================
    # 為何需要：紅/綠燈以個人總罰分 freeze_threshold(預設 500) 分界，軟罰分低的「近理想」
    # 護理師被歸成綠燈凍結，紅燈對症 mutation 永遠碰不到他們 → 不理想模式卡住升不了理想。
    # dp_polish 反向操作：專挑無硬違規、軟罰分『最低』的護理師（最容易清零者），對其主要
    # 殘留軟違規施以同一套對症 fix，目標直接拉高 desirable_pattern_count。
    def _dp_count(per_nurse) -> int:
        """完全乾淨（硬、軟皆 0）的護理師數 = 理想模式 (DP) 數量。"""
        return sum(1 for nid in nurses
                   if not any(c > 0 for c in per_nurse.get(nid, {}).values()))

    def _dp_candidates(per_nurse):
        """近理想護理師：無硬違規但仍有軟違規，依軟罰分升冪（最接近 DP 在前）。"""
        cands = []
        for nid in nurses:
            contribs = per_nurse.get(nid, {})
            if any(c > 0 for k, c in contribs.items() if k in HARD_PENALTY_KEYS):
                continue  # 還有硬違規 → 不是 DP candidate（紅燈的事）
            soft = sum(W[k] * c for k, c in contribs.items() if k not in HARD_PENALTY_KEYS)
            if soft > 0:
                cands.append((soft, nid))
        cands.sort(key=lambda x: x[0])
        return cands

    def dp_polish_mutation(per_nurse, dominant, mm, em, nm, rgm, rcm) -> bool:
        """挑最接近 DP 的護理師（軟罰分最低的前 dp_polish_pool 個內隨機），對其主要殘留軟違規
        路由到 TARGETED_FIX；找不到對症 fix 就退回 focused antiport。"""
        cands = _dp_candidates(per_nurse)
        if not cands:
            return False
        pool = cands[:max(1, min(len(cands), dp_polish_pool))]
        _, actor = random.choice(pool)
        contribs = per_nurse.get(actor, {})
        soft_contribs = {k: c for k, c in contribs.items()
                         if k not in HARD_PENALTY_KEYS and c > 0}
        if not soft_contribs:
            return False
        dom = max(soft_contribs.items(), key=lambda kv: W.get(kv[0], 0) * kv[1])[0]
        # 用單一 actor 的臨時 set + dominant override，重用既有 fix 函式的候選過濾
        single = {actor}
        dom_override = {actor: dom}
        fix = TARGETED_FIX.get(dom)
        if fix is not None and fix(single, dom_override, mm, em, nm, rgm, rcm):
            return True
        return antiport_focused(single, mm, em, nm, rgm, rcm)

    # —— 兩階段 TLPS：把整月罰分拆成「硬約束（禁止模式）」與「軟約束（不理想模式）」——
    # _hard_of 從 breakdown 抽出落在 HARD_PENALTY_KEYS 的罰分小計；soft = total - hard。
    def _hard_of(breakdown):
        return sum(W[k] * c for k, c in breakdown.items() if k in HARD_PENALTY_KEYS)

    current_p, current_breakdown, current_per_nurse = evaluate(m_mem, e_mem, n_mem, rg_mem, rc_mem)
    current_hard = _hard_of(current_breakdown)
    best_p = current_p
    best_hard = current_hard
    best_dp = _dp_count(current_per_nurse)
    # 初始 breakdown 必須直接帶進 best_breakdown — 若 SA 連一次嚴格改善都沒發生
    # （`current_p < best_p` 才更新），best_breakdown 會永遠是 `{}`，UI 顯示 penalty
    # 16680 但「前 3 大違規」卻空 → 「無違規」假象。
    best_breakdown = dict(current_breakdown)
    best_per_nurse = current_per_nurse
    best_m  = copy.deepcopy(m_mem)
    best_e  = copy.deepcopy(e_mem)
    best_n  = copy.deepcopy(n_mem)
    best_rg = copy.deepcopy(rg_mem)
    best_rc = copy.deepcopy(rc_mem)
    best_iter = 0

    # 兩階段狀態：current_hard 已 0 就直接進優化階段（init 就可行的罕見情形）
    phase = "optimization" if current_hard == 0 else "feasibility"
    feasibility_iter = 0 if current_hard == 0 else None

    def _save_best(p, hard, breakdown, per_nurse, it):
        """把目前膜狀態快照成 best。best_dp 同步重算，供優化階段 DP tiebreaker 用。"""
        nonlocal best_p, best_hard, best_dp, best_breakdown, best_per_nurse
        nonlocal best_m, best_e, best_n, best_rg, best_rc, best_iter
        best_p, best_hard, best_breakdown, best_per_nurse = p, hard, breakdown, per_nurse
        best_dp = _dp_count(per_nurse)
        best_m  = copy.deepcopy(m_mem)
        best_e  = copy.deepcopy(e_mem)
        best_n  = copy.deepcopy(n_mem)
        best_rg = copy.deepcopy(rg_mem)
        best_rc = copy.deepcopy(rc_mem)
        best_iter = it

    accepted_worse = 0
    rejected = 0
    # L3 stats
    focused_iters = 0
    targeted_iters = 0
    dp_polish_iters = 0
    thaw_iters = 0
    tabu_hits = 0
    stagnation_counter = 0
    classify_log = []  # 每次重新分類時記一筆 {iter, red_count, green_count}

    # 初始分類
    red_set, green_set, dominant, _ = _classify_nurses(current_per_nurse)
    classify_log.append({"iter": 0, "red": len(red_set), "green": len(green_set)})

    # In-place restore helper — 不能 rebind 變數，因為 work_mem_of 與 nurses_by_type
    # 在 init 時 capture 了 m_mem/e_mem/n_mem 的 dict 物件，rebind 會讓 mutation
    # 與 evaluate 看到不同的 dict（rollback 後 mutation 改舊 dict、evaluate 讀新
    # 的，invariant 立刻爆）。改成把 snapshot 的 list 值複製回原 dict 的 slot。
    def _restore_from_snap(snap_m, snap_e, snap_n, snap_rg, snap_rc):
        for d in range(1, num_days + 1):
            m_mem[d]  = list(snap_m[d])
            e_mem[d]  = list(snap_e[d])
            n_mem[d]  = list(snap_n[d])
            rg_mem[d] = list(snap_rg[d])
            rc_mem[d] = list(snap_rc[d])

    for i in range(max_iterations):
        snap_m  = copy.deepcopy(m_mem)
        snap_e  = copy.deepcopy(e_mem)
        snap_n  = copy.deepcopy(n_mem)
        snap_rg = copy.deepcopy(rg_mem)
        snap_rc = copy.deepcopy(rc_mem)

        # —— L3：每 reclassify_every iter 重算紅/綠燈 ——
        if focused_mode and i > 0 and i % reclassify_every == 0:
            red_set, green_set, dominant, _ = _classify_nurses(current_per_nurse)
            classify_log.append({"iter": i, "red": len(red_set), "green": len(green_set)})

        # —— L3：adaptive thaw — 若連 stagnation_thaw iter 沒進步，強制亂數攪局 ——
        force_thaw = focused_mode and stagnation_counter >= stagnation_thaw
        if force_thaw:
            thaw_iters += 1
            stagnation_counter = 0
            # 攪局用全範圍 mutation（不限紅燈、忽略 tabu）
            roll = random.random()
            if roll < 0.5:
                antiport(random.randint(1, num_days), m_mem, e_mem, n_mem, rg_mem, rc_mem)
            elif roll < 0.8:
                block_antiport(m_mem, e_mem, n_mem, rg_mem, rc_mem, block=3)
            else:
                month_swap(m_mem, e_mem, n_mem, rg_mem, rc_mem)
        elif focused_mode and (red_set or (dp_aware and phase == "optimization")):
            # Focused 模式：先給 DP-polish 一次機會（優化階段、機率 dp_polish_prob），
            # 再走原本的紅燈對症 mutation（60% targeted / 25% focused antiport / 15% block）。
            # 改 guard 為「red_set 或（優化階段+dp_aware）」：紅燈清空後仍能持續 polish 近理想者。
            focused_iters += 1
            mutated = False
            if dp_aware and phase == "optimization" and random.random() < dp_polish_prob:
                if dp_polish_mutation(current_per_nurse, dominant, m_mem, e_mem, n_mem, rg_mem, rc_mem):
                    dp_polish_iters += 1
                    mutated = True
            if not mutated and red_set:
                roll = random.random()
                if roll < 0.60:
                    mutated = targeted_mutation(red_set, dominant, m_mem, e_mem, n_mem, rg_mem, rc_mem)
                    if mutated:
                        targeted_iters += 1
                if not mutated and roll < 0.85:
                    mutated = antiport_focused(red_set, m_mem, e_mem, n_mem, rg_mem, rc_mem)
                if not mutated:
                    mutated = block_antiport_focused(red_set, m_mem, e_mem, n_mem, rg_mem, rc_mem, block=3)
            if not mutated:
                # focused 全部失敗 → 退回原始 mutation 才不會空轉
                antiport(random.randint(1, num_days), m_mem, e_mem, n_mem, rg_mem, rc_mem)
                tabu_hits += 1
        else:
            # 沒紅燈（已完美）或 focused_mode 關閉 → 原本 mutation 多樣化
            roll = random.random()
            if roll < 0.50:
                antiport(random.randint(1, num_days), m_mem, e_mem, n_mem, rg_mem, rc_mem)
            elif roll < 0.70:
                block_antiport(m_mem, e_mem, n_mem, rg_mem, rc_mem, block=3)
            elif roll < 0.85:
                block_antiport(m_mem, e_mem, n_mem, rg_mem, rc_mem, block=7)
            elif roll < 0.95:
                month_swap(m_mem, e_mem, n_mem, rg_mem, rc_mem)
            else:
                week_rotation(m_mem, e_mem, n_mem, rg_mem, rc_mem)

        new_p, new_breakdown, new_per_nurse = evaluate(m_mem, e_mem, n_mem, rg_mem, rc_mem)
        new_hard = _hard_of(new_breakdown)
        T = max(0.1, 1000 * (1 - i / max_iterations))

        if phase == "feasibility":
            # —— 可行性階段：只比硬約束罰分，目標是把所有「禁止模式」清成 0 ——
            # 軟約束此階段不參與接受判定（任它先漂移），先把法規違規逼到零。
            if new_hard <= current_hard:
                accept = True
            else:
                accept = random.random() < math.exp(-(new_hard - current_hard) / T)
                if accept:
                    accepted_worse += 1
            if accept:
                current_p, current_hard, current_per_nurse = new_p, new_hard, new_per_nurse
                if (new_hard, new_p) < (best_hard, best_p):
                    _save_best(new_p, new_hard, new_breakdown, new_per_nurse, i)
                    stagnation_counter = 0
                else:
                    stagnation_counter += 1
                if new_hard == 0:
                    # 100% 滿足硬約束 → 切換到優化階段，開始消除不理想模式
                    phase = "optimization"
                    feasibility_iter = i
            else:
                _restore_from_snap(snap_m, snap_e, snap_n, snap_rg, snap_rc)
                rejected += 1
                stagnation_counter += 1
        else:
            # —— 優化階段：硬約束已 0，任何重新引入「禁止模式」的 move 一律拒絕 ——
            # 在此前提下用標準退火最小化 total（此時 total == soft，hard 恆 0）。
            if new_hard > 0:
                _restore_from_snap(snap_m, snap_e, snap_n, snap_rg, snap_rc)
                rejected += 1
                stagnation_counter += 1
            elif new_p <= current_p:
                current_p, current_hard, current_per_nurse = new_p, new_hard, new_per_nurse
                # best 以 (hard, total, -DP) 字典序：總罰分相同時，理想模式較多者勝出 —
                # 這是讓 dp_polish 真正生效的關鍵（總罰分中性的 DP-creating move 才會被保存）。
                new_dp = _dp_count(new_per_nurse)
                if (new_hard, new_p, -new_dp) < (best_hard, best_p, -best_dp):
                    _save_best(new_p, new_hard, new_breakdown, new_per_nurse, i)
                    stagnation_counter = 0
                else:
                    stagnation_counter += 1
            elif random.random() < math.exp(-(new_p - current_p) / T):
                current_p, current_hard, current_per_nurse = new_p, new_hard, new_per_nurse
                accepted_worse += 1
                stagnation_counter += 1
            else:
                _restore_from_snap(snap_m, snap_e, snap_n, snap_rg, snap_rc)
                rejected += 1
                stagnation_counter += 1

        # 早停：已可行（hard=0）且軟罰分低於門檻
        if phase == "optimization" and current_p < OPTIMAL_THRESHOLD:
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

    # 算最終分類（給 UI 顯示哪些 nurse 收斂在綠燈）
    final_red, final_green, final_dominant, final_totals = _classify_nurses(best_per_nurse)

    # —— TLPS 三類模式分類（per-nurse pattern）——
    # Prohibited  ：含任一硬約束違規（禁止模式；優化階段若收斂應為 0）
    # Undesirable ：硬約束 0 但仍有軟約束違規（合法但折騰）
    # Desirable(DP)：硬、軟約束皆 0 — 論文竭力最大化的理想模式
    # 註：daily_demand_unmet / ratio_below_legal 是 schedule 層級、不歸屬單一 nurse，
    #     故 per-nurse 分類不含；那兩項由 best_hard（全域硬罰分）獨立反映。
    prohibited_nurses, undesirable_nurses, desirable_nurses = [], [], []
    for nid in nurses:
        contribs = best_per_nurse.get(nid, {})
        has_hard = any(c > 0 for k, c in contribs.items() if k in HARD_PENALTY_KEYS)
        has_soft = any(c > 0 for k, c in contribs.items() if k not in HARD_PENALTY_KEYS)
        if has_hard:
            prohibited_nurses.append(nid)
        elif has_soft:
            undesirable_nurses.append(nid)
        else:
            desirable_nurses.append(nid)
    best_soft = best_p - best_hard

    # solver_status：硬約束未清零 = INFEASIBLE（仍有禁止模式）；
    # 清零後依軟罰分是否低於門檻分 OPTIMAL / FEASIBLE。
    if best_hard > 0:
        solver_status = "INFEASIBLE"
    elif best_p < OPTIMAL_THRESHOLD:
        solver_status = "OPTIMAL"
    else:
        solver_status = "FEASIBLE"

    return {
        "status": "success",
        "solver_status": solver_status,
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
            # —— 兩階段 TLPS 統計 ——
            "hard_penalty": best_hard,
            "soft_penalty": best_soft,
            "feasibility_reached": feasibility_iter is not None,
            "feasibility_iteration": feasibility_iter,
            "final_phase": phase,
            # —— 三類模式計數（論文核心指標：DP 數量）——
            "desirable_pattern_count": len(desirable_nurses),
            "undesirable_pattern_count": len(undesirable_nurses),
            "prohibited_pattern_count": len(prohibited_nurses),
            "desirable_nurses": desirable_nurses,
            "undesirable_nurses": undesirable_nurses,
            "prohibited_nurses": prohibited_nurses,
            # —— L3 Focused SA 統計 ——
            "focused_mode": focused_mode,
            "focused_iterations": focused_iters,
            "targeted_iterations": targeted_iters,
            "dp_polish_iterations": dp_polish_iters,
            "thaw_iterations": thaw_iters,
            "tabu_hits": tabu_hits,
            "classify_log": classify_log,
            "final_red_nurses": sorted(final_red),
            "final_green_nurses": sorted(final_green),
            "nurse_penalties": final_totals,
            "nurse_dominant_violation": {nid: v for nid, v in final_dominant.items() if v},
            "per_nurse_breakdown": best_per_nurse,
        },
    }


# ============================================================
# Multi-start SA — 同 scenario 跑 N 次取最佳
# ============================================================
def run_sa_multistart(
    year: int,
    month: int,
    nurses: List[str],
    protected_indices: List[int] = None,
    daily_reqs: Dict[int, int] = None,
    custom_rules: List[Dict] = None,
    max_iterations: int = 10000,
    num_starts: int = 5,
    base_seed: int = None,
    weight_overrides: Dict[str, int] = None,
    focused_mode: bool = True,
    freeze_threshold: int = 500,
    reclassify_every: int = 200,
    tabu_size: int = 50,
    stagnation_thaw: int = 800,
) -> Dict:
    """
    跑 SA N 次（不同 seed），回傳最佳結果。

    SA 是隨機演算法，不同 init 可能找到差很多的局部最佳。multi-start 是最便宜
    的全域最佳化技巧：同樣 scenario 重跑 N 次，取罰分最低的那次。

    Returns 包含 stats.multistart_summary = [{attempt, seed, penalty, status}, ...]
    讓 dashboard 可以畫收斂變化。
    """
    results_summary = []
    best = None

    for i in range(num_starts):
        seed = (base_seed + i) if base_seed is not None else None
        r = run_sa(
            year=year, month=month, nurses=nurses,
            protected_indices=protected_indices,
            daily_reqs=daily_reqs, custom_rules=custom_rules,
            max_iterations=max_iterations, seed=seed,
            weight_overrides=weight_overrides,
            focused_mode=focused_mode,
            freeze_threshold=freeze_threshold,
            reclassify_every=reclassify_every,
            tabu_size=tabu_size,
            stagnation_thaw=stagnation_thaw,
        )
        results_summary.append({
            "attempt": i + 1,
            "seed": seed if seed is not None else "random",
            "penalty": r["stats"]["final_penalty"],
            "solver_status": r["solver_status"],
            "best_iteration": r["stats"]["best_iteration"],
            "elapsed_seconds": r["elapsed_seconds"],
            "top_violations": sorted(
                r["stats"]["violation_breakdown"].items(),
                key=lambda x: -x[1],
            )[:3],
        })
        if best is None or r["stats"]["final_penalty"] < best["stats"]["final_penalty"]:
            best = r

    best["stats"]["multistart_summary"] = results_summary
    best["stats"]["multistart_best_attempt"] = (
        min(range(len(results_summary)), key=lambda i: results_summary[i]["penalty"]) + 1
    )
    return best


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
