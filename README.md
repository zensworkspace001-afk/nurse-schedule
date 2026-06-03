# nurse-schedule

> 台灣某醫院護理排班系統。React + Vite 前端 + Firebase Firestore + 多後端路徑
> (Vercel Node 正式 / Laravel PHP 本機 sandbox)+ Python SA 排班引擎(Render)。

---

## Docs 入口

| 想做什麼 | 看哪份文件 |
|---|---|
| **完整系統架構** | [`ARCHITECTURE.md`](./ARCHITECTURE.md) ⭐ |
| 寫 code / 改 schema / Firestore 規則 | [`CLAUDE.md`](./CLAUDE.md) |
| 跑 PHP backend 本機 | [`php-backend/README.md`](./php-backend/README.md) |
| 玩 SA 演算法 / 看收斂行為 | [`local_test/README.md`](./local_test/README.md) |
| 部署 SA 引擎到 Render | [`CPSAT_DEPLOY.md`](./CPSAT_DEPLOY.md) |

---

## Quick start

### 前端 + Vercel 後端(預設,production-like)

```bash
npm install
npm run dev                       # → http://localhost:5173
                                  # /api/* 透過 vite proxy 打 Vercel production
```

### 前端 + 本機 PHP 後端(整合測試)

```bash
# 1) Laragon 跑著(自帶 Apache + PHP 8.3)
# 2) 建 directory junction(只需一次)
New-Item -ItemType Junction -Path C:\laragon\www\nurse-php \
                            -Target <repo>\php-backend
# 3) Laragon Restart(讓 auto-vhost 抓到 → http://nurse-php.test/ 可用)

# 4) .env.local 加一行,讓 vite proxy 把已 port 的端點走 PHP
echo "VITE_API_PROXY_TARGET=http://nurse-php.test" >> .env.local

# 5) 跑前端
npm run dev
```

之後 `http://localhost:5173/` 就會在 8 支已 port 的 endpoint 上吃 PHP backend,其餘繼續走 Vercel。詳見 [`php-backend/README.md`](./php-backend/README.md)。

### SA 排班引擎(本機微服務)

```bash
pip install -r requirements.txt
uvicorn main1:app --reload --port 8000
```

把前端 `.env.local` 的 `VITE_CPSAT_URL` 指向 `http://localhost:8000` 即可。

### 純演算法 iteration(無需 Firebase / FastAPI / 任何外服)

```bash
python local_test/run_demo.py --seed 42
```

---

## 主要指令

```bash
npm run dev              # vite dev server
npm run build            # 前端 production build → dist/
npm run lint             # ESLint
npm run test:e2e         # Playwright E2E(需 TEST_STAFF_ID / TEST_STAFF_PW)
npm run electron:build   # 桌面 app build
```

PHP 後端的指令在 `php-backend/` 子資料夾,見其 README。

---

## 專案組成(一句話)

| 資料夾 | 是什麼 |
|---|---|
| `src/` | React 前端 (Vite) |
| `api/` | Vercel Node 後端 (production) |
| `php-backend/` | Laravel 13 PHP 後端 (本機 sandbox, 8 / 13 endpoint 已 port) |
| `main1.py` | SA 排班引擎(FastAPI,部署 Render) |
| `local_test/` | SA / 法遵 / 健康度 純 Python 測試工具 |
| `scripts/` | 各種 migration / diagnostic 腳本(Node)|
| `sql/` | MySQL schema(僅 `access_logs` 表)|

詳細責任分工見 [`ARCHITECTURE.md`](./ARCHITECTURE.md)。

---

## 環境變數

`.env.local` 從 Vercel 拉:

```bash
vercel env pull
```

完整環境變數列表 + 從哪取見 [`CLAUDE.md`](./CLAUDE.md#environment-variables)。

> ⚠️ **`FIELD_ENC_KEY` 一旦遺失,所有 Firestore 上加密的 PII 全部解不開**。
> 一定要離線備份。

---

## 部署

- **前端 + Vercel Node 後端**:推 `main` → Vercel 自動 redeploy
- **SA 引擎**:推 `main` → Render(`.vercelignore` 排除 PHP/Python,Vercel 不會碰)
- **PHP 後端**:目前**沒部署**(本機 Laragon only)
- **MySQL**:目前**沒部署**(本機 Laragon only,可選用 PlanetScale/Aiven 等雲端 provider 上線)

切流量 / 上線規劃見 [`ARCHITECTURE.md`](./ARCHITECTURE.md) 末段。
