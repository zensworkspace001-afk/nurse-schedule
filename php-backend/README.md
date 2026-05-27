# php-backend — Laravel 後端移植（策略 A，綠色批次）

把原本 Vercel serverless（Node.js）的後端 **逐支改寫成 Laravel**。
目前完成的是難度最低的「綠色批次」3 支端點 + 共用層。Firestore 與 React 前端
**維持不動**，PHP 只接管寫入/管理類 API（前端的 `onSnapshot` 即時訂閱 PHP 給不了）。

> ⚠️ 這批檔案是手工移植、**尚未在本機實際執行測試**（開發機未安裝 PHP/Composer）。
> 請依下方步驟在有 PHP 8.2+/Composer 的環境跑起來驗證後再上線。

## 已移植清單

| 本檔案 | 對應 Node 原始碼 |
|---|---|
| `app/Services/FieldCrypto.php` | `api/_lib/crypto.js` |
| `app/Services/Sanitizer.php` | `api/_lib/sanitize.js` |
| `app/Support/Csrf.php` | `api/_lib/csrf.js` |
| `app/Support/RateLimit.php` | `api/_lib/rateLimit.js` |
| `app/Support/Firebase.php` | 各檔開頭的 `admin.initializeApp(...)` |
| `app/Services/ActivationToken.php` | `api/_lib/activationToken.js` |
| `app/Services/AccessLog.php` | `api/_lib/accessLog.js`（write + extractClientMeta；read 留待 admin-user） |
| `app/Http/Controllers/SendEmailController.php` | `api/sendEmail.js` |
| `app/Http/Controllers/ActivateAccountController.php` | `api/activate-account.js` |
| `app/Http/Controllers/LogLoginController.php` | `api/log-login.js` |
| `routes/api.php` | Vercel `/api/*` 路由 |

## 安裝（drop-in 到全新 Laravel）

這個資料夾只放「移植出來的程式碼」，不含 Laravel 框架本體（vendor/、bootstrap 等）。
把它疊進一個全新的 Laravel 專案即可：

```bash
# 1) 建立全新 Laravel（需 PHP 8.2+、Composer、ext-openssl、ext-mbstring）
composer create-project laravel/laravel nurse-php
cd nurse-php

# 2) 安裝相依
composer require kreait/firebase-php resend/resend-php google/cloud-firestore

# 3) 把本資料夾的 app/ 與 routes/api.php 覆蓋進去
#    （app/Services、app/Support、app/Http/Controllers、routes/api.php）

# 4) 設定環境變數
cp .env.example .env      # 或把 .env.example 內容併入 Laravel 既有 .env
php artisan key:generate  # 產生 APP_KEY
# 填入 FIREBASE_*、FIELD_ENC_KEY、RESEND_API_KEY、CRON_SECRET ...

# 5) 起服務
php artisan serve --port=8000
```

> `google/cloud-firestore` 在沒有 gRPC 擴充時會走 REST（較慢但可動）；
> 正式環境建議裝 `ext-grpc` + `ext-protobuf` 以提升 Firestore 效能。

## 端點

Laravel 自動把 `routes/api.php` 前綴成 `/api`，路徑與原本一致：

- `POST /api/sendEmail`
- `POST /api/activate-account`
- `POST /api/log-login`

三支都支援 `{ "healthCheck": true }` 做存活檢查（在 CSRF/auth 之前放行）。

## 移植時刻意保留 / 改變的點

1. **加密信封相容性**（最容易出事）：`FieldCrypto` 加密前會把值包成 `{t, v}`
   JSON 信封，與 Node `serialize()` 逐型別對齊；GCM 密文本身跨語言相容。
   **`FIELD_ENC_KEY` 必須與 Node 後端同一把**，否則解不開 Firestore 上的現有密文。
2. **Rate limit 換實作**：Node 用行程內記憶體 Map；PHP-FPM 每 request 全新行程，
   記憶體計數無效，因此改用 Laravel `RateLimiter`（背後接 cache）。
   **多實例部署務必把 `CACHE_STORE` 設成 redis**，否則各機計數獨立 = 限流失效。
3. **CSRF/auth 寫在 controller 內**（非 route middleware）：因為 `healthCheck`
   要在這些檢查之前放行，與 Node 版的程式結構維持 1:1，便於對照。
4. **`AccessLog::write` fire-and-forget**：寫入失敗只記 log、不丟例外、不阻擋業務，
   與 Node 版一致。`readAccessLogs` 屬於 `admin-user.js`（非綠色），之後再補。

## 驗證建議（移植後第一件事）

- **加密互通**：用 Node 後端加密一筆 PII 存 Firestore → 用 `FieldCrypto::decrypt`
  讀回來；再反向（PHP 加密 → Node 解）。兩向都通才算信封對齊成功。
- **三支端點**：先打 `healthCheck`，再用合法 Origin + Firebase token 跑正常流程，
  並確認非法 Origin 回 403、超頻回 429。

## 切換流量

前端只需把 API base URL 指向 PHP 主機；同時 `vercel.json` 的 CSP `connect-src`
要加上 PHP 後端網址，否則正式環境瀏覽器會擋掉 fetch。建議先小流量並行（PHP 與
Node 同時在線），逐支驗證無誤再下線對應的 Vercel function。
