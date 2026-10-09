using static Aegis.Engine.EngineConstants;

namespace Aegis.Engine;

public interface IFeasibilityPrechecks
{
    IReadOnlyList<string> MonthlyWorkdayShortfall(Problem p);
    IReadOnlyList<string> WeeklyStaffingShortfall(Problem p);
}

// = model.py monthly_workday_shortfall / _week_coverable / weekly_staffing_shortfall
// 回傳的字串與 Python 完全相同（會直接顯示給護理長）
public sealed class FeasibilityPrechecks : IFeasibilityPrechecks
{
    public IReadOnlyList<string> MonthlyWorkdayShortfall(Problem p)
    {
        var reasons = new List<string>();
        foreach (var s in p.Staff)
        {
            int cap = Problem.WeeklyCap(s);
            int weekMax = p.Weeks.Sum(w => Math.Min(cap, w.End - w.Start + 1));
            if (s.SpecialStatus == SpecialStatus.BiWeekly)   // 相鄰兩週合計 ≤ 10
            {
                var caps = p.Weeks.Select(w => Math.Min(cap, w.End - w.Start + 1)).ToArray();
                for (int i = 1; i < caps.Length; i++) caps[i] = Math.Min(caps[i], 10 - caps[i - 1]);
                weekMax = caps.Sum();
            }
            int best = Math.Min(Math.Min(weekMax, p.NumDays - MinRest), MaxMonthWork);
            if (best < p.Def.MinWorkDays)
                reasons.Add($"{s.StaffId}：本月週工時上限下最多只能上 {best} 天，達不到每月至少 {p.Def.MinWorkDays} 天");
        }
        return reasons;
    }

    private static bool WeekCoverable(Problem p, int L, IReadOnlyDictionary<string, int> capsBySid)
    {
        int protCap = p.Staff.Where(Problem.IsProtected).Sum(s => Math.Min(Problem.WeeklyCap(s), L));
        var caps = capsBySid.Values.OrderByDescending(c => c).ToArray();
        var memo = new Dictionary<(int, int, int, int), bool>();
        bool Ok(int i, int d, int e, int n)
        {
            if (d <= 0 && e <= 0 && n <= 0) return true;
            if (i == caps.Length) return false;
            if (memo.TryGetValue((i, d, e, n), out var r)) return r;
            int c = caps[i];
            r = Ok(i + 1, d - c, e, n) || Ok(i + 1, d, e - c, n) || Ok(i + 1, d, e, n - c) || Ok(i + 1, d, e, n);
            memo[(i, d, e, n)] = r;
            return r;
        }
        return Ok(0, Math.Max(0, p.Reqs.D * L - protCap), p.Reqs.E * L, p.Reqs.N * L);
    }

    public IReadOnlyList<string> WeeklyStaffingShortfall(Problem p)
    {
        var reasons = new List<string>();
        var nonprot = p.Staff.Where(s => !Problem.IsProtected(s)).ToList();

        Dictionary<string, int> CapsFor(int L, IReadOnlyDictionary<string, int>? bwCaps = null) =>
            nonprot.ToDictionary(s => s.StaffId,
                s => Math.Min(bwCaps != null && bwCaps.TryGetValue(s.StaffId, out var c) ? c : Problem.WeeklyCap(s), L));
        static string Label(int a, int b) => $"{a + 1}-{b + 1} 日";

        foreach (var (a, b) in p.Weeks)
            if (!WeekCoverable(p, b - a + 1, CapsFor(b - a + 1)))
                reasons.Add($"{Label(a, b)}這週：每人每週只能上一種班別，{nonprot.Count} 名可排夜班人員分配不出 "
                            + $"D{p.Reqs.D}/E{p.Reqs.E}/N{p.Reqs.N} 的每日需求");
        if (reasons.Count > 0) return reasons;

        var bw = nonprot.Where(s => s.SpecialStatus == SpecialStatus.BiWeekly).Select(s => s.StaffId).ToList();
        if (bw.Count > 0 && bw.Count <= 6)
            for (int wi = 0; wi + 1 < p.Weeks.Count; wi++)
            {
                var (a1, b1) = p.Weeks[wi];
                var (a2, b2) = p.Weeks[wi + 1];
                int L1 = b1 - a1 + 1, L2 = b2 - a2 + 1;
                bool feasible = false;
                // = itertools.product(range(0, min(6, L1) + 1), repeat=len(bw))，字典序
                foreach (var split in Product(Math.Min(6, L1) + 1, bw.Count))
                {
                    var c1 = bw.Select((sid, i) => (sid, c: split[i])).ToDictionary(t => t.sid, t => t.c);
                    var c2 = c1.ToDictionary(kv => kv.Key, kv => Math.Min(10 - kv.Value, 6));
                    if (WeekCoverable(p, L1, CapsFor(L1, c1)) && WeekCoverable(p, L2, CapsFor(L2, c2)))
                    {
                        feasible = true;
                        break;
                    }
                }
                if (!feasible)
                    reasons.Add($"{Label(a1, b1)} + {Label(a2, b2)}：雙週變形人員兩週合計最多 10 天，"
                                + "不能每週都上 6 天補位 → 每人每週只上一種班別時人力不足");
            }
        return reasons;
    }

    private static IEnumerable<int[]> Product(int range, int repeat)
    {
        var cur = new int[repeat];
        while (true)
        {
            yield return (int[])cur.Clone();
            int i = repeat - 1;
            while (i >= 0 && ++cur[i] == range) { cur[i] = 0; i--; }
            if (i < 0) yield break;
        }
    }
}
