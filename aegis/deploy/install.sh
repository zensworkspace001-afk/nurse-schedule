#!/usr/bin/env bash
# 神盾計畫 地端安裝 / 升級（隔離網路主機上，以 root 執行）
#   sudo ./install.sh                                   安裝或升級（升級前自動備份）
#   sudo ./install.sh --generate-secrets                第一次安裝：產生 sa / API 帳號密碼與 JWT 金鑰
#   sudo ./install.sh --generate-secrets --new-field-key  全新安裝、沒有要遷移的舊資料時才用（見 secrets/README.md）
#   --skip-load   不載入 images/（映像已在本機，例如 CI）
# macOS（Colima / Docker Desktop）只供試用：不需要 root，檔案擁有者改用寬鬆權限讓容器讀得到
set -euo pipefail
cd "$(dirname "$0")"

GEN=0; NEW_FIELD_KEY=0; SKIP_LOAD=0
for a in "$@"; do
  case "$a" in
    --generate-secrets) GEN=1 ;;
    --new-field-key) NEW_FIELD_KEY=1 ;;
    --skip-load) SKIP_LOAD=1 ;;
    *) echo "不認得的參數：$a" >&2; exit 2 ;;
  esac
done

step() { printf '\n== %s\n' "$*"; }
die() { echo "✗ $*" >&2; exit 1; }
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
env_val() { local key="$1"; grep -E "^${key}=" .env 2>/dev/null | tail -1 | cut -d= -f2- || true; }
set_env() { local key="$1" val="$2"; sed -i.bak "s#^${key}=.*#${key}=${val}#" .env && rm -f .env.bak; }   # GNU / BSD sed 都能用

MAC=0; [[ "$(uname -s)" == Darwin ]] && MAC=1
if [[ $MAC == 1 ]]; then
  echo "⚠ macOS：只供試用 / 展示（檔案權限放寬、不是正式部署）"
else
  [[ "$(id -u)" == 0 ]] || die "請用 root 執行（sudo ./install.sh）：要設定機密檔與憑證的擁有者"
fi
command -v docker >/dev/null || die "找不到 docker"
docker compose version >/dev/null 2>&1 || die "需要 Docker Compose v2（docker compose）"
command -v openssl >/dev/null || die "找不到 openssl"

if [[ -f SHA256SUMS ]]; then
  step "驗證安裝包完整性"
  if command -v sha256sum >/dev/null; then sha256sum --quiet -c SHA256SUMS; else shasum -a 256 -q -c SHA256SUMS; fi || die "SHA-256 不符：安裝包在搬運途中損毀或被改動"
  echo "✓ 全部檔案相符"
fi

if [[ $SKIP_LOAD == 0 && -d images ]]; then
  step "載入映像"
  for f in images/*.tar.gz; do echo "· $f"; docker load -i "$f" | tail -1; done
fi

step "設定檔 .env"
if [[ ! -f .env ]]; then
  cp .env.example .env
  [[ -f VERSION ]] && set_env AEGIS_VERSION "$(cat VERSION)"
  chmod 600 .env
  die "已從 .env.example 建立 .env：請修改 AEGIS_PUBLIC_URL 等設定後再執行一次"
fi
if [[ -f VERSION ]]; then set_env AEGIS_VERSION "$(cat VERSION)"; fi
echo "版本 $(env_val AEGIS_VERSION)，網址 $(env_val AEGIS_PUBLIC_URL)"

step "機密 secrets/"
mkdir -p secrets
gen_password() { printf '%sAa1' "$(openssl rand -base64 30 | tr -d '\n/+=')"; }   # 符合 SQL Server 密碼複雜度
missing=()
for name in mssql_sa_password db_app_password jwt_signing_key field_enc_key; do
  f="secrets/$name"
  [[ -s "$f" ]] && continue
  case "$name:$GEN:$NEW_FIELD_KEY" in
    mssql_sa_password:1:*|db_app_password:1:*) gen_password > "$f"; echo "· 已產生 $name" ;;
    jwt_signing_key:1:*) openssl rand -base64 48 | tr -d '\n' > "$f"; echo "· 已產生 $name" ;;
    field_enc_key:*:1) openssl rand -base64 32 | tr -d '\n' > "$f"; echo "· 已產生 $name —— ⚠ 立刻離線備份這把金鑰" ;;
    *) missing+=("$name") ;;
  esac
done
((${#missing[@]} == 0)) || die "缺少機密：${missing[*]}（見 secrets/README.md；密碼與 JWT 金鑰可用 --generate-secrets 產生）"
for name in field_enc_keys_previous smtp_password; do [[ -f "secrets/$name" ]] || : > "secrets/$name"; done
[[ "$(openssl base64 -d -A <<< "$(cat secrets/field_enc_key)" 2>/dev/null | wc -c | tr -d ' ')" == 32 ]] || die "secrets/field_enc_key 必須是 base64 編碼的 32 bytes"
if [[ $MAC == 0 ]]; then chown -R root:root secrets; chmod 700 secrets; fi   # 資料夾只有 root 能進
find secrets -type f -exec chmod 444 {} +                                     # 檔案讓容器裡的非 root 使用者讀
echo "✓ 機密齊全"

step "HTTPS 憑證 certs/"
[[ -s certs/tls.crt && -s certs/tls.key ]] || die "缺少 certs/tls.crt 或 certs/tls.key（見 certs/README.md）"
crt_pub="$(openssl x509 -in certs/tls.crt -noout -pubkey | sha256)"
key_pub="$(openssl pkey -in certs/tls.key -pubout | sha256)"
[[ "$crt_pub" == "$key_pub" ]] || die "certs/tls.crt 與 certs/tls.key 不成對"
openssl x509 -in certs/tls.crt -noout -checkend 0 >/dev/null || die "憑證已過期：$(openssl x509 -in certs/tls.crt -noout -enddate)"
openssl x509 -in certs/tls.crt -noout -checkend 2592000 >/dev/null || echo "⚠ 憑證 30 天內到期：$(openssl x509 -in certs/tls.crt -noout -enddate)"
if [[ $MAC == 0 ]]; then chown 101:101 certs/tls.key; chmod 400 certs/tls.key; else chmod 444 certs/tls.key; fi   # 101 = nginx-unprivileged 的使用者
chmod 444 certs/tls.crt
echo "✓ $(openssl x509 -in certs/tls.crt -noout -subject)"

mkdir -p backups   # 10001 = SQL Server 容器的 mssql 使用者
[[ $MAC == 1 ]] || chown 10001:0 backups   # macOS（Colima）以登入使用者的身分寫入，不用改擁有者
chmod 770 backups

if [[ -n "$(docker compose ps -q db 2>/dev/null)" ]]; then
  step "升級前備份"
  ./backup/backup.sh
fi

step "啟動（migrator 先套用資料庫結構變更）"
docker compose up -d --remove-orphans

PORT="$(env_val AEGIS_HTTPS_PORT)"; PORT="${PORT:-443}"
printf '等待服務就緒'
for _ in $(seq 1 120); do
  if curl -fsk "https://127.0.0.1:$PORT/health" 2>/dev/null | grep -q '"ok":true'; then ok=1; break; fi
  if [[ "$(docker compose ps -a migrator --format '{{.State}} {{.ExitCode}}' 2>/dev/null)" =~ ^exited\ [1-9] ]]; then break; fi
  printf '.'; sleep 5
done
echo
if [[ "${ok:-0}" != 1 ]]; then
  docker compose ps -a
  echo "—— migrator ——"; docker compose logs --tail 50 migrator
  echo "—— api ——"; docker compose logs --tail 50 api
  die "服務沒有在 10 分鐘內就緒（上面是最近的紀錄）"
fi
curl -fsk -o /dev/null "https://127.0.0.1:$PORT/" || die "前端首頁打不開"

step "完成"
echo "✓ $(env_val AEGIS_PUBLIC_URL) 已就緒（/health：資料庫連線正常、結構為最新）"
echo "· 每日備份（建議加進 root 的 crontab）："
echo "    30 2 * * * $(pwd)/backup/backup.sh >> /var/log/aegis-backup.log 2>&1"
echo "· 從 Firestore 遷移資料：見 README.md「正式匯入」"
