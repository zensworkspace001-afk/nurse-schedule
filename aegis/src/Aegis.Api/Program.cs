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
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;

var builder = WebApplication.CreateBuilder(args);
var cfg = builder.Configuration;

// —— 資料庫（地端 SQL Server；測試 / 開發可用 SQLite）——
builder.Services.AddDbContext<AegisDbContext>(o =>
{
    var cs = cfg.GetConnectionString("Aegis") ?? throw new InvalidOperationException("缺少 ConnectionStrings:Aegis");
    if (cfg["Aegis:DatabaseProvider"] == "Sqlite") o.UseSqlite(cs); else o.UseSqlServer(cs);
});
builder.Services.AddSingleton(TimeProvider.System);

// —— 欄位加密（FIELD_ENC_KEY 與 Node 版同一把；Docker secret 提供）——
builder.Services.AddSingleton<IFieldKeyProvider>(_ => StaticFieldKeyProvider.FromEnvironment());
builder.Services.AddSingleton<IFieldCrypto, FieldCrypto>();

// —— 登入 ——
builder.Services.Configure<AuthOptions>(cfg.GetSection("Auth"));
var authOptions = cfg.GetSection("Auth").Get<AuthOptions>() ?? new AuthOptions();
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

builder.Services.AddControllers(o => o.Filters.Add<ApiExceptionFilter>());
var app = builder.Build();

// 開發 / e2e：dotnet run -- --seed-demo（只在 Development；資料庫是空的才寫）
if (args.Contains("--seed-demo"))
{
    if (!app.Environment.IsDevelopment()) throw new InvalidOperationException("--seed-demo 只能在 Development 環境使用");
    await DemoSeed.RunAsync(app.Services, app.Logger);
}
app.UseRateLimiter();
app.UseAuthentication();
app.UseAuthorization();
app.MapControllers();
app.MapHub<ScheduleHub>("/hubs/schedule");
app.MapGet("/health", () => Results.Ok(new { ok = true, service = "aegis-api" }));
app.Run();

public partial class Program;   // WebApplicationFactory 用
