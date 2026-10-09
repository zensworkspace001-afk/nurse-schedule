# 神盾計畫（Project Aegis）

把排班系統從公有雲（Node.js + Python CP-SAT + Firebase）移植到半導體廠實體隔離內網的純微軟架構
（.NET 8、C# `Google.OrTools.Sat`、SQL Server、SignalR、Docker Compose）。分五個階段，每階段先確認介面再實作。

## 階段一：排班引擎移植（進行中）

`src/Aegis.Engine` 是 `local_test/hybrid/model.py`（現行正式引擎）的逐行移植。

**原則：行為與 Python 完全一致**，連帶著雲端的限制（110 秒預算、零權重起點、資深缺口優先）一起搬。
等基準測試證明兩邊一致後，才在地端放寬這些參數。這樣一旦結果不同，就能確定是移植錯誤，而不是求解器剛好找到更好的解。

### 基準測試怎麼證明「一致」

```bash
python aegis/baseline/make_golden.py      # 跑 Python 正式引擎，存黃金樣本到 aegis/baseline/golden/（不進 git）
cd aegis && dotnet test                   # C# 引擎跑同樣案例，逐次比對
```

每一次 `CpSolver.Solve` 都要通過以下比對：

1. 送進求解器的 `CpModelProto` 完全相同，包含變數、約束、目標、提示、assumptions。
2. 決定性時間、狀態、分數，以及完整解向量完全相同。

最後還要比對流程的最終輸出：班表、可行性判斷與原因文字、試算結果、資深缺口、每人違規數與不滿度。

**決定性模式**（`DeterminismMode.Baseline`，兩邊套用同一套轉換）：

- `num_workers` 改成 1。
- 時間上限改成 `max_deterministic_time`。
- 扣除剩餘時間時，用 `deterministic_time` 取代 wall time。

正式模式（`Production`）則和 Python 正式環境相同：多執行緒、以實際秒數計時。

### 移植時踩到的坑

- **線性約束的形狀。** Python（OR-Tools 9.15）會把每條約束依變數編號排序、合併同一變數、丟掉係數 0。
  C# 內建的 `LinearExpr` 照出現順序排列，係數 0 也保留，兩邊建出的模型就會不同。
  所以引擎改用自己的 `LinExpr` / `ProtoWriter`，直接照 Python 的形狀寫入 proto。
- **`clear_hints()` 要清掉整個欄位**，不能留一個空的 `SolutionHint`。
- **固定起點那一步（`s1`）在 Python 沒有設 `random_seed`**，C# 也不能設。
- **Python 的 `round()` 是銀行家捨入**（.5 取偶數）。`EngineConstants.PyRound` 用 `MidpointRounding.ToEven`。
- **OR-Tools 版本必須相同**：Python `ortools==9.15.6755`，NuGet `Google.OrTools 9.15.6755`。

CI：`.github/workflows/aegis.yml`。改到 `model.py` 或 `aegis/` 時，會在同一台機器上重產樣本並比對（只跑決定性的基準測試）。

### 業務流程層與背景排班

| 專案 | 內容 |
|---|---|
| `src/Aegis.Scheduling` | `IScheduleService`，對應 `cpsat_service.py` 的 `staffing_estimate` / `submit_wish` / `generate`（110 秒預算、零權重起點、預假衝突退回軟約束、外部起點修復）；`IScheduleDataStore` 只定介面，階段二再接 SQL Server。回應 JSON 欄位與現行 API 相同。 |
| `src/Aegis.Scheduling.Hosting` | `IScheduleJobQueue` + `ScheduleWorker`（BackgroundService，一次算一個）+ `IScheduleJobNotifier`（階段三接 SignalR）；`services.AddAegisScheduling()` 註冊全部。 |
| `tests/Aegis.Scheduling.Tests` | `test_cpsat_service.py` 的驗收測試移植：37 項中有 34 項在這裡，另外 3 項授權檢查在階段三的 Controller 測；再加上背景佇列的測試。 |

```bash
cd aegis && dotnet test tests/Aegis.Scheduling.Tests   # 約 9 分鐘；有實際秒數的時間預算，只在本機跑（CI 的 2 vCPU 會因速度誤判）
```
