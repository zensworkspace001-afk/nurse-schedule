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

## 階段二：資料層與跨語言加密遷移

| 專案 | 內容 |
|---|---|
| `src/Aegis.Security` | `FieldCrypto`：AES-256-GCM，與 `api/_lib/crypto.js` 雙向互通（同一把 `FIELD_ENC_KEY`、kid 金鑰環、錯誤訊息一字不差）。<br>`JsEnvelope`：`{t,v}` 信封，與 `JSON.stringify` 逐位元組相同。<br>`Scrypt`：RFC 7914 自行實作，用於密碼歷史。<br>`FirebaseScrypt`：Firebase 改良版 scrypt，讓舊密碼遷移後照樣能登入（方案 A）。 |
| `src/Aegis.Data` | EF Core 8 實體 + `AegisDbContext`。三份員工文件合併成 `Staff` + `StaffSensitive` + `StaffAvatar`；`StaffPublic` / `SchedulesPublic` 改成檢視表 `vStaffPublic` / `vSchedulePublic`。<br>`SqlScheduleDataStore` 是階段一 `IScheduleDataStore` 的 SQL 版，預假提交在交易內重算每日人數，並用 `Version` 樂觀鎖。 |
| `src/Aegis.Migration` | ETL 命令列工具（見下方）。 |

### ETL：在可連網的機器匯出 → 帶進隔離網路 → 匯入

```bash
cd aegis
dotnet run --project src/Aegis.Migration -- dryrun-live --include-auth     # 唯讀匯出 → 記憶體試跑 → 只印對帳報告，不落地
dotnet run --project src/Aegis.Migration -- export --out snapshot.json --include-auth   # 產生 snapshot.json + .sha256
# —— 用加密隨身碟帶進隔離網路 ——
FIELD_ENC_KEY=... dotnet run --project src/Aegis.Migration -- import --in snapshot.json --provider sqlserver --connection "<cs>"            # 試跑
FIELD_ENC_KEY=... dotnet run --project src/Aegis.Migration -- import --in snapshot.json --provider sqlserver --connection "<cs>" --commit   # 寫入
echo '<密碼>' | dotnet run --project src/Aegis.Migration -- check-password --uid n001     # 方案 A 驗收：真實帳號的 Firebase 雜湊
```

**匯入流程：**

- 先驗快照的 SHA-256，檔案在搬運途中被改動就拒絕。
- 只接受空的資料庫。
- 全部在單一交易內寫入。

**報告內容：**

- 每張表的來源數與寫入數對帳；
- 所有加密欄位能否用目前金鑰解開；
- 哪些明文個資已加密後才匯入；
- 刻意不遷移的資料（舊認領流程、暫存 token、可由檢視表重建的公開投影）；
- 三份員工資料之間的不一致。

**2026-10-09 對正式資料的試跑結果：**

- 15 張表全部對帳相符，包括 `ScheduleCell` 14,980 列、`AccessLog` 1,486 列。
- N035 的三個個資欄位是明文，正式匯入時會加密。
- 三份員工資料彼此一致，沒有漂移。
- 37 個登入帳號都有密碼雜湊；N001 與 admin 的真實密碼都通過 Firebase 雜湊驗證。

### 測試

```bash
dotnet test tests/Aegis.Security.Tests    # 與 Node 雙向對照（需要 node）+ RFC 7914 / Firebase 官方向量
dotnet test tests/Aegis.Data.Tests        # SQLite：檢視表、加密欄位、樂觀鎖、業務層接 SQL
dotnet test tests/Aegis.Migration.Tests   # 轉換、快照雜湊、試跑回滾、正式匯入對帳
```

**本機沒有 Docker，以下兩項尚未驗證**，要等到有 SQL Server 的環境（階段五的 docker-compose）：

- SQL Server 專屬的 `rowversion`；
- 實際的 SQL Server 匯入。

資料層邏輯目前都是用 SQLite 驗證的。

## 階段三：Web API、自有登入與 SignalR（`src/Aegis.Api`）

**原則：** API 回應的形狀和現行 Firestore 文件一樣；SignalR 推送的內容和對應 GET 的回應一樣。這樣階段四的前端只要換資料來源，元件不必改。

| 取代 | 改成 |
|---|---|
| Firebase Auth | `AuthController`：JWT 15 分鐘 + refresh token。refresh token 存在 HttpOnly / SameSite=Strict cookie，每次換發都輪替，重放舊的就整串撤銷。連錯 5 次鎖 15 分鐘。錯誤代碼沿用 Firebase 的。 |
| 從 Firebase 遷移的密碼 | `firebase-scrypt$…` 驗一次後自動換成 ASP.NET Core Identity 格式（方案 A）。 |
| Firestore 規則 | 每條路由用 `[Authorize(Policy)]`（Admin / SuperAdmin / Staff）；「員工只能碰自己的資料」在服務層檢查。 |
| `onSnapshot` | `ScheduleHub`（`/hubs/schedule`）：寫入後推送最新文件，依群組分送：all / admins / staff:{id} / month:{y}_{m}。 |
| `admin-user` / `complete-profile` / `secure-field` / `log-login` / `activate-account` | `StaffController`、`MeController`、`SecureFieldController`、`AuthController`。驗證規則與錯誤訊息逐字移植。 |
| Cloud Run 引擎 | `EngineController`：排班回 202 加工作 ID，背景計算，完成時推送 `ScheduleJobChanged`。 |
| Vercel Cron 保留期限掃除 | `RetentionService`（每天一次）。 |

**新增的保護：**

- **ETag 樂觀鎖：** 兩人同時編輯時，後存的人會收到 409，不再直接覆蓋前一個人的修改。
- **員工名單漏傳就拒絕：** 移除員工必須走離職流程。
- **伺服器控管的欄位不能被前端覆寫：** 管理員權限、強制改密、個資同意紀錄。
- **明文個資一律在伺服器端加密。**
- **管理員讀全院名單會自動留下稽核紀錄。**

**依決策刻意不同於現行版本：**

- **寄信：** 沒設院內 SMTP 時，啟用與重設連結交回給管理員親自轉交；自助 OTP 重設停用。
- **AI：** 所有 AI 路由回 503「未啟用」。
- **`auto-settle.js` 沒有移植：** 正式版用錯文件 ID（`2026-11` 而非 `2026_11`），從來沒有成功執行過。結算仍由前端「結算並封存至歷史區」完成，資料寫入改走新的 API。

**設定：**

- `ConnectionStrings:Aegis` 與 `Aegis:DatabaseProvider`（SqlServer / Sqlite）
- `Auth:JwtSigningKey`（base64，至少 32 bytes）
- `FIELD_ENC_KEY`
- `Aegis:PublicBaseUrl`
- `Smtp:*`（選填）

```bash
dotnet test tests/Aegis.Api.Tests   # 19 項：登入 8 + API 11（權限矩陣、ETag、名單保護、遮罩、SignalR 推送、預假、排班背景工作、離職、首登個資、加密欄位、帳號同步）
```
