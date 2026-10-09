using Aegis.Api.Auth;
using Aegis.Data;
using Aegis.Engine;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

[assembly: Xunit.CollectionBehavior(DisableTestParallelization = true)]

namespace Aegis.Api.Tests;

// 整個 API 跑在記憶體裡：SQLite（共享記憶體資料庫）+ 測試用 JWT 金鑰 + 測試用欄位金鑰
public sealed class ApiFactory : WebApplicationFactory<Program>
{
    public static readonly string FieldKey = Convert.ToBase64String(Enumerable.Range(0, 32).Select(i => (byte)i).ToArray());
    private readonly string _cs = $"DataSource=file:aegis-{Guid.NewGuid():N}?mode=memory&cache=shared";
    private readonly SqliteConnection _keepAlive;

    // Firebase 官方範例（github.com/firebase/scrypt README）：模擬「從 Firebase 遷移過來、密碼是舊雜湊」的帳號
    public const string LegacyPassword = "user1password";
    public const string AdminPassword = "Admin1234";

    public ApiFactory()
    {
        Environment.SetEnvironmentVariable("FIELD_ENC_KEY", FieldKey);
        _keepAlive = new SqliteConnection(_cs);
        _keepAlive.Open();
    }

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseSetting("ConnectionStrings:Aegis", _cs);
        builder.UseSetting("Aegis:DatabaseProvider", "Sqlite");
        builder.UseSetting("Auth:JwtSigningKey", Convert.ToBase64String(Enumerable.Range(100, 32).Select(i => (byte)i).ToArray()));
        builder.UseSetting("Aegis:AuthPerMinute", "1000");
    }

    public void Seed()
    {
        using var scope = Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AegisDbContext>();
        if (!db.Database.EnsureCreated()) return;
        Views.CreateAsync(db).GetAwaiter().GetResult();
        var hasher = scope.ServiceProvider.GetRequiredService<IPasswordService>();
        db.LegacyHashConfig.Add(new LegacyHashConfig { SignerKey = "jxspr8Ki0RYycVU8zykbdLGjFQ3McFUH0uiiTvC8pVMXAn210wjLNmdZJzxUECKbm0QsEmYUSDzZvpjeJ9WmXA==",
                                                       SaltSeparator = "Bw==", Rounds = 8, MemoryCost = 14 });
        foreach (var (id, admin, must) in new[] { ("N001", false, false), ("N002", true, false), ("N003", false, true), ("N004", false, false) })
            db.Staff.Add(new Staff { StaffId = id, Name = id, Email = $"{id.ToLower()}@x", IsAdmin = admin, MustChangePassword = must,
                                     SpecialStatus = SpecialStatus.Standard });
        var now = DateTimeOffset.UtcNow;
        db.Users.AddRange(
            new AppUser { Id = "N001", LoginId = "n001", StaffId = "N001", CreatedAt = now,
                          PasswordHash = "firebase-scrypt$42xEC+ixf3L2lw==$lSrfV15cpx95/sZS2W9c9Kp6i/LVgQNDNC/qzrCnh1SAyZvqmZqAjTdn3aoItz+VHjoZilo78198JAdRuid5lQ==" },
            new AppUser { Id = "N002", LoginId = "n002", StaffId = "N002", CreatedAt = now, PasswordHash = hasher.Hash("Nurse2pw1") },
            new AppUser { Id = "N003", LoginId = "n003", StaffId = "N003", CreatedAt = now, PasswordHash = hasher.Hash("Nurse3pw1") },
            new AppUser { Id = "N004", LoginId = "n004", StaffId = "N004", CreatedAt = now, PasswordHash = "", Disabled = true },   // 待啟用
            new AppUser { Id = "Xq9rAnDoM", LoginId = "admin", CreatedAt = now, IsSuperAdmin = true, PasswordHash = hasher.Hash(AdminPassword) });
        db.SaveChanges();
    }

    // 排班 / 預假測試用：= local_test/run_demo.py SAMPLE_STAFF 的 14 人（N002 孕婦、N003 雙週、N009 實習生）
    public void SeedSample14()
    {
        using var scope = Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AegisDbContext>();
        var hasher = scope.ServiceProvider.GetRequiredService<IPasswordService>();
        for (int i = 5; i <= 14; i++)
        {
            string id = $"N{i:000}";
            db.Staff.Add(new Staff { StaffId = id, Name = id, Email = $"{id.ToLower()}@x", SpecialStatus = SpecialStatus.Standard,
                                     LeaveStatus = id == "N009" ? "Student" : "None" });
            db.Users.Add(new AppUser { Id = id, LoginId = id.ToLower(), StaffId = id, CreatedAt = DateTimeOffset.UtcNow, PasswordHash = hasher.Hash("Pass1word") });
        }
        var n002 = db.Staff.Single(s => s.StaffId == "N002"); n002.IsPregnantOrNursing = true;
        var n003 = db.Staff.Single(s => s.StaffId == "N003"); n003.SpecialStatus = SpecialStatus.BiWeekly;
        db.Users.Single(u => u.Id == "N004").Disabled = false;
        db.Users.Single(u => u.Id == "N004").PasswordHash = hasher.Hash("Pass1word");
        db.SaveChanges();
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (disposing) _keepAlive.Dispose();
    }
}
