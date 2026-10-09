# syntax=docker/dockerfile:1
# Aegis.Api（+ ETL 工具 Aegis.Migration）映像。建置脈絡 = aegis/（見 docker-compose.yml）
#   docker build -f deploy/api.Dockerfile -t aegis-api:<版本> aegis/
# 同一個映像三種用法：API 服務（預設）、--migrate（一次性的 aegis-migrator）、dotnet /app/tools/Aegis.Migration.dll（正式匯入）

FROM mcr.microsoft.com/dotnet/sdk:8.0-bookworm-slim AS build
WORKDIR /src
COPY Aegis.sln ./
COPY src/ src/
# linux-x64：OR-Tools 只帶這一個平台的原生函式庫（不帶 osx / win，映像小一半）
RUN dotnet publish src/Aegis.Api -c Release -r linux-x64 --self-contained false -o /out/api \
 && dotnet publish src/Aegis.Migration -c Release -r linux-x64 --self-contained false -o /out/tools

# aspnet 映像是 Debian（glibc）：OR-Tools 的原生函式庫需要 glibc，不能用 alpine（musl）
FROM mcr.microsoft.com/dotnet/aspnet:8.0-bookworm-slim
WORKDIR /app
COPY --from=build /out/api ./api
COPY --from=build /out/tools ./tools
ENV ASPNETCORE_ENVIRONMENT=Production \
    ASPNETCORE_HTTP_PORTS=8080 \
    DOTNET_gcServer=0
# 非 root（映像內建的 app 使用者，UID 1654）
USER $APP_UID
EXPOSE 8080
ENTRYPOINT ["dotnet", "/app/api/Aegis.Api.dll"]
