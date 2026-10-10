#!/usr/bin/env bash
# 從 backups/ 的備份還原資料庫（災難復原 / 還原演練）。會停掉 web、api，還原後重新啟動（migrator 會重新對應 API 帳號、補上較新的 migrations）。
#   ./backup/restore.sh backups/Aegis_20261101_023000.bak
set -euo pipefail
cd "$(dirname "$0")/.."

BAK="${1:?用法：./backup/restore.sh backups/<檔名>.bak}"
NAME="$(basename "$BAK")"
[[ -f "backups/$NAME" ]] || { echo "找不到 backups/$NAME（備份檔必須放在 deploy/backups/ 裡）" >&2; exit 1; }
[[ "$NAME" =~ ^[A-Za-z0-9_.-]+$ ]] || { echo "檔名只能是英數字、底線、點、減號：$NAME" >&2; exit 1; }
if [[ -f "backups/$NAME.sha256" ]]; then
  (cd backups && { sha256sum -c "$NAME.sha256" 2>/dev/null || shasum -a 256 -c "$NAME.sha256"; }) || { echo "SHA-256 不符：備份檔已損毀" >&2; exit 1; }
fi
DB="$(grep -E '^AEGIS_DB_NAME=' .env 2>/dev/null | tail -1 | cut -d= -f2-)"; DB="${DB:-Aegis}"
[[ "$DB" =~ ^[A-Za-z0-9_]+$ ]] || { echo "AEGIS_DB_NAME 只能是英數字與底線：$DB" >&2; exit 1; }

read -r -p "會用 $NAME 覆蓋資料庫 $DB 的所有資料，輸入資料庫名稱確認：" ans
[[ "$ans" == "$DB" ]] || { echo "已取消"; exit 1; }

docker compose stop web api
docker compose exec -T -e DB="$DB" -e FILE="$NAME" db bash -c '
  /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P "$(cat /run/secrets/mssql_sa_password)" -b -Q "
    IF DB_ID(N'\''$DB'\'') IS NOT NULL ALTER DATABASE [$DB] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
    RESTORE DATABASE [$DB] FROM DISK = N'\''/var/opt/mssql/backup/$FILE'\'' WITH REPLACE, CHECKSUM, STATS = 25;
    ALTER DATABASE [$DB] SET MULTI_USER;"'
docker compose up -d
echo "還原完成；請登入確認資料。"
