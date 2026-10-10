# certs/ — HTTPS 憑證（不進版控）

Nginx 讀這兩個檔：

| 檔名 | 內容 |
|---|---|
| `tls.crt` | 伺服器憑證（PEM），**後面接上中繼 CA**（伺服器憑證在前） |
| `tls.key` | 私鑰（PEM，不加密碼） |

由廠內 CA 簽發，SAN 必須包含使用者輸入的主機名稱（`.env` 的 `AEGIS_PUBLIC_URL`）。根 CA 由 IT 以群組原則派送到使用者電腦的受信任根憑證，瀏覽器才不會出現警告。

```bash
# 產生私鑰與 CSR，交給廠內 CA 簽發
openssl req -new -newkey rsa:3072 -nodes -keyout tls.key -out tls.csr \
  -subj "/CN=nurse-schedule.fab.local" -addext "subjectAltName=DNS:nurse-schedule.fab.local"
# 拿回憑證後：cat server.crt intermediate.crt > tls.crt
```

`install.sh` 會檢查兩個檔案都在、憑證與私鑰成對、未過期（30 天內到期會提醒），並設定權限：私鑰只給 Nginx 容器的使用者（UID 101）讀（`chown 101 tls.key && chmod 400 tls.key`）。換憑證：替換檔案後 `docker compose restart web`。
