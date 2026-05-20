# 護理排班 CP-SAT 引擎 — production container
# 設計目標：給 Render / Railway / Fly.io / Cloud Run 部署用
#
# Render / Railway 平台會自動注入 $PORT 環境變數，所以 CMD 用 sh -c 形式
# 確保變數展開。本機跑 docker run 時若沒設 PORT 預設用 8000。

FROM python:3.12-slim

# SA 演算法純 Python，不需要額外 native libs
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先複製 requirements 利用 Docker layer cache（依賴沒改就不重裝）
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main1.py .

# 預設 healthcheck（Render/Fly.io 會自動接管，這條主要給 docker compose 用）
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:${PORT:-8000}/health').read()"

EXPOSE 8000

CMD ["sh", "-c", "uvicorn main1:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1"]
