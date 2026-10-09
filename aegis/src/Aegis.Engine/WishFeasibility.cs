namespace Aegis.Engine;

public interface IWishFeasibilityChecker
{
    WishFeasibility Check(Problem p, IReadOnlyList<KeyValuePair<string, IReadOnlyList<int>>> wishes, double timeLimit,
                          int workers, CancellationToken ct = default);
}

// = model.py check_wishes_feasible：所有預假當「必休」硬約束，純可行性（零權重）求解
// wishes 用有序清單：約束的建立順序 = 傳入順序（與 Python dict 順序一致）
public sealed class WishFeasibilityChecker(ICpSatScheduler scheduler, IFeasibilityPrechecks prechecks,
                                           DeterminismMode mode = DeterminismMode.Production) : IWishFeasibilityChecker
{
    public static ModelExtension PinRest(IReadOnlyList<KeyValuePair<string, IReadOnlyList<int>>> wishes, IReadOnlyCollection<string>? onlyIds = null) =>
        (b, pr) =>
        {
            foreach (var (sid, days) in wishes)
            {
                if (onlyIds != null && !onlyIds.Contains(sid)) continue;
                foreach (var d in days)
                    ProtoWriter.Eq(b.Model, LinExpr.Sum(EngineConstants.Rest.Select(r => (LinExpr)b.X[(sid, d, r)])), 1);
            }
            return null;
        };

    public WishFeasibility Check(Problem p, IReadOnlyList<KeyValuePair<string, IReadOnlyList<int>>> wishes, double timeLimit,
                                 int workers, CancellationToken ct = default)
    {
        var reasons = prechecks.MonthlyWorkdayShortfall(p);
        if (reasons.Count == 0 && p.Def.OneShiftPerWeek) reasons = prechecks.WeeklyStaffingShortfall(p);
        if (reasons.Count > 0) return new(false, "INFEASIBLE", reasons[0]);

        var d = p.Def;
        var zero = new Problem(new ProblemDefinition(d.Year, d.Month, d.Staff, d.Reqs,
            p.Ids.ToDictionary(i => i, _ => WishSet.Empty), ReqsMax: p.ReqsMax, OneShiftPerWeek: d.OneShiftPerWeek,
            PostNightRest: d.PostNightRest, BackwardWeight: 0, MaxConsecWork: d.MaxConsecWork, MinWorkDays: d.MinWorkDays,
            Mix2Weight: 0, Mix3Weight: 0));
        var r = scheduler.Solve(zero, FeatureWeights.Zero, p.Ids.ToDictionary(i => i, _ => 1.0), 0.0,
                                new SolveOptions(timeLimit, Workers: workers, Mode: mode, Extension: PinRest(wishes, p.Ids.ToHashSet())), ct);
        if (r.Schedule != null) return new(true, StatusNames.Of(r.Status), "");
        if (r.Status == SolveStatus.Infeasible)
            return new(false, "INFEASIBLE", "加上已登記的預假後，勞基法與人力需求無法同時滿足（例如同一週可上夜班的人不夠）");
        return new(false, StatusNames.Of(r.Status), "系統忙碌或人力接近上限，暫時無法確認這組預假，請稍後再試或聯絡護理長");
    }
}
