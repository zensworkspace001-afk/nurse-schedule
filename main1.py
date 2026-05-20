"""
護理排班 CP-SAT 最佳化引擎
============================
獨立微服務（部署於 Render / Railway / Fly.io），與 Vercel 上的 nurse-schedule
前端配合運作。為什麼獨立部署：
  - ortools 套件 ~65MB，超出 Vercel Python serverless 函式 50MB 警戒
  - CP-SAT 求解最壞情況跑 60 秒，超過 Vercel Hobby plan 的 10 秒上限
  - 計算密集型任務適合放在常駐進程，省去每次冷啟動

API
  POST /generate_schedule       — 主要排班入口（需 Firebase ID token）
  GET  /health                  — 健康檢查（無需 auth，給負載平衡器 / 監控用）

環境變數（部署時設定）
  FIREBASE_PROJECT_ID           — 與 Vercel 同步
  FIREBASE_CLIENT_EMAIL         — service account email
  FIREBASE_PRIVATE_KEY          — service account private key（\\n 會被自動還原）
  ALLOWED_ORIGINS               — CORS 白名單，逗號分隔
                                   預設: http://localhost:5173,
                                         https://nurse-schedule-bachelor.vercel.app
  PORT                          — uvicorn 監聽埠（Render/Railway 會自動注入）
  MAX_SOLVE_SECONDS             — CP-SAT 單次求解時限上限，預設 60
"""

import os
import json
import calendar
import logging
from typing import List, Dict, Optional, Any
from collections import defaultdict
from time import time

from fastapi import FastAPI, HTTPException, Header, Depends, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, validator
from ortools.sat.python import cp_model
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
    max_solve_seconds: Optional[float] = Field(default=None, ge=1, le=120)

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
    """主要排班入口。Admin 才有意義（員工 token 也能通過驗證但通常不會呼叫此端點）。"""
    _check_rate_limit(user.get("uid", "anonymous"))
    t_start = time()

    year, month = req.year, req.month
    _, num_days = calendar.monthrange(year, month)
    num_nurses = len(req.nurses)

    log.info(f"求解 {year}/{month} ({num_days}天) | {num_nurses} 名護理師 | 保護名單 {len(req.protected_indices)} 人 | rules {len(req.custom_rules or [])} 條")

    model = cp_model.CpModel()

    # 班別定義：0=休假(O), 1=白班(D), 2=小夜(E), 3=大夜(N)
    off_shift = 0
    work_shifts = [1, 2, 3]
    num_shifts = 4

    work = {}
    for n in range(num_nurses):
        for d in range(num_days):
            for s in range(num_shifts):
                work[(n, d, s)] = model.NewBoolVar(f"w_n{n}_d{d}_s{s}")

    # ==========================================
    # 動態規則整合
    # ==========================================
    target_reqs = {d: {s: req.daily_reqs.get(s, 0) for s in work_shifts} for d in range(num_days)}
    shift_mapping_reverse = {"D": 1, "E": 2, "N": 3, "O": 0}

    for rule in req.custom_rules or []:
        try:
            day = int(rule["date"].split("-")[2])
            d = day - 1
        except Exception:
            continue
        action = rule.get("action")

        if action == "UPDATE_DEMAND":
            s = shift_mapping_reverse.get(rule.get("shift"))
            if s in work_shifts:
                target_reqs[d][s] = int(rule.get("new_value", 0))
        elif action == "FORCE_OFF":
            nurse_id = rule.get("nurse_id")
            try:
                n = req.nurses.index(nurse_id)
                model.Add(work[(n, d, off_shift)] == 1)
            except ValueError:
                pass

    # ==========================================
    # 硬限制
    # ==========================================
    illegal_transitions = [(3, 1), (3, 2), (2, 1)]  # N→D, N→E, E→D

    for n in range(num_nurses):
        # 每天只能一種班
        for d in range(num_days):
            model.AddExactlyOne([work[(n, d, s)] for s in range(num_shifts)])

        # 輪班間隔 11h
        for d in range(num_days - 1):
            for (s_y, s_t) in illegal_transitions:
                model.Add(work[(n, d, s_y)] + work[(n, d + 1, s_t)] <= 1)

        # 七休一（滑動 7 天區間至少 1 休）
        for d in range(num_days - 6):
            model.Add(sum(work[(n, d + i, off_shift)] for i in range(7)) >= 1)

        # 下大夜必連休 2 天
        for d in range(1, num_days - 1):
            was_night_yesterday = work[(n, d - 1, 3)]
            is_post_night_off = model.NewBoolVar(f"post_night_off_n{n}_d{d}")
            model.AddBoolAnd([was_night_yesterday, work[(n, d, 3)].Not()]).OnlyEnforceIf(is_post_night_off)
            model.AddBoolOr([was_night_yesterday.Not(), work[(n, d, 3)]]).OnlyEnforceIf(is_post_night_off.Not())
            model.AddImplication(is_post_night_off, work[(n, d, off_shift)])
            model.AddImplication(is_post_night_off, work[(n, d + 1, off_shift)])

        # 四週變形：月休 ≥ 8、月工作天 ≤ 27
        model.Add(sum(work[(n, d, off_shift)] for d in range(num_days)) >= 8)
        model.Add(sum(work[(n, d, s)] for d in range(num_days) for s in work_shifts) <= 27)

    # 母性保護 / 實習生 — 禁 E、N
    for n in req.protected_indices:
        for d in range(num_days):
            model.Add(work[(n, d, 2)] == 0)
            model.Add(work[(n, d, 3)] == 0)

    # ==========================================
    # 軟限制（目標函數）
    # ==========================================
    objective_penalties = []
    shortfall_weight = 100

    # 營運缺口
    for d in range(num_days):
        for s in work_shifts:
            target = target_reqs[d][s]
            shortfall = model.NewIntVar(0, target, f"shortfall_d{d}_s{s}")
            model.Add(sum(work[(n, d, s)] for n in range(num_nurses)) + shortfall == target)
            objective_penalties.append(shortfall * shortfall_weight)

    # 個人健康扣分（連 4 大夜 -5 / 連 6 上班 -5）+ 防護網總扣 ≤ 30
    for n in range(num_nurses):
        nurse_health_penalties = []
        for d in range(num_days - 3):
            is_4_nights = model.NewBoolVar(f"4_nights_n{n}_d{d}")
            nights_window = [work[(n, d + i, 3)] for i in range(4)]
            model.Add(sum(nights_window) == 4).OnlyEnforceIf(is_4_nights)
            model.Add(sum(nights_window) < 4).OnlyEnforceIf(is_4_nights.Not())
            nurse_health_penalties.append(is_4_nights * 5)
        for d in range(num_days - 5):
            is_6_work = model.NewBoolVar(f"6_work_n{n}_d{d}")
            offs_window = [work[(n, d + i, off_shift)] for i in range(6)]
            model.Add(sum(offs_window) == 0).OnlyEnforceIf(is_6_work)
            model.Add(sum(offs_window) > 0).OnlyEnforceIf(is_6_work.Not())
            nurse_health_penalties.append(is_6_work * 5)
        total_nurse_penalty = sum(nurse_health_penalties)
        model.Add(total_nurse_penalty <= 30)
        objective_penalties.append(total_nurse_penalty)

    model.Minimize(sum(objective_penalties))

    # ==========================================
    # 求解
    # ==========================================
    solver = cp_model.CpSolver()
    solve_limit = req.max_solve_seconds or float(os.getenv("MAX_SOLVE_SECONDS", "60"))
    solver.parameters.max_time_in_seconds = min(solve_limit, 120.0)

    status = solver.Solve(model)
    elapsed = time() - t_start

    if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        shift_mapping = {0: "O", 1: "D", 2: "E", 3: "N"}
        result = []
        for n in range(num_nurses):
            for d in range(num_days):
                for s in range(num_shifts):
                    if solver.Value(work[(n, d, s)]) == 1:
                        result.append(ScheduleCell(
                            nurse_id=req.nurses[n],
                            date=f"{year}-{month:02d}-{d + 1:02d}",
                            shift=shift_mapping[s],
                        ))
        log.info(f"求解成功 {solver.StatusName(status)} | 耗時 {elapsed:.2f}s | 罰分 {solver.ObjectiveValue():.0f}")
        return ScheduleResponse(
            status="success",
            solver_status=solver.StatusName(status),
            elapsed_seconds=round(elapsed, 2),
            schedule=result,
            stats={
                "objective_value": solver.ObjectiveValue(),
                "num_days": num_days,
                "num_nurses": num_nurses,
                "num_branches": solver.NumBranches(),
                "num_conflicts": solver.NumConflicts(),
            },
        )

    log.warning(f"求解失敗 {solver.StatusName(status)} | 耗時 {elapsed:.2f}s")
    raise HTTPException(
        status_code=400,
        detail=f"運算失敗（solver_status={solver.StatusName(status)}）：條件過於嚴苛或人力嚴重不足。"
               f" 嘗試放寬保護名單、降低人力需求、或減少 custom_rules。",
    )


@app.exception_handler(Exception)
async def _global_exception_handler(request: Request, exc: Exception):
    log.exception(f"未預期錯誤: {exc}")
    return JSONResponse(status_code=500, content={"detail": f"伺服器內部錯誤：{type(exc).__name__}"})


if __name__ == "__main__":
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run("main1:app", host="0.0.0.0", port=port, reload=True)
