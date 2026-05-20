# CP-SAT 排班引擎部署指南

`main1.py` 是獨立的 FastAPI 微服務，用 Google OR-Tools CP-SAT 求解器算出**數學最佳化**的班表。跟 Vercel 上的 `api/gemini.js`（LLM 流程）並存，admin 可以在 UI 上二選一。

## 為什麼分開部署

- ortools 套件約 65 MB，撞 Vercel Python serverless 50 MB 警戒
- CP-SAT 求解最久跑 60 秒，遠超 Vercel Hobby 的 10 秒上限
- 計算密集型任務適合常駐進程，省去每次冷啟動

## 三種部署方式擇一

---

### 選項 1：Render（最推薦，免費階即可）

1. Render Dashboard → **New +** → **Web Service**
2. 連 GitHub repo `nurse-schedule`
3. 設定：
   - **Runtime**: Docker
   - **Branch**: main
   - **Dockerfile Path**: `./Dockerfile`
   - **Plan**: Free（512 MB RAM 夠用；冷啟動 ~30 秒、15 分鐘無流量會睡）
4. **Environment** 頁面新增：
   ```
   FIREBASE_PROJECT_ID       = (從 Vercel 抓)
   FIREBASE_CLIENT_EMAIL     = (從 Vercel 抓)
   FIREBASE_PRIVATE_KEY      = (從 Vercel 抓，整段含 \n)
   ALLOWED_ORIGINS           = https://nurse-schedule-bachelor.vercel.app,http://localhost:5173
   ```
5. Deploy 完成後拿到 URL，例如 `https://nurse-schedule-cpsat.onrender.com`
6. 測試 health：
   ```bash
   curl https://nurse-schedule-cpsat.onrender.com/health
   ```

---

### 選項 2：Railway

1. Railway Dashboard → **New Project** → **Deploy from GitHub repo**
2. 選 `nurse-schedule`，Railway 自動偵測 Dockerfile
3. **Variables** 頁面同 Render 的環境變數
4. **Settings → Networking → Generate Domain**，拿到 URL
5. 免費階每月 $5 額度，跑這個 service 大約撐 1 個月

---

### 選項 3：Fly.io

```bash
# 一次性安裝 flyctl
brew install flyctl   # macOS
# 或 Windows: iwr https://fly.io/install.ps1 -useb | iex

fly auth login
fly launch              # 互動式，選 No 不要 db, 選 region (nrt 東京最近)
fly secrets set FIREBASE_PROJECT_ID=... FIREBASE_CLIENT_EMAIL=... \
                FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n..." \
                ALLOWED_ORIGINS=https://nurse-schedule-bachelor.vercel.app,http://localhost:5173
fly deploy
```

免費階含 3 個 shared-cpu-1x VM、3 GB 永久儲存。不會睡。

---

## 部署後的前端設定

### 1. Vercel 環境變數
到 Vercel Dashboard → Settings → Environment Variables，新增：
```
VITE_CPSAT_URL = https://你的部署網址
```

然後重新 deploy 前端讓 `import.meta.env.VITE_CPSAT_URL` 生效。

### 2. `vercel.json` CSP 更新
`Content-Security-Policy` 的 `connect-src` 要把微服務 URL 加進去：
```
connect-src 'self' ... https://你的部署網址
```
否則 production 環境的瀏覽器會直接擋掉前端 fetch。

### 3. 本機 dev
`.env.local` 加：
```
VITE_CPSAT_URL=http://localhost:8000
```

本機跑 CP-SAT：
```bash
pip install -r requirements.txt
uvicorn main1:app --reload --port 8000
```

---

## API 規格

### `POST /generate_schedule`
**Headers**：`Authorization: Bearer <Firebase ID Token>`
**Body**：
```json
{
  "year": 2026,
  "month": 5,
  "nurses": ["N01", "N02", "N03"],
  "protected_indices": [0],
  "daily_reqs": {"1": 5, "2": 4, "3": 3},
  "custom_rules": [
    {"date": "2026-05-15", "action": "UPDATE_DEMAND", "shift": "D", "new_value": 8},
    {"date": "2026-05-20", "action": "FORCE_OFF", "nurse_id": "N02"}
  ],
  "max_solve_seconds": 30
}
```

**Response 200**：
```json
{
  "status": "success",
  "solver_status": "OPTIMAL",
  "elapsed_seconds": 4.32,
  "schedule": [
    {"nurse_id": "N01", "date": "2026-05-01", "shift": "D"},
    ...
  ],
  "stats": {
    "objective_value": 12,
    "num_days": 31,
    "num_nurses": 3,
    "num_branches": 1284,
    "num_conflicts": 87
  }
}
```

**Response 400**：條件過於嚴苛、無可行解
**Response 401**：Firebase token 無效
**Response 429**：求解請求過於頻繁（5/分鐘上限）

### `GET /health`
不需 auth，回傳基本診斷：
```json
{"ok": true, "service": "cpsat-schedule", "firebase_ready": true, ...}
```

---

## 監控

- Render / Railway / Fly.io 都內建 logs 與 metrics dashboard
- main1.py 用 stdout logging，所有求解請求會印一行 `求解成功 ... | 耗時 X.XXs`
- 求解失敗會印 `求解失敗 ...` 與 solver status

如果常常 429 → 把 `RATE_LIMIT_PER_MIN` 環境變數調高（預設 5）。
如果常常 timeout → 把 `MAX_SOLVE_SECONDS` 調高（預設 60，上限 120）。
