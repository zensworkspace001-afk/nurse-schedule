using static Aegis.Engine.EngineConstants;

namespace Aegis.Engine;

public interface IScheduleInspector
{
    int HardViolations(ShiftCode[] shifts, StaffMember s, Problem p);
    int BackwardRotations(ShiftCode[] shifts);
    int SeniorGapCount(Problem p, IReadOnlyDictionary<string, ShiftCode[]> schedule);
    IReadOnlyDictionary<SoftFeature, int> Features(ShiftCode[] shifts, string staffId, Problem p);
    double PersonCost(ShiftCode[] shifts, string staffId, Problem p, FeatureWeights w);
}

// = model.py hard_violations / backward_rotations / features / dissat / person_cost / senior_gap_count
// 用來獨立驗證 CP-SAT 的解與產生回應裡的統計；與 CP-SAT 模型一一對應
public sealed class ScheduleInspector : IScheduleInspector
{
    public int HardViolations(ShiftCode[] shifts, StaffMember s, Problem p)
    {
        int v = 0;
        var work = shifts.Select(IsWork).ToArray();
        if (Problem.IsProtected(s)) v += shifts.Count(x => x is ShiftCode.E or ShiftCode.N);
        for (int i = 0; i + 1 < shifts.Length; i++)
            if (Forbidden.Contains((shifts[i], shifts[i + 1]))) v++;
        int run = 0, nRun = 0, gap = 0;
        int cw = Math.Min(MaxConsecWork, p.Def.MaxConsecWork);
        for (int i = 0; i < shifts.Length; i++)
        {
            run = work[i] ? run + 1 : 0;
            nRun = shifts[i] == ShiftCode.N ? nRun + 1 : 0;
            if (shifts[i] == ShiftCode.RG) gap = 0;
            else if (work[i]) gap++;
            v += (run > cw ? 1 : 0) + (nRun > MaxConsecN ? 1 : 0) + (gap > MaxRgGap ? 1 : 0);
        }
        int cap = Problem.WeeklyCap(s);
        var weekWork = p.Weeks.Select(w => Enumerable.Range(w.Start, w.End - w.Start + 1).Count(t => work[t])).ToList();
        v += weekWork.Count(w => w > cap);
        if (s.SpecialStatus == SpecialStatus.BiWeekly)
            for (int i = 0; i + 1 < weekWork.Count; i++) if (weekWork[i] + weekWork[i + 1] > 10) v++;
        int nRg = shifts.Count(x => x == ShiftCode.RG), nRc = shifts.Count(x => x == ShiftCode.RC), total = work.Count(w => w);
        v += (nRg < MinRg ? 1 : 0) + (nRg + nRc < MinRest ? 1 : 0) + (total > MaxMonthWork ? 1 : 0);
        v += total < p.Def.MinWorkDays ? 1 : 0;
        if (p.Def.OneShiftPerWeek)
            v += p.Weeks.Count(w => shifts.Skip(w.Start).Take(w.End - w.Start + 1).Where(IsWork).Distinct().Count() > 1);
        int k = p.Def.PostNightRest;
        for (int d = 0; d + 1 < shifts.Length; d++)
            if (shifts[d] == ShiftCode.N && shifts[d + 1] != ShiftCode.N)
                for (int t = d + 1; t < Math.Min(d + 1 + k, shifts.Length); t++)
                    if (!IsRest(shifts[t])) v++;
        return v;
    }

    public int BackwardRotations(ShiftCode[] shifts)
    {
        int n = 0, gap = 0;
        ShiftCode? last = null;
        foreach (var x in shifts)
        {
            if (IsWork(x))
            {
                if (last is ShiftCode l && gap <= BackwardMaxGap && ShiftOrder(x) < ShiftOrder(l)) n++;
                last = x;
                gap = 0;
            }
            else gap++;
        }
        return n;
    }

    public IReadOnlyDictionary<SoftFeature, int> Features(ShiftCode[] shifts, string staffId, Problem p)
    {
        var work = shifts.Select(IsWork).ToArray();
        int nd = p.NumDays;
        var w = p.WishesOf(staffId);
        return new Dictionary<SoftFeature, int>
        {
            [SoftFeature.WishHighMiss] = w.High.Count(d => work[d]),
            [SoftFeature.WishNormalMiss] = w.Normal.Count(d => work[d]),
            [SoftFeature.Nights] = shifts.Count(x => x == ShiftCode.N),
            [SoftFeature.IsolatedOff] = Enumerable.Range(1, Math.Max(0, nd - 2)).Count(d => work[d - 1] && !work[d] && work[d + 1]),
            [SoftFeature.WeekendWork] = p.Weekend.Count(d => work[d]),
            [SoftFeature.ShiftSwitch] = Enumerable.Range(0, Math.Max(0, nd - 1)).Count(d => work[d] && work[d + 1] && shifts[d] != shifts[d + 1]),
            [SoftFeature.Streak6] = Enumerable.Range(0, Math.Max(0, nd - 5)).Count(d => Enumerable.Range(d, 6).All(t => work[t])),
        };
    }

    public double PersonCost(ShiftCode[] shifts, string staffId, Problem p, FeatureWeights W)
    {
        int nTypes = shifts.Where(IsWork).Distinct().Count();
        double mix = nTypes >= 3 ? p.Def.Mix3Weight : nTypes == 2 ? p.Def.Mix2Weight : 0.0;
        var f = Features(shifts, staffId, p);
        double dissat = Enum.GetValues<SoftFeature>().Sum(k => W[k] * f[k]);
        return dissat + p.Def.BackwardWeight * BackwardRotations(shifts) + mix;
    }

    public int SeniorGapCount(Problem p, IReadOnlyDictionary<string, ShiftCode[]> schedule)
    {
        var seniors = p.Staff.Where(Problem.IsSenior).Select(s => s.StaffId).ToList();
        int n = 0;
        for (int d = 0; d < p.NumDays; d++)
            foreach (var sh in EngineConstants.Work)
                if (p.Reqs[sh] > 0 && !seniors.Any(sid => schedule[sid][d] == sh)) n++;
        return n;
    }
}
