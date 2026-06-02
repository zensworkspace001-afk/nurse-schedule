# 本機測試套件 (`local_test/`)

把 SA 排班、法遵檢查、健康度計算這三塊**獨立抽出來**，不需要 Firebase / Render / FastAPI 就能跑。用來：

- 在本機快速迭代 SA 演算法、調參
- 驗證 SA 的內部罰分跟 JS 端 `checkLaborLawCompliance` 是否一致
- 測試新場景（孕婦、實習生、custom rules、極端人力配置）
- 看每位員工的健康度分布

## 檔案結構

```
local_test/
├── scheduler.py      # SA 演算法（從 main1.py 抽純函式）
├── compliance.py     # 法遵檢查（src/constants.js checkLaborLawCompliance 的 Python port）
├── health.py         # 健康度（PublishPanel.jsx calculateHealthScore 的 Python port）
├── run_demo.py       # CLI runner，跑完三項並印報告
└── README.md         # 本檔
```

三個 module 都是**獨立、可單獨 import**，不互相依賴。

## 安裝

只需要 Python 3.9+，無需任何外部套件（scheduler/compliance/health 全用 standard library）：

```bash
python --version    # 確認 ≥ 3.9
```

## 跑 demo

```bash
# 用預設樣本（10 員工、2026/5、D=3 E=2 N=2、10000 次迭代）
python local_test/run_demo.py

# 自訂月份與人力需求
python local_test/run_demo.py --year 2026 --month 6 --d 4 --e 3 --n 2

# 跑久一點增加收斂機會
python local_test/run_demo.py --iters 30000

# 固定種子可重現結果（debug 用）
python local_test/run_demo.py --seed 42

# 不要印整月班表表格（只看統計）
python local_test/run_demo.py --no-grid
```

## 輸出範例

```
======================================================================
🧪 本機測試 — 2026/5 | 10 名員工
======================================================================
班別需求：D=3  E=2  N=2  (每日總計 7 人)
保護名單 (2 人，禁排 E/N)：
  • [1] N002 陳美麗 (孕/哺乳)
  • [8] N009 周大維 (實習生)

======================================================================
1️⃣  執行 SA 排班
======================================================================
⚠️ 求解狀態：FEASIBLE
   耗時：8.42s
   最終罰分：1050 (0 = 完美)
   最佳解出現在第 8423 / 10000 次迭代
   接受次優交換 1245 次 / 拒絕 6712 次
   SA 內部殘留違規：
     • consecutive_work_7: 1 處
     • forbidden_e_d: 1 處

[整月班表表格...]

======================================================================
2️⃣  法遵檢查（對齊前端 src/constants.js 規則）
======================================================================
⚠️ 共 5 處違規
   按類型分布：
     • CONSECUTIVE_DAYS: 3
     • SHIFT_INTERVAL: 1
     • INSUFFICIENT_RG: 1
   前 10 筆細節：
     • [陳美麗] Day 14: 違反七休一：連續工作已達 7 天
     ...

======================================================================
3️⃣  個人健康度（對齊 PublishPanel calculateHealthScore）
======================================================================
團隊平均：87.3  /  最低 70  /  最高 100
<75 分：1 人 ['N005']
<90 分：3 人 ['N003', 'N005', 'N007']

   每人分數：
     ✅ [N001] 王小明    100 分
     ⚠️ [N003] 李志強     85 分  扣分：3 項
              [-5] 連續大夜 4 天 (~day 12)
              [-20] N→D 短間隔 (day 15-16)
              ...

======================================================================
📊 總結
======================================================================
  SA 內部罰分為 0      : ❌ (penalty=1050)
  JS 端法遵 0 違規     : ❌ (5 處)
  全員健康度 ≥ 75     : ❌ (最低 70 分)
```

## 三個模組可以單獨使用

### 只跑 SA
```python
from scheduler import run_sa

result = run_sa(
    year=2026, month=5,
    nurses=["N001", "N002", "N003"],
    protected_indices=[1],
    daily_reqs={1: 2, 2: 1, 3: 1},
    max_iterations=5000,
    seed=42,
)
print(result["stats"]["final_penalty"])
```

### 只驗法遵
```python
from compliance import check_labor_law_compliance

schedule = {
    "N001": {1: "D", 2: "D", 3: "D", 4: "D", 5: "D", 6: "D", 7: "D"},  # 連 7 天會違規
}
staff = [{"staff_id": "N001", "name": "test", "tenure_years": 5}]
violations = check_labor_law_compliance(schedule, staff, 2026, 5)
for v in violations:
    print(v["message"])
```

### 只算健康度
```python
from health import calculate_health_score

shifts = ["D", "D", "D", "E", "D"]  # E→D 短間隔會 -20
print(calculate_health_score(shifts))
# {"score": 80, "deductions": ["[-20] E→D 短間隔 (day 4-5)"]}
```

## 跟 production 程式碼的關係

| Module | 對應的 production 來源 |
|---|---|
| `scheduler.py` | `main1.py` 的 `generate_schedule()` body |
| `compliance.py` | `src/constants.js` 的 `checkLaborLawCompliance` |
| `health.py` | `src/components/PublishPanel.jsx` 的 `calculateHealthScore` |

**更動 production 端時，本機這幾隻要同步更新**，否則交叉驗證會誤判。建議流程：

1. 在這裡先迭代演算法 / 規則
2. 跑 `python local_test/run_demo.py --seed 42` 驗證
3. 通過後再把改動同步到 production 的 `main1.py` / `constants.js` / `PublishPanel.jsx`

## 班別輸出 — `O` 已棄用，改用 `RG` / `RC`

> **已過時的舊版註記在 `O` 萬用休假時期是正確的，現在 scheduler.py 早就 split 了。**

`scheduler.py` 從 commit `1086fa6` 起 emit **五種班別 `D / E / N / RG / RC`**，跟 JS 端的勞基法分類一致：

- `RG` — 例假（§36 強制不可出勤，月 ≥ 4 天、兩 RG 之間 ≤ 6 工作日）
- `RC` — 休息日（可付加班費後出勤，月 ≥ 4 天）

`compliance.py` 因此能精準地對齊 JS 端的 `RG_INTERVAL` / `INSUFFICIENT_RG` / `INSUFFICIENT_OFF` 規則，不再需要把 `O` 當萬用 RG。

舊行為（單一 `O` + 萬用 RG）會比 production 寬鬆；新行為**比 production 嚴格**（強制 RG/RC 分流 + 每週節律檢查），詳見 `scheduler.py` 的 `week_missing_rg` / `week_missing_rc` / `rg_interval_over_6` 等 penalty。

---

## SA 收斂行為基準（2026-06 期診斷）

`post_night_not_off_2`、`UPDATE_DEMAND` 等新規則（main1.py commit `d81b1fe` / scheduler.py commit `c8a50df` 同步進來）之後，跑了一輪基準測試確認**沒破壞 SA 的收斂特性**，並找出真實的瓶頸所在。

### 多 seed 穩定性（預設樣本：14 nurses × 9 工作位/天）

| seed | penalty | JS 法遵 | 健康度 ≥75 |
|---|---|---|---|
| 1 | 44,970 | ✅ | ✅ |
| 42 | 50,185 | ✅ | ✅ |
| 100 | 50,735 | ✅ | ✅ |
| 999 | 49,415 | ✅ | ✅ |

4 個 seed 全部 **JS 法遵 + 健康度過關**；SA 內部 penalty 穩定落在 45-51k 區間。

### 加長迭代效果邊際遞減

`--iters 20000 → 50000`（2.5×）只把 penalty 從 50,185 降到 42,170（-15%）—— 不是迭代次數不夠，是**搜尋空間本身有結構性的不可解區域**。

### 每日需求密度掃描（seed=42）

| 配置 | 每日總需求/14 人 | 預估月休/人 | penalty | `post_night_not_off_2` |
|---|---|---|---|---|
| D=4 E=3 N=2（預設） | 9 | 10-11 天 | 32,500 | 9 處 |
| **D=5 E=3 N=2** | **10** | **8-9 天** | **42,850** | **7 處** |
| D=5 E=3 N=3 | 11 | 6-7 天 | 163,660 | 15 處 |

### 結論：penalty 高不是新規則的鍋

**問題在「樣本人力配置」**，不在 SA 新規則。預設 14 nurses × 9 工作位/天 → 每天閒置 5 人，月平均 ~10.7 休假天/人，**剛好踩在「月休 8-11 區間」上緣** → `total_rest_above_9` / `excess_rc` / `work_days_below_22` 自動觸發。

**新規則 `post_night_not_off_2` 表現符合預期**：

- 預設樣本下只貢獻 14-18k penalty（×2000/處）
- 隨夜班密度上升而比例增加（N=2→3 從 7 處跳到 15 處，符合直覺）
- 完全沒讓 JS 法遵或健康度漏網（4/4 seed 全綠）

### 建議

預設 demo 樣本應該調成 **D=5 E=3 N=2（daily=10）**，會把 penalty 從 5 萬降到 4 萬區間，並消除大部分「休太多」類違規。這是 demo 範例的調校問題，**不必動 SA 演算法或新規則的權重**。

### 副發現：相同 seed 仍有 run-to-run 變動

跑 `seed=42 --d 4 --e 3 --n 2` 兩次得到 50,185 vs 32,500 不同 penalty。`random.seed(seed)` 只設 Python 全域 `random`；`run_sa_multistart` 內部的並行起點或 tabu list 可能有自己的 randomness 沒受控。

> **要完全可重現（學術發表 / 對拍）時，先檢查 `run_sa_multistart()` 內所有的 `random.X()` 呼叫是否都吃同一個 `random.Random(seed)` 實例**。目前不影響功能正確性，只影響「同 seed 應得同結果」的契約。
