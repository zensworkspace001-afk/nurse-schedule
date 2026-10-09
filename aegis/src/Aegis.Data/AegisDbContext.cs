using Aegis.Engine;
using Aegis.Security;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Aegis.Data;

public sealed class AegisDbContext(DbContextOptions<AegisDbContext> options) : DbContext(options)
{
    public DbSet<Staff> Staff => Set<Staff>();
    public DbSet<StaffSensitive> StaffSensitive => Set<StaffSensitive>();
    public DbSet<StaffAvatar> StaffAvatars => Set<StaffAvatar>();
    public DbSet<SettlementRecord> Settlements => Set<SettlementRecord>();
    public DbSet<WardSettings> WardSettings => Set<WardSettings>();
    public DbSet<ShiftOption> ShiftOptions => Set<ShiftOption>();
    public DbSet<LevelBonus> LevelBonuses => Set<LevelBonus>();
    public DbSet<Announcement> Announcements => Set<Announcement>();
    public DbSet<LeaveWishWindow> LeaveWishWindows => Set<LeaveWishWindow>();
    public DbSet<LeaveWishEntry> LeaveWishEntries => Set<LeaveWishEntry>();
    public DbSet<LeaveWishDay> LeaveWishDays => Set<LeaveWishDay>();
    public DbSet<ScheduleCell> ScheduleCells => Set<ScheduleCell>();
    public DbSet<ScheduleMonth> ScheduleMonths => Set<ScheduleMonth>();
    public DbSet<ArchiveReport> ArchiveReports => Set<ArchiveReport>();
    public DbSet<MonthlyHealthStat> HealthStats => Set<MonthlyHealthStat>();
    public DbSet<AccessLog> AccessLogs => Set<AccessLog>();
    public DbSet<PasswordHistoryEntry> PasswordHistory => Set<PasswordHistoryEntry>();
    public DbSet<ExStaff> ExStaff => Set<ExStaff>();
    public DbSet<AppUser> Users => Set<AppUser>();
    public DbSet<RefreshToken> RefreshTokens => Set<RefreshToken>();
    public DbSet<OneTimeToken> OneTimeTokens => Set<OneTimeToken>();
    public DbSet<LegacyHashConfig> LegacyHashConfig => Set<LegacyHashConfig>();
    public DbSet<StaffPublicView> StaffPublic => Set<StaffPublicView>();
    public DbSet<SchedulePublicView> SchedulePublic => Set<SchedulePublicView>();

    protected override void OnModelCreating(ModelBuilder b)
    {
        b.Entity<Staff>(e =>
        {
            e.ToTable("Staff");
            e.Property(x => x.SpecialStatus).HasConversion<string>().HasMaxLength(16);
            e.HasOne(x => x.Sensitive).WithOne().HasForeignKey<StaffSensitive>(x => x.StaffId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.Avatar).WithOne().HasForeignKey<StaffAvatar>(x => x.StaffId).OnDelete(DeleteBehavior.Cascade);
            e.HasMany(x => x.Settlements).WithOne().HasForeignKey(x => x.StaffId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<StaffSensitive>(e =>
        {
            e.ToTable("StaffSensitive");
            Encrypted(e.OwnsOne(x => x.IdNumber), "IdNumber");
            Encrypted(e.OwnsOne(x => x.BankAccount), "BankAccount");
            Encrypted(e.OwnsOne(x => x.Phone), "Phone");
        });
        b.Entity<StaffAvatar>().ToTable("StaffAvatar");
        b.Entity<SettlementRecord>(e => { e.ToTable("SettlementRecord"); e.HasKey(x => new { x.StaffId, x.Period }); });
        b.Entity<WardSettings>(e =>
        {
            e.ToTable("WardSettings");
            e.Property(x => x.Id).ValueGeneratedNever();
            Encrypted(e.OwnsOne(x => x.BaseSalary), "BaseSalary");
        });
        b.Entity<ShiftOption>().ToTable("ShiftOption");
        b.Entity<LevelBonus>().ToTable("LevelBonus");
        b.Entity<Announcement>(e => { e.ToTable("Announcement"); e.Property(x => x.Id).ValueGeneratedNever(); });
        b.Entity<LeaveWishWindow>(e => { e.ToTable("LeaveWishWindow"); e.HasKey(x => new { x.Year, x.Month }); });
        b.Entity<LeaveWishEntry>(e =>
        {
            e.ToTable("LeaveWishEntry");
            e.HasKey(x => new { x.Year, x.Month, x.StaffId });
            e.HasMany(x => x.Days).WithOne().HasForeignKey(d => new { d.Year, d.Month, d.StaffId }).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<LeaveWishDay>(e => { e.ToTable("LeaveWishDay"); e.HasKey(x => new { x.Year, x.Month, x.StaffId, x.Day }); });
        b.Entity<ScheduleCell>(e =>
        {
            e.ToTable("ScheduleCell");
            e.HasKey(x => new { x.Year, x.Month, x.Kind, x.RowKey, x.Day });
            e.Property(x => x.Kind).HasConversion<byte>();
        });
        b.Entity<ScheduleMonth>(e => { e.ToTable("ScheduleMonth"); e.HasKey(x => new { x.Year, x.Month }); });
        b.Entity<ArchiveReport>(e => { e.ToTable("ArchiveReport"); e.HasKey(x => new { x.Year, x.Month }); });
        b.Entity<MonthlyHealthStat>(e => { e.ToTable("MonthlyHealthStat"); e.HasKey(x => new { x.Year, x.Month }); });
        b.Entity<AccessLog>(e =>
        {
            e.ToTable("AccessLog");
            e.HasIndex(x => x.Ts);
            e.HasIndex(x => new { x.Action, x.Ts });
        });
        b.Entity<PasswordHistoryEntry>(e => { e.ToTable("PasswordHistory"); e.HasKey(x => new { x.StaffId, x.Seq }); });
        b.Entity<ExStaff>().ToTable("ExStaff");
        b.Entity<AppUser>(e => { e.ToTable("AppUser"); e.HasIndex(x => x.LoginId).IsUnique(); e.HasIndex(x => x.StaffId); });
        b.Entity<RefreshToken>(e => { e.ToTable("RefreshToken"); e.HasIndex(x => x.UserId); e.HasIndex(x => x.FamilyId); });
        b.Entity<OneTimeToken>(e => { e.ToTable("OneTimeToken"); e.HasIndex(x => new { x.UserId, x.Purpose }); });
        b.Entity<LegacyHashConfig>(e => { e.ToTable("LegacyHashConfig"); e.Property(x => x.Id).ValueGeneratedNever(); });
        b.Entity<StaffPublicView>(e => { e.HasNoKey(); e.ToView("vStaffPublic"); });
        if (!Database.IsSqlServer())   // SQLite（測試用）沒有 rowversion：改成一般欄位、不當並行權杖（並行用 LeaveWishWindow.Version）
        {
            b.Entity<Staff>().Property(x => x.RowVersion).IsConcurrencyToken(false).ValueGeneratedNever();
            b.Entity<ScheduleMonth>().Property(x => x.RowVersion).IsConcurrencyToken(false).ValueGeneratedNever();
        }
        b.Entity<SchedulePublicView>(e => { e.HasNoKey(); e.ToView("vSchedulePublic"); });
    }

    private static void Encrypted<T>(OwnedNavigationBuilder<T, EncryptedValue> o, string prefix) where T : class
    {
        o.Property(x => x.Ciphertext).HasColumnName($"{prefix}Ciphertext");
        o.Property(x => x.Nonce).HasColumnName($"{prefix}Nonce").HasMaxLength(12);
        o.Property(x => x.Tag).HasColumnName($"{prefix}Tag").HasMaxLength(16);
        o.Property(x => x.Version).HasColumnName($"{prefix}Version");
        o.Property(x => x.KeyId).HasColumnName($"{prefix}KeyId").HasMaxLength(8);
    }
}

// 兩個檢視表的 DDL（建表後執行；SQL Server 與 SQLite 的字串字面值語法不同）
public static class Views
{
    public static IEnumerable<string> CreateSql(bool sqlServer)
    {
        string N(string s) => sqlServer ? $"N'{s}'" : $"'{s}'";
        yield return """
            CREATE VIEW vStaffPublic AS
            SELECT s.StaffId, s.Name, s.Level, s.IsLeader, s.IsActive, a.AvatarThumb
            FROM Staff s LEFT JOIN StaffAvatar a ON a.StaffId = s.StaffId
            """;
        yield return $"""
            CREATE VIEW vSchedulePublic AS
            SELECT c.Year, c.Month, c.RowKey, c.Day,
                   CASE WHEN c.ShiftType IN ({N("事假")}, {N("病假")}, {N("特休")}) THEN 'OFF' ELSE c.ShiftType END AS ShiftType,
                   c.ShiftTime
            FROM ScheduleCell c WHERE c.Kind = {(int)ScheduleKind.Final}
            """;
    }

    public static async Task CreateAsync(AegisDbContext db, CancellationToken ct = default)
    {
        bool sqlServer = db.Database.ProviderName?.Contains("SqlServer") == true;
        foreach (var sql in CreateSql(sqlServer)) await db.Database.ExecuteSqlRawAsync(sql, ct);
    }
}
