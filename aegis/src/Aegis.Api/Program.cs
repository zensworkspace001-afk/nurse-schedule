using System.Threading.RateLimiting;
using Aegis.Api.Auth;
using Aegis.Api.Controllers;
using Aegis.Api.Realtime;
using Aegis.Api.Services;
using Aegis.Data;
using Aegis.Scheduling;
using Aegis.Scheduling.Hosting;
using Aegis.Security;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;

// Docker healthcheck（aspnet 映像沒有 curl / wget）：dotnet Aegis.Api.dll --healthcheck → 打自己的 /health
if (args.Contains("--healthcheck"))
{
    using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
    var port = (Environment.GetEnvironmentVariable("ASPNETCORE_HTTP_PORTS") ?? "8080").Split(';')[0];
    try { Environment.ExitCode = (await http.GetAsync($"http://127.0.0.1:{port}/health")).IsSuccessStatusCode ? 0 : 1; }
    catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException) { Environment.ExitCode = 1; }
    return;
}

var builder = WebApplication.CreateBuilder(args);
var cfg = builder.Configuration;
// --migrate：一次性的 aegis-migrator 容器（以 sa 套用 migrations、建立 / 更新 API 的最小權限帳號，做完就結束）
bool migrateMode = args.Contains("--migrate");

// —— 資料庫（地端 SQL Server；測試 / 開發可用 SQLite）——
//   ConnectionStrings:Aegis 有設就直接用（開發 / 測試）；沒設就用 Aegis:Db:* + Docker secret 組（正式）
string ConnectionString()
{
    if (cfg.GetConnectionString("Aegis") is { Length: > 0 } cs) return cs;
    string host = cfg["Aegis:Db:Host"] ?? "db", name = cfg["Aegis:Db:Name"] ?? "Aegis";
    return migrateMode
        ? AegisDatabase.SqlServerConnection(host, name, "sa", Secrets.Get("MSSQL_SA_PASSWORD") ?? throw new InvalidOperationException("缺少 Docker secret mssql_sa_password"))
        : AegisDatabase.SqlServerConnection(host, name, cfg["Aegis:Db:User"] ?? "aegis_app",
                                            Secrets.Get("DB_APP_PASSWORD") ?? throw new InvalidOperationException("缺少 Docker secret db_app_password"));
}
builder.Services.AddDbContext<AegisDbContext>(o =>
{
    var cs = ConnectionString();
    if (cfg["Aegis:DatabaseProvider"] == "Sqlite") o.UseSqlite(cs); else o.UseSqlServer(cs);   // 不開 EnableRetryOnFailure：它不支援程式自己開的交易（BeginTransactionAsync）
});
builder.Services.AddSingleton(TimeProvider.System);

// —— 欄位加密（FIELD_ENC_KEY 與 Node 版同一把；Docker secret 提供）——
builder.Services.AddSingleton<IFieldKeyProvider>(_ => StaticFieldKeyProvider.FromEnvironment());
builder.Services.AddSingleton<IFieldCrypto, FieldCrypto>();

// —— 登入 ——
var authOptions = cfg.GetSection("Auth").Get<AuthOptions>() ?? new AuthOptions();
if (string.IsNullOrEmpty(authOptions.JwtSigningKey)) authOptions.JwtSigningKey = Secrets.Get("JWT_SIGNING_KEY") ?? "";   // Docker secret jwt_signing_key
builder.Services.Configure<AuthOptions>(cfg.GetSection("Auth"));
builder.Services.PostConfigure<AuthOptions>(o => o.JwtSigningKey = authOptions.JwtSigningKey);
builder.Services.AddSingleton<IPasswordService, PasswordService>();
builder.Services.AddScoped<TokenService>();
builder.Services.AddScoped<PasswordHistoryService>();
builder.Services.AddScoped<IAuditLogger, EfAuditLogger>();
builder.Services.AddScoped<AuthService>();
builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme).AddJwtBearer(o =>
{
    o.MapInboundClaims = false;   // 保留 sub / role 等原始 claim 名稱
    o.TokenValidationParameters = new TokenValidationParameters
    {
        ValidIssuer = authOptions.Issuer, ValidAudience = authOptions.Audience, IssuerSigningKey = TokenService.SigningKey(authOptions),
        ValidateLifetime = true, ClockSkew = TimeSpan.FromSeconds(30), NameClaimType = AegisClaims.Login, RoleClaimType = AegisClaims.Role,
    };
    // SignalR 的 WebSocket 無法帶 Authorization 標頭 → 允許 /hubs/* 用 access_token 查詢參數
    o.Events = new JwtBearerEvents
    {
        OnMessageReceived = ctx =>
        {
            if (ctx.HttpContext.Request.Path.StartsWithSegments("/hubs") && ctx.Request.Query.TryGetValue("access_token", out var t)) ctx.Token = t;
            return Task.CompletedTask;
        },
    };
});
builder.Services.AddAuthorization(o =>
{
    o.AddPolicy(Policies.Admin, p => p.RequireClaim(AegisClaims.Role, AegisClaims.AdminRole));
    o.AddPolicy(Policies.SuperAdmin, p => p.RequireClaim(AegisClaims.SuperAdmin, "true"));
    o.AddPolicy(Policies.Staff, p => p.RequireClaim(AegisClaims.StaffId));
});

// —— 頻率限制（取代 Node 的行程內 Map；單機地端用內建 RateLimiter）——
builder.Services.AddRateLimiter(o =>
{
    o.RejectionStatusCode = 429;
    o.AddPolicy("auth", ctx => RateLimitPartition.GetFixedWindowLimiter(ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown",
        _ => new FixedWindowRateLimiterOptions { PermitLimit = cfg.GetValue("Aegis:AuthPerMinute", 30), Window = TimeSpan.FromMinutes(1) }));
});

// —— 業務：文件讀寫、個人資料、帳號管理、即時推送、排班引擎（階段一）——
builder.Services.AddScoped<DocumentService>();
builder.Services.AddScoped<ProfileService>();
builder.Services.AddScoped<AccountService>();
builder.Services.AddSingleton<IEmailSender, SmtpEmailSender>();
builder.Services.AddScoped<RealtimeNotifier>();
builder.Services.AddAegisScheduling(o =>
{
    o.Workers = cfg.GetValue("Aegis:Engine:Workers", Math.Max(1, Environment.ProcessorCount));
    o.RequestBudgetSeconds = cfg.GetValue("Aegis:Engine:RequestBudgetSeconds", 110.0);
});
builder.Services.AddScoped<IScheduleDataStore, SqlScheduleDataStore>();
builder.Services.AddSingleton<IScheduleJobNotifier, SignalRJobNotifier>();
builder.Services.AddSingleton<RetentionService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<RetentionService>());
builder.Services.AddSignalR();

// —— 反向代理（Nginx 終結 HTTPS）：信任它送來的 X-Forwarded-For / -Proto，
//    否則頻率限制全算在 Nginx 一個 IP 上、refresh cookie 也不會標 Secure。
//    只信任 Aegis:TrustedProxies 列的網段（= compose 內部網路），外面偽造的標頭不採用。
var trustedProxies = (cfg["Aegis:TrustedProxies"] ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
builder.Services.Configure<ForwardedHeadersOptions>(o =>
{
    o.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
    o.ForwardLimit = 1;
    o.KnownNetworks.Clear();
    o.KnownProxies.Clear();
    foreach (var cidr in trustedProxies)
    {
        var parts = cidr.Split('/');
        var ip = System.Net.IPAddress.Parse(parts[0]);
        o.KnownNetworks.Add(new Microsoft.AspNetCore.HttpOverrides.IPNetwork(ip, parts.Length > 1 ? int.Parse(parts[1]) : (ip.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork ? 32 : 128)));
    }
});

builder.Services.AddControllers(o => o.Filters.Add<ApiExceptionFilter>());
var app = builder.Build();

// 示範資料（dotnet run -- --seed-demo）：Development，或明確設 Aegis:AllowDemoSeed（CI 的 compose 驗收）；資料庫是空的才寫
bool seedDemo = args.Contains("--seed-demo");
if (seedDemo && !app.Environment.IsDevelopment() && !cfg.GetValue<bool>("Aegis:AllowDemoSeed"))
    throw new InvalidOperationException("--seed-demo 只能在 Development 環境，或設定 Aegis:AllowDemoSeed=true 時使用");

if (migrateMode)
{
    using (var scope = app.Services.CreateScope())
    {
        var db = scope.ServiceProvider.GetRequiredService<AegisDbContext>();
        var applied = db.Database.IsSqlServer() ? (await db.Database.GetPendingMigrationsAsync()).ToList() : [];
        await AegisDatabase.PrepareAsync(db);
        app.Logger.LogInformation("資料庫結構已是最新（本次套用 {Count} 個 migration：{List}）", applied.Count, string.Join(", ", applied));
        if (db.Database.IsSqlServer() && Secrets.Get("DB_APP_PASSWORD") is { } appPw)
        {
            await AegisDatabase.EnsureAppLoginAsync(db, cfg["Aegis:Db:User"] ?? "aegis_app", appPw);
            app.Logger.LogInformation("API 資料庫帳號已就緒（只有讀寫資料的權限）");
        }
    }
    if (seedDemo) await DemoSeed.RunAsync(app.Services, app.Logger);
    return;
}
if (seedDemo) await DemoSeed.RunAsync(app.Services, app.Logger);

if (trustedProxies.Length > 0) app.UseForwardedHeaders();
app.UseRateLimiter();
app.UseAuthentication();
app.UseAuthorization();
app.MapControllers();
app.MapHub<ScheduleHub>("/hubs/schedule");
// 健康檢查（Docker healthcheck / install.sh / 前端系統狀態頁）：資料庫連得上、結構是最新的才算健康
app.MapGet("/health", async (AegisDbContext db, CancellationToken ct) =>
{
    string state;
    try
    {
        if (!await db.Database.CanConnectAsync(ct)) state = "unreachable";
        else if (db.Database.IsSqlServer() && (await db.Database.GetPendingMigrationsAsync(ct)).Any()) state = "pending-migrations";
        else state = "ok";
    }
    catch (Exception ex) when (ex is not OperationCanceledException) { state = "unreachable"; }
    return state == "ok"
        ? Results.Ok(new { ok = true, service = "aegis-api", db = state })
        : Results.Json(new { ok = false, service = "aegis-api", db = state }, statusCode: 503);
});
app.Run();

public partial class Program;   // WebApplicationFactory 用
