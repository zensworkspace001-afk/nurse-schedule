"""
神盾計畫（Project Aegis）階段一 — Python 黃金樣本產生器
=====================================================
用「現行正式引擎」（local_test/hybrid/model.py + cpsat_service.py 的權重與流程）跑一組固定案例，
把每一次 CpSolver.solve 的「模型 protobuf、求解參數、求解結果」與最終班表存成黃金樣本，
給 C# 版（aegis/src/Aegis.Engine）逐一比對。

決定性模式（Baseline）— C# 端必須套用完全相同的轉換：
  num_workers            := 1
  max_deterministic_time := 程式原本設定的 max_time_in_seconds
  max_time_in_seconds    := 1e9（不再受實際秒數影響）
  solver.wall_time       := response.deterministic_time（引擎用它扣除剩餘時間，必須決定性）
random_seed 照程式原本的設定（不覆寫）。不修改任何正式程式碼，只在這支腳本內攔截。

輸出（不進 git，見 aegis/.gitignore）：
  aegis/baseline/golden/<case>/case.json        案例輸入
  aegis/baseline/golden/<case>/call_NN.pb       第 NN 次 solve 的 CpModelProto（binary）
  aegis/baseline/golden/<case>/calls.json       每次 solve 的參數與結果（含完整解向量）
  aegis/baseline/golden/<case>/result.json      流程最終輸出（班表、狀態、分數）

用法：python aegis/baseline/make_golden.py [case ...]
"""
import copy
import json
import os
import shutil
import sys
from time import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "local_test"))
sys.path.insert(0, os.path.join(ROOT, "local_test", "hybrid"))

from ortools.sat.python import cp_model  # noqa: E402

import model as cps  # noqa: E402
import cpsat_service as svc  # noqa: E402
from run_demo import SAMPLE_STAFF  # noqa: E402

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "golden")

# ------------------------------------------------------------
# 攔截 CpSolver：決定性化 + 記錄
# ------------------------------------------------------------
_rec = {"dir": None, "calls": []}
_orig_solve = cp_model.CpSolver.solve


def _baseline_solve(self, model, solution_callback=None):
    p = self.parameters
    det = p.max_time_in_seconds
    p.num_workers = 1
    p.max_deterministic_time = det
    p.max_time_in_seconds = 1e9
    idx = len(_rec["calls"])
    model.export_to_file(os.path.join(_rec["dir"], f"call_{idx:02d}.pb"))
    status = _orig_solve(self, model, solution_callback)
    resp = self.response_proto
    has_sol = status in (cp_model.OPTIMAL, cp_model.FEASIBLE)
    _rec["calls"].append({
        "index": idx,
        "params": {"random_seed": p.random_seed, "num_workers": p.num_workers,
                   "max_deterministic_time": det},
        "status": self.status_name(status),
        "objective": resp.objective_value if has_sol else None,
        "best_bound": resp.best_objective_bound if has_sol else None,
        "deterministic_time": resp.deterministic_time,
        "solution": list(resp.solution) if has_sol else None,
    })
    return status


cp_model.CpSolver.solve = _baseline_solve
cp_model.CpSolver.wall_time = property(lambda self: self.response_proto.deterministic_time)


# ------------------------------------------------------------
# 案例
# ------------------------------------------------------------
def staff14(levels=None):
    rows = [dict(s, is_active=True) for s in copy.deepcopy(SAMPLE_STAFF)]
    for r in rows:
        if levels and r["staff_id"] in levels:
            r["level"], r["is_leader"] = levels[r["staff_id"]]
    return svc.eligible_staff(rows)


SENIOR_MIX = {"N001": ("N3", True), "N003": ("N2", False), "N005": ("N4", False), "N007": ("N2", False),
              "N010": ("N3", False), "N013": ("N2", False)}

CASES = {
    # 1) 現行測試資料（14 人、孕婦 + 實習生 + 雙週 1 人），完整排班流程（零權重起點 → 完整模型），含預假
    "sample14_generate": dict(kind="generate", year=2026, month=8, reqs={"D": 3, "E": 2, "N": 2},
                              staff=staff14(SENIOR_MIX), wishes={"N004": [3, 4, 5, 6], "N010": [10, 11, 17, 18]},
                              time_limit=80.0),   # 預假釘死後零權重起點較難找：單執行緒給足時間才走得到完整模型
    # 2) 人力剛好：D3/E2/N2 的最少人數 12（試算測試的已知結果）
    "tight12_generate": dict(kind="generate", year=2026, month=8, reqs={"D": 3, "E": 2, "N": 2},
                             staff=staff14(SENIOR_MIX)[:12], wishes={}, time_limit=30.0),
    # 3) 雙週人員多（4 位）— 覆蓋雙週 ≤ 10 天與 weekly_staffing_shortfall 的雙週分支
    "biweekly_generate": dict(kind="generate", year=2026, month=9, reqs={"D": 3, "E": 2, "N": 2},
                              staff=[dict(s, special_status="BiWeekly") if s["staff_id"] in ("N004", "N006", "N008", "N011") else s
                                     for s in staff14(SENIOR_MIX)], wishes={"N006": [1, 2, 3, 4]}, time_limit=80.0),
    # 4) 孕哺 / 實習多（4 位只能上白班）
    "protected_generate": dict(kind="generate", year=2026, month=10, reqs={"D": 4, "E": 2, "N": 2},
                               staff=[dict(s, is_pregnant_or_nursing=True) if s["staff_id"] in ("N012", "N014") else s
                                      for s in staff14(SENIOR_MIX)], wishes={}, time_limit=30.0),
    # 5) 資深不足：只有 1 位資深 → 必然有資深缺口（senior 階段的最小化）
    "senior_short_generate": dict(kind="generate", year=2026, month=8, reqs={"D": 3, "E": 2, "N": 2},
                                  staff=staff14({"N001": ("N3", False)}), wishes={}, time_limit=30.0),
    # 6) 預假可行性檢查（全部預假當硬約束的純可行性模型）
    "sample14_wishcheck": dict(kind="wishcheck", year=2026, month=8, reqs={"D": 3, "E": 2, "N": 2},
                               staff=staff14(SENIOR_MIX), wishes={"N004": [3, 4, 5, 6], "N005": [3, 4, 5, 6],
                                                                  "N010": [10, 11, 17, 18]}, time_limit=20.0),
    # 7) 人力試算（不設 deadline，每個人數 check_time 秒）
    "sample14_staffing": dict(kind="staffing", year=2026, month=8, reqs={"D": 3, "E": 2, "N": 2},
                              staff=staff14(SENIOR_MIX), wishes={}, time_limit=10.0),
}


def run_generate(c):
    """= cpsat_service.generate 的求解流程（拿掉 Firestore / HTTP / 實際時鐘）：
    零權重模型（預假當硬約束）求合法起點 → 完整模型以它為 hint（hint_trusted）"""
    staff, reqs, year, month = c["staff"], c["reqs"], c["year"], c["month"]
    ids = [s["staff_id"] for s in staff]
    nd = __import__("calendar").monthrange(year, month)[1]
    wishes = {s: [d - 1 for d in ds if 1 <= d <= nd] for s, ds in c["wishes"].items() if s in ids}

    def pin(m, x, pr, wy):
        for s, ds in wishes.items():
            for d in ds:
                m.add(sum(x[s, d, r] for r in cps.REST) == 1)
        return 0

    prob = svc._problem(year, month, staff, reqs, wishes)
    zero = cps.Problem(year, month, staff, reqs, {i: {"high": set(), "normal": set()} for i in ids},
                       backward_weight=0, mix2_weight=0, mix3_weight=0)
    f = cps.solve_cpsat(zero, {k: 0.0 for k in cps.FEATURES}, {i: 1.0 for i in ids}, 0.0,
                        time_limit=c["time_limit"] * 0.6, workers=1, extra=pin if wishes else None)
    if f["schedule"] is None:
        return {"stage": "zero", "zero": f}
    r = cps.solve_cpsat(prob, svc.GEN_WEIGHTS, {i: 1.0 for i in ids}, 1.0, time_limit=c["time_limit"],
                        workers=1, extra=pin if wishes else None, hint=f["schedule"], hint_trusted=True)
    S = r["schedule"]
    out = {"stage": "full", "zero_status": f["status"], "status": r["status"], "objective": r.get("objective"),
           "hint_value": r.get("hint_value"), "hint_rejected": r.get("hint_rejected"), "schedule": S}
    if S:
        out["hard_violations"] = {s: cps.hard_violations(S[s], next(t for t in staff if t["staff_id"] == s), prob)
                                  for s in ids}
        out["senior_gaps"] = cps.senior_gap_count(prob, S)
        out["backward_rotations"] = sum(cps.backward_rotations(S[s]) for s in ids)
        out["person_cost"] = {s: cps.person_cost(S[s], s, prob, svc.GEN_WEIGHTS) for s in ids}
    return out


def run_wishcheck(c):
    staff, ids = c["staff"], [s["staff_id"] for s in c["staff"]]
    prob = svc._problem(c["year"], c["month"], staff, c["reqs"])
    return cps.check_wishes_feasible(prob, {s: [d - 1 for d in ds] for s, ds in c["wishes"].items() if s in ids},
                                     time_limit=c["time_limit"], workers=1)


def run_staffing(c):
    rng = cps.staffing_range(c["year"], c["month"], c["reqs"], c["staff"], check_time=c["time_limit"],
                             deadline=None, workers=1)
    rng["checks"] = [list(x) for x in rng["checks"]]
    return rng


RUNNERS = {"generate": run_generate, "wishcheck": run_wishcheck, "staffing": run_staffing}


def main(names):
    import ortools
    for name in names or CASES:
        c = CASES[name]
        d = os.path.join(OUT, name)
        shutil.rmtree(d, ignore_errors=True)
        os.makedirs(d)
        _rec["dir"], _rec["calls"] = d, []
        t = time()
        result = RUNNERS[c["kind"]](c)
        with open(os.path.join(d, "case.json"), "w") as fh:
            json.dump({"name": name, "ortools": ortools.__version__, **c}, fh, ensure_ascii=False, indent=1)
        with open(os.path.join(d, "calls.json"), "w") as fh:
            json.dump(_rec["calls"], fh)
        with open(os.path.join(d, "result.json"), "w") as fh:
            json.dump(result, fh, ensure_ascii=False, indent=1)
        size = sum(os.path.getsize(os.path.join(d, f)) for f in os.listdir(d))
        print(f"{name:24s} {len(_rec['calls'])} solves  {time() - t:6.1f}s  {size / 1e6:5.1f} MB  "
              f"→ {[x['status'] for x in _rec['calls']]}  {result.get('status', result.get('feasible', result.get('min')))}")


if __name__ == "__main__":
    main(sys.argv[1:])
