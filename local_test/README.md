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

## 已知差異 — `O` vs `RG`/`RC`

SA 輸出的休假只有單一型別 `O`，但 JS 端規則區分 `RG`（例假）跟 `RC`（休息日）。

`compliance.py` 在處理時把 `O` 視為「萬用休假」—— 對 `RG_INTERVAL` 與 `INSUFFICIENT_RG` 都當成有效 RG。這讓 SA 輸出能被合理檢驗，但**比 production 寬鬆**。

要嚴格區分的話，需要在 SA 加上「每 7 天必須有 1 個標記為 RG」的限制（軟性或硬性），這個 production 沒做，本機也沒做。
