# syntax=docker/dockerfile:1
# 前端（VITE_BACKEND=aegis）+ Nginx。建置脈絡 = repo 根目錄（見 docker-compose.yml）
#   國定假日（public/holidays/）與人臉偵測模型（public/models/blazeface/）由 package.sh 在可連網機器上先下載

FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY index.html vite.config.js ./
COPY shared/ shared/
COPY src/ src/
COPY public/ public/
ENV VITE_BACKEND=aegis
# 有下載模型才指過去；沒有的話前端照舊走 tfhub（隔離網路下人臉檢查會失敗，但只是提示、不擋上傳）
RUN if [ -f public/models/blazeface/model.json ]; then export VITE_BLAZEFACE_MODEL_URL=/models/blazeface/model.json; fi \
 && npm run build \
 && rm -f dist/sphere-drop.html

# 非 root 的 Nginx（監聽 8080 / 8443）
FROM nginxinc/nginx-unprivileged:1.27-alpine
# templates/ 會在啟動時以環境變數（AEGIS_HTTPS_PORT）展開到 conf.d/（子資料夾照搬：snippets/ 不會被 conf.d/*.conf 直接載入）
COPY aegis/deploy/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY aegis/deploy/nginx/security-headers.conf.template /etc/nginx/templates/snippets/security-headers.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080 8443
