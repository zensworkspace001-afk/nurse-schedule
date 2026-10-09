using Google.OrTools.Sat;
using static Aegis.Engine.EngineConstants;

namespace Aegis.Engine;

// solve_cpsat 建模完成後（求解前）的狀態；Scheduler 與基準測試共用
public sealed class BuiltModel
{
    public required CpModel Model { get; init; }
    public required Dictionary<(string Sid, int Day, ShiftCode Shift), BoolVar> X { get; init; }   // 插入順序 = Python dict 順序
    public required Dictionary<(string Sid, int Week), (Dictionary<ShiftCode, BoolVar> Y, int Cap)> WeekY { get; init; }
    public required LinExpr Objective { get; init; }
    public required List<BoolVar> SeniorGaps { get; init; }
    public required IntVar MaxDissat { get; init; }
    public required bool FeasOnly { get; init; }

    public LinExpr Work(string sid, int d) => LinExpr.Sum(Work_.Select(sh => (LinExpr)X[(sid, d, sh)]));
    private static readonly ShiftCode[] Work_ = EngineConstants.Work;
}

public interface IScheduleModelBuilder
{
    BuiltModel Build(Problem p, FeatureWeights w, IReadOnlyDictionary<string, double> mult, double fairness,
                     ModelExtension? ext);
}

// = model.py solve_cpsat 第 523–697 行（建變數、硬約束、軟特徵、冗餘約束、資深缺口、公平性、extra）
// 每一段的「建立順序」都與 Python 相同 — 不要為了好讀而調整迴圈順序。
public sealed class ScheduleModelBuilder : IScheduleModelBuilder
{
    public BuiltModel Build(Problem p, FeatureWeights W, IReadOnlyDictionary<string, double> mult, double fairness,
                            ModelExtension? ext)
    {
        var m = new CpModel();
        int nd = p.NumDays;
        var weekY = new Dictionary<(string, int), (Dictionary<ShiftCode, BoolVar>, int)>();
        var x = new Dictionary<(string, int, ShiftCode), BoolVar>();
        foreach (var sid in p.Ids)
            for (int d = 0; d < nd; d++)
                foreach (var sh in Shifts)
                    x[(sid, d, sh)] = m.NewBoolVar($"x_{sid}_{d}_{sh}");

        LinExpr work(string sid, int d) => LinExpr.Sum(EngineConstants.Work.Select(sh => (LinExpr)x[(sid, d, sh)]));
        LinExpr sumRange(Func<int, LinExpr> f, int from, int toExclusive) =>
            LinExpr.Sum(Enumerable.Range(from, Math.Max(0, toExclusive - from)).Select(f));

        // —— 每人每天恰一個班別 ——
        foreach (var sid in p.Ids)
            for (int d = 0; d < nd; d++)
                ProtoWriter.ExactlyOne(m, Shifts.Select(sh => x[(sid, d, sh)]));

        // —— 每日覆蓋：req ≤ 人數 ≤ req_max ——
        for (int d = 0; d < nd; d++)
            foreach (var sh in EngineConstants.Work)
            {
                var cnt = LinExpr.Sum(p.Ids.Select(sid => (LinExpr)x[(sid, d, sh)]));
                ProtoWriter.Ge(m, cnt, p.Reqs[sh]);
                ProtoWriter.Le(m, cnt, p.ReqsMax[sh]);
            }

        var Wi = Enum.GetValues<SoftFeature>().ToDictionary(k => k, k => Scale10(W[k]));
        var dExprs = new Dictionary<string, LinExpr>();
        var objTerms = new List<LinExpr>();
        var def = p.Def;
        bool feasOnly = Wi.Values.All(v => v == 0) && fairness == 0 && def.BackwardWeight == 0
                        && def.Mix2Weight == 0 && def.Mix3Weight == 0 && def.SeniorWeight == 0;

        foreach (var s in p.Staff)
        {
            var sid = s.StaffId;
            // 母性保護 / 實習生：禁 E/N
            if (Problem.IsProtected(s))
                for (int d = 0; d < nd; d++)
                {
                    ProtoWriter.Eq(m, x[(sid, d, ShiftCode.E)], 0);
                    ProtoWriter.Eq(m, x[(sid, d, ShiftCode.N)], 0);
                }
            // 輪班間隔 11h
            for (int d = 0; d < nd - 1; d++)
                foreach (var (a, b) in Forbidden)
                    ProtoWriter.Le(m, (LinExpr)x[(sid, d, a)] + x[(sid, d + 1, b)], 1);
            // 連續上班上限
            int cw = Math.Min(MaxConsecWork, def.MaxConsecWork);
            for (int d = 0; d < nd - cw; d++)
                ProtoWriter.Le(m, sumRange(t => work(sid, t), d, d + cw + 1), cw);
            // 連續大夜 ≤ 3
            for (int d = 0; d < nd - MaxConsecN; d++)
                ProtoWriter.Le(m, sumRange(t => x[(sid, t, ShiftCode.N)], d, d + MaxConsecN + 1), MaxConsecN);
            // 大夜段結束 → 接下來 post_night_rest 天都要休
            for (int d = 0; d < nd - 1; d++)
            {
                var endN = (LinExpr)x[(sid, d, ShiftCode.N)] - x[(sid, d + 1, ShiftCode.N)];
                for (int k = 1; k <= def.PostNightRest; k++)
                    if (d + k < nd)
                        ProtoWriter.Ge(m, LinExpr.Sum(Rest.Select(r => (LinExpr)x[(sid, d + k, r)])), endN);
            }
            // 兩 RG 間 ≤ 6 工作日
            for (int a = 0; a < nd; a++)
                for (int b = a + MaxRgGap; b < nd; b++)
                {
                    int L = b - a + 1;
                    ProtoWriter.Le(m, sumRange(t => work(sid, t), a, b + 1),
                                   MaxRgGap + L * sumRange(t => x[(sid, t, ShiftCode.RG)], a, b + 1));
                }
            // 週工時
            int cap = Problem.WeeklyCap(s);
            var weekSums = p.Weeks.Select(w => sumRange(t => work(sid, t), w.Start, w.End + 1)).ToList();
            foreach (var ws in weekSums) ProtoWriter.Le(m, ws, cap);
            if (s.SpecialStatus == SpecialStatus.BiWeekly)
                for (int i = 0; i + 1 < weekSums.Count; i++)
                    ProtoWriter.Le(m, weekSums[i] + weekSums[i + 1], 10);
            // 週內不花花班
            if (def.OneShiftPerWeek)
                for (int wi = 0; wi < p.Weeks.Count; wi++)
                {
                    var (a, b) = p.Weeks[wi];
                    var y = EngineConstants.Work.ToDictionary(sh => sh, sh => m.NewBoolVar($"y_{sid}_{wi}_{sh}"));
                    weekY[(sid, wi)] = (y, Math.Min(cap, b - a + 1));
                    ProtoWriter.Le(m, LinExpr.Sum(y.Values.Select(v => (LinExpr)v)), 1);
                    for (int t = a; t <= b; t++)
                        foreach (var sh in EngineConstants.Work)
                            ProtoWriter.Le(m, x[(sid, t, sh)], y[sh]);
                }
            // 月總量
            ProtoWriter.Ge(m, sumRange(d => x[(sid, d, ShiftCode.RG)], 0, nd), MinRg);
            ProtoWriter.Ge(m, LinExpr.Sum(Enumerable.Range(0, nd).SelectMany(d => Rest.Select(r => (LinExpr)x[(sid, d, r)]))), MinRest);
            ProtoWriter.Le(m, sumRange(d => work(sid, d), 0, nd), MaxMonthWork);
            ProtoWriter.Ge(m, sumRange(d => work(sid, d), 0, nd), def.MinWorkDays);
            if (feasOnly)
            {
                dExprs[sid] = LinExpr.Zero;
                continue;
            }

            // —— 軟特徵（線性化）——
            var w = p.WishesOf(sid);
            var f = new Dictionary<SoftFeature, LinExpr>
            {
                [SoftFeature.WishHighMiss] = LinExpr.Sum(w.High.OrderBy(d => d).Select(d => work(sid, d))),
                [SoftFeature.WishNormalMiss] = LinExpr.Sum(w.Normal.OrderBy(d => d).Select(d => work(sid, d))),
                [SoftFeature.Nights] = sumRange(d => x[(sid, d, ShiftCode.N)], 0, nd),
                [SoftFeature.WeekendWork] = LinExpr.Sum(p.Weekend.OrderBy(d => d).Select(d => work(sid, d))),
            };
            var iso = new List<LinExpr>();
            for (int d = 1; d < nd - 1; d++)
            {
                var b = m.NewBoolVar("");
                ProtoWriter.Ge(m, b, work(sid, d - 1) + (1 - work(sid, d)) + work(sid, d + 1) - 2);
                iso.Add(b);
            }
            f[SoftFeature.IsolatedOff] = LinExpr.Sum(iso);
            var sw = new List<LinExpr>();
            for (int d = 0; d < nd - 1; d++)
            {
                var b = m.NewBoolVar("");
                foreach (var a in EngineConstants.Work)
                    foreach (var c in EngineConstants.Work)
                        if (a != c)
                            ProtoWriter.Ge(m, b, (LinExpr)x[(sid, d, a)] + x[(sid, d + 1, c)] - 1);
                sw.Add(b);
            }
            f[SoftFeature.ShiftSwitch] = LinExpr.Sum(sw);
            var st = new List<LinExpr>();
            for (int d = 0; d < nd - 5; d++)
            {
                var b = m.NewBoolVar("");
                ProtoWriter.Ge(m, b, sumRange(t => work(sid, t), d, d + 6) - 5);
                st.Add(b);
            }
            f[SoftFeature.Streak6] = LinExpr.Sum(st);

            // 逆向輪班
            var back = new List<LinExpr>();
            if (def.BackwardWeight != 0)
                for (int d = 0; d < nd - 1; d++)
                    for (int g = 0; g <= BackwardMaxGap; g++)
                    {
                        int e = d + g + 1;
                        if (e >= nd) break;
                        var between = sumRange(t => work(sid, t), d + 1, e);
                        var b = m.NewBoolVar("");
                        foreach (var a in EngineConstants.Work)
                            foreach (var c in EngineConstants.Work)
                                if (ShiftOrder(c) < ShiftOrder(a))
                                    ProtoWriter.Ge(m, b, (LinExpr)x[(sid, d, a)] + x[(sid, e, c)] - 1 - between);
                        back.Add(b);
                    }
            long bw = Scale10(def.BackwardWeight);
            // 整月班別種類
            var used = new List<BoolVar>();
            foreach (var sh in EngineConstants.Work)
            {
                var u = m.NewBoolVar("");
                for (int d = 0; d < nd; d++) ProtoWriter.Ge(m, u, x[(sid, d, sh)]);
                used.Add(u);
            }
            var t2 = m.NewBoolVar("");
            var t3 = m.NewBoolVar("");
            for (int i = 0; i < used.Count; i++)
                for (int j = i + 1; j < used.Count; j++)
                    ProtoWriter.Ge(m, t2, (LinExpr)used[i] + used[j] - 1);
            ProtoWriter.Ge(m, t3, LinExpr.Sum(used) - 2);
            var mixExpr = Scale10(def.Mix2Weight) * (LinExpr)t2 + Scale10(def.Mix3Weight - def.Mix2Weight) * (LinExpr)t3;
            dExprs[sid] = LinExpr.Sum(Enum.GetValues<SoftFeature>().Select(k => Wi[k] * f[k]))
                          + bw * LinExpr.Sum(back) + mixExpr;
            objTerms.Add(Scale10(mult[sid]) * dExprs[sid]);
        }

        // 冗餘約束：每週選某班別的人，產能總和要蓋得住該班需求
        if (def.OneShiftPerWeek)
            for (int wi = 0; wi < p.Weeks.Count; wi++)
            {
                var (a, b) = p.Weeks[wi];
                foreach (var sh in EngineConstants.Work)
                    ProtoWriter.Ge(m, LinExpr.Sum(p.Ids.Select(sid => { var (y, c) = weekY[(sid, wi)]; return (long)c * (LinExpr)y[sh]; })),
                                   (long)p.Reqs[sh] * (b - a + 1));
            }

        // 每班至少一位資深（軟）
        var seniorGaps = new List<BoolVar>();
        if (def.SeniorWeight != 0)
        {
            var seniors = p.Staff.Where(Problem.IsSenior).Select(s => s.StaffId).ToList();
            for (int d = 0; d < nd; d++)
                foreach (var sh in EngineConstants.Work)
                {
                    if (p.Reqs[sh] <= 0) continue;
                    var g = m.NewBoolVar("");
                    ProtoWriter.Ge(m, LinExpr.Sum(seniors.Select(sid => (LinExpr)x[(sid, d, sh)])) + g, 1);
                    seniorGaps.Add(g);
                }
        }

        var maxD = m.NewIntVar(0, 10_000_000, "max_dissat");
        foreach (var sid in p.Ids) ProtoWriter.Ge(m, maxD, dExprs[sid]);

        var built = new BuiltModel
        {
            Model = m, X = x, WeekY = weekY, Objective = LinExpr.Zero, SeniorGaps = seniorGaps,
            MaxDissat = maxD, FeasOnly = feasOnly,
        };
        var extraObj = ext?.Invoke(built, p) ?? LinExpr.Zero;
        var obj = LinExpr.Sum(objTerms) + Scale10(fairness) * LinExpr.Of(maxD) + extraObj
                  + Scale10(def.SeniorWeight) * LinExpr.Sum(seniorGaps);
        return new BuiltModel
        {
            Model = m, X = x, WeekY = weekY, Objective = obj, SeniorGaps = seniorGaps, MaxDissat = maxD, FeasOnly = feasOnly,
        };
    }
}
