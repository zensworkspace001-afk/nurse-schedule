# secrets/ — Docker secrets（不進版控）

每個檔案一個值，容器內掛在 `/run/secrets/<檔名>`。程式讀取順序：環境變數 → `<名稱>_FILE` → `/run/secrets/<名稱小寫>`（`Aegis.Security.Secrets`）。檔尾換行會自動去掉。

| 檔名 | 必要 | 內容 | 產生方式 |
|---|---|---|---|
| `mssql_sa_password` | ✔ | SQL Server `sa` 密碼（只有 migrator 與備份使用） | `install.sh --generate-secrets` |
| `db_app_password` | ✔ | API 用的 `aegis_app` 帳號密碼（只有讀寫資料權限，不能改結構） | `install.sh --generate-secrets` |
| `jwt_signing_key` | ✔ | 登入權杖簽章金鑰，base64、≥ 32 bytes。換掉 = 所有人重新登入 | `install.sh --generate-secrets` |
| `field_enc_key` | ✔ | **欄位加密主金鑰**（身分證、帳號、電話、底薪），base64 32 bytes | 見下方 ⚠ |
| `field_enc_keys_previous` | 選用 | 舊金鑰（逗號分隔），換金鑰期間解舊資料用；不用就留空檔 | — |
| `smtp_password` | 選用 | 院內 SMTP 密碼；不用就留空檔 | — |

⚠ **`field_enc_key`**
- 從 Firestore 遷移過來的資料是用雲端版的 `FIELD_ENC_KEY` 加密的：**必須放同一把**，否則舊資料解不開（`Unsupported state or unable to authenticate data`）。
- 全新安裝（沒有舊資料）才可以 `install.sh --generate-secrets --new-field-key` 產生新的。
- **遺失 = 所有加密欄位永久無法解密**。安裝後立刻離線備份（例如列印封存、放保險箱），不要只存在這台主機上。

權限：`install.sh` 會把這個資料夾設成 `700`（只有 root 能進）、檔案 `444`（容器裡的非 root 使用者要能讀）。
換 `mssql_sa_password` 要先在 SQL Server 裡改密碼（`ALTER LOGIN sa WITH PASSWORD = …`）再改檔；換 `db_app_password` 改檔後重跑 `docker compose up -d`（migrator 會同步更新帳號密碼）。
