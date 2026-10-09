using Aegis.Data;
using Aegis.Engine;
using Aegis.Scheduling;
using Aegis.Security;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace Aegis.Data.Tests;

// SQLite 記憶體資料庫：驗證資料層邏輯（SQL Server 專屬的 rowversion / migration 在有 SQL Server 的環境另外驗）
public sealed class SqliteDb : IDisposable
{
    private readonly SqliteConnection _conn = new("DataSource=:memory:");
    public SqliteDb()
    {
        _conn.Open();
        using var db = New();
        db.Database.EnsureCreated();
        Views.CreateAsync(db).GetAwaiter().GetResult();
    }
    public AegisDbContext New() => new(new DbContextOptionsBuilder<AegisDbContext>().UseSqlite(_conn).Options);
    public void Dispose() => _conn.Dispose();

    // = local_test/run_demo.py SAMPLE_STAFF（N002 孕婦、N003 雙週、N009 實習生）
    public void SeedSampleStaff()
    {
        using var db = New();
        for (int i = 1; i <= 14; i++)
        {
            string id = $"N{i:000}";
            db.Staff.Add(new Staff
            {
                StaffId = id, Name = id, Email = $"{id.ToLower()}@example.com", Level = "N1",
                SpecialStatus = id == "N003" ? SpecialStatus.BiWeekly : SpecialStatus.Standard,
                IsPregnantOrNursing = id == "N002", LeaveStatus = id == "N009" ? "Student" : "None",
            });
        }
        db.SaveChanges();
    }
}

public sealed class DataLayerTests : IDisposable
{
    private readonly SqliteDb _db = new();
    public void Dispose() => _db.Dispose();

    private static readonly string TestKey = Convert.ToBase64String(Enumerable.Range(0, 32).Select(i => (byte)i).ToArray());

    [Fact]
    public async Task 公開名單檢視只露出6個欄位_含頭貼縮圖()
    {
        using (var db = _db.New())
        {
            db.Staff.Add(new Staff { StaffId = "N001", Name = "王小明", Level = "N3", IsLeader = true, IsPregnantOrNursing = true,
                                     Avatar = new StaffAvatar { StaffId = "N001", Avatar = "data:big", AvatarThumb = "data:thumb" } });
            await db.SaveChangesAsync();
        }
        using var db2 = _db.New();
        var row = Assert.Single(await db2.StaffPublic.ToListAsync());
        Assert.Equal(("N001", "王小明", "N3", true, true, "data:thumb"), (row.StaffId, row.Name, row.Level, row.IsLeader, row.IsActive, row.AvatarThumb));
        var cols = typeof(StaffPublicView).GetProperties().Select(p => p.Name).ToHashSet();
        Assert.DoesNotContain("IsPregnantOrNursing", cols);   // 孕哺等敏感欄位不在公開檢視
    }

    [Fact]
    public async Task 公開班表檢視_假別遮成OFF_只含正式班表()
    {
        using (var db = _db.New())
        {
            foreach (var (day, type, kind) in new[] { (1, "D", ScheduleKind.Final), (2, "事假", ScheduleKind.Final), (3, "病假", ScheduleKind.Final),
                                                     (4, "特休", ScheduleKind.Final), (5, "RG", ScheduleKind.Final), (6, "N", ScheduleKind.Draft) })
                db.ScheduleCells.Add(new ScheduleCell { Year = 2026, Month = 11, Kind = kind, RowKey = "N001", Day = day, ShiftType = type });
            await db.SaveChangesAsync();
        }
        using var db2 = _db.New();
        var rows = (await db2.SchedulePublic.ToListAsync()).OrderBy(r => r.Day).Select(r => r.ShiftType).ToList();
        Assert.Equal(new[] { "D", "OFF", "OFF", "OFF", "RG" }, rows);
    }

    [Fact]
    public async Task 加密欄位存進資料庫再讀出_解密後值不變()
    {
        var crypto = new FieldCrypto(new StaticFieldKeyProvider(TestKey));
        using (var db = _db.New())
        {
            db.Staff.Add(new Staff { StaffId = "N001", Name = "x",
                Sensitive = new StaffSensitive { StaffId = "N001", IdNumber = crypto.Encrypt(FieldPlain.Of("A123456789")),
                                                 Phone = crypto.Encrypt(FieldPlain.Of("0912345678")) } });
            db.WardSettings.Add(new WardSettings { BaseSalary = crypto.Encrypt(new FieldPlain.Num(40000)) });
            await db.SaveChangesAsync();
        }
        using var db2 = _db.New();
        var s = await db2.StaffSensitive.SingleAsync();
        Assert.Equal("A123456789", Assert.IsType<FieldPlain.Str>(crypto.Decrypt(s.IdNumber!)).Value);
        Assert.Equal("0912345678", Assert.IsType<FieldPlain.Str>(crypto.Decrypt(s.Phone!)).Value);
        Assert.Null(s.BankAccount);
        Assert.Equal(40000, Assert.IsType<FieldPlain.Num>(crypto.Decrypt((await db2.WardSettings.SingleAsync()).BaseSalary!)).Value);
        Assert.Equal(crypto.CurrentKeyId, s.IdNumber!.KeyId);
    }

    [Fact]
    public async Task 預假樂觀鎖_版本變了或超過配額就拒絕_改日期保留順位()
    {
        using var db = _db.New();
        var store = new SqlScheduleDataStore(db);
        Assert.True(await store.CommitWishAsync(2026, 8, "N001", new[] { 8, 9, 15, 16 }, 0, 2, default));
        Assert.False(await store.CommitWishAsync(2026, 8, "N002", new[] { 1, 2, 3, 4 }, 0, 2, default));   // 版本已是 1
        Assert.True(await store.CommitWishAsync(2026, 8, "N002", new[] { 8, 2, 3, 4 }, 1, 2, default));
        Assert.False(await store.CommitWishAsync(2026, 8, "N003", new[] { 8, 5, 6, 7 }, 2, 2, default));   // 8 號已 2 人 = 配額
        Assert.True(await store.CommitWishAsync(2026, 8, "N001", new[] { 20, 21, 22, 23 }, 2, 2, default)); // 本人改日期：舊日期釋出

        var state = await store.GetWishStateAsync(2026, 8, default);
        Assert.Equal(3, state.Version);
        Assert.Equal(new[] { "N001", "N002" }, state.Entries.Select(e => e.Key));      // N001 改日期仍排在前面（第一次登記時間不變）
        Assert.Equal(new[] { 20, 21, 22, 23 }, state.Entries[0].Value);
        Assert.Equal(new[] { 2, 3, 4, 8 }, state.Entries[1].Value);
    }

    [Fact]
    public async Task 業務層接SQL資料層_預假送出流程與假資料庫行為相同()
    {
        _db.SeedSampleStaff();
        using (var db = _db.New())
        {
            db.LeaveWishWindows.Add(new LeaveWishWindow { Year = 2026, Month = 8, Open = true, ReqD = 3, ReqE = 3, ReqN = 2, Quota = 6,
                                                          DaysPerPerson = 4, OpenedAt = DateTimeOffset.UtcNow });
            await db.SaveChangesAsync();
        }
        using var db2 = _db.New();
        var prechecks = new FeasibilityPrechecks();
        var scheduler = new CpSatScheduler(new ScheduleModelBuilder(), prechecks);
        var staffing = new StaffingCalculator(scheduler, prechecks);
        var service = new ScheduleService(new SqlScheduleDataStore(db2), new InMemoryStaffingCache(), scheduler, staffing,
                                          new WishFeasibilityChecker(scheduler, prechecks), new ScheduleInspector(),
                                          Microsoft.Extensions.Options.Options.Create(new SchedulingOptions()));
        var ok = await service.SubmitWishAsync("n001", new[] { 8, 9, 15, 16 });   // 工號大小寫不拘
        Assert.Equal(5, ok.Remaining["8"]);
        var changed = await service.SubmitWishAsync("N001", new[] { 1, 2, 3, 4 });
        Assert.Equal(6, changed.Remaining["8"]);
        var ex = await Assert.ThrowsAsync<ScheduleDomainException>(() => service.SubmitWishAsync("N999", new[] { 8, 9, 15, 16 }));
        Assert.Equal(ScheduleErrorKind.Forbidden, ex.Kind);
        var settings = await new SqlScheduleDataStore(db2).GetLeaveSettingsAsync(default);
        Assert.True(settings!.Open);
        Assert.Equal(new ShiftRequirement(3, 3, 2), settings.Reqs);
    }
}
