"""
護理排班 TLPS 模擬退火引擎（進階版 / L3 Focused SA）
====================================================
獨立微服務（部署於 Render / Railway / Fly.io），與 Vercel 上的 nurse-schedule
前端配合運作。架構承襲先前 CP-SAT 版本的安全骨架（auth/CORS/rate-limit/
healthcheck），演算法為「Tissue-Like P-System」+ 模擬退火 (SA)。

本檔的 run_sa() 與 local_test/scheduler.py 逐字對齊（同 seed 可對拍），差別只在
這裡多包了 FastAPI / Firebase auth / rate-limit / Pydantic 外殼。當你在 local_test
調好演算法後，把 run_sa（含 PENALTY / calculate_health_score）整段同步過來即可。

  - 5 個「細胞膜」分別代表 D/E/N/RG/RC（把休假拆成例假 RG + 休息日 RC，
    才能精準對齊勞基法 §36「兩 RG 之間 ≤ 6 工作日」這條法定要求）
  - 貪婪 rotation 初始化 + 班別專一化（每位護理師整月只排一種工作班別）
  - L3 Focused SA：紅/綠燈分類 + tabu list + 對症 mutation + adaptive thaw
  - 模擬退火接受策略：用 Boltzmann 機率跳出局部最佳
  - Penalty function 把違規（連上 >6、連大夜 >3、禁止輪班序列、保護名單 E/N、
    大夜後沒連休 2 天、RG/RC 範圍、每週節律、健康度防護網、custom_rules）轉成罰分
  - custom_rules 支援三種 action：
      UPDATE_DEMAND  改寫某日某班別的需求人數（LLM 動態調整）
      FORCE_OFF      強制某員工某日休假
      FORCE_WORK     強制某員工某日上指定班

⚠️ SA 跟 CP-SAT 的本質差異：CP-SAT 數學保證硬限制全滿足；SA 只是「盡量低罰分」，
   可能停在還有殘留違規的解。stats.final_penalty < OPTIMAL_THRESHOLD（預設 1000）
   才回報 solver_status='OPTIMAL'；否則 'FEASIBLE'，admin 須人工檢視 / 微調。
   實務上真正要過的關是前端 src/constants.js 的 checkLaborLawCompliance == 0 違規，
   SA 內部罰分含「比法律更嚴」的客製規則，所以即使合規 penalty 仍可能 > 0。

API
  POST /generate_schedule       — 主要排班入口（需 Firebase ID token）
  GET  /health                  — 健康檢查（無需 auth，給負載平衡器 / 監控用）
  GET  /                        — 服務簡介
  GET  /docs                    — Swagger UI

環境變數（部署時設定）
  FIREBASE_PROJECT_ID           — 與 Vercel 同步
  FIREBASE_CLIENT_EMAIL         — service account email
  FIREBASE_PRIVATE_KEY          — service account private key（\\n 會被自動還原）
  ALLOWED_ORIGINS               — CORS 白名單，逗號分隔
                                   預設: http://localhost:5173,
                                         https://nurse-schedule-bachelor.vercel.app
  PORT                          — uvicorn 監聽埠（Render/Railway 會自動注入）
  SA_MAX_ITERATIONS             — SA 最多迭代次數，預設 20000
"""

import os
import json
import math
import random
import copy
import calendar
import logging
from typing import List, Dict, Optional, Any, Tuple, Set
from collections import defaultdict, deque
from time import time

from fastapi import FastAPI, HTTPException, Header, Depends, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, validator
import firebase_admin
from firebase_admin import auth as fb_auth, credentials
import uvicorn

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("sa-schedule")

# ==========================================
# Firebase Admin SDK 初始化
# ==========================================
def _init_firebase():
    if firebase_admin._apps:
        return
    sa_json = os.getenv("FIREBASE_SERVICE_ACCOUNT")
    try:
        if sa_json:
            cred = credentials.Certificate(json.loads(sa_json))
        else:
            pk = os.getenv("FIREBASE_PRIVATE_KEY", "")
            # Render/Railway 等平台的環境變數會把 \n 轉成字面 "\\n"，要還原
            pk = pk.replace("\\n", "\n").strip('"')
            cred = credentials.Certificate({
                "type": "service_account",
                "project_id": os.getenv("FIREBASE_PROJECT_ID"),
                "client_email": os.getenv("FIREBASE_CLIENT_EMAIL"),
                "private_key": pk,
                # 補上其餘必要欄位（即使空字串）讓 Certificate 不會 raise
                "private_key_id": os.getenv("FIREBASE_PRIVATE_KEY_ID", ""),
                "client_id": os.getenv("FIREBASE_CLIENT_ID", ""),
                "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                "token_uri": "https://oauth2.googleapis.com/token",
            })
        firebase_admin.initialize_app(cred)
        log.info("Firebase Admin SDK 初始化成功")
    except Exception as e:
        # 不要在 import 時 raise，留到第一次 verify token 時報錯，
        # 否則健康檢查也會死掉，導致部署被誤判為不健康
        log.error(f"Firebase Admin SDK 初始化失敗：{e}")

_init_firebase()

# ==========================================
# Pydantic Models
# ==========================================
class ScheduleRequest(BaseModel):
    year: int = Field(..., ge=2020, le=2099)
    month: int = Field(..., ge=1, le=12)
    nurses: List[str] = Field(..., min_items=1, max_items=200)
    protected_indices: List[int] = Field(default_factory=list)
    daily_reqs: Dict[int, int] = Field(..., description="班別代碼 → 人數，例 {1:5, 2:4, 3:3}")
    min_daily_reqs: Optional[Dict[int, int]] = Field(
        default=None,
        description="衛福部護病比法定下限（每班最少護理師數），例 {1:9, 2:6, 3:5}；不給就不啟用第 2 層硬檢查",
    )
    custom_rules: Optional[List[Dict[str, Any]]] = Field(default_factory=list)
    max_iterations: Optional[int] = Field(default=None, ge=100, le=100000,
                                          description="SA 最大迭代次數；不給就吃環境變數 SA_MAX_ITERATIONS（預設 20000）")

    @validator("protected_indices", each_item=True)
    def _check_index_range(cls, v, values):
        nurses = values.get("nurses", [])
        if v < 0 or v >= len(nurses):
            raise ValueError(f"protected_indices 包含越界 index: {v}（員工總數 {len(nurses)}）")
        return v

    @validator("daily_reqs")
    def _check_shift_codes(cls, v):
        valid_shifts = {1, 2, 3}  # D=1, E=2, N=3
        bad = [k for k in v.keys() if k not in valid_shifts]
        if bad:
            raise ValueError(f"daily_reqs 包含未知班別代碼: {bad}（合法: 1=D, 2=E, 3=N）")
        return v


class ScheduleCell(BaseModel):
    nurse_id: str
    date: str
    shift: str  # 'D' | 'E' | 'N' | 'RG' | 'RC'


class ScheduleResponse(BaseModel):
    status: str
    solver_status: str
    elapsed_seconds: float
    schedule: List[ScheduleCell]
    stats: Dict[str, Any]


# ==========================================
# FastAPI 實例 + middleware
# ==========================================
app = FastAPI(title="護理排班 SA 最佳化引擎", version="2.0.0")

ALLOWED_ORIGINS = [
    o.strip() for o in os.getenv(
        "ALLOWED_ORIGINS",
        "http://localhost:5173,https://nurse-schedule-bachelor.vercel.app"
    ).split(",") if o.strip()
]
log.info(f"CORS 白名單: {ALLOWED_ORIGINS}")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,  # 走 Authorization Bearer，不需要 cookie
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)

# 簡易 in-memory rate limiter（per-uid 每分鐘 5 次求解）
# SA 求解很重，rate limit 比一般 API 要嚴
_rate_buckets: Dict[str, List[float]] = defaultdict(list)
RATE_LIMIT_PER_MIN = int(os.getenv("RATE_LIMIT_PER_MIN", "5"))

def _check_rate_limit(uid: str):
    now = time()
    bucket = _rate_buckets[uid]
    _rate_buckets[uid] = [t for t in bucket if now - t < 60]
    if len(_rate_buckets[uid]) >= RATE_LIMIT_PER_MIN:
        raise HTTPException(
            status_code=429,
            detail=f"求解請求過於頻繁（{RATE_LIMIT_PER_MIN}/分鐘上限）。SA 計算昂貴，請稍候。",
        )
    _rate_buckets[uid].append(now)


# ==========================================
# Auth dependency
# ==========================================
async def verify_firebase_token(authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="缺少登入憑證")
    token = authorization.split("Bearer ", 1)[1].strip()
    try:
        decoded = fb_auth.verify_id_token(token)
        return decoded
    except Exception as e:
        log.warning(f"Firebase token 驗證失敗: {e}")
        raise HTTPException(status_code=401, detail="登入憑證無效或已過期")


# ==========================================
# 健康度計算 — inlined port of PublishPanel.jsx calculateHealthScore
# （與 local_test/health.py 的 calculate_health_score 逐字對齊）
# 每位護理師起始 100 分：
#   -20  E→D / N→D / N→E（輪班間隔過短，每處）
#   -5   連續 4+ 大夜（每段 streak 一次）
#   -5   連續 6+ 上班（每段 streak 一次）
# ==========================================
_HEALTH_WORKING = {"D", "E", "N", "支援"}

def _is_work(shift: str) -> bool:
    if not shift:
        return False
    return shift in _HEALTH_WORKING or "OT" in shift

def calculate_health_score(shifts: List[str]) -> Dict:
    score = 100
    deductions = []
    for i in range(len(shifts) - 1):
        cur, nxt = shifts[i], shifts[i + 1]
        if (cur == "E" and nxt == "D") or (cur == "N" and nxt in ("D", "E")):
            score -= 20
            deductions.append(f"[-20] {cur}→{nxt} 短間隔 (day {i+1}-{i+2})")
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
        if s and _is_work(s):
            consecutive_work += 1
        else:
            if consecutive_work >= 6:
                score -= 5
                deductions.append(f"[-5] 連六疲勞 {consecutive_work} 天 (~day {i})")
            consecutive_work = 0
    return {"score": score, "deductions": deductions}


# 視為「已達成可接受最佳」的罰分上限。
# 0    = 嚴格要求完全合規。
# 1000 = 容忍極少軟限制違規。影響：早停條件 + solver_status 判定。
OPTIMAL_THRESHOLD = 1000


PENALTY = {
    # —— 原有規則 ——
    "consecutive_work_7":  2000,    # 連續上班 > 6 天（七休一）
    "consecutive_night_4": 1000,    # 連續大夜 > 3 天
    "post_night_not_off_2":2000,    # 大夜後沒連休 2 天（每違規日）
    "forbidden_n_d":       1000,    # N→D 違反 11h 輪班間隔
    "forbidden_n_e":       1000,    # N→E
    "forbidden_e_d":       1000,    # E→D
    "isolated_off":           0,    # （已棄用，由 isolated_off_n / isolated_off_de 取代）
    # —— 班別敏感的孤立休假懲罰 ——
    "isolated_off_n":       100,    # 至少一側是 N → 重罰
    "isolated_off_de":       10,    # 兩側都是 D 或 E → 輕罰
    "consecutive_rest_after_work": 20,  # 工作班後接 2+ 連休
    "protected_on_en":   500000,    # 保護名單上 E/N（接近天譴）
    "custom_rule_violation": 1000000,  # FORCE_OFF / FORCE_WORK 違反

    # —— 對齊 JS 端 checkLaborLawCompliance ——
    "weekly_hours_over_40":  800,   # 每週 > 40h
    "monthly_hours_over_222":1200,  # 月總工時 > 176 + 46
    "insufficient_rg":      1500,   # 月 RG < 4 天
    "insufficient_off":        0,   # 已棄用
    "total_rest_below_8":   1500,   # RG+RC < 8
    "total_rest_above_9":   1500,   # RG+RC > 11（變數名沿用早期）
    "rg_interval_over_6":   1000,   # 兩 RG 之間 > 6 工作日

    # —— 健康度移植 ——
    "health_deficit_per_point": 5,  # 每位員工 (100 - 健康分數) × 5
    "health_floor_breach":  50000,  # 個人健康 < 70（deficit > 30）

    # —— 客製化規則（比勞基法嚴）——
    "excess_rg":            1500,   # RG > 5
    "insufficient_rc":      1500,   # RC < 4
    "excess_rc":            1500,   # RC > 5
    "mixed_work_shifts":    5000,   # 整月只能一種工作班別

    # —— 每週節律 ——
    "week_missing_rg":      1000,
    "week_missing_rc":      1000,

    # —— 每人月工作天數嚴格範圍 ——
    "work_days_below_22":   1200,   # work < num_days - 9
    "work_days_above_23":   1200,   # work > num_days - 8

    # —— streak / OT ——
    "consecutive_work_pair": 10,    # streak 第 4 天起每天 +10
    "overtime_6th_day_pay":  500,   # 連 6 天起算 OT

    # —— 每日各班別人數需在 [req_min, req_max] ——
    "daily_demand_unmet":   3000,
    "daily_demand_exceeded":1500,

    # —— 衛福部三班護病比法定下限（硬底線，防禦深度第 2 層）——
    # min_daily_reqs 由前端依床數 + 醫院等級算出（src/constants.js legalDailyFloor）。
    # 即使 daily_reqs 被誤設成低於法定護病比，這條也會把不合規班表罰到極高。
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
# HARD_PENALTY_KEYS 精準對齊前端 src/constants.js checkLaborLawCompliance 會抓的
# 法定違規 + 三項營運硬底線（覆蓋、護病比、admin 強制）。不在此集合者一律視為軟
# 約束（比勞基法更嚴的客製規則 + 個人偏好）。
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


# ============================================================
# 「理想模式」(Desirable Pattern) 的判定：法遵 + 健康 = 理想
# ============================================================
# 實測「完全零違規」在現行 15 條軟規則下幾乎不可能達成（人多→軟性配額爆、人少→
# 硬性過勞爆），故採分級定義（最貼近論文「desirable=好班，不是完美班」）：
#   理想 (DP)    = 0 硬違規（法遵）+ 0 下列「健康/疲勞關鍵」軟違規
#   不理想       = 0 硬違規，但仍有健康/疲勞關鍵軟違規
#   禁止         = 有任一硬違規
# 其餘比勞基法更嚴的客製配額 / 節律 / 美觀偏好（work_days·RG·RC 範圍、週節律、
# 孤立 D/E 休假、休假叢集、OT 成本…）視為可容忍，不影響分級也不擋 DP。
# 注意：SA 的最佳化目標仍是「完整軟罰分 total」；HEALTH_CRITICAL 只用於 DP 分級
# 與 dp_polish 的定向修復，兩者互補（高權重的健康關鍵本來就會被 total 優先壓低）。
HEALTH_CRITICAL_SOFT_KEYS = frozenset({
    "consecutive_night_4",       # 連續大夜 > 3：晝夜節律疲勞
    "post_night_not_off_2",      # 大夜後未連休 2 天：生理時鐘恢復不足
    "consecutive_work_pair",     # 連續工作 ≥ 4 天：累積疲勞
    "overtime_6th_day_pay",      # 連 6 天起算 OT：過勞風險
    "isolated_off_n",            # 大夜相鄰的孤立休假：恢復不足
    "health_floor_breach",       # 個人健康分數 < 70（接近天譴）
    "health_deficit_per_point",  # 健康分數任何扣分（短間隔 / 連大夜 / 連六）
})


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
    tabu_size: int = 50,              # tabu list 長度
    stagnation_thaw: int = 800,       # 連續 N iter 沒進步 → 強制亂數攪局
    # —— DP-aware polish 參數（最大化理想模式數量）——
    dp_aware: bool = True,            # 優化階段啟用「把近理想護理師推成 DP」的對症 mutation
    dp_polish_prob: float = 0.35,     # focused 分支內、優化階段嘗試 dp_polish 的機率
    dp_polish_pool: int = 5,          # 從健康關鍵罰分最低的前 N 位近理想護理師隨機挑一位
) -> Dict:
    """執行 TLPS 模擬退火排班（L3 Focused SA）。回傳格式見檔頭。

    Raises:
      ValueError: 人力顯然不足或保護名單過多（呼叫端應轉成 HTTP 400）。
    """
    if seed is not None:
        random.seed(seed)

    protected_indices = protected_indices or []
    daily_reqs = daily_reqs or {}
    custom_rules = custom_rules or []

    weight_overrides = weight_overrides or {}
    W = {**PENALTY, **weight_overrides}

    protected = set(protected_indices)

    def _req(code: int) -> int:
        return int(daily_reqs.get(code, daily_reqs.get(str(code), 0)))

    req_D, req_E, req_N = _req(1), _req(2), _req(3)
    daily_demand = req_D + req_E + req_N

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

    def _calendar_weeks():
        weeks = []
        day1_wd = calendar.weekday(year, month, 1)  # 0=Mon, 6=Sun
        current = 1 - day1_wd
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
    m_mem  = {d: [] for d in range(1, num_days + 1)}
    e_mem  = {d: [] for d in range(1, num_days + 1)}
    n_mem  = {d: [] for d in range(1, num_days + 1)}
    rg_mem = {d: [] for d in range(1, num_days + 1)}
    rc_mem = {d: [] for d in range(1, num_days + 1)}

    # —— 班別專一化：預先把每位護理師指派到一種工作班別 ——
    non_prot_list = [nid for nid in nurses if nid not in protected_ids]
    random.shuffle(non_prot_list)
    total_demand = max(1, req_D + req_E + req_N)
    target_d = max(req_D, round(num_nurses * req_D / total_demand))
    target_e = max(req_E, round(num_nurses * req_E / total_demand))
    target_n = max(req_N, round(num_nurses * req_N / total_demand))
    while target_d + target_e + target_n > num_nurses:
        if target_d >= max(target_e, target_n) and target_d > req_D: target_d -= 1
        elif target_e >= target_n and target_e > req_E: target_e -= 1
        elif target_n > req_N: target_n -= 1
        else: break
    while target_d + target_e + target_n < num_nurses:
        target_d += 1

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

    nurse_home_type: Dict[str, str] = {}
    for nid in d_pool: nurse_home_type[nid] = "D"
    for nid in e_pool: nurse_home_type[nid] = "E"
    for nid in n_pool: nurse_home_type[nid] = "N"
    nurses_by_type = {
        "D": list(d_pool),
        "E": list(e_pool),
        "N": list(n_pool),
    }

    # —— 貪婪 rotation init ——
    def _rotation_init(pool: List[str], daily_req: int):
        P = len(pool)
        R = daily_req
        result = {d: {"work": [], "rg": [], "rc": []} for d in range(1, num_days + 1)}
        if P == 0:
            return result
        if R >= P:
            for d in range(1, num_days + 1):
                result[d]["work"] = list(pool)
            return result

        work_count = {nid: 0 for nid in pool}
        rest_count = {nid: 0 for nid in pool}
        tiebreak_offset = 0

        for d in range(1, num_days + 1):
            ranked = sorted(
                enumerate(pool),
                key=lambda x: (work_count[x[1]], (x[0] + tiebreak_offset) % P),
            )
            for rank, (i, nid) in enumerate(ranked):
                if rank < R:
                    result[d]["work"].append(nid)
                    work_count[nid] += 1
                else:
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
        rg_mem[d] = list(d_rot[d]["rg"]) + list(e_rot[d]["rg"]) + list(n_rot[d]["rg"])
        rc_mem[d] = list(d_rot[d]["rc"]) + list(e_rot[d]["rc"]) + list(n_rot[d]["rc"])

    # —— 解析 custom_rules + per-day 需求對照表 ——
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
        total = 0
        breakdown = defaultdict(int)
        per_nurse: Dict[str, Dict[str, int]] = {nid: defaultdict(int) for nid in nurses}
        REST = {"RG", "RC"}
        WORK = {"D", "E", "N"}

        def _add(nid, key, count=1):
            nonlocal total
            total += W[key] * count
            breakdown[key] += count
            per_nurse[nid][key] += count

        for nid in nurses:
            sched = get_sched(nid, mm, em, nm, rgm, rcm)
            c_work = 0
            c_night = 0
            days_since_rg = 0

            for d in range(num_days):
                shift = sched[d]
                if shift in WORK:
                    c_work += 1
                    c_night = c_night + 1 if shift == "N" else 0
                    days_since_rg += 1
                elif shift == "RG":
                    c_work, c_night = 0, 0
                    days_since_rg = 0
                else:  # RC
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
                    days_since_rg = 0

            for d in range(num_days - 1):
                if sched[d] == "N" and sched[d + 1] == "D":
                    _add(nid, "forbidden_n_d")
                if sched[d] == "N" and sched[d + 1] == "E":
                    _add(nid, "forbidden_n_e")
                if sched[d] == "E" and sched[d + 1] == "D":
                    _add(nid, "forbidden_e_d")

            for d in range(num_days - 1):
                if sched[d] == "N" and sched[d + 1] != "N":
                    if sched[d + 1] not in REST:
                        _add(nid, "post_night_not_off_2")
                    if d + 2 < num_days and sched[d + 2] not in REST:
                        _add(nid, "post_night_not_off_2")

            for d in range(1, num_days - 1):
                if sched[d - 1] in WORK and sched[d] in REST and sched[d + 1] in WORK:
                    if sched[d - 1] == "N" or sched[d + 1] == "N":
                        _add(nid, "isolated_off_n")
                    else:
                        _add(nid, "isolated_off_de")

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

            total_work_days = sum(1 for s in sched if s in WORK)
            total_work_h = total_work_days * 8
            if total_work_h > 222:
                _add(nid, "monthly_hours_over_222")
            if total_work_days < num_days - 11:
                _add(nid, "work_days_below_22")
            if total_work_days > num_days - 7:
                _add(nid, "work_days_above_23")

            rg_count = sum(1 for s in sched if s == "RG")
            rc_count = sum(1 for s in sched if s == "RC")
            if rg_count < 4:  _add(nid, "insufficient_rg")
            if rg_count > 5:  _add(nid, "excess_rg")
            if rc_count < 4:  _add(nid, "insufficient_rc")
            if rc_count > 5:  _add(nid, "excess_rc")
            total_rest = rg_count + rc_count
            if total_rest < 8:  _add(nid, "total_rest_below_8")
            if total_rest > 11: _add(nid, "total_rest_above_9")

            work_types_used = set(s for s in sched if s in WORK)
            if len(work_types_used) > 1:
                _add(nid, "mixed_work_shifts")

        # —— 每日各班別人數需 ∈ [req_min, req_max] ——
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

        # FORCE_OFF / FORCE_WORK
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
        if num_days < 7:
            return
        nid = random.choice(nurses)
        home = nurse_home_type[nid]
        work_mem = work_mem_of[home]
        candidates = (work_mem, rgm, rcm)
        week_start = random.randint(1, num_days - 6)
        days = list(range(week_start, week_start + 7))

        nid_locations = []
        for d in days:
            m = next((mem for mem in candidates if nid in mem[d]), None)
            if m is None:
                return
            nid_locations.append(m)

        rotated = [nid_locations[-1]] + nid_locations[:-1]
        if rotated == nid_locations:
            return

        for d, (old_m, new_m) in zip(days, zip(nid_locations, rotated)):
            if old_m is new_m:
                continue
            old_m[d].remove(nid)
            new_m[d].append(nid)

    # ==========================================
    # L3 Focused SA：分類器 + tabu + 對症 mutation
    # ==========================================
    tabu: deque = deque(maxlen=tabu_size)

    def _tabu_key(n1: str, n2: str, day: int) -> Tuple:
        a, b = sorted([n1, n2])
        return (a, b, day)

    def _classify_nurses(per_nurse: Dict[str, Dict[str, int]]):
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
        if _tabu_key(n1, n2, day) in tabu:
            return False
        home = nurse_home_type.get(n1)
        if home != nurse_home_type.get(n2):
            return False
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
    # L2 對症 mutation
    # ==========================================
    def fix_excess_rg(red_set, dominant, mm, em, nm, rgm, rcm) -> bool:
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
            rest_mem = rcm if rest_mem is rgm else rgm
            partners = [n for n in nurses_by_type[home] if n != actor and n in rest_mem[day]]
        if not partners:
            return False
        partner = random.choice(partners)
        return _swap_two(actor, partner, day, mm, em, nm, rgm, rcm)

    def fix_consecutive_work(red_set, dominant, mm, em, nm, rgm, rcm) -> bool:
        targets = ("consecutive_work_7", "consecutive_work_pair", "overtime_6th_day_pay", "consecutive_night_4")
        cands = [n for n in red_set if dominant.get(n) in targets]
        if not cands:
            return False
        actor = random.choice(cands)
        home = nurse_home_type[actor]
        work_mem = work_mem_of[home]
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
        day = mid + 1
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
        adj_day_idx = random.choice((iso_d - 1, iso_d + 1))
        day = adj_day_idx + 1
        if day < 1 or day > num_days:
            return False
        rest_mem = rgm if sched[iso_d] == "RG" else rcm
        partners = [n for n in nurses_by_type[home] if n != actor and n in rest_mem[day]]
        if not partners:
            return False
        partner = random.choice(partners)
        return _swap_two(actor, partner, day, mm, em, nm, rgm, rcm)

    def fix_consecutive_rest(red_set, dominant, mm, em, nm, rgm, rcm) -> bool:
        """主角有「工-休-休」連續休假叢集 → 把第 2 個休假日換成工作（與工作中 partner swap），打散叢集。"""
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
        day = base + 3
        if day > num_days:
            return False
        rest_mem = rgm if sched[base + 2] == "RG" else rcm
        partners = [n for n in nurses_by_type[home] if n != actor and n in work_mem[day]]
        if not partners:
            return False
        partner = random.choice(partners)
        return _swap_two(actor, partner, day, mm, em, nm, rgm, rcm)

    TARGETED_FIX = {
        "excess_rg":             fix_excess_rg,
        "excess_rc":             fix_excess_rc,
        "total_rest_above_9":    fix_excess_rg,
        "work_days_above_23":    fix_insufficient_rest,
        "insufficient_rg":       fix_insufficient_rest,
        "insufficient_rc":       fix_insufficient_rest,
        "total_rest_below_8":    fix_insufficient_rest,
        "work_days_below_22":    fix_excess_rg,
        "consecutive_work_7":    fix_consecutive_work,
        "consecutive_work_pair": fix_consecutive_work,
        "consecutive_night_4":   fix_consecutive_work,
        "overtime_6th_day_pay":  fix_consecutive_work,
        "isolated_off_n":        fix_isolated_off,
        "isolated_off_de":       fix_isolated_off,
        "consecutive_rest_after_work": fix_consecutive_rest,
    }

    def targeted_mutation(red_set, dominant, mm, em, nm, rgm, rcm) -> bool:
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
    # 紅/綠燈以個人總罰分分界，軟罰分低的「近理想」護理師被凍結成綠燈，紅燈對症 mutation
    # 永遠碰不到。dp_polish 反向操作：專挑無硬違規、僅剩健康/疲勞關鍵軟違規的護理師，
    # 對其主要健康關鍵違規施以對症修復，目標直接拉高 desirable_pattern_count。
    def _dp_count(per_nurse) -> int:
        """理想模式 (DP) 數量 = 法遵 + 健康：無硬違規且無健康/疲勞關鍵軟違規的護理師數。"""
        n = 0
        for nid in nurses:
            contribs = per_nurse.get(nid, {})
            if any(c > 0 for k, c in contribs.items() if k in HARD_PENALTY_KEYS):
                continue
            if any(c > 0 for k, c in contribs.items() if k in HEALTH_CRITICAL_SOFT_KEYS):
                continue
            n += 1
        return n

    def _dp_candidates(per_nurse):
        """近理想護理師：無硬違規，但仍有『健康/疲勞關鍵』軟違規。依健康關鍵罰分升冪。"""
        cands = []
        for nid in nurses:
            contribs = per_nurse.get(nid, {})
            if any(c > 0 for k, c in contribs.items() if k in HARD_PENALTY_KEYS):
                continue
            hc = sum(W[k] * c for k, c in contribs.items() if k in HEALTH_CRITICAL_SOFT_KEYS)
            if hc > 0:
                cands.append((hc, nid))
        cands.sort(key=lambda x: x[0])
        return cands

    def dp_polish_mutation(per_nurse, dominant, mm, em, nm, rgm, rcm) -> bool:
        """挑最接近 DP 的護理師（健康關鍵罰分最低的前 dp_polish_pool 個內隨機），針對其主要
        殘留『健康/疲勞關鍵』軟違規路由到 TARGETED_FIX；找不到對症 fix 就退回 focused antiport。"""
        cands = _dp_candidates(per_nurse)
        if not cands:
            return False
        pool = cands[:max(1, min(len(cands), dp_polish_pool))]
        _, actor = random.choice(pool)
        contribs = per_nurse.get(actor, {})
        hc_contribs = {k: c for k, c in contribs.items()
                       if k in HEALTH_CRITICAL_SOFT_KEYS and c > 0}
        if not hc_contribs:
            return False
        dom = max(hc_contribs.items(), key=lambda kv: W.get(kv[0], 0) * kv[1])[0]
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
    focused_iters = 0
    targeted_iters = 0
    dp_polish_iters = 0
    thaw_iters = 0
    tabu_hits = 0
    stagnation_counter = 0
    classify_log = []

    red_set, green_set, dominant, _ = _classify_nurses(current_per_nurse)
    classify_log.append({"iter": 0, "red": len(red_set), "green": len(green_set)})

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

        if focused_mode and i > 0 and i % reclassify_every == 0:
            red_set, green_set, dominant, _ = _classify_nurses(current_per_nurse)
            classify_log.append({"iter": i, "red": len(red_set), "green": len(green_set)})

        force_thaw = focused_mode and stagnation_counter >= stagnation_thaw
        if force_thaw:
            thaw_iters += 1
            stagnation_counter = 0
            roll = random.random()
            if roll < 0.5:
                antiport(random.randint(1, num_days), m_mem, e_mem, n_mem, rg_mem, rc_mem)
            elif roll < 0.8:
                block_antiport(m_mem, e_mem, n_mem, rg_mem, rc_mem, block=3)
            else:
                month_swap(m_mem, e_mem, n_mem, rg_mem, rc_mem)
        elif focused_mode and (red_set or (dp_aware and phase == "optimization")):
            # 先給 DP-polish 一次機會（優化階段、機率 dp_polish_prob），再走原本紅燈對症 mutation。
            # guard 改「red_set 或（優化階段+dp_aware）」：紅燈清空後仍能持續 polish 近理想者。
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
                antiport(random.randint(1, num_days), m_mem, e_mem, n_mem, rg_mem, rc_mem)
                tabu_hits += 1
        else:
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

    final_red, final_green, final_dominant, final_totals = _classify_nurses(best_per_nurse)

    # —— TLPS 三類模式分類（per-nurse pattern）：法遵 + 健康 = 理想 ——
    # Prohibited  ：含任一硬約束違規（禁止模式；優化階段若收斂應為 0）
    # Undesirable ：硬約束 0，但仍有健康/疲勞關鍵軟違規（合法但傷身）
    # Desirable(DP)：硬約束 0 且健康/疲勞關鍵軟違規 0 — 論文竭力最大化的理想模式
    #               （客製配額 / 節律 / 美觀偏好可殘留，不影響此分級）
    # 註：daily_demand_unmet / ratio_below_legal 是 schedule 層級、不歸屬單一 nurse，
    #     故 per-nurse 分類不含；那兩項由 best_hard（全域硬罰分）獨立反映。
    prohibited_nurses, undesirable_nurses, desirable_nurses = [], [], []
    for nid in nurses:
        contribs = best_per_nurse.get(nid, {})
        has_hard = any(c > 0 for k, c in contribs.items() if k in HARD_PENALTY_KEYS)
        has_health_critical = any(c > 0 for k, c in contribs.items() if k in HEALTH_CRITICAL_SOFT_KEYS)
        if has_hard:
            prohibited_nurses.append(nid)
        elif has_health_critical:
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


# ==========================================
# Endpoints
# ==========================================
@app.get("/")
def root():
    """根路徑提示 — 避免 admin 用瀏覽器打開時看到「Not Found」誤以為服務掛掉。"""
    return {
        "service": "nurse-schedule SA 排班引擎",
        "version": "2.0.0",
        "algorithm": "TLPS + Simulated Annealing (L3 Focused SA)",
        "endpoints": {
            "GET /health": "健康檢查（無需 auth）",
            "POST /generate_schedule": "排班求解（需 Firebase Bearer token）",
            "GET /docs": "互動式 API 文件 (Swagger UI)",
            "GET /redoc": "API 文件 (ReDoc)",
        },
        "frontend": "https://nurse-schedule-bachelor.vercel.app",
    }


@app.get("/health")
def health():
    """負載平衡 / 監控用，不需 auth。回傳基本診斷資訊。"""
    return {
        "ok": True,
        "service": "sa-schedule",
        "version": "2.0.0",
        "firebase_ready": bool(firebase_admin._apps),
        "cors_origins": ALLOWED_ORIGINS,
    }


@app.post("/generate_schedule", response_model=ScheduleResponse)
def generate_schedule(req: ScheduleRequest, user: Dict = Depends(verify_firebase_token)):
    """主要排班入口（TLPS L3 Focused 模擬退火）。"""
    _check_rate_limit(user.get("uid", "anonymous"))

    max_iter = req.max_iterations or int(os.getenv("SA_MAX_ITERATIONS", "20000"))
    # daily_reqs key 在 pydantic v1 進來已是 int；保險再轉一次
    daily_reqs = {int(k): int(v) for k, v in req.daily_reqs.items()}
    min_daily_reqs = {int(k): int(v) for k, v in (req.min_daily_reqs or {}).items()} or None

    log.info(
        f"求解 {req.year}/{req.month} | {len(req.nurses)} 名 | 保護 {len(req.protected_indices)} | "
        f"D{daily_reqs.get(1,0)}/E{daily_reqs.get(2,0)}/N{daily_reqs.get(3,0)} | "
        f"rules {len(req.custom_rules or [])} | max_iter {max_iter}"
    )

    try:
        result = run_sa(
            year=req.year,
            month=req.month,
            nurses=req.nurses,
            protected_indices=req.protected_indices,
            daily_reqs=daily_reqs,
            min_daily_reqs=min_daily_reqs,
            custom_rules=req.custom_rules or [],
            max_iterations=max_iter,
        )
    except ValueError as e:
        # 人力不足 / 保護名單過多 → 條件無法滿足，回 400 讓前端顯示原因
        raise HTTPException(status_code=400, detail=str(e))

    stats = result["stats"]
    if stats["final_penalty"] >= OPTIMAL_THRESHOLD:
        log.warning(
            f"SA 收斂未達門檻：best_penalty={stats['final_penalty']} "
            f"@ iter {stats['best_iteration']} | breakdown={stats['violation_breakdown']}"
        )
    else:
        log.info(
            f"SA 收斂達標：best_penalty={stats['final_penalty']} "
            f"@ iter {stats['best_iteration']} | 耗時 {result['elapsed_seconds']}s"
        )

    return result


@app.exception_handler(Exception)
async def _global_exception_handler(request: Request, exc: Exception):
    log.exception(f"未預期錯誤: {exc}")
    return JSONResponse(status_code=500, content={"detail": f"伺服器內部錯誤：{type(exc).__name__}"})


if __name__ == "__main__":
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run("main1:app", host="0.0.0.0", port=port, reload=True)
