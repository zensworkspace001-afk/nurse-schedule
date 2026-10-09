using Aegis.Engine;
using Aegis.Scheduling;
using Microsoft.Extensions.Options;

[assembly: Xunit.CollectionBehavior(DisableTestParallelization = true)]   // CP-SAT 吃滿 CPU：與 Python 測試一樣逐項跑，時間預算才準

namespace Aegis.Scheduling.Tests;

// = test_cpsat_service.py 的 FakeStore
public sealed class FakeStore : IScheduleDataStore
{
    public LeaveWishSettings? Settings;
    public List<StaffRow> Staff = Samples.Rows();
    public int Version;
    public List<KeyValuePair<string, IReadOnlyList<int>>> Entries = new();   // 插入順序 = Python dict
    public bool BumpOnce;   // 模擬「別人同時送出」：第一次 commit 時版本已變

    public Task<LeaveWishSettings?> GetLeaveSettingsAsync(CancellationToken ct) => Task.FromResult(Settings);
    public Task<IReadOnlyList<StaffRow>> GetStaffRowsAsync(CancellationToken ct) => Task.FromResult<IReadOnlyList<StaffRow>>(Staff);
    public Task<WishState> GetWishStateAsync(int y, int m, CancellationToken ct) => Task.FromResult(new WishState(Version, Entries.ToList()));

    public Task<bool> CommitWishAsync(int y, int m, string sid, IReadOnlyList<int> days, int expectedVersion, int quota, CancellationToken ct)
    {
        if (BumpOnce) { BumpOnce = false; Version++; return Task.FromResult(false); }
        if (expectedVersion != Version) return Task.FromResult(false);
        SetEntry(sid, days.ToList());
        Version++;
        return Task.FromResult(true);
    }

    public void SetEntry(string sid, IReadOnlyList<int> days)
    {
        int i = Entries.FindIndex(e => e.Key == sid);
        var kv = new KeyValuePair<string, IReadOnlyList<int>>(sid, days);
        if (i >= 0) Entries[i] = kv; else Entries.Add(kv);
    }

    public IReadOnlyList<int>? EntryOf(string sid) => Entries.FirstOrDefault(e => e.Key == sid).Value;
}

public static class Samples
{
    // = local_test/run_demo.py SAMPLE_STAFF（N002 孕婦、N003 雙週、N009 實習生）
    public static List<StaffRow> Rows() => Enumerable.Range(1, 14).Select(i =>
    {
        string id = $"N{i:000}";
        return new StaffRow(id, id, true, id == "N003" ? "BiWeekly" : "Standard", id == "N002", id == "N009" ? "Student" : "None");
    }).ToList();

    public static List<StaffMember> Many(int n, string prefix = "S") => Enumerable.Range(0, n)
        .Select(i => new StaffMember($"{prefix}{i:00}", $"{prefix}{i:00}", SpecialStatus.Standard, false, "None", "N0", false)).ToList();

    public static StaffingRange Range(int? min, int max, int? comfort = null, bool timedOut = false, bool currentUnknown = false,
                                      params (int N, string Status)[] checks) =>
        new(min, max, comfort, Array.Empty<int>(), 0, 31, 0, checks.Select(c => new StaffingCheck(c.N, c.Status, "")).ToList(),
            timedOut, false, currentUnknown);
}

public sealed class Harness
{
    public FakeStore Store { get; } = new();
    public InMemoryStaffingCache Cache { get; } = new();
    public SchedulingOptions Options { get; } = new();
    public FeasibilityPrechecks Prechecks { get; } = new();
    public ScheduleInspector Inspector { get; } = new();
    public CpSatScheduler Scheduler { get; }
    public StaffingCalculator Staffing { get; }
    public ScheduleService Service { get; }

    public Harness(double? budget = null)
    {
        if (budget is double b) Options.RequestBudgetSeconds = b;
        Scheduler = new CpSatScheduler(new ScheduleModelBuilder(), Prechecks);
        Staffing = new StaffingCalculator(Scheduler, Prechecks);
        Service = new ScheduleService(Store, Cache, Scheduler, Staffing, new WishFeasibilityChecker(Scheduler, Prechecks),
                                      Inspector, Microsoft.Extensions.Options.Options.Create(Options));
    }

    public static ShiftRequirement R(int d, int e, int n) => new(d, e, n);
}
