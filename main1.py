"""
護理排班 TLPS 模擬退火引擎
============================
獨立微服務（部署於 Render / Railway / Fly.io），與 Vercel 上的 nurse-schedule
前端配合運作。架構承襲先前 CP-SAT 版本的安全骨架（auth/CORS/rate-limit/
healthcheck），演算法換成「Tissue-Like P-System」+ 模擬退火 (SA)：

  - 4 個「細胞膜」分別代表 D/E/N/OFF 四種班別
  - 隨機初始化，保證每日 D/E/N 人數正好符合 daily_reqs
  - 透過跨膜 antiport 交換 + 區塊交換進行 mutation
  - 模擬退火接受策略：用 Boltzmann 機率跳出局部最佳
  - Penalty function 把違規行為（連上 >6、連大夜 >3、禁止輪班序列、
    保護名單上 E/N、大夜後沒連休 2 天、月休 <8、月工作 >27、
    個人健康扣分 >30 防護網、custom_rules）轉成數字罰分
  - custom_rules 支援三種 action：
      UPDATE_DEMAND  改寫某日某班別的需求人數（LLM 動態調整）
      FORCE_OFF      強制某員工某日休假
      FORCE_WORK     強制某員工某日上指定班

⚠️ SA 跟 CP-SAT 的本質差異：CP-SAT 數學保證硬限制全滿足；SA 只是「盡量低
   罰分」，可能停在還有違規的解（penalty > 0 但已是 20000 次迭代內最佳）。
   返回的 stats.final_penalty == 0 才代表完全合規；> 0 表示有殘留違規，
   admin 必須人工檢視 / 微調。

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
from typing import List, Dict, Optional, Any
from collections import defaultdict
from time import time

from fastapi import FastAPI, HTTPException, Header, Depends, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, validator
import firebase_admin
from firebase_admin import auth as fb_auth, credentials
import uvicorn

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("cpsat-schedule")

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
    shift: str  # 'O' | 'D' | 'E' | 'N'


class ScheduleResponse(BaseModel):
    status: str
    solver_status: str
    elapsed_seconds: float
    schedule: List[ScheduleCell]
    stats: Dict[str, Any]


# ==========================================
# FastAPI 實例 + middleware
# ==========================================
app = FastAPI(title="護理排班 CP-SAT 最佳化引擎", version="1.0.0")

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
# CP-SAT 求解很重，rate limit 比一般 API 要嚴
_rate_buckets: Dict[str, List[float]] = defaultdict(list)
RATE_LIMIT_PER_MIN = int(os.getenv("RATE_LIMIT_PER_MIN", "5"))

def _check_rate_limit(uid: str):
    now = time()
    bucket = _rate_buckets[uid]
    _rate_buckets[uid] = [t for t in bucket if now - t < 60]
    if len(_rate_buckets[uid]) >= RATE_LIMIT_PER_MIN:
        raise HTTPException(
            status_code=429,
            detail=f"求解請求過於頻繁（{RATE_LIMIT_PER_MIN}/分鐘上限）。CP-SAT 計算昂貴，請稍候。",
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
# Endpoints
# ==========================================
@app.get("/")
def root():
    """根路徑提示 — 避免 admin 用瀏覽器打開時看到「Not Found」誤以為服務掛掉。"""
    return {
        "service": "nurse-schedule CP-SAT 排班引擎",
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
        "service": "cpsat-schedule",
        "version": "1.0.0",
        "firebase_ready": bool(firebase_admin._apps),
        "cors_origins": ALLOWED_ORIGINS,
    }


@app.post("/generate_schedule", response_model=ScheduleResponse)
def generate_schedule(req: ScheduleRequest, user: Dict = Depends(verify_firebase_token)):
    """主要排班入口（TLPS 模擬退火）。"""
    _check_rate_limit(user.get("uid", "anonymous"))
    t_start = time()

    year, month = req.year, req.month
    _, num_days = calendar.monthrange(year, month)
    num_nurses = len(req.nurses)
    protected = set(req.protected_indices)
    nurses = req.nurses
    protected_ids = {nurses[i] for i in protected}
    non_protected = num_nurses - len(protected)

    # daily_reqs 進來時 key 可能是 int 也可能是 str（pydantic v1 / v2 行為差異）
    def _req(code: int) -> int:
        return int(req.daily_reqs.get(code, req.daily_reqs.get(str(code), 0)))
    req_D, req_E, req_N = _req(1), _req(2), _req(3)

    # ==========================================
    # 解析 custom_rules — 三種 action：
    #   UPDATE_DEMAND  改寫某日某班別需求（前端 / LLM 動態調整）
    #   FORCE_OFF      強制某員工某日休假
    #   FORCE_WORK     強制某員工某日上指定班
    # 每日 target_reqs 以 daily_reqs 為基準、由 UPDATE_DEMAND 覆寫；
    # 之後的初始化、pre-flight、antiport 全部以這份「每日」需求為準
    # （antiport 在同日內換人，會自動保持每日配額）。
    # ==========================================
    target_reqs: Dict[int, Dict[str, int]] = {
        d: {"D": req_D, "E": req_E, "N": req_N} for d in range(1, num_days + 1)
    }
    SHIFT_INT_TO_LETTER = {1: "D", 2: "E", 3: "N"}
    force_off: List[tuple] = []   # (nurse_id, day)
    force_work: List[tuple] = []  # (nurse_id, day, shift_letter)

    for rule in req.custom_rules or []:
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
                target_reqs[d][sh] = int(new_val)
            continue
        nid = rule.get("nurse_id")
        if action == "FORCE_OFF" and nid in nurses:
            force_off.append((nid, d))
        elif action == "FORCE_WORK" and nid in nurses:
            sh = rule.get("shift")
            if sh in ("D", "E", "N"):
                force_work.append((nid, d, sh))

    max_daily = max(sum(v.values()) for v in target_reqs.values())
    log.info(
        f"求解 {year}/{month} ({num_days}天) | {num_nurses} 名 | 保護 {len(protected)} | "
        f"基準 D{req_D}/E{req_E}/N{req_N} | rules {len(req.custom_rules or [])} "
        f"(UPDATE_DEMAND 後 max-daily-total={max_daily})"
    )

    # —— Pre-flight：每一日都要可行，否則跑 20000 次白工 ——
    for d in range(1, num_days + 1):
        rD = target_reqs[d]["D"]
        rE = target_reqs[d]["E"]
        rN = target_reqs[d]["N"]
        if rD + rE + rN > num_nurses:
            raise HTTPException(
                status_code=400,
                detail=f"第 {d} 日總需求 {rD + rE + rN}（D{rD}+E{rE}+N{rN}）> 員工數 {num_nurses}",
            )
        if rE + rN > non_protected:
            raise HTTPException(
                status_code=400,
                detail=f"第 {d} 日 E+N 需求 {rE + rN} > 可排夜班人數 {non_protected}"
                       f"（扣除保護名單 {len(protected)} 人）",
            )

    # ==========================================
    # 初始化四個細胞膜（D/E/N/OFF）— 依每日 target_reqs 配額
    # ==========================================
    m_mem = {d: [] for d in range(1, num_days + 1)}
    e_mem = {d: [] for d in range(1, num_days + 1)}
    n_mem = {d: [] for d in range(1, num_days + 1)}
    o_mem = {d: [] for d in range(1, num_days + 1)}

    for d in range(1, num_days + 1):
        rD = target_reqs[d]["D"]
        rE = target_reqs[d]["E"]
        rN = target_reqs[d]["N"]
        # 先把非保護的丟進候選池排 E/N，剩下的再給 D，最後 O
        non_prot = [nid for nid in nurses if nid not in protected_ids]
        prot = list(protected_ids)
        random.shuffle(non_prot)
        random.shuffle(prot)

        for _ in range(rE): e_mem[d].append(non_prot.pop())
        for _ in range(rN): n_mem[d].append(non_prot.pop())
        # D 可以任意人排
        pool_for_d = non_prot + prot
        random.shuffle(pool_for_d)
        for _ in range(rD): m_mem[d].append(pool_for_d.pop())
        o_mem[d].extend(pool_for_d)

    # ==========================================
    # 輔助：取單一護理師的整月班別字串
    # ==========================================
    def get_sched(nid: str, mm, em, nm) -> List[str]:
        sched = []
        for d in range(1, num_days + 1):
            if nid in mm[d]:   sched.append("D")
            elif nid in em[d]: sched.append("E")
            elif nid in nm[d]: sched.append("N")
            else:              sched.append("O")
        return sched

    # ==========================================
    # 適應度（罰分越低越好）
    # ==========================================
    PENALTY = {
        "consecutive_work_7":      2000,   # 連續上班 > 6 天（七休一）
        "consecutive_night_4":     1000,   # 連續大夜 > 3 天
        "forbidden_n_d":           1000,   # N→D 違反 11h 輪班間隔
        "forbidden_n_e":           1000,   # N→E
        "forbidden_e_d":           1000,   # E→D
        "isolated_off":              50,   # 孤立休假（軟限制）
        "protected_on_en":       500000,   # 保護名單上 E/N（接近天譴）
        "custom_rule_violation":1000000,   # FORCE_OFF / FORCE_WORK 違反
        # ↓ 對應 main.py 最新模型的硬限制（SA 以重罰實現）
        "post_night_not_off_2":    2000,   # 大夜後沒連休 2 天（每違規日 +2000）
        "monthly_off_below_8":      500,   # 月休 < 8（per missing day）
        "monthly_work_above_27":    500,   # 月工作 > 27（per excess day）
        "health_cap_exceeded":   500000,   # 個人健康扣分 > 30（防護網）
    }

    # 健康扣分（對應 main.py「連 4 大夜 -5」「連 6 上班 -5」+「個人扣分 ≤ 30 防護網」）
    HEALTH_DEBIT_PER_NIGHT_WINDOW = 5
    HEALTH_DEBIT_PER_WORK_WINDOW  = 5
    HEALTH_CAP_PER_NURSE          = 30

    def evaluate(mm, em, nm) -> tuple:
        """回傳 (total_penalty, violation_breakdown)。
        sched_cache 只算一次（取代原本兩次的 get_sched），新增規則均在此一輪掃完。"""
        total = 0
        breakdown = defaultdict(int)
        sched_cache = {nid: get_sched(nid, mm, em, nm) for nid in nurses}

        for nid in nurses:
            sched = sched_cache[nid]
            c_work = 0
            c_night = 0
            work_days = 0
            off_days = 0
            health_debit = 0

            # —— 1. 每日掃描：連續上班 / 連大夜 / 保護名單 / 月休工作天累計 ——
            for d in range(num_days):
                if sched[d] != "O":
                    c_work += 1
                    work_days += 1
                    c_night = c_night + 1 if sched[d] == "N" else 0
                else:
                    c_work, c_night = 0, 0
                    off_days += 1

                if c_work > 6:
                    total += PENALTY["consecutive_work_7"]
                    breakdown["consecutive_work_7"] += 1
                if c_night > 3:
                    total += PENALTY["consecutive_night_4"]
                    breakdown["consecutive_night_4"] += 1
                if nid in protected_ids and sched[d] in ("E", "N"):
                    total += PENALTY["protected_on_en"]
                    breakdown["protected_on_en"] += 1

            # —— 2. 月休 ≥ 8、月工作 ≤ 27（main.py 的四週彈性工時整月剎車）——
            if off_days < 8:
                miss = 8 - off_days
                total += PENALTY["monthly_off_below_8"] * miss
                breakdown["monthly_off_below_8"] += miss
            if work_days > 27:
                excess = work_days - 27
                total += PENALTY["monthly_work_above_27"] * excess
                breakdown["monthly_work_above_27"] += excess

            # —— 3. 11h 輪班間隔（N→D / N→E / E→D 全禁）——
            for d in range(num_days - 1):
                if sched[d] == "N" and sched[d + 1] == "D":
                    total += PENALTY["forbidden_n_d"]; breakdown["forbidden_n_d"] += 1
                if sched[d] == "N" and sched[d + 1] == "E":
                    total += PENALTY["forbidden_n_e"]; breakdown["forbidden_n_e"] += 1
                if sched[d] == "E" and sched[d + 1] == "D":
                    total += PENALTY["forbidden_e_d"]; breakdown["forbidden_e_d"] += 1

            # —— 4. 大夜後連休 2 天：d 是 N、d+1 非 N → d+1 必 O、d+2 也必 O ——
            for d in range(num_days - 1):
                if sched[d] == "N" and sched[d + 1] != "N":
                    if sched[d + 1] != "O":
                        total += PENALTY["post_night_not_off_2"]
                        breakdown["post_night_not_off_2"] += 1
                    if d + 2 < num_days and sched[d + 2] != "O":
                        total += PENALTY["post_night_not_off_2"]
                        breakdown["post_night_not_off_2"] += 1

            # —— 5. 健康扣分（連 4 大夜 -5、連 6 上班 -5；滑動窗）——
            for d in range(num_days - 3):
                if all(sched[d + i] == "N" for i in range(4)):
                    health_debit += HEALTH_DEBIT_PER_NIGHT_WINDOW
            for d in range(num_days - 5):
                if all(sched[d + i] != "O" for i in range(6)):
                    health_debit += HEALTH_DEBIT_PER_WORK_WINDOW

            # —— 6. 健康防護網（個人扣分 > 30 = 違規，對應 main.py model.Add(... <= 30)）——
            if health_debit > HEALTH_CAP_PER_NURSE:
                total += PENALTY["health_cap_exceeded"]
                breakdown["health_cap_exceeded"] += 1

            # —— 7. 孤立休假（既有軟限）——
            for d in range(1, num_days - 1):
                if sched[d - 1] != "O" and sched[d] == "O" and sched[d + 1] != "O":
                    total += PENALTY["isolated_off"]
                    breakdown["isolated_off"] += 1

        # —— 8. custom_rules（外圈統一）——
        for (nid, d) in force_off:
            if sched_cache[nid][d - 1] != "O":
                total += PENALTY["custom_rule_violation"]
                breakdown["custom_rule_violation"] += 1
        for (nid, d, sh) in force_work:
            if sched_cache[nid][d - 1] != sh:
                total += PENALTY["custom_rule_violation"]
                breakdown["custom_rule_violation"] += 1

        return total, dict(breakdown)

    # ==========================================
    # Mutation: 單點 / 區塊交換
    # ==========================================
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

    # ==========================================
    # 模擬退火主迴圈
    # ==========================================
    max_iter = req.max_iterations or int(os.getenv("SA_MAX_ITERATIONS", "20000"))
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

    for i in range(max_iter):
        # 備份當前狀態（為 rollback 用）
        snap_m = copy.deepcopy(m_mem)
        snap_e = copy.deepcopy(e_mem)
        snap_n = copy.deepcopy(n_mem)
        snap_o = copy.deepcopy(o_mem)

        if random.random() < 0.3:
            block_antiport(m_mem, e_mem, n_mem, o_mem, block=3)
        else:
            antiport(random.randint(1, num_days), m_mem, e_mem, n_mem, o_mem)

        new_p, new_breakdown = evaluate(m_mem, e_mem, n_mem)
        T = max(0.1, 1000 * (1 - i / max_iter))

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

    # ==========================================
    # 格式化輸出
    # ==========================================
    result = []
    for nid in nurses:
        sched = get_sched(nid, best_m, best_e, best_n)
        for d in range(num_days):
            result.append(ScheduleCell(
                nurse_id=nid,
                date=f"{year}-{month:02d}-{d + 1:02d}",
                shift=sched[d],
            ))

    solver_status = "OPTIMAL" if best_p == 0 else "FEASIBLE"
    if best_p > 0:
        log.warning(f"SA 收斂未到 0：best_penalty={best_p} @ iter {best_iter} | breakdown={best_breakdown}")
    else:
        log.info(f"SA 完美收斂：best_penalty=0 @ iter {best_iter} | 耗時 {elapsed:.2f}s")

    return ScheduleResponse(
        status="success",
        solver_status=solver_status,
        elapsed_seconds=round(elapsed, 2),
        schedule=result,
        stats={
            "final_penalty": best_p,
            "best_iteration": best_iter,
            "max_iterations": max_iter,
            "accepted_worse_swaps": accepted_worse,
            "rejected_swaps": rejected,
            "violation_breakdown": best_breakdown,
            "num_days": num_days,
            "num_nurses": num_nurses,
        },
    )


@app.exception_handler(Exception)
async def _global_exception_handler(request: Request, exc: Exception):
    log.exception(f"未預期錯誤: {exc}")
    return JSONResponse(status_code=500, content={"detail": f"伺服器內部錯誤：{type(exc).__name__}"})


if __name__ == "__main__":
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run("main1:app", host="0.0.0.0", port=port, reload=True)
