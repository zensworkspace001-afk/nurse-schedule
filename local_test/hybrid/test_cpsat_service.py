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
store.settings = dict(store.settings or {}, open=False)
store.entries = {}
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
