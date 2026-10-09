using System.Collections.Concurrent;
using System.Text.Json.Serialization;
using Aegis.Engine;

namespace Aegis.Scheduling;

// ============================================================
// 資料存取（介面在此；SQL Server 實作在階段二）
// ============================================================

// 員工資料的原始列（= Firestore NurseApp/Staff.staffData[*]；缺欄位以 null 表示，套預設值的規則在 Eligibility）
public sealed record StaffRow(
    string? StaffId, string? Name = null, bool? IsActive = null, string? SpecialStatus = null,
    bool? IsPregnantOrNursing = null, string? LeaveStatus = null, string? Level = null, bool? IsLeader = null);

// = Settings.leaveWish { open, year, month, reqs, quota, days_per_person }
public sealed record LeaveWishSettings(bool Open, int Year, int Month, ShiftRequirement? Reqs, int? Quota = null,
                                       int? DaysPerPerson = null);

// 預假登記（依「第一次登記時間」排序；改日期不會失去順位）
public sealed record WishState(int Version, IReadOnlyList<KeyValuePair<string, IReadOnlyList<int>>> Entries);   // days 1-indexed

public interface IScheduleDataStore
{
    Task<LeaveWishSettings?> GetLeaveSettingsAsync(CancellationToken ct);
    Task<IReadOnlyList<StaffRow>> GetStaffRowsAsync(CancellationToken ct);
    Task<WishState> GetWishStateAsync(int year, int month, CancellationToken ct);
    // 樂觀鎖：版本沒變、且交易內重算每日人數不超過 quota 才寫入；否則回 false 由呼叫端重讀重算
    Task<bool> CommitWishAsync(int year, int month, string staffId, IReadOnlyList<int> days, int expectedVersion, int quota,
                               CancellationToken ct);
}

// ============================================================
// 人力試算快取（= cpsat_service._staffing_cache / _staffing_partial）
// ============================================================
// 試算只跟「人數組成」有關（保護 / 雙週 / 總數），跟是誰無關
public sealed record StaffingKey(int Year, int Month, ShiftRequirement Reqs, int Protected, int BiWeekly, int Size);

public interface IStaffingCache
{
    bool TryGet(StaffingKey key, out StaffingRange range);
    void SetComplete(StaffingKey key, StaffingRange range);
    StaffingRange? GetPartial(StaffingKey key);
    void SetPartial(StaffingKey key, StaffingRange range);
    void ClearPartial(StaffingKey key);
    void Remove(StaffingKey key);
}

// 行程內快取，與 Python 版相同（多台主機時各自一份 — 只影響顯示的最少人數，不影響能否排班）
public sealed class InMemoryStaffingCache : IStaffingCache
{
    private readonly ConcurrentDictionary<StaffingKey, StaffingRange> _done = new(), _partial = new();
    public bool TryGet(StaffingKey key, out StaffingRange range) => _done.TryGetValue(key, out range!);
    public void SetComplete(StaffingKey key, StaffingRange range) => _done[key] = range;
    public StaffingRange? GetPartial(StaffingKey key) => _partial.TryGetValue(key, out var r) ? r : null;
    public void SetPartial(StaffingKey key, StaffingRange range) => _partial[key] = range;
    public void ClearPartial(StaffingKey key) => _partial.TryRemove(key, out _);
    public void Remove(StaffingKey key) => _done.TryRemove(key, out _);
}

// ============================================================
// 設定（= cpsat_service.py 的環境變數）。照搬雲端的限制；基準測試通過後在地端調整
// ============================================================
public sealed class SchedulingOptions
{
    public double RequestBudgetSeconds { get; set; } = 110;     // ENGINE_TIME_BUDGET
    public double SolveMarginSeconds { get; set; } = 10;        // SOLVE_MARGIN
    public double WishCheckSeconds { get; set; } = 20;          // WISH_CHECK_SECONDS
    public double StaffingCheckSeconds { get; set; } = 20;      // staffing_estimate 的 check_time
    public int Workers { get; set; } = Math.Max(1, Environment.ProcessorCount);   // CPSAT_WORKERS
    public int DaysPerPersonDefault { get; set; } = 4;
    public double FeasibleShareOfBudget { get; set; } = 0.6;    // 零權重起點用剩餘時間的 60%
    public double FeasibleShareOnFallback { get; set; } = 0.5;  // 預假衝突改軟約束時的起點時間比例
    public DeterminismMode Mode { get; set; } = DeterminismMode.Production;
}

// ============================================================
// 錯誤：對應 Python HTTPException 的狀態碼（HTTP 對應在階段三）
// ============================================================
public enum ScheduleErrorKind { BadRequest = 400, Forbidden = 403, Conflict = 409, Timeout = 503 }

public sealed class ScheduleDomainException(ScheduleErrorKind kind, string message) : Exception(message)
{
    public ScheduleErrorKind Kind { get; } = kind;
}

// ============================================================
// 回應（JSON 欄位名稱與現行 Python API 完全相同，前端不用改）
// ============================================================
public sealed record StaffingCheckDto(
    [property: JsonPropertyName("n")] int N,
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("reason")] string Reason);

public sealed record StaffingEstimateResult(
    [property: JsonPropertyName("min")] int? Min,
    [property: JsonPropertyName("max")] int Max,
    [property: JsonPropertyName("recommended")] int? Recommended,
    [property: JsonPropertyName("gray")] IReadOnlyList<int> Gray,
    [property: JsonPropertyName("demand")] int Demand,
    [property: JsonPropertyName("days")] int Days,
    [property: JsonPropertyName("team_size")] int TeamSize,
    [property: JsonPropertyName("ok")] bool Ok,
    [property: JsonPropertyName("note")] string Note,
    [property: JsonPropertyName("participants")] IReadOnlyList<string> Participants,
    [property: JsonPropertyName("default_quota")] int DefaultQuota,
    [property: JsonPropertyName("checks")] IReadOnlyList<StaffingCheckDto> Checks);

public sealed record WishSubmitResult(
    [property: JsonPropertyName("ok")] bool Ok,
    [property: JsonPropertyName("year")] int Year,
    [property: JsonPropertyName("month")] int Month,
    [property: JsonPropertyName("days")] IReadOnlyList<int> Days,
    [property: JsonPropertyName("quota")] int Quota,
    [property: JsonPropertyName("remaining")] IReadOnlyDictionary<string, int> Remaining);

public sealed record GenerateCommand(
    int Year, int Month, ShiftRequirement Reqs, IReadOnlyList<string>? StaffIds = null,
    double TimeLimit = 120.0,                                          // 5–240，與 Python GenerateRequest 相同
    IReadOnlyDictionary<string, IReadOnlyList<string>>? Hint = null,   // 外部起點（例如 LLM），原始字串
    bool UseWishes = true);

public sealed record ScheduleCell(
    [property: JsonPropertyName("nurse_id")] string NurseId,
    [property: JsonPropertyName("date")] string Date,
    [property: JsonPropertyName("shift")] string Shift);

public sealed record StaffingInfo(
    [property: JsonPropertyName("min")] int? Min,
    [property: JsonPropertyName("max")] int Max,
    [property: JsonPropertyName("recommended")] int? Recommended,
    [property: JsonPropertyName("note")] string Note);

public sealed record GenerateStats(
    [property: JsonPropertyName("engine")] string Engine,
    [property: JsonPropertyName("cpsat_status")] string CpsatStatus,
    [property: JsonPropertyName("gap")] double? Gap,
    [property: JsonPropertyName("objective")] long? Objective,
    [property: JsonPropertyName("hint_value")] long? HintValue,
    [property: JsonPropertyName("hard_penalty")] int HardPenalty,
    [property: JsonPropertyName("num_days")] int NumDays,
    [property: JsonPropertyName("num_nurses")] int NumNurses,
    [property: JsonPropertyName("wishes_total")] int WishesTotal,
    [property: JsonPropertyName("wishes_met")] int WishesMet,
    [property: JsonPropertyName("wishes_hard")] bool WishesHard,
    [property: JsonPropertyName("staffing")] StaffingInfo Staffing,
    [property: JsonPropertyName("backward_rotations")] int BackwardRotations,
    [property: JsonPropertyName("shift_types")] IReadOnlyDictionary<string, int> ShiftTypes,
    [property: JsonPropertyName("senior_gaps")] int SeniorGaps,
    [property: JsonPropertyName("start_repaired")] bool StartRepaired,
    [property: JsonPropertyName("hint_rows_used")] int HintRowsUsed);

public sealed record GenerateResult(
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("solver_status")] string SolverStatus,
    [property: JsonPropertyName("elapsed_seconds")] double ElapsedSeconds,
    [property: JsonPropertyName("schedule")] IReadOnlyList<ScheduleCell> Schedule,
    [property: JsonPropertyName("stats")] GenerateStats Stats);
