"""
CP-SAT 排班 + 預假 API（掛在 main1.py 的 FastAPI app 上，部署於 Cloud Run）
=========================================================================
排班引擎本體是 local_test/hybrid/model.py（單一來源）：
  - Docker 映像裡被複製成 cpsat_model.py
  - 本機開發時直接從 local_test/hybrid/ 匯入
所以不會出現 main1.py ↔ local_test/scheduler.py 那種「兩份手動同步」的漂移。

Endpoints（全部需要 Firebase Bearer token）
  POST /cpsat/staffing_estimate   admin  — 人力試算：最少 / 建議 / 最多人數 + 本次參與名單
  POST /cpsat/generate_schedule   admin  — 直接指派排班（已登記預假 = 硬約束，保證滿足）
  POST /leave_wishes/submit       staff  — 送出本人 4 天預假：每日配額 + CP-SAT 可行性檢查通過才寫入

Firestore 結構
  NurseApp/Settings.leaveWish            { open, year, month, reqs:{D,E,N}, quota, days_per_person }
                                         護理長開關預假時由前端（admin）寫入
  LeaveWishes/{Y_M}                      { counts:{"1":n,...}, quota, version, updatedAt }
                                         只有後端寫；任何登入者可讀（只有人數、沒有名字）
  LeaveWishes/{Y_M}/entries/{staffId}    { staff_id, days:[1-indexed], submittedAt }
                                         只有後端寫；本人與 admin 可讀
"""

import calendar
import logging
import os
import sys
from collections import Counter
from time import time
from typing import Any, Callable, Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, validator

try:
    import cpsat_model as cps                      # Docker 映像
except ImportError:                                # 本機：直接用 local_test 的單一來源
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "local_test", "hybrid"))
    import model as cps                            # noqa: E402

log = logging.getLogger("cpsat-service")

ADMIN_EMAIL = os.getenv("ADMIN_EMAIL", "admin@hospital.com")
WORKERS = max(1, int(os.getenv("CPSAT_WORKERS", str(os.cpu_count() or 2))))
# 每個請求的計算時間上限（秒）：超過就停止並回報，不讓請求拖到 Cloud Run 的 300 秒逾時。
# 被 Cloud Run 切斷的請求會在背景繼續算、佔住 CPU，拖慢之後的請求。
REQUEST_BUDGET = float(os.getenv("ENGINE_TIME_BUDGET", "110"))
ESTIMATE_SHARE = 0.6        # 排班時，人力試算（沒有快取時）最多用掉預算的這個比例，剩下給求解
SOLVE_MARGIN = 10.0         # 建模型、組回應等求解器時限以外的時間
WISH_CHECK_SECONDS = float(os.getenv("WISH_CHECK_SECONDS", "20"))
DAYS_PER_PERSON_DEFAULT = 4

# 排班權重：與使用者確認過的優先序（預假另外當硬約束，這裡的權重只在退回軟約束時用）
#   預假 20 > 整月混 2 種班別 6（3 種 18）> 逆向輪班 3 > 孤立休 2 > 夜班 / 週末公平 0.3
GEN_WEIGHTS = {k: 1.0 for k in cps.FEATURES}
GEN_WEIGHTS.update(wish_high_miss=20.0, isolated_off=2.0, nights=0.3, weekend_work=0.3)
# senior_weight 30：比任何偏好都重（預假在排班時是硬約束，不受影響）— 每班盡量有資深人員坐鎮
GEN_PROBLEM_KW = dict(mix2_weight=6.0, mix3_weight=18.0, backward_weight=3.0, senior_weight=30.0)


# ============================================================
# 資料存取層（Firestore）— 測試時換成假的 store
# ============================================================
class FirestoreStore:
    def __init__(self):
        from firebase_admin import firestore
        self._fs = firestore
        self.db = firestore.client()

    def leave_settings(self) -> Optional[Dict]:
        snap = self.db.document("NurseApp/Settings").get()
        return (snap.to_dict() or {}).get("leaveWish") if snap.exists else None

    def staff_rows(self) -> List[Dict]:
        snap = self.db.document("NurseApp/Staff").get()
        return (snap.to_dict() or {}).get("staffData", []) if snap.exists else []

    def wish_state(self, ym: str) -> Tuple[int, Dict[str, List[int]]]:
        head = self.db.document(f"LeaveWishes/{ym}").get()
        version = (head.to_dict() or {}).get("version", 0) if head.exists else 0
        entries = {d.id: list((d.to_dict() or {}).get("days", []))
                   for d in self.db.collection(f"LeaveWishes/{ym}/entries").stream()}
        return version, entries

    def commit_wish(self, ym: str, sid: str, days: List[int], expected_version: int, quota: int) -> bool:
        """樂觀鎖：版本沒變才寫入；交易內再檢查一次配額，避免兩人同時搶最後一個名額"""
        fs = self._fs
        head_ref = self.db.document(f"LeaveWishes/{ym}")
        entry_ref = self.db.document(f"LeaveWishes/{ym}/entries/{sid}")

        @fs.transactional
        def _tx(tx):
            head = head_ref.get(transaction=tx)
            entry = entry_ref.get(transaction=tx)
            data = head.to_dict() if head.exists else {}
            if data.get("version", 0) != expected_version:
                return False
            counts = Counter({int(k): v for k, v in (data.get("counts") or {}).items()})
            for d in ((entry.to_dict() or {}).get("days", []) if entry.exists else []):
                counts[d] -= 1
            for d in days:
                counts[d] += 1
                if counts[d] > quota:
                    return False
            tx.set(head_ref, {"counts": {str(k): v for k, v in counts.items() if v > 0}, "quota": quota,
                              "version": expected_version + 1, "updatedAt": fs.SERVER_TIMESTAMP})
            tx.set(entry_ref, {"staff_id": sid, "days": sorted(days), "submittedAt": fs.SERVER_TIMESTAMP})
            return True

        return _tx(self.db.transaction())


_store = None


def get_store():
    global _store
    if _store is None:
        _store = FirestoreStore()
    return _store


# ============================================================
# 共用
# ============================================================
def eligible_staff(rows: List[Dict]) -> List[Dict]:
    """在職、且不是產假 / 長假（與 StaffDashboard 的防呆 2、3 一致）"""
    out = []
    for s in rows:
        if s.get("is_active") in (False, "false"):
            continue
        if s.get("leave_status") in ("Maternal", "OnLeave"):
            continue
        if not s.get("staff_id"):
            continue
        out.append({
            "staff_id": str(s["staff_id"]),
            "name": s.get("name", s["staff_id"]),
            "special_status": s.get("special_status", "Standard"),
            "is_pregnant_or_nursing": s.get("is_pregnant_or_nursing") in (True, "True", "true"),
            "leave_status": s.get("leave_status", "None"),
            "level": s.get("level", "N0"),
            "is_leader": s.get("is_leader") in (True, "True", "true"),
        })
    return out


def _reqs(d: Dict[str, Any]) -> Dict[str, int]:
    try:
        r = {k: int(d[k]) for k in ("D", "E", "N")}
    except (KeyError, TypeError, ValueError):
        raise HTTPException(400, "每日人力需求格式錯誤，需要 {D, E, N}")
    if min(r.values()) < 0 or sum(r.values()) == 0:
        raise HTTPException(400, "每日人力需求不可為負，且總和需大於 0")
    return r


def _problem(year: int, month: int, staff: List[Dict], reqs: Dict[str, int],
             wishes0: Optional[Dict[str, List[int]]] = None) -> "cps.Problem":
    ids = [s["staff_id"] for s in staff]
    w = wishes0 or {}
    return cps.Problem(year, month, staff, reqs,
                       {i: {"high": set(w.get(i, [])), "normal": set()} for i in ids}, **GEN_PROBLEM_KW)


def _require_admin(user: Dict):
    if (user.get("email") or "").lower() != ADMIN_EMAIL.lower():
        raise HTTPException(403, "僅限管理員")


def _uid_staff_id(user: Dict) -> str:
    """staff_id ↔ Firebase UID 對齊（見 CLAUDE.md：UID realignment），email 前綴當備援"""
    uid = str(user.get("uid") or "")
    email = (user.get("email") or "").lower()
    if email == ADMIN_EMAIL.lower():
        raise HTTPException(403, "管理員不需要預假")
    return uid or email.split("@")[0]


# ============================================================
# 業務邏輯（與 HTTP 解耦，方便測試）
# ============================================================
_staffing_cache: Dict[Tuple, Dict] = {}
_staffing_partial: Dict[Tuple, Dict] = {}   # 逾時中止的試算進度：下次從停下的人數接著算


def staffing_estimate(store, year: int, month: int, reqs: Dict[str, int],
                      staff_ids: Optional[List[str]] = None, deadline: Optional[float] = None) -> Dict:
    staff = eligible_staff(store.staff_rows())
    if staff_ids:
        wanted = {str(x).upper() for x in staff_ids}
        staff = [s for s in staff if s["staff_id"].upper() in wanted]
    if not staff:
        raise HTTPException(400, "沒有可排班的員工")
    # 試算只跟「人數組成」有關（保護 / 雙週 / 一般），跟是誰無關 → 用組成當快取 key
    comp = (sum(1 for s in staff if s["is_pregnant_or_nursing"] or s["leave_status"] == "Student"),
            sum(1 for s in staff if s["special_status"] == "BiWeekly"), len(staff))
    key = (year, month, tuple(sorted(reqs.items())), comp)
    rng = _staffing_cache.get(key)
    if rng is None:
        rng = cps.staffing_range(year, month, reqs, staff, check_time=20.0, workers=WORKERS,
                                 deadline=deadline if deadline is not None else time() + REQUEST_BUDGET,
                                 resume=_staffing_partial.get(key))
        if rng["timed_out"]:              # 中途停止：結果不完整，只存進度
            _staffing_partial[key] = rng
        else:
            _staffing_cache[key] = rng
            _staffing_partial.pop(key, None)
    adj = cps.adjust_headcount(staff, rng)
    nd = calendar.monthrange(year, month)[1]
    return {
        "min": rng["min"], "max": rng["max"], "recommended": rng["comfort"], "gray": rng["gray"],
        "demand": rng["demand"], "days": nd, "team_size": len(staff),
        "ok": adj["ok"], "note": adj["note"],
        "participants": [s["staff_id"] for s in adj["staff"]] if adj["ok"] else [],
        # 預假每日配額預設：參與人數 − 每日最低需求（壓力測試：與 CP-SAT 算出的單日上限一致）
        "default_quota": max(0, len(adj["staff"]) - rng["demand"]) if adj["ok"] else 0,
        "checks": [{"n": n, "status": st, "reason": why} for n, st, why in rng["checks"]],
    }


def submit_wish(store, sid: str, days: List[int]) -> Dict:
    st = store.leave_settings()
    if not st or not st.get("open"):
        raise HTTPException(403, "目前未開放預假")
    year, month = int(st["year"]), int(st["month"])
    nd = calendar.monthrange(year, month)[1]
    need = int(st.get("days_per_person", DAYS_PER_PERSON_DEFAULT))
    if len(days) != need or len(set(days)) != need or not all(isinstance(d, int) and 1 <= d <= nd for d in days):
        raise HTTPException(400, f"請選擇 {need} 個不重複、且在 {month} 月內的日期")
    reqs = _reqs(st.get("reqs") or {})
    staff = eligible_staff(store.staff_rows())
    if sid.upper() not in {s["staff_id"].upper() for s in staff}:
        raise HTTPException(403, "您本月不在排班名單內（離職、產假或長假）")
    sid = next(s["staff_id"] for s in staff if s["staff_id"].upper() == sid.upper())
    quota = int(st.get("quota", max(0, len(staff) - sum(reqs.values()))))
    ym = f"{year}_{month}"

    for _ in range(3):
        version, entries = store.wish_state(ym)
        wishes = dict(entries)
        wishes[sid] = sorted(days)
        counts = Counter(d for ds in wishes.values() for d in ds)
        full = sorted(d for d in days if counts[d] > quota)
        if full:
            raise HTTPException(409, f"{'、'.join(f'{month}/{d}' for d in full)} 已額滿（每日上限 {quota} 人），請改選其他日期")
        prob = _problem(year, month, staff, reqs)
        chk = cps.check_wishes_feasible(prob, {s: [d - 1 for d in ds] for s, ds in wishes.items()},
                                        time_limit=WISH_CHECK_SECONDS, workers=WORKERS)
        if not chk["feasible"]:
            raise HTTPException(409, chk["reason"])
        if store.commit_wish(ym, sid, sorted(days), version, quota):
            remaining = {str(d): quota - counts.get(d, 0) for d in range(1, nd + 1)}
            log.info(f"預假 {ym} {sid} {sorted(days)} 已登記")
            return {"ok": True, "year": year, "month": month, "days": sorted(days), "quota": quota,
                    "remaining": remaining}
        # 版本變了（有人同時送出）→ 重讀重算
    raise HTTPException(409, "同時有其他同仁送出預假，請重新整理後再試一次")


def generate(store, year: int, month: int, reqs: Dict[str, int], staff_ids: Optional[List[str]],
             time_limit: float, hint: Optional[Dict[str, List[str]]], use_wishes: bool) -> Dict:
    # 預假還開放就排班 → 之後才登記的人會被告知「保證休假」，但班表已經排好、沒有反映。必須先截止。
    st = store.leave_settings()
    if use_wishes and st and st.get("open") and int(st.get("year", 0)) == year and int(st.get("month", 0)) == month:
        raise HTTPException(409, f"{year}/{month} 的預假尚未截止，請先到「預假管理」截止後再排班"
                                 "（截止前排出的班表不會包含之後才登記的預假）")
    t_start = time()
    deadline = t_start + REQUEST_BUDGET
    est = staffing_estimate(store, year, month, reqs, staff_ids, deadline=t_start + REQUEST_BUDGET * ESTIMATE_SHARE)
    if not est["ok"]:
        raise HTTPException(400, est["note"])
    rows = {s["staff_id"]: s for s in eligible_staff(store.staff_rows())}
    staff = [rows[i] for i in est["participants"]]
    ids = [s["staff_id"] for s in staff]
    nd = calendar.monthrange(year, month)[1]

    wishes: Dict[str, List[int]] = {}
    if use_wishes:
        _, entries = store.wish_state(f"{year}_{month}")
        wishes = {s: [d - 1 for d in ds if 1 <= d <= nd] for s, ds in entries.items() if s in ids}

    def pin(m, x, pr, wy):  # 已登記預假 = 硬約束（送出時已檢查過可行，保證滿足）
        for s, ds in wishes.items():
            for d in ds:
                m.add(sum(x[s, d, r] for r in cps.REST) == 1)
        return 0

    prob = _problem(year, month, staff, reqs, wishes)
    if hint:
        hint = {s: v for s, v in hint.items() if s in ids and len(v) == nd and all(c in cps.SHIFTS for c in v)}
        hint = hint if len(hint) == len(ids) else None
    t0 = time()
    time_limit = max(5.0, min(time_limit, deadline - t0 - SOLVE_MARGIN))
    r = cps.solve_cpsat(prob, GEN_WEIGHTS, {i: 1.0 for i in ids}, 1.0, time_limit=time_limit,
                        workers=WORKERS, extra=pin if wishes else None, hint=hint)
    wishes_hard = bool(wishes)
    retry_limit = deadline - time() - SOLVE_MARGIN
    if r["schedule"] is None and wishes and retry_limit >= 5:
        # 理論上不會發生（送出時已檢查），保險起見退回「預假當軟約束」（只用剩下的時間預算）
        log.warning(f"{year}/{month} 預假當硬約束無解（{r['status']}），退回軟約束")
        r = cps.solve_cpsat(prob, GEN_WEIGHTS, {i: 1.0 for i in ids}, 1.0, time_limit=retry_limit,
                            workers=WORKERS, hint=hint)
        wishes_hard = False
    if r["schedule"] is None:
        if r["status"] == "UNKNOWN":
            raise HTTPException(503, f"排班超過 {int(REQUEST_BUDGET)} 秒仍沒有找到合法班表，已中止。請再試一次，或增補人力 / 降低每日需求")
        raise HTTPException(400, "；".join(r.get("reasons") or []) or f"找不到合法班表（{r['status']}），請增補人力或降低需求")

    S = r["schedule"]
    hit = sum(1 for s, ds in wishes.items() for d in ds if S[s][d] in cps.REST)
    staff_by_id = {s["staff_id"]: s for s in staff}
    hard = sum(cps.hard_violations(S[s], staff_by_id[s], prob) for s in ids)
    cells = [{"nurse_id": s, "date": f"{year}-{month:02d}-{d + 1:02d}", "shift": S[s][d]}
             for s in ids for d in range(nd)]
    return {
        "status": "success",
        "solver_status": "INFEASIBLE" if hard else ("OPTIMAL" if r["status"] == "OPTIMAL" else "FEASIBLE"),
        "elapsed_seconds": round(time() - t0, 2),
        "schedule": cells,
        "stats": {
            "engine": "cpsat", "cpsat_status": r["status"], "gap": r.get("gap"),
            "objective": r.get("objective"), "hint_value": r.get("hint_value"),
            "hard_penalty": hard, "num_days": nd, "num_nurses": len(ids),
            "wishes_total": sum(len(v) for v in wishes.values()), "wishes_met": hit,
            "wishes_hard": wishes_hard, "staffing": {k: est[k] for k in ("min", "max", "recommended", "note")},
            "backward_rotations": sum(cps.backward_rotations(S[s]) for s in ids),
            "shift_types": dict(Counter(len({c for c in S[s] if c in cps.WORK}) for s in ids)),
            "senior_gaps": cps.senior_gap_count(prob, S),
        },
    }


# ============================================================
# HTTP
# ============================================================
class StaffingRequest(BaseModel):
    year: int = Field(..., ge=2020, le=2099)
    month: int = Field(..., ge=1, le=12)
    reqs: Dict[str, int]
    staff_ids: Optional[List[str]] = None


class GenerateRequest(StaffingRequest):
    time_limit: float = Field(120.0, ge=5.0, le=240.0)
    hint: Optional[Dict[str, List[str]]] = None
    use_wishes: bool = True


class WishRequest(BaseModel):
    days: List[int] = Field(..., min_items=1, max_items=10)

    @validator("days", each_item=True)
    def _int_day(cls, v):
        if not 1 <= v <= 31:
            raise ValueError("日期需在 1~31")
        return v


def build_router(verify_token: Callable, rate_limit: Callable[[str], None], store_factory=get_store) -> APIRouter:
    router = APIRouter()

    @router.post("/cpsat/staffing_estimate")
    def staffing_endpoint(req: StaffingRequest, user: Dict = Depends(verify_token)):
        _require_admin(user)
        rate_limit(user.get("uid", "anonymous"))
        return staffing_estimate(store_factory(), req.year, req.month, _reqs(req.reqs), req.staff_ids)

    @router.post("/cpsat/generate_schedule")
    def generate_endpoint(req: GenerateRequest, user: Dict = Depends(verify_token)):
        _require_admin(user)
        rate_limit(user.get("uid", "anonymous"))
        return generate(store_factory(), req.year, req.month, _reqs(req.reqs), req.staff_ids,
                        req.time_limit, req.hint, req.use_wishes)

    @router.post("/leave_wishes/submit")
    def submit_endpoint(req: WishRequest, user: Dict = Depends(verify_token)):
        sid = _uid_staff_id(user)
        rate_limit(f"wish:{sid}")
        return submit_wish(store_factory(), sid, req.days)

    return router
