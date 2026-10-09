using System.Text;
using Aegis.Data;
using Aegis.Security;
using Microsoft.EntityFrameworkCore;

namespace Aegis.Migration;

public sealed record MigrationReport(
    IReadOnlyList<(string Table, int Source, int Loaded)> Counts,
    IReadOnlyList<string> UndecryptableFields, IReadOnlyList<string> PlaintextPiiEncrypted,
    IReadOnlyList<string> Skipped, IReadOnlyList<string> Warnings, bool DecryptChecked, bool Committed)
{
    public bool CountsMatch => Counts.All(c => c.Source == c.Loaded);

    public override string ToString()
    {
        var sb = new StringBuilder();
        sb.AppendLine(Committed ? "== 匯入完成（已寫入）==" : "== 試跑完成（交易已回滾，沒有寫入）==");
        sb.AppendLine("資料表                     來源    寫入");
        foreach (var (t, s, l) in Counts) sb.AppendLine($"{(s == l ? "✓" : "✗")} {t,-24} {s,6}  {l,6}");
        sb.AppendLine(DecryptChecked
            ? (UndecryptableFields.Count == 0 ? "✓ 所有加密欄位都能用目前金鑰解密" : $"✗ 目前金鑰解不開 {UndecryptableFields.Count} 個欄位：{string.Join("、", UndecryptableFields)}")
            : "— 未提供 FIELD_ENC_KEY：加密欄位的可解性沒有驗證");
        if (PlaintextPiiEncrypted.Count > 0) sb.AppendLine($"⚠ 明文個資已加密後匯入（{PlaintextPiiEncrypted.Count}）：{string.Join("、", PlaintextPiiEncrypted)}");
        foreach (var s in Skipped) sb.AppendLine($"— 不遷移：{s}");
        foreach (var w in Warnings) sb.AppendLine($"⚠ {w}");
        return sb.ToString();
    }
}

public interface IMigrationLoader
{
    Task<MigrationReport> LoadAsync(MigrationPlan plan, bool commit, CancellationToken ct = default);
}

// 單一交易寫入；試跑（commit = false）同樣完整寫入再回滾，對帳數字與正式匯入相同
public sealed class MigrationLoader(AegisDbContext db, IFieldCrypto? crypto) : IMigrationLoader
{
    public async Task<MigrationReport> LoadAsync(MigrationPlan plan, bool commit, CancellationToken ct = default)
    {
        await AegisDatabase.PrepareAsync(db, ct);   // SQL Server：套用 migrations；SQLite：建表
        if (await db.Staff.AnyAsync(ct))
            throw new InvalidOperationException("目標資料庫已經有員工資料：匯入只接受空資料庫（避免和既有資料混在一起）");

        await using var tx = await db.Database.BeginTransactionAsync(ct);
        db.Staff.AddRange(plan.Staff);
        if (plan.Ward != null) db.WardSettings.Add(plan.Ward);
        db.ShiftOptions.AddRange(plan.ShiftOptions);
        db.LevelBonuses.AddRange(plan.LevelBonuses);
        if (plan.Announcement != null) db.Announcements.Add(plan.Announcement);
        db.LeaveWishWindows.AddRange(plan.Windows);
        db.LeaveWishEntries.AddRange(plan.WishEntries);
        db.ScheduleMonths.AddRange(plan.Months);
        db.ScheduleCells.AddRange(plan.Cells);
        db.ArchiveReports.AddRange(plan.Archives);
        db.HealthStats.AddRange(plan.HealthStats);
        db.AccessLogs.AddRange(plan.AccessLogs);
        db.PasswordHistory.AddRange(plan.PasswordHistory);
        db.ExStaff.AddRange(plan.ExStaff);
        db.Users.AddRange(plan.Users);
        if (plan.HashConfig != null) db.LegacyHashConfig.Add(plan.HashConfig);
        await db.SaveChangesAsync(ct);
        db.ChangeTracker.Clear();

        // 對帳：從資料庫重新數，不是數記憶體裡的清單
        var counts = new List<(string, int, int)>
        {
            ("Staff", plan.SourceCounts.GetValueOrDefault("staff"), await db.Staff.CountAsync(ct)),
            ("SettlementRecord", plan.Staff.Sum(s => s.Settlements.Count), await db.Settlements.CountAsync(ct)),
            ("StaffSensitive", plan.Staff.Count(s => s.Sensitive != null), await db.StaffSensitive.CountAsync(ct)),
            ("StaffAvatar", plan.Staff.Count(s => s.Avatar != null), await db.StaffAvatars.CountAsync(ct)),
            ("ShiftOption", plan.ShiftOptions.Count, await db.ShiftOptions.CountAsync(ct)),
            ("LevelBonus", plan.LevelBonuses.Count, await db.LevelBonuses.CountAsync(ct)),
            ("LeaveWishWindow", plan.Windows.Count, await db.LeaveWishWindows.CountAsync(ct)),
            ("LeaveWishEntry", plan.SourceCounts.Where(k => k.Key.EndsWith("/entries")).Sum(k => k.Value), await db.LeaveWishEntries.CountAsync(ct)),
            ("ScheduleMonth", plan.SourceCounts.GetValueOrDefault("Schedules"), await db.ScheduleMonths.CountAsync(ct)),
            ("ScheduleCell", plan.Cells.Count, await db.ScheduleCells.CountAsync(ct)),
            ("ArchiveReport", plan.SourceCounts.GetValueOrDefault("archive_reports"), await db.ArchiveReports.CountAsync(ct)),
            ("MonthlyHealthStat", plan.SourceCounts.GetValueOrDefault("healthStats"), await db.HealthStats.CountAsync(ct)),
            ("AccessLog", plan.SourceCounts.GetValueOrDefault("access_logs"), await db.AccessLogs.CountAsync(ct)),
            ("PasswordHistory(docs)", plan.SourceCounts.GetValueOrDefault("password_history"),
                await db.PasswordHistory.Select(p => p.StaffId).Distinct().CountAsync(ct)),
            ("ExStaff", plan.SourceCounts.GetValueOrDefault("ex_staff"), await db.ExStaff.CountAsync(ct)),
            ("AppUser", plan.SourceCounts.GetValueOrDefault("auth_users"), await db.Users.CountAsync(ct)),
        };

        var undecryptable = new List<string>();
        if (crypto != null)
        {
            foreach (var s in await db.StaffSensitive.AsNoTracking().ToListAsync(ct))
                foreach (var (name, v) in new[] { ("idNumber", s.IdNumber), ("bankAccount", s.BankAccount), ("phone", s.Phone) })
                    if (v != null && !CanDecrypt(v)) undecryptable.Add($"{s.StaffId}.{name}");
            var ward = await db.WardSettings.AsNoTracking().FirstOrDefaultAsync(ct);
            if (ward?.BaseSalary != null && !CanDecrypt(ward.BaseSalary)) undecryptable.Add("Settings.baseSalary");
        }

        if (commit) await tx.CommitAsync(ct); else await tx.RollbackAsync(ct);
        return new MigrationReport(counts, undecryptable, plan.PlaintextPiiEncrypted, plan.Skipped, plan.Warnings, crypto != null, commit);
    }

    private bool CanDecrypt(EncryptedValue v)
    {
        try { crypto!.Decrypt(v); return true; } catch (System.Security.Cryptography.CryptographicException) { return false; }
    }
}
