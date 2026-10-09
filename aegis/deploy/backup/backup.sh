#!/usr/bin/env bash
# SQL Server 完整備份 → deploy/backups/<資料庫>_<時間>.bak（+ .sha256），驗證可還原，刪掉超過保留天數的舊檔。
# 建議每天跑一次（install.sh 結束時會印出 crontab 範例）。Express 版不支援備份壓縮。
# ⚠ 備份和資料庫在同一台主機：請另外排程把 backups/ 複製到其他主機或媒體。
set -euo pipefail
cd "$(dirname "$0")/.."

env_val() { grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- || true; }
DB="$(env_val AEGIS_DB_NAME)"; DB="${DB:-Aegis}"
KEEP="$(env_val BACKUP_RETENTION_DAYS)"; KEEP="${KEEP:-7}"
[[ "$DB" =~ ^[A-Za-z0-9_]+$ ]] || { echo "AEGIS_DB_NAME 只能是英數字與底線：$DB" >&2; exit 1; }
[[ "$KEEP" =~ ^[0-9]+$ ]] || { echo "BACKUP_RETENTION_DAYS 必須是整數：$KEEP" >&2; exit 1; }

FILE="${DB}_$(date +%Y%m%d_%H%M%S).bak"
echo "[$(date '+%F %T')] 備份 $DB → backups/$FILE"
# 密碼在容器內從 Docker secret 讀，不經過主機的命令列
docker compose exec -T -e DB="$DB" -e FILE="$FILE" db bash -c '
  /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P "$(cat /run/secrets/mssql_sa_password)" -b -Q "
    BACKUP DATABASE [$DB] TO DISK = N'\''/var/opt/mssql/backup/$FILE'\'' WITH CHECKSUM, INIT, STATS = 50;
    RESTORE VERIFYONLY FROM DISK = N'\''/var/opt/mssql/backup/$FILE'\'' WITH CHECKSUM;"'

if command -v sha256sum >/dev/null; then (cd backups && sha256sum "$FILE" > "$FILE.sha256"); else (cd backups && shasum -a 256 "$FILE" > "$FILE.sha256"); fi
find backups -maxdepth 1 -name "${DB}_*.bak*" -mtime +"$KEEP" -print -delete | sed 's/^/刪除過期備份：/'
echo "[$(date '+%F %T')] 完成（保留 $KEEP 天）"
