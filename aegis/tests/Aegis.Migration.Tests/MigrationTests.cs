using System.Text.Json.Nodes;
using Aegis.Data;
using Aegis.Migration;
using Aegis.Security;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Xunit;
using Xunit.Abstractions;

namespace Aegis.Migration.Tests;

public sealed class MigrationTests(ITestOutputHelper output)
{
    private static readonly FieldCrypto Crypto = new(new StaticFieldKeyProvider(Convert.ToBase64String(Enumerable.Range(0, 32).Select(i => (byte)i).ToArray())));

    private static JsonObject Blob(string plain)
    {
        var b = Crypto.Encrypt(FieldPlain.Of(plain));
        return new JsonObject { ["ct"] = Convert.ToBase64String(b.Ciphertext), ["iv"] = Convert.ToBase64String(b.Nonce),
                                ["tag"] = Convert.ToBase64String(b.Tag), ["v"] = 1, ["kid"] = b.KeyId };
    }

    // 形狀照正式 Firestore 的實際結構（2026-10-09 唯讀盤點）
    private static FirestoreSnapshot Sample()
    {
        JsonObject Row(string id, JsonNode? idNumber, JsonNode? phone, bool withHistory) => new()
        {
            ["staff_id"] = id, ["name"] = $"名字{id}", ["email"] = $"{id}@x", ["level"] = "N2", ["is_leader"] = true, ["is_active"] = true,
            ["special_status"] = id == "N003" ? "BiWeekly" : "Standard", ["leave_status"] = "None", ["is_pregnant_or_nursing"] = false,
            ["can_night_shift"] = true, ["tenure_years"] = 5, ["accumulated_ot"] = 3, ["night_shift_balance"] = 1, ["prevMonthLeave"] = null,
            ["idNumber"] = idNumber, ["bankAccount"] = null, ["phone"] = phone,
            ["pdpa_consented_at"] = "2026-05-20T01:02:03.000Z", ["pdpa_notice_version"] = "v1", ["profile_completed"] = true,
            ["avatar"] = "data:big", ["avatar_thumb"] = "data:thumb",
            ["settlement_history"] = withHistory ? new JsonObject { ["2026-09"] = new JsonObject { ["annual"] = 1, ["ot"] = 2, ["night"] = 3 } } : null,
        };
        var rows = new JsonArray(Row("N001", Blob("A123456789"), Blob("0912345678"), true), Row("N003", "B987654321", null, false));
        var snap = new FirestoreSnapshot { Project = "test", ExportedAt = DateTimeOffset.UtcNow };
        snap.Collections["NurseApp"] =
        [
            new("Staff", new JsonObject { ["staffData"] = rows, ["healthStats"] = new JsonArray(new JsonObject { ["year"] = 2026, ["month"] = 9, ["avg"] = 88, ["median"] = 90 }) }),
            new("Settings", new JsonObject
            {
                ["bedConfig"] = new JsonObject { ["bedCount"] = 50, ["hospitalLevel"] = "MedicalCenter", ["ratioD"] = 10, ["ratioE"] = 12, ["ratioN"] = 15 },
                ["requirements"] = new JsonObject { ["D"] = 3, ["E"] = 2, ["N"] = 2, ["optimalD"] = 4 },
                ["levelBonus"] = new JsonObject { ["N0"] = 0, ["N3"] = 3200 },
                ["publishedDate"] = new JsonObject { ["year"] = 2026, ["month"] = 11 },
                ["baseSalary"] = Blob("40000"),
                ["shiftOptions"] = new JsonArray(new JsonObject { ["code"] = "D", ["name"] = "白班", ["time"] = "07-16", ["color"] = "#fff" }),
                ["priorityConfig"] = new JsonObject { ["count"] = 1 },
                ["leaveWish"] = new JsonObject { ["open"] = false, ["year"] = 2026, ["month"] = 10, ["quota"] = 4, ["days_per_person"] = 4,
                                                 ["reqs"] = new JsonObject { ["D"] = 3, ["E"] = 2, ["N"] = 2 }, ["openedAt"] = "2026-09-20T00:00:00Z" },
            }),
            new("Announcement", new JsonObject { ["active"] = true, ["kind"] = "info", ["text"] = "公告", ["updatedBy"] = new JsonObject { ["uid"] = "u", ["name"] = "n" } }),
        ];
        snap.Collections["StaffPrivate"] = [new("N001", (JsonObject)rows[0]!.DeepClone()), new("N003", new JsonObject { ["staff_id"] = "N003", ["name"] = "舊名字" })];
        snap.Collections["Schedules"] = [new("2026_11", new JsonObject
        {
            ["schedule"] = new JsonObject { ["D001"] = new JsonObject { ["1"] = new JsonObject { ["type"] = "D", ["time"] = "07-16" } } },
            ["finalizedSchedule"] = new JsonObject { ["N001"] = new JsonObject { ["1"] = new JsonObject { ["type"] = "事假" }, ["2"] = new JsonObject { ["type"] = "N", ["time"] = "23-08" } } },
        })];
        snap.Collections["archive_reports"] = [new("2026_10", new JsonObject { ["note"] = "x", ["backedUpAt"] = "2026-11-01T00:00:00Z",
            ["schedule_backup"] = new JsonObject { ["N001"] = new JsonObject { ["3"] = new JsonObject { ["type"] = "E" } } } })];
        snap.Collections["LeaveWishes"] = [new("2026_10", new JsonObject { ["version"] = 2, ["quota"] = 4 })];
        snap.Collections["LeaveWishes/2026_10/entries"] =
        [
            new("N001", new JsonObject { ["staff_id"] = "N001", ["days"] = new JsonArray(12, 5, 19, 26), ["submittedAt"] = new JsonObject { ["$ts"] = "2026-09-21T03:00:00Z" } }),
        ];
        snap.Collections["access_logs"] = [new("a1", new JsonObject { ["ts"] = "2026-10-01T00:00:00Z", ["action"] = "login",
            ["actor"] = new JsonObject { ["uid"] = "N001", ["email"] = "n001@x" }, ["target"] = new JsonObject { ["kind"] = "staff", ["id"] = null },
            ["fields"] = new JsonArray(), ["ip"] = "1.2.3.4", ["ua"] = "UA" })];
        snap.Collections["password_history"] = [new("n001", new JsonObject { ["entries"] = new JsonArray(new JsonObject { ["salt"] = "aa", ["hash"] = "bb", ["at"] = "2026-10-01T00:00:00Z" }) })];
        snap.Collections["ex_staff"] = [new("N033", new JsonObject { ["staff_id"] = "N033", ["name"] = "離職", ["had_avatar"] = false,
            ["deleted_by"] = new JsonObject { ["uid"] = "admin", ["email"] = "admin@hospital.com" } })];
        snap.SkippedCollections["SelectionTurn"] = 12;
        snap.SkippedCollections["AI_Decision_Logs"] = 82;
        return snap;
    }

    [Fact]
    public void 轉換_欄位對照_明文加密_漂移與跳過都有報告()
    {
        var plan = new SnapshotTransformer(Crypto).Transform(Sample(), new MigrationOptions());
        var n1 = plan.Staff.Single(s => s.StaffId == "N001");
        Assert.Equal("A123456789", Assert.IsType<FieldPlain.Str>(Crypto.Decrypt(n1.Sensitive!.IdNumber!)).Value);   // 密文原樣搬
        Assert.Equal(new DateTimeOffset(2026, 5, 20, 1, 2, 3, TimeSpan.Zero), n1.PdpaConsentedAt);
        Assert.Equal(("2026-09", 1, 2, 3), (n1.Settlements[0].Period, n1.Settlements[0].Annual, n1.Settlements[0].Ot, n1.Settlements[0].Night));
        var n3 = plan.Staff.Single(s => s.StaffId == "N003");
        Assert.Equal(Aegis.Engine.SpecialStatus.BiWeekly, n3.SpecialStatus);
        Assert.Equal("B987654321", Assert.IsType<FieldPlain.Str>(Crypto.Decrypt(n3.Sensitive!.IdNumber!)).Value); // 明文 → 已加密
        Assert.Equal(new[] { "N003.idNumber" }, plan.PlaintextPiiEncrypted);
        Assert.Contains(plan.Warnings, w => w.StartsWith("StaffPrivate/N003 與主檔不一致的欄位"));
        Assert.DoesNotContain(plan.Warnings, w => w.StartsWith("StaffPrivate/N001"));
        Assert.Contains(plan.Skipped, s => s.StartsWith("SelectionTurn"));
        Assert.Contains(plan.Skipped, s => s.StartsWith("Settings.priorityConfig"));
        Assert.Equal(40000, double.Parse(((FieldPlain.Str)Crypto.Decrypt(plan.Ward!.BaseSalary!)).Value));
        var w = plan.Windows.Single();
        Assert.Equal((2026, 10, 2, 4, false), (w.Year, w.Month, w.Version, w.Quota, w.Open));
        var e = plan.WishEntries.Single();
        Assert.Equal(new[] { 5, 12, 19, 26 }, e.Days.Select(d => d.Day));
        Assert.Equal(e.SubmittedAt, e.FirstSubmittedAt);                         // 舊資料沒有 firstSubmittedAt → 用 submittedAt
        Assert.Equal(new DateTimeOffset(2026, 9, 21, 3, 0, 0, TimeSpan.Zero), e.SubmittedAt);
        Assert.Equal(4, plan.Cells.Count);                                         // 草稿 1、正式 2、封存 1
        Assert.Contains(plan.Cells, c => c is { Kind: ScheduleKind.Draft, RowKey: "D001", Day: 1, ShiftType: "D", ShiftTime: "07-16" });
        Assert.Contains(plan.Cells, c => c is { Kind: ScheduleKind.Archive, RowKey: "N001", Day: 3, ShiftType: "E" });
    }

    [Fact]
    public void 轉換_沒有金鑰又遇到明文個資_拒絕而不是以明文寫入()
    {
        var ex = Assert.Throws<InvalidOperationException>(() => new SnapshotTransformer(null).Transform(Sample(), new MigrationOptions()));
        Assert.Contains("N003.idNumber", ex.Message);
    }

    [Fact]
    public async Task 快照檔_SHA256不符就拒絕匯入()
    {
        var path = Path.Combine(Path.GetTempPath(), $"snap-{Guid.NewGuid():N}.json");
        await SnapshotFile.SaveAsync(Sample(), path);
        var loaded = await SnapshotFile.LoadAsync(path);
        Assert.Equal(2, loaded.Doc("NurseApp", "Staff")!.Fields["staffData"]!.AsArray().Count);
        await File.AppendAllTextAsync(path, " ");
        var ex = await Assert.ThrowsAsync<InvalidDataException>(() => SnapshotFile.LoadAsync(path));
        Assert.Contains("SHA-256 不符", ex.Message);
        File.Delete(path); File.Delete(path + ".sha256");
    }

    [Fact]
    public async Task 匯入_試跑回滾_正式寫入對帳全部相符_加密欄位可解_檢視表可用()
    {
        await using var conn = new SqliteConnection("DataSource=:memory:");
        await conn.OpenAsync();
        DbContextOptions<AegisDbContext> opts = new DbContextOptionsBuilder<AegisDbContext>().UseSqlite(conn).Options;
        // 經過檔案存讀（數字型別與正式流程相同）
        var path = Path.Combine(Path.GetTempPath(), $"snap-{Guid.NewGuid():N}.json");
        await SnapshotFile.SaveAsync(Sample(), path);
        var snap = await SnapshotFile.LoadAsync(path);
        File.Delete(path); File.Delete(path + ".sha256");

        await using (var db = new AegisDbContext(opts))
        {
            var dry = await new MigrationLoader(db, Crypto).LoadAsync(new SnapshotTransformer(Crypto).Transform(snap, new MigrationOptions()), commit: false);
            Assert.True(dry.CountsMatch);
            Assert.False(await db.Staff.AnyAsync());                               // 試跑沒有留下資料
        }
        await using (var db = new AegisDbContext(opts))
        {
            var report = await new MigrationLoader(db, Crypto).LoadAsync(new SnapshotTransformer(Crypto).Transform(snap, new MigrationOptions()), commit: true);
            output.WriteLine(report.ToString());
            Assert.True(report.CountsMatch);
            Assert.Empty(report.UndecryptableFields);
            Assert.Equal(2, await db.StaffPublic.CountAsync());
            Assert.Equal(new[] { "OFF", "N" }, (await db.SchedulePublic.Where(c => c.Year == 2026 && c.Month == 11).ToListAsync()).OrderBy(c => c.Day).Select(c => c.ShiftType));
        }
        await using (var db = new AegisDbContext(opts))   // 再匯一次 → 拒絕（只接受空資料庫）
            await Assert.ThrowsAsync<InvalidOperationException>(() => new MigrationLoader(db, Crypto).LoadAsync(new SnapshotTransformer(Crypto).Transform(snap, new MigrationOptions()), true));
    }
}
