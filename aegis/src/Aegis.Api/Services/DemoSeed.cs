using Aegis.Api.Auth;
using Aegis.Data;
using Aegis.Engine;
using Microsoft.EntityFrameworkCore;

namespace Aegis.Api.Services;

// 開發 / e2e 測試用的示範資料（dotnet run -- --seed-demo）。只在 Development 環境、而且資料庫是空的時候才會寫。
//   admin（超級管理員）+ N001–N014（= local_test/run_demo.py 的 14 人樣本：N002 孕婦、N003 雙週、N009 實習生）
//   密碼由環境變數 AEGIS_DEMO_ADMIN_PW / AEGIS_DEMO_STAFF_PW 提供（e2e 用 TEST_ADMIN_PW / TEST_STAFF_PW 帶進來）
public static class DemoSeed
{
    public static async Task RunAsync(IServiceProvider services, ILogger log)
    {
        using var scope = services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AegisDbContext>();
        var hasher = scope.ServiceProvider.GetRequiredService<IPasswordService>();
        if (await db.Database.EnsureCreatedAsync()) await Views.CreateAsync(db);
        if (await db.Staff.AnyAsync()) { log.LogInformation("資料庫已有資料，不寫示範資料"); return; }

        string adminPw = Environment.GetEnvironmentVariable("AEGIS_DEMO_ADMIN_PW") ?? "Admin1234";
        string staffPw = Environment.GetEnvironmentVariable("AEGIS_DEMO_STAFF_PW") ?? "Demo1234";
        var now = DateTimeOffset.UtcNow;
        db.WardSettings.Add(new WardSettings { BedCount = 20, HospitalLevel = "Regional", RatioD = 9, RatioE = 13, RatioN = 17, ReqD = 3, ReqE = 2, ReqN = 2 });
        int order = 0;
        foreach (var (code, name, color, time) in new[] {
            ("D", "白班", "#FFD93D", "08:00-16:00"), ("E", "小夜", "#FF6B9D", "16:00-24:00"), ("N", "大夜", "#4D96FF", "00:00-08:00"),
            ("RG", "例假", "#2ecc71", "例假"), ("RC", "休假", "#d5f5e3", "休假"), ("OFF", "空班", "#E8E8E8", "空班"),
            ("支援", "支援", "#D4AC0D", "09:00-18:00"), ("事假", "事假", "#95a5a6", "扣全薪"), ("病假", "病假", "#bdc3c7", "扣半薪"), ("特休", "特休", "#9af33b", "全薪") })
            db.ShiftOptions.Add(new ShiftOption { Code = code, Name = name, Color = color, Time = time, SortOrder = order++ });
        foreach (var (lv, amt) in new[] { ("N0", 0), ("N1", 1000), ("N2", 2000), ("N3", 3200), ("N4", 5000) })
            db.LevelBonuses.Add(new LevelBonus { Level = lv, Amount = amt });
        db.Users.Add(new AppUser { Id = "admin", LoginId = "admin", IsSuperAdmin = true, CreatedAt = now, PasswordHash = hasher.Hash(adminPw) });
        string[] names = ["王怡君", "林雅婷", "陳淑芬", "張家豪", "李佩珊", "黃志明", "吳欣怡", "劉建宏", "蔡宜蓁", "楊明哲", "許雅雯", "鄭家銘", "謝佳穎", "洪志偉"];
        for (int i = 1; i <= 14; i++)
        {
            string id = $"N{i:000}";
            db.Staff.Add(new Staff
            {
                StaffId = id, Name = names[i - 1], Email = $"{id.ToLower()}@example.local", Gender = i % 3 == 0 ? "男" : "女",
                Level = i <= 4 ? "N3" : i <= 9 ? "N2" : "N1", IsLeader = i == 1, TenureYears = 15 - i,
                SpecialStatus = id == "N003" ? SpecialStatus.BiWeekly : SpecialStatus.Standard,
                IsPregnantOrNursing = id == "N002", LeaveStatus = id == "N009" ? "Student" : "None",
            });
            db.Users.Add(new AppUser { Id = id, LoginId = id.ToLower(), StaffId = id, CreatedAt = now, PasswordHash = hasher.Hash(staffPw) });
        }
        await db.SaveChangesAsync();
        log.LogInformation("已寫入示範資料：admin + N001–N014");
    }
}
