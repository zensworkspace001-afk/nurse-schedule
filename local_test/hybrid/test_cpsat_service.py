"""
cpsat_service.py 端點測試（不連 Firebase：假 token + 假 Firestore store）

  pip install -r requirements.txt httpx
  python local_test/hybrid/test_cpsat_service.py
"""
import copy
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "local_test"))

from fastapi import FastAPI, Header, HTTPException  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import cpsat_service  # noqa: E402
from run_demo import SAMPLE_STAFF  # noqa: E402


class FakeStore:
    def __init__(self):
        self.settings = None
        self.staff = [dict(s, is_active=True) for s in copy.deepcopy(SAMPLE_STAFF)]
        self.version = 0
        self.entries = {}
        self.bump_once = False          # 模擬「別人同時送出」：第一次 commit 時版本已變

    def leave_settings(self):
        return self.settings

    def staff_rows(self):
        return self.staff

    def wish_state(self, ym):
        return self.version, dict(self.entries)

    def commit_wish(self, ym, sid, days, expected_version, quota):
        if self.bump_once:
            self.bump_once = False
            self.version += 1
            return False
        if expected_version != self.version:
            return False
        self.entries[sid] = list(days)
        self.version += 1
        return True


store = FakeStore()


def fake_verify(authorization: str = Header(None)):
    # 測試用 token 格式："Bearer uid:email"
    if not authorization:
        raise HTTPException(401, "缺少登入憑證")
    uid, email = authorization.split(" ", 1)[1].split(":", 1)
    return {"uid": uid, "email": email}


app = FastAPI()
app.include_router(cpsat_service.build_router(fake_verify, lambda key: None, store_factory=lambda: store))
client = TestClient(app)
ADMIN = {"Authorization": "Bearer admin:admin@hospital.com"}


def staff(sid):
    return {"Authorization": f"Bearer {sid}:{sid.lower()}@hospital.com"}


results = []


def check(name, cond, detail=""):
    results.append(cond)
    print(f"{'✅' if cond else '❌'} {name}" + (f" — {detail}" if detail else ""))


# —— 預假 ——
r = client.post("/leave_wishes/submit", json={"days": [8, 9, 15, 16]}, headers=staff("N001"))
check("未開放時送出 → 403", r.status_code == 403, r.json().get("detail"))

store.settings = {"open": True, "year": 2026, "month": 8, "reqs": {"D": 3, "E": 3, "N": 2},
                  "quota": 6, "days_per_person": 4}
r = client.post("/leave_wishes/submit", json={"days": [8, 9, 15]}, headers=staff("N001"))
check("只選 3 天 → 400", r.status_code == 400, r.json().get("detail"))
r = client.post("/leave_wishes/submit", json={"days": [8, 8, 15, 16]}, headers=staff("N001"))
check("重複日期 → 400", r.status_code == 400)
r = client.post("/leave_wishes/submit", json={"days": [8, 9, 15, 16]}, headers=ADMIN)
check("管理員送預假 → 403", r.status_code == 403)
r = client.post("/leave_wishes/submit", json={"days": [8, 9, 15, 16]}, headers=staff("N999"))
check("不在名單的人 → 403", r.status_code == 403)

r = client.post("/leave_wishes/submit", json={"days": [8, 9, 15, 16]}, headers=staff("N001"))
check("正常送出 → 200", r.status_code == 200 and r.json()["remaining"]["8"] == 5, str(r.json().get("days")))
r = client.post("/leave_wishes/submit", json={"days": [1, 2, 3, 4]}, headers=staff("N001"))
check("本人改選 → 舊的日期釋出", r.status_code == 200 and r.json()["remaining"]["8"] == 6)

# 額滿：N002~N007 共 6 人先占 8/22
store.entries.clear()
for i, sid in enumerate(["N002", "N003", "N004", "N005", "N006", "N007"]):
    r = client.post("/leave_wishes/submit", json={"days": [22, 23, 29, 30]}, headers=staff(sid))
    assert r.status_code == 200, r.json()
r = client.post("/leave_wishes/submit", json={"days": [22, 5, 6, 7]}, headers=staff("N008"))
check("8/22 已滿 6 人 → 409 額滿", r.status_code == 409, r.json().get("detail"))

# 可行性：6 位夜班人員同一週連休 8/10–8/13（每天都沒超過配額，但排不出來）
store.entries.clear()
night = ["N001", "N003", "N004", "N005", "N006", "N007"]
codes = []
for sid in night:
    r = client.post("/leave_wishes/submit", json={"days": [10, 11, 12, 13]}, headers=staff(sid))
    codes.append(r.status_code)
check("第 6 位讓這週夜班人力不足 → 409（前 5 位成功）", codes[:5] == [200] * 5 and codes[5] == 409,
      f"{codes}｜{r.json().get('detail')}")

# 同時送出：第一次 commit 版本已變 → 自動重讀重試
store.entries.clear()
store.bump_once = True
r = client.post("/leave_wishes/submit", json={"days": [3, 4, 5, 6]}, headers=staff("N010"))
check("同時送出 → 自動重試成功", r.status_code == 200 and store.entries.get("N010") == [3, 4, 5, 6])

# —— 人力試算 ——
r = client.post("/cpsat/staffing_estimate", json={"year": 2026, "month": 8, "reqs": {"D": 3, "E": 2, "N": 2}},
                headers=staff("N001"))
check("員工呼叫人力試算 → 403", r.status_code == 403)
r = client.post("/cpsat/staffing_estimate", json={"year": 2026, "month": 8, "reqs": {"D": 3, "E": 2, "N": 2}},
                headers=ADMIN)
j = r.json()
check("人力試算 D3/E2/N2 → 最少 12、全員參與", r.status_code == 200 and j["min"] == 12 and j["ok"]
      and len(j["participants"]) == 14, j.get("note"))
r = client.post("/cpsat/staffing_estimate", json={"year": 2026, "month": 8, "reqs": {"D": 5, "E": 4, "N": 3}},
                headers=ADMIN)
check("人力試算 D5/E4/N3 → 人力不足", r.status_code == 200 and not r.json()["ok"], r.json().get("note"))

# —— 排班（直接指派，預假硬約束）——
store.entries = {"N001": [8, 9, 15, 16], "N002": [8, 16, 18, 24], "N007": [2, 8, 9, 16], "N013": [1, 3, 8, 15]}
r = client.post("/cpsat/generate_schedule",
                json={"year": 2026, "month": 8, "reqs": {"D": 3, "E": 3, "N": 2}, "time_limit": 30},
                headers=ADMIN)
check("預假尚未截止就排班 → 409", r.status_code == 409 and "尚未截止" in r.json().get("detail", ""), r.json().get("detail"))
store.settings = dict(store.settings, open=False)   # 護理長截止預假
r = client.post("/cpsat/generate_schedule",
                json={"year": 2026, "month": 8, "reqs": {"D": 3, "E": 3, "N": 2}, "time_limit": 30},
                headers=ADMIN)
j = r.json()
st = j.get("stats", {})
check("排班：0 硬違規、預假全滿足、直接指派到真實工號",
      r.status_code == 200 and st.get("hard_penalty") == 0 and st.get("wishes_met") == st.get("wishes_total") == 16
      and {c["nurse_id"] for c in j["schedule"]} == {s["staff_id"] for s in SAMPLE_STAFF},
      f"{j.get('solver_status')}，預假 {st.get('wishes_met')}/{st.get('wishes_total')}，班別種類 {st.get('shift_types')}")
r = client.post("/cpsat/generate_schedule", json={"year": 2026, "month": 8, "reqs": {"D": 5, "E": 4, "N": 3}},
                headers=ADMIN)
check("排班人力不足 → 400 並說明", r.status_code == 400, r.json().get("detail"))

# 每班資深坐鎮（N2+ 或組長）：給 6 位資深，排出來每天每班都要有（對齊前端 checkSkillMixSafety）
store.entries = {}
seniors = {"N002", "N004", "N005", "N006", "N008", "N010"}
saved_staff = store.staff
store.staff = [dict(s, level="N3" if s["staff_id"] in seniors else "N1") for s in saved_staff]
r = client.post("/cpsat/generate_schedule",
                json={"year": 2026, "month": 8, "reqs": {"D": 3, "E": 3, "N": 2}, "time_limit": 40},
                headers=ADMIN)
st = r.json().get("stats", {})
check("排班：每班都有資深坐鎮（senior_gaps = 0）", r.status_code == 200 and st.get("senior_gaps") == 0
      and st.get("hard_penalty") == 0, f"senior_gaps={st.get('senior_gaps')}")
store.staff = saved_staff

# 試算範圍內都找不到可行人數（min=None）：訊息不能出現 None，下限 = 已證明無解的最大人數 + 1
from model import adjust_headcount  # noqa: E402
adj = adjust_headcount([{"staff_id": f"N{i:03d}"} for i in range(20)],
                       {"min": None, "max": 39, "checks": [(27, "預檢無解", ""), (28, "預檢無解", ""), (29, "UNKNOWN", ""), (35, "UNKNOWN", "")]})
check("試算無解（min=None）→ 訊息不含 None、下限 29", not adj["ok"] and "None" not in adj["note"] and "29 人以上" in adj["note"],
      adj["note"])

# —— 時間預算（每個請求最多約 2 分鐘）——
import time as _time  # noqa: E402
from model import staffing_range, adjust_headcount as _adj  # noqa: E402
base = [dict(s, is_active=True) for s in copy.deepcopy(SAMPLE_STAFF)]
part = staffing_range(2026, 9, {"D": 3, "E": 2, "N": 2}, base, check_time=20, deadline=_time.time())
check("試算到截止時間 → 停止並標記 timed_out、不印 None",
      part["timed_out"] and part["min"] is None and part["checks"][-1][1] == "TIMEOUT"
      and "None" not in _adj(base, part)["note"], _adj(base, part)["note"])
full = staffing_range(2026, 9, {"D": 3, "E": 2, "N": 2}, base, check_time=20, resume=part)
ns = [c[0] for c in full["checks"]]
check("接續試算：沿用進度、不重複檢查、找到最少人數",
      not full["timed_out"] and full["min"] is not None and len(ns) == len(set(ns))
      and all(c in full["checks"] for c in part["checks"] if c[1] != "TIMEOUT"), f"min={full['min']} checks={ns}")
# 「整月混 3 種班」是扣分（mix3_weight），不能變成禁止：強制一人 D/E/N 都上，完整模型仍要排得出來
import model as _cps  # noqa: E402
mixp = cpsat_service._problem(2026, 8, [s for s in cpsat_service.eligible_staff(base)], {"D": 3, "E": 2, "N": 2})
mix_sid = next(s["staff_id"] for s in mixp.staff if not mixp.is_protected(s))
def _force_all3(m, x, pr, wy):
    for sh in _cps.WORK:
        m.add(sum(x[mix_sid, d, sh] for d in range(pr.num_days)) >= 1)
    return 0
mr = _cps.solve_cpsat(mixp, cpsat_service.GEN_WEIGHTS, {i: 1.0 for i in mixp.ids}, 1.0, time_limit=30, extra=_force_all3)
check("整月混 3 種班只扣分、不是禁止", mr["status"] != "INFEASIBLE", f"{mix_sid} → {mr['status']}")

# 不變式：輕量（零權重）模型的合法解，固定進完整模型（GEN 權重）不可以是 INFEASIBLE
#  — 兩者硬約束必須一致；否則排班時的起點會被默默丟掉（就是混 3 種班 bug 的樣子）
zp = _cps.Problem(2026, 8, mixp.staff, {"D": 3, "E": 2, "N": 2}, {i: {"high": set(), "normal": set()} for i in mixp.ids},
                  backward_weight=0, mix2_weight=0, mix3_weight=0)
zs = _cps.solve_cpsat(zp, {k: 0.0 for k in _cps.FEATURES}, {i: 1.0 for i in zp.ids}, 0.0, time_limit=60,
                      workers=1, seed=0, extra=_force_all3)   # 固定 worker / seed：起點每次一樣，下面的測試才可重現
def _pin_hint(m, x, pr, wy):
    for sid in pr.ids:
        for d in range(pr.num_days):
            m.add(x[sid, d, zs["schedule"][sid][d]] == 1)
    return 0
pinned = _cps.solve_cpsat(mixp, cpsat_service.GEN_WEIGHTS, {i: 1.0 for i in mixp.ids}, 1.0, time_limit=30, extra=_pin_hint)
check("不變式：零權重模型的解固定進完整模型不可 INFEASIBLE", zs["schedule"] is not None and pinned["status"] != "INFEASIBLE",
      f"zero={zs['status']} pinned={pinned['status']}")

# 超過人數上限要排除人時，已登記預假（保證休假）的人優先保留
many = [{"staff_id": f"S{i:02d}", "special_status": "Standard"} for i in range(10)]
kept = _adj(many, {"min": 1, "max": 8, "comfort": 1}, keep_ids={"S09"})
check("人數超過上限：已登記預假的人不會被排除", "S09" in {s["staff_id"] for s in kept["staff"]} and len(kept["staff"]) == 8,
      kept["note"])

# B1：從合法起點出發，正式搜尋要能改善（pin 開關不可被提示成 1 — 那會把所有 x 釘死在起點）
imp = _cps.solve_cpsat(mixp, cpsat_service.GEN_WEIGHTS, {i: 1.0 for i in mixp.ids}, 1.0, time_limit=30,
                       hint=zs["schedule"], hint_trusted=True)
check("從合法起點出發會往更好的方向找（不被釘死在起點）", imp.get("hint_value") is not None
      and imp.get("objective", 10 ** 9) < imp["hint_value"], f"{imp['status']} {imp.get('hint_value')} → {imp.get('objective')}")

# B3：要保留的人（預假者）超過上限 → 剛好留到上限，不可因負數切片留更多
def _team(n, wish_n):
    st = [{"staff_id": f"S{i:02d}", "special_status": "Standard"} for i in range(n)]
    return st, {f"S{i:02d}" for i in range(wish_n)}
for n, wn in ((26, 25), (30, 26)):
    st_, keep_ = _team(n, wn)
    k_ = _adj(st_, {"min": 1, "max": 24, "comfort": 1}, keep_ids=keep_)
    ids_ = {s["staff_id"] for s in k_["staff"]}
    check(f"{n} 人、{wn} 人登記預假、上限 24 → 剛好保留 24 人且優先預假者", len(ids_) == 24 and ids_ <= keep_
          and "預假失效" in k_["note"], f"保留 {len(ids_)}")

over = {"min": None, "max": 24, "timed_out": True,
        "checks": [(10, "預檢無解", ""), (15, "預檢無解", ""), (16, "UNKNOWN", ""), (25, "INFEASIBLE", ""), (28, "INFEASIBLE", "")]}
note = _adj(base, over)["note"]
check("人太多造成的排不出來不算下限（只採連續被證明的那一段）", "15 人以下" in note and "28" not in note, note)
store.settings = dict(store.settings or {}, open=False)
# 預假彼此衝突（全員都要 8/1–8/4 休）→ 排班仍要有結果，改為軟約束並標示
store.entries = {s["staff_id"]: [1, 2, 3, 4] for s in store.staff}
r = client.post("/cpsat/generate_schedule",
                json={"year": 2026, "month": 8, "reqs": {"D": 3, "E": 2, "N": 2}, "time_limit": 40},
                headers=ADMIN)
st = r.json().get("stats", {})
check("預假彼此衝突 → 仍排出合法班表、wishes_hard=false", r.status_code == 200 and st.get("wishes_hard") is False
      and st.get("hard_penalty") == 0, f"{r.status_code} wishes_hard={st.get('wishes_hard')} {r.json().get('detail', '')}")
store.entries = {}
# B2 / B6：呼叫端給明顯不合法的起點（全員天天上白班）→ 要修成合法班表。
# 跑在子程序裡：OR-Tools 原生程式 abort（例如舊的 repair_hint）Python 接不到，會讓整個測試程式消失
import subprocess  # noqa: E402
_code = f"""
import sys, copy
sys.path[:0] = [{ROOT!r}, {os.path.join(ROOT, "local_test")!r}, {os.path.dirname(os.path.abspath(__file__))!r}]
import cpsat_service as svc
from run_demo import SAMPLE_STAFF
rows = [dict(s, is_active=True) for s in copy.deepcopy(SAMPLE_STAFF)]
class St:
    def leave_settings(self): return None
    def staff_rows(self): return rows
    def wish_state(self, ym): return 0, {{}}
bad = {{s["staff_id"]: ["D"] * 31 for s in rows}}
for _ in range(3):
    r = svc.generate(St(), 2026, 8, {{"D": 3, "E": 2, "N": 2}}, None, 40, bad, True)
    assert r["stats"]["hard_penalty"] == 0 and r["stats"]["start_repaired"] is True, r["stats"]
print("OK")
"""
proc = subprocess.run([sys.executable, "-c", _code], capture_output=True, text=True, timeout=600)
check("呼叫端起點不合法 → 修成合法班表（子程序 3 次，不可 abort）", proc.returncode == 0 and "OK" in proc.stdout,
      f"returncode={proc.returncode} {proc.stderr.strip().splitlines()[-1] if proc.stderr.strip() else ''}")

# B7：外部起點格式不齊（工號小寫、OFF、少一列）→ 不整份丟，合格的列照用，修成合法
messy = {k.lower(): ["OFF" if c in ("RG", "RC") else c.lower() for c in v] for k, v in zs["schedule"].items()}
messy.pop(next(iter(messy)))
r = client.post("/cpsat/generate_schedule",
                json={"year": 2026, "month": 8, "reqs": {"D": 3, "E": 2, "N": 2}, "time_limit": 40, "hint": messy},
                headers=ADMIN)
st = r.json().get("stats", {})
check("外部起點格式不齊 → 合格的列照用、修成合法", r.status_code == 200 and st.get("hard_penalty") == 0
      and st.get("hint_rows_used") == len(zs["schedule"]) - 1 and st.get("start_repaired") is True,
      f"{r.status_code} rows_used={st.get('hint_rows_used')} repaired={st.get('start_repaired')}")

# B5：試算「目前人數」時限內無法判定 ≠ 人力不足；快取的最少人數也不能拿來拒絕排班
unk = _adj(base, {"min": None, "max": 30, "comfort": None, "current_unknown": True, "checks": [(14, "UNKNOWN", "")]})
check("試算目前人數 UNKNOWN → 不當人力不足", unk["ok"] and "不代表人力不足" in unk["note"], unk["note"])
_team_rows, _key = cpsat_service._team_and_key(store, 2026, 8, {"D": 3, "E": 2, "N": 2}, None)
cpsat_service._staffing_cache[_key] = {"min": 99, "max": 30, "comfort": 99, "gray": [], "demand": 7, "checks": []}
r = client.post("/cpsat/generate_schedule",
                json={"year": 2026, "month": 8, "reqs": {"D": 3, "E": 2, "N": 2}, "time_limit": 30},
                headers=ADMIN)
cpsat_service._staffing_cache.pop(_key, None)
check("快取說要 99 人 → 排班仍自己求解、不直接 400", r.status_code == 200, f"{r.status_code} {r.json().get('detail', '')}")

# B4：人數超過上限時，送預假要用排班時的團隊；被截掉的人直接告知
small = {"D": 1, "E": 1, "N": 1}            # 上限 = (3×3)×31 ÷ 20 = 13 < 14 人
store.settings = {"open": True, "year": 2026, "month": 8, "reqs": small, "quota": 3, "days_per_person": 4}
_el = cpsat_service.eligible_staff(store.staff)
_core = {x["staff_id"] for x in _el if x["is_pregnant_or_nursing"] or x["leave_status"] == "Student"
         or x["special_status"] == "BiWeekly"}
_others = [x["staff_id"] for x in _el if x["staff_id"] not in _core]
_room = _cps.max_headcount(small, 31) - len(_core)          # 一般人員還有幾個位子
store.entries = {sid_: [1, 2, 3, 4] for sid_ in _others[:_room]}   # 位子已被先登記的人佔滿
late = _others[_room]
r = client.post("/leave_wishes/submit", json={"days": [5, 6, 7, 8]}, headers=staff(late))
check("人數超過上限且位子已被先登記者佔滿 → 後送的人 403 說明超過上限",
      r.status_code == 403 and "超過上限" in r.json().get("detail", ""), f"{late} {r.status_code} {r.json().get('detail', '')}")
kept_ = _cps.adjust_headcount(_el, {"min": 0, "max": _cps.max_headcount(small, 31), "comfort": None},
                              keep_ids=list(store.entries) + [late])["staff"]
check("名額不夠時保留先登記的人、不是後送的人", late not in {x["staff_id"] for x in kept_}
      and set(store.entries) <= {x["staff_id"] for x in kept_}, "")
store.entries = {}
store.settings = dict(store.settings, open=False)
# B2 補充：逐人都合法、但某天白班少 1 人的外部起點（LLM 最常見的錯）→ 仍要修成合法班表
short = {k: list(v) for k, v in zs["schedule"].items()}
done_short = False
_mreqs = {"D": 3, "E": 2, "N": 2}
for d, sh_ in ((d, sh_) for d in range(31) for sh_ in _cps.WORK):
    on_d = [s_ for s_ in mixp.ids if short[s_][d] == sh_]
    if len(on_d) != _mreqs[sh_]:
        continue
    for s_ in on_d:
        if sum(c in _cps.WORK for c in short[s_]) <= _cps.MIN_MONTH_WORK:
            continue
        trial = list(short[s_]); trial[d] = "RC"
        if _cps.hard_violations(trial, next(x for x in mixp.staff if x["staff_id"] == s_), mixp) == 0:
            short[s_] = trial; done_short = True
            break
    if done_short:
        break
assert done_short, "測試前置失敗：造不出「逐人合法但某天人力不足」的起點"
r = client.post("/cpsat/generate_schedule",
                json={"year": 2026, "month": 8, "reqs": {"D": 3, "E": 2, "N": 2}, "time_limit": 40, "hint": short},
                headers=ADMIN)
st = r.json().get("stats", {})
check("外部起點逐人合法、但某天某班人力不足 → 走零權重修復並排出合法班表", done_short and r.status_code == 200
      and st.get("hard_penalty") == 0 and st.get("start_repaired") is True,
      f"造出不足起點={done_short} {r.status_code} {r.json().get('detail', '')}")
saved_budget = cpsat_service.REQUEST_BUDGET
cpsat_service.REQUEST_BUDGET = 30.0
t = _time.time()
r = client.post("/cpsat/generate_schedule",
                json={"year": 2026, "month": 8, "reqs": {"D": 3, "E": 3, "N": 2}, "time_limit": 120},
                headers=ADMIN)
elapsed = _time.time() - t
cpsat_service.REQUEST_BUDGET = saved_budget
check("排班要求 120 秒也會被壓在時間預算（30 秒）內", r.status_code in (200, 503) and elapsed < 35,
      f"{r.status_code}，{elapsed:.1f}s")

print(f"\n{sum(results)}/{len(results)} 通過")
sys.exit(0 if all(results) else 1)
