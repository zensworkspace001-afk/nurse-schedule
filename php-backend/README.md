# php-backend — Laravel 13 移植「綠色批次」(策略 A)

把原本 Vercel serverless（Node.js）的後端**逐支改寫成 Laravel**，這個資料夾現在
是一個**可獨立執行的 Laravel 13 app**，不是只放原始碼。Firestore 與 React 前端
維持不動，PHP 只接管寫入/管理類 API（前端的 `onSnapshot` 即時訂閱 PHP 給不了）。

> 這是**策略 A** 的 POC —— 為了驗證 PHP 版與 Node 版行為一致，不取代任何線上服務。
> Vercel 上的 13 支 Node endpoint 與前端流量都沒有變動。

## 此次已移植（綠色批次：易）

| 端點 | 對應 Node | 狀態 |
|---|---|---|
| `POST /api/sendEmail` | `api/sendEmail.js` | ✅ 已實測（Resend SDK 接通，回 `API key is invalid` 證明走到 Resend 端） |
| `POST /api/activate-account` | `api/activate-account.js` | ⚠️ 路由+控制器 OK；Firestore 部分需 grpc，見下方 |
| `POST /api/log-login` | `api/log-login.js` | ✅ 已實測（CSRF 403、healthCheck 200、寫稽核 fire-and-forget 不擋業務） |

共用層：`FieldCrypto` (AES-256-GCM + Node 同款 `{t,v}` 信封)、`Sanitizer`、`Csrf`、
`RateLimit` (Laravel cache)、`Firebase` (kreait 入口)、`ActivationToken`、`AccessLog`。

## 跑起來

需要 **PHP 8.2+** + **Composer**（Laragon 的 8.3 完全 OK）。

```bash
cd php-backend
composer install              # 抓 vendor/（已 gitignore，不會進 repo）
cp .env.example .env          # 或自己編輯
php artisan key:generate      # 產生 APP_KEY
# 填 FIREBASE_*、FIELD_ENC_KEY、RESEND_API_KEY、CRON_SECRET（從 Vercel env 對齊）
php artisan serve --port=8000
```

路由清單 (`php artisan serve` 後 `php artisan route:list --path=api`)：

```
POST api/activate-account
POST api/log-login
POST api/sendEmail
```

三支都支援 `{ "healthCheck": true }` 在 CSRF/auth 之前的存活檢查。

## 已驗證過什麼

| 驗證項 | 結果 |
|---|---|
| 11 支 PHP `php -l` 語法 | ✅ 全過 |
| 加密信封 **PHP ↔ Node** 雙向互通 | ✅ 中文/數字/浮點/布林/null/巢狀皆完整還原 |
| Sanitizer：清 `<script>`、`onerror`、`javascript:`、`<iframe>` | ✅ |
| Sanitizer：偵測身分證 / 台灣手機 | ✅ |
| 路由註冊（`bootstrap/app.php` 接上 `routes/api.php`）| ✅ |
| HTTP 200：log-login healthCheck | ✅ |
| HTTP 403：無 Origin + 無 CRON_SECRET 被擋 | ✅ |
| HTTP 200：fire-and-forget 在 Firestore 失敗時不擋業務 | ✅ |
| HTTP 503：sendEmail healthCheck 真的打到 Resend API | ✅ |

## ⚠️ Firestore (grpc) 注意事項

`google/cloud-firestore` 在 Windows 上**需要 ext-grpc** 才能用。本機目前沒裝 grpc，
所以下列功能會在 Firestore 呼叫處失敗（但**不會讓 app 崩潰**，因為 `AccessLog::write`
是 fire-and-forget，`ActivationToken` 的失敗會被 controller 包成 400/500 回去）：

- `activate-account` 的 token 讀寫
- `log-login` 的稽核寫入（成功登入分支 + 失敗稽核分支）

兩條路二選一：

1. **裝 grpc DLL**：從 PECL 下載對應 PHP 8.3 TS x64 VS16 的 `php_grpc.dll`，放進
   `C:\laragon\bin\php\php-8.3.30-Win32-vs16-x64\ext\`，並在 `php.ini` 加
   `extension=grpc`，然後 `composer require google/cloud-firestore`。
2. **改走 Firestore REST API**：用 Guzzle 直接打 `https://firestore.googleapis.com/v1/...`，
   service account 用 `google/auth` 取 OAuth token。純 PHP、無原生擴充，但要多寫一些程式碼。

正式部署到 Linux 主機 (Laravel Forge / Railway / Docker) 時 grpc 比較好裝，本機開發
偷懶選 REST 也合理。

## 刻意保留 / 與 Node 版的差異

1. **加密信封逐型別對齊 Node `serialize()`**（`{t, v}` JSON 包裝）。GCM 跨語言相容，但
   **`FIELD_ENC_KEY` 必須與 Node 後端同一把**，否則解不開 Firestore 上的現有密文。
2. **Rate limit 換實作**：Node 用行程內記憶體 Map；PHP-FPM 每 request 全新行程，
   改用 Laravel `RateLimiter`（背後接 cache）。多實例部署 **`CACHE_STORE` 設 redis**。
3. **CSRF/auth 留在 controller 內**（非 route middleware）：讓 `healthCheck` 能在所有
   檢查之前放行，與 Node 版 1:1。
4. **`AccessLog::write` fire-and-forget**：與 Node 版一致，寫入失敗只記 log，不擋業務。
5. **`readAccessLogs`**：屬於 `admin-user.js`（非綠色批次），等移植到時再補。

## 切換流量（POC 之後才考慮）

前端把 API base URL 改指向 PHP 後端，同時 `vercel.json` 的 CSP `connect-src` 要加上
PHP 後端網址；建議先小流量並行（PHP 與 Node 同時在線），逐支驗證無誤再下線對應的
Vercel function。

## 還沒做的批次

- **中**：`complete-profile`、`claim-schedule`（Firestore 交易）、`auto-settle`、`cron/check-timeout`
- **難**：`gemini`、`auto-relay`、`analyze-excel`、`admin-user`（含 `readAccessLogs`）
