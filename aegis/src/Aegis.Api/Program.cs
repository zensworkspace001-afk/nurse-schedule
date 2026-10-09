using System.Threading.RateLimiting;
using Aegis.Api.Auth;
using Aegis.Data;
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

builder.Services.AddControllers();
var app = builder.Build();
app.UseRateLimiter();
app.UseAuthentication();
app.UseAuthorization();
app.MapControllers();
app.MapGet("/health", () => Results.Ok(new { ok = true, service = "aegis-api" }));
app.Run();

public partial class Program;   // WebApplicationFactory 用
