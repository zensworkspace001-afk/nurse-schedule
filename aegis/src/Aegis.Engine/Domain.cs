// 神盾計畫 階段一 — 排班引擎的資料型別（對應 local_test/hybrid/model.py）
// 原則：行為與 Python 版完全一致，任何「順序」都照 Python 原樣（員工名單順序、班別 D,E,N,RG,RC、日期遞增），
// 因為變數與約束的建立順序決定 CpModelProto 的內容，基準測試要求兩邊模型逐項相同。
namespace Aegis.Engine;

public enum ShiftCode { D, E, N, RG, RC }              // = Python SHIFTS 的順序

public enum SpecialStatus { Standard, BiWeekly }

public enum SoftFeature { WishHighMiss, WishNormalMiss, Nights, IsolatedOff, WeekendWork, ShiftSwitch, Streak6 } // = FEATURES 順序

public sealed record StaffMember(
    string StaffId, string Name, SpecialStatus SpecialStatus,
    bool IsPregnantOrNursing, string LeaveStatus, string Level, bool IsLeader);

public sealed record ShiftRequirement(int D, int E, int N)
{
    public int this[ShiftCode s] => s switch
    {
        ShiftCode.D => D, ShiftCode.E => E, ShiftCode.N => N,
        _ => throw new ArgumentOutOfRangeException(nameof(s)),
    };
    public int Total => D + E + N;
}

public sealed record WishSet(IReadOnlySet<int> High, IReadOnlySet<int> Normal)   // day 0-indexed
{
    public static readonly WishSet Empty = new(new HashSet<int>(), new HashSet<int>());
}

public sealed record MonthCalendar(int Year, int Month, int NumDays,
    IReadOnlySet<int> Weekend, IReadOnlyList<(int Start, int End)> Weeks);           // 週一重置

public sealed record ProblemDefinition(
    int Year, int Month,
    IReadOnlyList<StaffMember> Staff,                  // 順序有意義
    ShiftRequirement Reqs,
    IReadOnlyDictionary<string, WishSet> Wishes,
    ShiftRequirement? ReqsMax = null,                  // null → Reqs + MAX_OVERSTAFF(2)
    bool OneShiftPerWeek = true,
    int PostNightRest = EngineConstants.PostNightRest,
    double BackwardWeight = 2.0,
    int MaxConsecWork = EngineConstants.HealthConsecWork,
    int MinWorkDays = EngineConstants.MinMonthWork,
    double Mix2Weight = 1.0,
    double Mix3Weight = 3.0,
    double SeniorWeight = 0.0);

public sealed record FeatureWeights(IReadOnlyDictionary<SoftFeature, double> Values)
{
    public double this[SoftFeature f] => Values[f];
    public static FeatureWeights Zero { get; } =
        new(Enum.GetValues<SoftFeature>().ToDictionary(f => f, _ => 0.0));
}

// 對應 Python 的 extra(m, x, prob, week_y)：可加約束，回傳額外目標項（null = 0）
public delegate LinExpr? ModelExtension(BuiltModel model, Problem problem);

public enum DeterminismMode { Production, Baseline }   // Baseline = workers 1 + 決定性時間（見 SolverRunner）

public sealed record SolveOptions(
    double TimeLimitSeconds = 10, int Seed = 0, int Workers = 8,
    DeterminismMode Mode = DeterminismMode.Production,
    IReadOnlyDictionary<string, ShiftCode[]>? Hint = null,
    bool HintTrusted = false,
    ModelExtension? Extension = null);

public enum SolveStatus { Optimal, Feasible, Infeasible, Unknown, ModelInvalid, HintKept }

public sealed record SolveResult(
    SolveStatus Status,
    IReadOnlyDictionary<string, ShiftCode[]>? Schedule,
    double ElapsedSeconds, double? Gap, long? Objective, long? HintValue,
    bool HintRejected, IReadOnlyList<string> Reasons);

public sealed record StaffingCheck(int N, string Status, string Reason);   // 預檢無解 / INFEASIBLE / FEASIBLE / UNKNOWN / TIMEOUT

public sealed record StaffingRange(
    int? Min, int Max, int? Comfort, IReadOnlyList<int> Gray, int Demand, int Days, int Protected,
    IReadOnlyList<StaffingCheck> Checks, bool TimedOut, bool Approx, bool CurrentUnknown);

public sealed record HeadcountAdjustment(bool Ok, IReadOnlyList<StaffMember> Staff, string Note);

public sealed record WishFeasibility(bool Feasible, string Status, string Reason);

public static class StatusNames
{
    // 與 Python cp_model.CpSolver.status_name 相同的字串（回應 JSON / 試算紀錄都用這個）
    public static string Of(SolveStatus s) => s switch
    {
        SolveStatus.Optimal => "OPTIMAL", SolveStatus.Feasible => "FEASIBLE",
        SolveStatus.Infeasible => "INFEASIBLE", SolveStatus.Unknown => "UNKNOWN",
        SolveStatus.ModelInvalid => "MODEL_INVALID", SolveStatus.HintKept => "HINT_KEPT",
        _ => throw new ArgumentOutOfRangeException(nameof(s)),
    };
}
