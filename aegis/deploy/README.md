# 神盾計畫 地端部署（階段五）

隔離網路單機部署：Docker Compose 跑四個服務。

```
瀏覽器 ──HTTPS──▶ web（Nginx：前端 + 反向代理，廠內 CA 憑證）
                    │  /api、/hubs（WebSocket）、/health
                    ▼
                  api（Aegis.Api：登入、資料、SignalR、CP-SAT 排班）──SMTP──▶ 院內郵件（選用）
                    │  aegis_app 帳號（只有讀寫資料權限）
                    ▼
                  db（SQL Server 2022 Express，只在內部網路，沒有對外 port）
                    ▲
                  migrator（每次啟動先以 sa 套用 EF Core migrations、同步 aegis_app 帳號，成功才放行 api）
```

| 檔案 | 用途 |
|---|---|
| `docker-compose.yml` | 正式部署（映像 `pull_policy: never`：絕不嘗試連外） |
| `docker-compose.ci.yml` | CI 覆寫：示範資料、SQL Server 開給測試、放寬登入頻率 |
| `api.Dockerfile` / `web.Dockerfile` | 兩個自建映像（非 root；API 用 Debian 是因為 OR-Tools 需要 glibc） |
| `nginx/` | Nginx 設定範本（TLS、WebSocket、CSP 等安全標頭、SPA） |
| `.env.example` | 一般設定（網址、port、資源上限、SMTP） |
| `secrets/` | 密碼與金鑰（[README](secrets/README.md)） |
| `certs/` | HTTPS 憑證（[README](certs/README.md)） |
| `package.sh` | 可連網機器：打包離線安裝包 |
| `install.sh` | 隔離網路主機：安裝 / 升級 |
| `backup/backup.sh`、`backup/restore.sh` | 每日備份、還原 |

## 1. 打包（可連網、有 Docker 的機器）

```bash
./aegis/deploy/package.sh 1.0.0
# → aegis/deploy/dist/aegis-1.0.0.tar 與 .tar.sha256（約 1 GB：SQL Server 映像佔大部分）
```

會先下載國定假日資料與人臉偵測模型（隔離網路下載不到），再建置映像、`docker save`、為每個檔案算 SHA-256。

## 2. 安裝（隔離網路主機，Linux x86-64，Docker Engine + Compose v2）

```bash
sha256sum -c aegis-1.0.0.tar.sha256 && tar xf aegis-1.0.0.tar && cd aegis-1.0.0
sudo ./install.sh                      # 第一次：建立 .env 後停下，請修改 AEGIS_PUBLIC_URL 等設定
# 放好 certs/tls.crt、certs/tls.key，以及 secrets/field_enc_key（見下方）
sudo ./install.sh --generate-secrets   # 產生 sa / aegis_app 密碼與 JWT 金鑰 → 載入映像 → 啟動 → 健康檢查
```

`install.sh` 會依序：驗 `SHA256SUMS` → `docker load` → 檢查 `.env`、機密、憑證（成對、未過期）並設定權限 → 已在執行就先備份 → `docker compose up -d` → 等 `https://127.0.0.1/health` 回報資料庫正常、結構為最新。

**`field_enc_key`（欄位加密主金鑰）**：要從 Firestore 遷移資料，就**必須放雲端版 Vercel 的同一把 `FIELD_ENC_KEY`**，否則遷移過來的身分證 / 帳號 / 電話 / 底薪都解不開。只有全新安裝（不遷移）才用 `--new-field-key` 產生新的。不論哪一種，**安裝後立刻離線備份這把金鑰**。

## 3. 正式匯入（從 Firestore 遷移，只做一次）

快照在可連網機器上以 `Aegis.Migration export` 產生（見 [`aegis/README.md` 階段二](../README.md)），用加密隨身碟帶進來：

```bash
# 先試跑：完整寫入再回滾，只看對帳報告
sudo docker compose run --rm -v /media/usb:/import:ro --entrypoint dotnet migrator \
  /app/tools/Aegis.Migration.dll import --in /import/snapshot.json
# 對帳全部相符、沒有解不開的欄位 → 正式寫入
sudo docker compose run --rm -v /media/usb:/import:ro --entrypoint dotnet migrator \
  /app/tools/Aegis.Migration.dll import --in /import/snapshot.json --commit
```

匯入工具在 API 映像裡，以 Docker secret 的 sa 密碼與 `field_enc_key` 連線、加密，不需要在命令列輸入密碼。只接受空資料庫。匯入後銷毀隨身碟上的快照（含加密個資與密碼雜湊）。

## 4. 升級

用新版本的安裝包再跑一次 `sudo ./install.sh`（沿用舊的 `.env`、`secrets/`、`certs/`，複製過去即可）。流程會先備份，再由 migrator 套用新的 migrations；migrator 失敗時 api 不會啟動，舊資料不受影響（還原見下方）。

## 5. 備份與還原

```bash
sudo crontab -e      # 每天 02:30：30 2 * * * /opt/aegis/backup/backup.sh >> /var/log/aegis-backup.log 2>&1
sudo ./backup/restore.sh backups/Aegis_20261101_023000.bak   # 會要求輸入資料庫名稱確認
```

- 完整備份（`WITH CHECKSUM` + `RESTORE VERIFYONLY`）寫到 `backups/`，附 `.sha256`，保留 `BACKUP_RETENTION_DAYS` 天。Express 版不支援備份壓縮。
- **備份和資料庫在同一台主機**：請另外排程把 `backups/` 複製到其他主機或媒體。
- 還原到另一台主機：把 `.bak` 放進那台的 `backups/` 再執行 `restore.sh`；之後 migrator 會重新對應 `aegis_app` 帳號（孤立使用者）。**還要同一把 `field_enc_key`**，加密欄位才解得開。

## 6. 日常維運

| 要做的事 | 指令 |
|---|---|
| 狀態 | `sudo docker compose ps` |
| 紀錄 | `sudo docker compose logs -f api`（每個容器最多保留 5 × 20 MB） |
| 換憑證 | 替換 `certs/` 兩個檔 → `sudo docker compose restart web` |
| 換 `db_app_password` | 改檔 → `sudo docker compose up -d --force-recreate migrator api` |
| 換 `jwt_signing_key` | 改檔 → `sudo docker compose up -d --force-recreate api`（所有人要重新登入） |
| 換欄位加密金鑰 | 舊金鑰移到 `field_enc_keys_previous`、新金鑰放 `field_enc_key` → 重建 api；舊資料仍可解，新寫入用新金鑰 |

## 7. 擴充：多台 API 時要加 Redis

目前是**單一 API 實例**，以下狀態都在 API 行程的記憶體裡，單機時正確，多實例時就不對了：

| 狀態 | 單實例 | 多實例的問題 | 對策 |
|---|---|---|---|
| SignalR 群組與連線 | 行程內 | A 實例發的推送，連在 B 實例的瀏覽器收不到 | `Microsoft.AspNetCore.SignalR.StackExchangeRedis`：`AddSignalR().AddStackExchangeRedis(…)` |
| 登入頻率限制 | 行程內 `RateLimiter` | 每台各算各的，上限變成 N 倍 | 改用 Redis 計數（例如 `RedisRateLimiting`），或在 Nginx 層用 `limit_req` |
| 排班背景工作與人力試算快取 | 行程內佇列 / 快取 | 送工作的實例和查狀態的實例不同 → 查不到 | 工作狀態寫 SQL（或 Redis），並讓排班工作只在一台跑 |

做法：compose 加一個 `redis` 服務（只在內部網路、`requirepass` 放 Docker secret），上面三項改接 Redis，Nginx 的 `upstream aegis_api` 列多台並對 `/hubs/` 開 `ip_hash`（SignalR 長輪詢需要黏著）。資料本身都在 SQL Server，不受影響。**單台主機的負載（一個病房、數十人）不需要做這一步。**

## 驗收（CI）

`.github/workflows/ci.yml` 的 **e2e-aegis-docker** 每次都照上面流程部署一次：建置映像 → `install.sh --generate-secrets --new-field-key` → 對 `https://localhost:8443` 跑整組地端 Playwright e2e → 資料層 / ETL / API 測試改連真的 SQL Server（`AEGIS_TEST_SQLSERVER`，走 migrations）→ 用映像裡的匯入工具匯入樣本快照 → 備份、還原、再確認健康檢查。
