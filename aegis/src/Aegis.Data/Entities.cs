using System.ComponentModel.DataAnnotations;
using Aegis.Engine;
using Aegis.Security;

namespace Aegis.Data;

// 階段二 EF Core 實體（使用者已確認的設計）。對照 Firestore：
//   NurseApp/Staff + StaffPublic + StaffPrivate/{id} → Staff + StaffSensitive + StaffAvatar（公開投影改成檢視表 vStaffPublic）
//   NurseApp/Settings → WardSettings + ShiftOption + LevelBonus；Settings.leaveWish + LeaveWishes/{ym} → LeaveWishWindow
//   Schedules / archive_reports → ScheduleCell（SchedulesPublic 改成檢視表 vSchedulePublic）

public class Staff
{
    [Key, MaxLength(32)] public string StaffId { get; set; } = "";
    [MaxLength(100)] public string Name { get; set; } = "";
    [MaxLength(200)] public string Email { get; set; } = "";
    [MaxLength(16)] public string? Gender { get; set; }
    [MaxLength(8)] public string Level { get; set; } = "N0";
    public bool IsLeader { get; set; }
    public bool IsActive { get; set; } = true;
    public SpecialStatus SpecialStatus { get; set; }
    [MaxLength(16)] public string LeaveStatus { get; set; } = "None";
    public bool IsPregnantOrNursing { get; set; }
    public bool CanNightShift { get; set; } = true;
    public int TenureYears { get; set; }
    public int AccumulatedOt { get; set; }
    public int NightShiftBalance { get; set; }
    public int? AnnualLeaveUsed { get; set; }
    public bool? ProfileCompleted { get; set; }        // null = 精靈上線前的舊帳號（前端判斷 === false，三種狀態要保留）
    public DateTimeOffset? ProfileCompletedAt { get; set; }
    public DateTimeOffset? ProfileUpdatedAt { get; set; }
    public DateTimeOffset? PdpaConsentedAt { get; set; }
    [MaxLength(16)] public string? PdpaNoticeVersion { get; set; }
    public bool MustChangePassword { get; set; }
    public bool IsAdmin { get; set; }
    [Timestamp] public byte[] RowVersion { get; set; } = [];
    public StaffSensitive? Sensitive { get; set; }
    public StaffAvatar? Avatar { get; set; }
    public List<SettlementRecord> Settlements { get; set; } = [];
}

public class StaffSensitive   // 加密個資獨立一張表：權限、稽核分開
{
    [Key, MaxLength(32)] public string StaffId { get; set; } = "";
    public EncryptedValue? IdNumber { get; set; }
    public EncryptedValue? BankAccount { get; set; }
    public EncryptedValue? Phone { get; set; }
}

public class StaffAvatar      // 頭貼 data URL 另放，Staff 列保持精簡
{
    [Key, MaxLength(32)] public string StaffId { get; set; } = "";
    public string? Avatar { get; set; }
    public string? AvatarThumb { get; set; }
}

public class SettlementRecord   // = staffData[*].settlement_history["YYYY-MM"]
{
    [MaxLength(32)] public string StaffId { get; set; } = "";
    [MaxLength(7)] public string Period { get; set; } = "";
    public int Annual { get; set; }
    public int Ot { get; set; }
    public int Night { get; set; }
}

public class WardSettings       // 單列（Id = 1）
{
    public int Id { get; set; } = 1;
    public int BedCount { get; set; }
    [MaxLength(32)] public string HospitalLevel { get; set; } = "";
    public int RatioD { get; set; }
    public int RatioE { get; set; }
    public int RatioN { get; set; }
    public int ReqD { get; set; }
    public int ReqE { get; set; }
    public int ReqN { get; set; }
    public int? OptimalD { get; set; }
    public int? OptimalE { get; set; }
    public int? OptimalN { get; set; }
    public EncryptedValue? BaseSalary { get; set; }
    public int? PublishedYear { get; set; }
    public int? PublishedMonth { get; set; }
}

public class ShiftOption
{
    [Key, MaxLength(8)] public string Code { get; set; } = "";
    [MaxLength(32)] public string Name { get; set; } = "";
    [MaxLength(32)] public string Time { get; set; } = "";
    [MaxLength(16)] public string Color { get; set; } = "";
    public int SortOrder { get; set; }
}

public class LevelBonus
{
    [Key, MaxLength(8)] public string Level { get; set; } = "";
    public int Amount { get; set; }
}

public class Announcement       // 單列（Id = 1）
{
    public int Id { get; set; } = 1;
    public bool Active { get; set; }
    [MaxLength(16)] public string Kind { get; set; } = "";
    public string Text { get; set; } = "";
    public DateTimeOffset? UpdatedAt { get; set; }
    [MaxLength(64)] public string? UpdatedByUid { get; set; }
    [MaxLength(100)] public string? UpdatedByName { get; set; }
}

public class LeaveWishWindow    // 每月一列；= Settings.leaveWish + LeaveWishes/{ym} 的表頭（每日人數改由查詢算）
{
    public int Year { get; set; }
    public int Month { get; set; }
    public bool Open { get; set; }
    public int ReqD { get; set; }
    public int ReqE { get; set; }
    public int ReqN { get; set; }
    public int Quota { get; set; }
    public int DaysPerPerson { get; set; } = 4;
    public DateTimeOffset? OpenedAt { get; set; }
    public DateTimeOffset? ClosedAt { get; set; }
    [ConcurrencyCheck] public int Version { get; set; }   // = Firestore version（樂觀鎖）
}

public class LeaveWishEntry
{
    public int Year { get; set; }
    public int Month { get; set; }
    [MaxLength(32)] public string StaffId { get; set; } = "";
    public DateTimeOffset FirstSubmittedAt { get; set; }   // 名額不夠時先登記的優先；改日期不會失去順位
    public DateTimeOffset SubmittedAt { get; set; }
    public List<LeaveWishDay> Days { get; set; } = [];
}

public class LeaveWishDay
{
    public int Year { get; set; }
    public int Month { get; set; }
    [MaxLength(32)] public string StaffId { get; set; } = "";
    public int Day { get; set; }   // 1-indexed
}

public enum ScheduleKind : byte { Draft = 0, Final = 1, Archive = 2 }

public class ScheduleCell       // 一人一天一列
{
    public int Year { get; set; }
    public int Month { get; set; }
    public ScheduleKind Kind { get; set; }
    [MaxLength(32)] public string RowKey { get; set; } = "";   // 員工編號，或舊認領流程的虛擬列 D001（不設外鍵）
    public int Day { get; set; }
    [MaxLength(16)] public string ShiftType { get; set; } = "";
    [MaxLength(32)] public string? ShiftTime { get; set; }
}

public class ScheduleMonth
{
    public int Year { get; set; }
    public int Month { get; set; }
    [Timestamp] public byte[] RowVersion { get; set; } = [];
}

public class ArchiveReport
{
    public int Year { get; set; }
    public int Month { get; set; }
    public string? Note { get; set; }
    public string? Csv { get; set; }
    public DateTimeOffset? BackedUpAt { get; set; }
}

public class MonthlyHealthStat
{
    public int Year { get; set; }
    public int Month { get; set; }
    public int Avg { get; set; }
    public int Median { get; set; }
}

public class AccessLog          // 與 sql/access_logs.sql（MySQL 版）同欄位
{
    public long Id { get; set; }
    public DateTimeOffset Ts { get; set; }
    [MaxLength(128)] public string? ActorUid { get; set; }
    [MaxLength(200)] public string? ActorEmail { get; set; }
    [MaxLength(30)] public string Action { get; set; } = "";
    [MaxLength(32)] public string? TargetKind { get; set; }
    [MaxLength(128)] public string? TargetId { get; set; }
    public string? FieldsJson { get; set; }
    [MaxLength(64)] public string? Ip { get; set; }
    [MaxLength(512)] public string? Ua { get; set; }
    public string? ExtraJson { get; set; }
}

public class PasswordHistoryEntry   // scrypt（見 Aegis.Security.Scrypt）
{
    [MaxLength(32)] public string StaffId { get; set; } = "";   // 小寫（= Firestore doc id）
    public int Seq { get; set; }
    [MaxLength(64)] public string Salt { get; set; } = "";
    [MaxLength(128)] public string Hash { get; set; } = "";
    public DateTimeOffset At { get; set; }
}

public class ExStaff            // 離職歸檔（刻意不含加密個資）
{
    [Key, MaxLength(32)] public string StaffId { get; set; } = "";
    [MaxLength(100)] public string Name { get; set; } = "";
    [MaxLength(200)] public string? Email { get; set; }
    [MaxLength(8)] public string? Level { get; set; }
    public int? TenureYears { get; set; }
    public string? Avatar { get; set; }
    public string? AvatarThumb { get; set; }
    public bool HadAvatar { get; set; }
    public DateTimeOffset? DeletedAt { get; set; }
    [MaxLength(128)] public string? DeletedByUid { get; set; }
    [MaxLength(200)] public string? DeletedByEmail { get; set; }
}

// 檢視表（唯讀）
public class StaffPublicView    // = 舊 NurseApp/StaffPublic：同事看得到的 6 個欄位
{
    public string StaffId { get; set; } = "";
    public string Name { get; set; } = "";
    public string Level { get; set; } = "";
    public bool IsLeader { get; set; }
    public bool IsActive { get; set; }
    public string? AvatarThumb { get; set; }
}

public class SchedulePublicView // = 舊 SchedulesPublic：事假 / 病假 / 特休 → OFF
{
    public int Year { get; set; }
    public int Month { get; set; }
    public string RowKey { get; set; } = "";
    public int Day { get; set; }
    public string ShiftType { get; set; } = "";
    public string? ShiftTime { get; set; }
}
