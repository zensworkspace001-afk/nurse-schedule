#!/usr/bin/env bash
# 在「可連網、有 Docker 的機器」上打包離線安裝包：
#   ./aegis/deploy/package.sh [版本]      → aegis/deploy/dist/aegis-<版本>.tar（+ .sha256）
# 內容：三個映像（docker save + gzip）、compose 與設定範本、install.sh、備份 / 還原腳本、說明文件、SHA256SUMS。
# 前端映像會內含國定假日資料（public/holidays/）與人臉偵測模型（public/models/blazeface/），這兩樣在隔離網路下載不到。
set -euo pipefail
DEPLOY="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DEPLOY/../.." && pwd)"
cd "$ROOT"

VERSION="${1:-$(git describe --tags --always --dirty 2>/dev/null || date +%Y%m%d)}"
[[ "$VERSION" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "版本只能是英數字、點、底線、減號：$VERSION" >&2; exit 1; }
MSSQL_TAG="$(grep -E '^MSSQL_TAG=' "$DEPLOY/.env.example" | cut -d= -f2-)"
YEAR="$(date +%Y)"
HOLIDAY_YEARS="${HOLIDAY_YEARS:-$YEAR $((YEAR + 1))}"
OUT="$DEPLOY/dist/aegis-$VERSION"

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
step() { printf '\n== %s\n' "$*"; }

step "國定假日：$HOLIDAY_YEARS"
# shellcheck disable=SC2086
node aegis/scripts/fetch-holidays.mjs $HOLIDAY_YEARS --out public/holidays

step "人臉偵測模型（BlazeFace，Apache-2.0）"
MODEL_DIR=public/models/blazeface
MODEL_URL=https://tfhub.dev/tensorflow/tfjs-model/blazeface/1/default/1
mkdir -p "$MODEL_DIR"
curl -fsSL "$MODEL_URL/model.json?tfjs-format=file" -o "$MODEL_DIR/model.json"
for shard in $(node -e 'const m=require(process.argv[1]);for(const g of m.weightsManifest)for(const p of g.paths)console.log(p)' "$ROOT/$MODEL_DIR/model.json"); do
  [[ "$shard" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "模型檔名不合預期：$shard" >&2; exit 1; }
  curl -fsSL "$MODEL_URL/$shard?tfjs-format=file" -o "$MODEL_DIR/$shard"
done

step "建置映像（版本 $VERSION）"
# 直接 docker build（不經 compose：compose 會要求 secrets/ 的檔案已存在）；per-Dockerfile 的 .dockerignore 需要 BuildKit
docker build --pull --platform linux/amd64 -f "$DEPLOY/api.Dockerfile" -t "aegis-api:$VERSION" "$ROOT/aegis"
docker build --pull --platform linux/amd64 -f "$DEPLOY/web.Dockerfile" -t "aegis-web:$VERSION" "$ROOT"
docker pull --platform linux/amd64 "mcr.microsoft.com/mssql/server:$MSSQL_TAG"

step "匯出映像 → $OUT"
rm -rf "$OUT"; mkdir -p "$OUT/images" "$OUT/secrets" "$OUT/certs" "$OUT/backup"
docker save "aegis-api:$VERSION" | gzip > "$OUT/images/aegis-api.tar.gz"
docker save "aegis-web:$VERSION" | gzip > "$OUT/images/aegis-web.tar.gz"
docker save "mcr.microsoft.com/mssql/server:$MSSQL_TAG" | gzip > "$OUT/images/mssql.tar.gz"

cp "$DEPLOY/docker-compose.yml" "$DEPLOY/.env.example" "$DEPLOY/install.sh" "$DEPLOY/README.md" "$OUT/"
cp "$DEPLOY/backup/backup.sh" "$DEPLOY/backup/restore.sh" "$OUT/backup/"
cp "$DEPLOY/secrets/README.md" "$OUT/secrets/"
cp "$DEPLOY/certs/README.md" "$OUT/certs/"
echo "$VERSION" > "$OUT/VERSION"
git rev-parse HEAD > "$OUT/COMMIT" 2>/dev/null || true
(cd "$OUT" && find . -type f ! -name SHA256SUMS | LC_ALL=C sort | xargs sha256 > SHA256SUMS)

tar -C "$DEPLOY/dist" -cf "$DEPLOY/dist/aegis-$VERSION.tar" "aegis-$VERSION"
(cd "$DEPLOY/dist" && sha256 "aegis-$VERSION.tar" > "aegis-$VERSION.tar.sha256")
step "完成"
ls -lh "$DEPLOY/dist/aegis-$VERSION.tar"
cat "$DEPLOY/dist/aegis-$VERSION.tar.sha256"
echo "把 .tar 與 .tar.sha256 帶進隔離網路 → 驗 SHA-256 → 解開 → sudo ./install.sh（說明見 README.md）"
