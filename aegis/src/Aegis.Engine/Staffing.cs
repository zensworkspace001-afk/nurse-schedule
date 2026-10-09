using static Aegis.Engine.EngineConstants;

namespace Aegis.Engine;

public interface IStaffingCalculator
{
    StaffingRange StaffingRange(int year, int month, ShiftRequirement reqs, IReadOnlyList<StaffMember> baseStaff,
                                int maxExtra = 15, double checkTime = 30, int wishSlack = 4,
                                Func<double>? secondsUntilDeadline = null, int workers = 8, StaffingRange? resume = null,
                                CancellationToken ct = default);
    int MaxHeadcount(ShiftRequirement reqs, int numDays);
    HeadcountAdjustment AdjustHeadcount(IReadOnlyList<StaffMember> staff, StaffingRange rng, IReadOnlyList<string> keepIds);
}

// = model.py staffing_range / max_headcount / _proven_lower_bound / adjust_headcount
// deadline：Python 傳的是 time() 絕對時間，這裡改成「還剩幾秒」的函式（null = 不限，基準測試用）
public sealed class StaffingCalculator(ICpSatScheduler scheduler, IFeasibilityPrechecks prechecks,
                                       DeterminismMode mode = DeterminismMode.Production) : IStaffingCalculator
{
    public int MaxHeadcount(ShiftRequirement reqs, int numDays) =>
        ((reqs.D + MaxOverstaff) + (reqs.E + MaxOverstaff) + (reqs.N + MaxOverstaff)) * numDays / Math.Max(1, MinMonthWork + 1);

    private static bool IsProtectedRaw(StaffMember s) => s.IsPregnantOrNursing || s.LeaveStatus == "Student";

    public StaffingRange StaffingRange(int year, int month, ShiftRequirement reqs, IReadOnlyList<StaffMember> baseStaff,
                                       int maxExtra = 15, double checkTime = 30, int wishSlack = 4,
                                       Func<double>? secondsUntilDeadline = null, int workers = 8, StaffingRange? resume = null,
                                       CancellationToken ct = default)
    {
        int nd = DateTime.DaysInMonth(year, month);
        int demand = reqs.Total;
        var prot = baseStaff.Where(IsProtectedRaw).ToList();
        var others = baseStaff.Where(s => !IsProtectedRaw(s)).ToList();

        List<StaffMember> Team(int n)
        {
            int k = n - prot.Count;
            if (k < 0) return new();
            var extra = Enumerable.Range(0, Math.Max(0, k - others.Count))
                .Select(i => new StaffMember($"X{i + 1:00}", $"補{i + 1}", SpecialStatus.Standard, false, "None", "", false));
            return prot.Concat(others.Take(k)).Concat(extra).ToList();
        }

        int hi = MaxHeadcount(reqs, nd);
        var checks = (resume?.Checks ?? Array.Empty<StaffingCheck>()).Where(c => c.Status != "TIMEOUT").ToList();
        var done = checks.Select(c => c.N).ToHashSet();
        int? nMin = null;
        bool approx = false, timedOut = false;

        string Run(int n, double cap)
        {
            var staff = Team(n);
            var ids = staff.Select(s => s.StaffId).ToList();
            var prob = new Problem(new ProblemDefinition(year, month, staff, reqs,
                ids.ToDictionary(i => i, _ => WishSet.Empty), BackwardWeight: 0, Mix2Weight: 0, Mix3Weight: 0));
            var why = prechecks.MonthlyWorkdayShortfall(prob);
            if (why.Count == 0) why = prechecks.WeeklyStaffingShortfall(prob);
            if (why.Count > 0)
            {
                checks.Add(new StaffingCheck(n, "預檢無解", why[0]));
                return "預檢無解";
            }
            double limit = cap;
            if (secondsUntilDeadline != null)
            {
                limit = Math.Min(cap, secondsUntilDeadline() - 2);
                if (limit < 3)
                {
                    checks.Add(new StaffingCheck(n, "TIMEOUT", ""));
                    return "STOP";
                }
            }
            ct.ThrowIfCancellationRequested();
            var r = scheduler.Solve(prob, FeatureWeights.Zero, ids.ToDictionary(i => i, _ => 1.0), 0.0,
                                    new SolveOptions(limit, Workers: workers, Mode: mode), ct);
            string st = r.Schedule != null ? "FEASIBLE" : StatusNames.Of(r.Status);
            checks.Add(new StaffingCheck(n, st, ""));
            return st;
        }

        int lo = Math.Max(demand, prot.Count + 1);
        int top = Math.Min(baseStaff.Count + maxExtra, hi);
        int n0 = Math.Min(Math.Max(baseStaff.Count, lo), top);
        var prior = checks.GroupBy(c => c.N).ToDictionary(g => g.Key, g => g.Last().Status);   // = dict(...)：後者覆蓋
        string st0 = prior.TryGetValue(n0, out var p0) ? p0 : Run(n0, Math.Max(checkTime, 45.0));
        bool currentUnknown = false;
        if (st0 == "STOP") timedOut = true;
        else if (st0 == "UNKNOWN") currentUnknown = true;
        else if (st0 == "FEASIBLE")
        {
            nMin = n0;
            for (int n = n0 - 1; n >= lo; n--)
            {
                string st = prior.TryGetValue(n, out var pv) ? pv : Run(n, checkTime);
                if (st == "FEASIBLE") { nMin = n; continue; }
                approx = st is "UNKNOWN" or "STOP";
                break;
            }
        }
        else
        {
            for (int n = n0 + 1; n <= top; n++)
            {
                if (done.Contains(n))
                {
                    if (prior[n] == "FEASIBLE") { nMin = n; break; }
                    continue;
                }
                string st = Run(n, checkTime);
                if (st == "STOP") { timedOut = true; break; }
                if (st == "FEASIBLE") { nMin = n; break; }
            }
        }
        var sorted = checks.OrderBy(c => c.N).ToList();   // OrderBy 是穩定排序，= Python list.sort
        int? comfort = nMin is int nm ? Math.Max(nm, demand + wishSlack) : null;
        var gray = sorted.Where(c => c.Status == "UNKNOWN").Select(c => c.N).ToList();
        return new StaffingRange(nMin, hi, comfort, gray, demand, nd, prot.Count, sorted, timedOut, approx, currentUnknown);
    }

    private static int? ProvenLowerBound(StaffingRange rng)
    {
        int? lb = null;
        foreach (var c in rng.Checks.OrderBy(c => c.N))
        {
            if (c.Status is not ("預檢無解" or "INFEASIBLE")) break;
            lb = c.N + 1;
        }
        return lb;
    }

    public HeadcountAdjustment AdjustHeadcount(IReadOnlyList<StaffMember> staff, StaffingRange rng, IReadOnlyList<string> keepIds)
    {
        int n = staff.Count;
        if (rng.CurrentUnknown)
        {
            if (n > rng.Max)
                return AdjustHeadcount(staff, rng with { Min = 0, CurrentUnknown = false }, keepIds);
            return new(true, staff, $"目前 {n} 人：時限內無法確認排得出來（不代表人力不足），排班時會再試；最多 {rng.Max} 人");
        }
        if (rng.Min is null && rng.TimedOut)
        {
            var lb = ProvenLowerBound(rng);
            string known = lb is int l ? $"已確認 {l - 1} 人以下排不出來；" : "";
            return new(false, staff, $"人力試算超過時間上限而中止（{known}目前 {n} 人）。請稍後再試，或降低每日需求");
        }
        if (rng.Min is null)
        {
            int tried = rng.Checks.Count > 0 ? rng.Checks.Max(c => c.N) : n;
            int lb = ProvenLowerBound(rng) ?? n + 1;
            return new(false, staff, $"人力不足：至少需要 {lb} 人以上（試算到 {tried} 人仍無法確認排得出來），目前 {n} 人，請增補人力或降低每日需求");
        }
        if (n < rng.Min)
            return new(false, staff, $"人力不足：至少需要 {rng.Min} 人，目前 {n} 人，請增補人力或降低每日需求");
        if (n > rng.Max)
        {
            var core = staff.Where(s => IsProtectedRaw(s) || s.SpecialStatus == SpecialStatus.BiWeekly).ToList();
            var order = keepIds.Select((sid, i) => (sid, i)).GroupBy(t => t.sid).ToDictionary(g => g.Key, g => g.Last().i);   // = {sid: i}，後者覆蓋
            var coreIds = core.Select(s => s.StaffId).ToHashSet();
            var wishers = staff.Where(s => !coreIds.Contains(s.StaffId) && order.ContainsKey(s.StaffId))
                               .OrderBy(s => order[s.StaffId]).ToList();
            var wisherIds = wishers.Select(s => s.StaffId).ToHashSet();
            var rest = staff.Where(s => !coreIds.Contains(s.StaffId) && !wisherIds.Contains(s.StaffId)).ToList();
            var kept = new List<StaffMember>();
            foreach (var group in new[] { core, wishers, rest })
                kept.AddRange(group.Take(Math.Max(0, rng.Max - kept.Count)));
            var keptIds = kept.Select(s => s.StaffId).ToHashSet();
            var dropped = staff.Where(s => !keptIds.Contains(s.StaffId)).Select(s => s.StaffId).ToList();
            var lost = wishers.Where(s => !keptIds.Contains(s.StaffId)).Select(s => s.StaffId).ToList();
            string note = $"人力過剩：最多 {rng.Max} 人（每人至少 {MinMonthWork} 天會班不夠分），本次不排 {PyList(dropped)}";
            if (lost.Count > 0) note += $"；其中 {PyList(lost)} 已登記預假，本月預假失效，請個別告知";
            return new(true, kept, note);
        }
        string least = rng.Approx ? $"不超過 {rng.Min}" : $"{rng.Min}";
        return new(true, staff, $"人力適中（最少 {least}、建議 ≥ {rng.Comfort?.ToString() ?? "None"}、最多 {rng.Max}）");   // Python 印 None
    }

    // Python f-string 印 list 的樣子：['N001', 'N002']
    private static string PyList(IEnumerable<string> xs) => "[" + string.Join(", ", xs.Select(v => $"'{v}'")) + "]";
}
