# php-backend — Laravel 13 移植「綠批 + 中批」(策略 A)

把原本 Vercel serverless（Node.js）的後端**逐支改寫成 Laravel**，這個資料夾現在
是一個**可獨立執行的 Laravel 13 app**，不是只放原始碼。Firestore 與 React 前端
維持不動，PHP 只接管寫入/管理類 API（前端的 `onSnapshot` 即時訂閱 PHP 給不了）。

> 這是**策略 A** 的本機 POC —— 為了驗證 PHP 版與 Node 版行為一致，**目前未取代任何
> 線上服務**。Vercel 上的 Node endpoint 與正式流量都沒變動，hospital 員工感受不到差異。

## 已移植清單

| 端點 | 對應 Node | 狀態 |
|---|---|---|
| `POST /api/sendEmail` | `api/sendEmail.js` | ✅ HTTP 級實測（Resend SDK 接通）|
| `POST /api/activate-account` | `api/activate-account.js` | ✅ 端到端（token 一次性消化、`revokeRefreshTokens` 確認執行）|
| `POST /api/log-login` | `api/log-login.js` | ✅ 端到端（瀏覽器登入後 access_logs 寫入確認）|
| `POST /api/complete-profile` | `api/complete-profile.js` | ✅ 端到端 first + update mode（瀏覽器新員工 PII 加密寫入）|
| `POST /api/secure-field` | `api/secure-field.js` | ✅ 端到端（瀏覽器 admin 解密員工 PII 還原明文）|
| `POST /api/claim-schedule` | `api/claim-schedule.js` | 🟡 HTTP 級實測；瀏覽器選班路徑待確認 |
| `POST /api/auto-settle` | `api/auto-settle.js` | ✅ 4 種 cURL 情境（CSRF 擋 / cron 認證 / Time Tuner / 404）|
| `POST /api/cron/check-timeout` | `api/cron/check-timeout.js` | ✅ HTTP 級實測（auth gate 全綠;真實 cron 觸發需上線後測）|

共用層：`FieldCrypto` (AES-256-GCM + Node 同款 `{t,v}` 信封)、`Sanitizer`、`Csrf`、
`RateLimit` (Laravel cache)、`Firebase` (kreait 入口)、`ActivationToken`、`AccessLog`。

## 本機跑法(2 選 1)

需要 **PHP 8.2+** + **Composer**(Laragon 的 8.3 完全 OK)。

### 方案 A:Laragon Apache(推薦,免管理終端)⭐

讓 Laragon Apache 24/7 服務 `php-backend/`,你完全不用開終端跑 `artisan serve`:

```powershell
# 1) 在 Laragon www 建 directory junction 指回 repo(只需一次)
New-Item -ItemType Junction `
  -Path C:\laragon\www\nurse-php `
  -Target <你的 repo 路徑>\php-backend

# 2) Reload Laragon (右鍵 tray icon → Reload),它的 Auto VirtualHosts 會自動偵測
#    public/index.php 並生成 vhost(C:\laragon\etc\apache2\sites-enabled\auto.nurse-php.test.conf)
#    同時往 C:\Windows\System32\drivers\etc\hosts 加 127.0.0.1 nurse-php.test

# 3) DNS cache flush 一次(Windows 不主動讀新 hosts 條目)
ipconfig /flushdns

# 4) 驗證
curl http://nurse-php.test/                          # → Laravel 歡迎頁
curl -X POST http://nurse-php.test/api/log-login `
     -H "Content-Type: application/json" `
     -d '{"healthCheck":true}'                       # → {"ok":true,"service":"log-login"}
```

**之後每次開機 Laragon 自動啟動 Apache,你直接打 `http://nurse-php.test` 就能用。**

#### Troubleshooting

| 症狀 | 解 |
|---|---|
| `nurse-php.test` DNS 解不到 | `ipconfig /flushdns`(Windows 快取);或在瀏覽器無痕模式試 |
| `Connection refused` port 80 | Apache 沒起。Laragon GUI 點「Start All」,或 cmd:`C:\laragon\bin\apache\httpd-*\bin\httpd.exe -d C:/laragon/bin/apache/httpd-*` |
| reload 後 Apache 沒回來 | Laragon `reload` 在某些版本只送 shutdown 不送 start。**用 Laragon GUI 的 Restart 按鈕** 而非 reload |
| 503 但 Apache 是好的 | 看 `php-backend/storage/logs/laravel.log` 抓 Laravel 錯誤;或 `C:\laragon\bin\apache\httpd-*\logs\error_log` 抓 Apache 錯誤 |

### 方案 B:`php artisan serve`(臨時開發用)

```bash
cd php-backend
php artisan serve --port=8000
```

簡單,但是 PHP 內建的單執行緒 dev server,適合除錯不適合長期掛。
你的終端要一直開著,Ctrl+C 就停。

## 環境變數(從 Vercel 拉過來對齊)

`cp .env.example .env`,然後填以下 8 個 keys:

| Key | 從哪取 | 注意 |
|---|---|---|
| `APP_KEY` | `php artisan key:generate` 自動產 | Laravel 內部用,與 Firebase 無關 |
| `FIREBASE_PROJECT_ID` | Vercel env(同 Node 後端)| |
| `FIREBASE_CLIENT_EMAIL` | Vercel env | |
| `FIREBASE_PRIVATE_KEY` | Vercel env | `\n` 跳脫會在 `Firebase::factory()` 內還原 |
| `FIELD_ENC_KEY` | Vercel env(**必須與 Node 同一把**)| 換 key 會讓現有 Firestore 密文全部解不開 |
| `RESEND_API_KEY` | Vercel env | |
| `CRON_SECRET` | Vercel env | 給 `auto-settle` / `cron/check-timeout` cron 觸發用 |
| `INTERNAL_API_BASE` | 預設 `https://nurse-schedule-bachelor.vercel.app` | `cron/check-timeout` 內部呼叫 `auto-relay` / `sendEmail` 的 base URL,難批 port 完可改指自己 |

`FIRESTORE_TRANSPORT=rest`(預設)在 Windows + Laragon ZTS PHP 上穩定,Linux 生產可改 `grpc`(`apt install php-grpc`)。

## 配合本機前端開發

`vite.config.js` 已支援**混合 proxy**:在你的 `.env.local` 設

```bash
VITE_API_PROXY_TARGET=http://nurse-php.test
```

`npm run dev` 啟動的前端(localhost:5173)的 `/api/*` 請求就會自動分流:
- **已 port 的 8 支**(本檔最上方清單)→ 你的本機 PHP(via Apache)
- **其餘**(`/api/admin-user` / `/api/gemini` / `/api/auto-relay` / `/api/analyze-excel`)→ 繼續走 Vercel

這樣你能完整跑前端、邊測 PHP 邊看是否破事 —— 不會因為還沒 port 的端點 404 就把整個 UI 弄死。

## 與 Node 版的關鍵差異 / 注意點

1. **加密信封**逐型別對齊 Node `serialize()`(`{t, v}` JSON 包裝)。GCM 跨語言相容,但
   `FIELD_ENC_KEY` 必須與 Node 後端同一把,否則解不開 Firestore 上的現有密文。
2. **Rate limit 換實作**:Node 用行程內記憶體 Map;PHP-FPM 每 request 全新行程,
   改用 Laravel `RateLimiter`(背後接 cache)。多實例部署 `CACHE_STORE` 設 redis。
3. **CSRF/auth 留在 controller 內**(非 route middleware):讓 `healthCheck` 能在所有
   檢查之前放行,與 Node 版 1:1。
4. **`AccessLog::write` fire-and-forget**:寫入失敗只記 log、不擋業務、不丟例外。
5. **Firestore 多 doc 原子寫入**:`google/cloud-firestore` v2 拿掉 `batch()`,改用
   `runTransaction()` write-only 寫法(底層走 commit batch RPC),保持 JS 端 `batch.commit()` 的 all-or-nothing 語意。
6. **Firestore 經 REST 而非 grpc**:見上面 `FIRESTORE_TRANSPORT`。
7. **`secure-field` 的 ADMIN_EMAIL 寫死 `admin@hospital.com`**:與 Node 版完全一致。

## 還沒做(難批 + 缺口)

- **難**:`gemini`、`auto-relay`、`analyze-excel`、`admin-user`(含 `readAccessLogs` / `delete-staff` / sync)

完成這 4 支 PHP backend 就可以**完全取代** Node。但取代與否是另一個決策(部署、CSP、流量切換),
本資料夾只負責「跟 Node 行為一致的 PHP 版」這一件事。

## 切換流量(POC 之後才考慮)

詳見專案根目錄 `CLAUDE.md`。簡言:把前端的 API base URL 環境變數(`VITE_PHP_API_BASE` 之類)
寫進去、`vercel.json` 的 CSP `connect-src` 加上 PHP 主機網址、單支單支灰度切過去。
切完 8 支現有就涵蓋 ~60% Vercel API 流量;難批 port 完才能 100% 切離 Vercel。
