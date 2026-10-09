using System.Diagnostics;
using Google.OrTools.Sat;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using static Aegis.Engine.EngineConstants;

namespace Aegis.Engine;

public interface ICpSatScheduler
{
    SolveResult Solve(Problem p, FeatureWeights w, IReadOnlyDictionary<string, double> mult, double fairness,
                      SolveOptions o, CancellationToken ct = default);
}

// = model.py solve_cpsat：預檢 → 建模 →（有資深權重）先壓資深缺口 →（有起點）固定起點求精確分數 → 正式搜尋
public sealed class CpSatScheduler(
    IScheduleModelBuilder builder, IFeasibilityPrechecks prechecks,
    ISolveObserver? observer = null, ILogger<CpSatScheduler>? logger = null) : ICpSatScheduler
{
    private readonly ILogger _log = logger ?? NullLogger<CpSatScheduler>.Instance;

    public SolveResult Solve(Problem p, FeatureWeights W, IReadOnlyDictionary<string, double> mult, double fairness,
                             SolveOptions o, CancellationToken ct = default)
    {
        var reasons = prechecks.MonthlyWorkdayShortfall(p);
        if (reasons.Count == 0 && p.Def.OneShiftPerWeek) reasons = prechecks.WeeklyStaffingShortfall(p);
        if (reasons.Count > 0)
            return new SolveResult(SolveStatus.Infeasible, null, 0.0, null, null, null, false, reasons);

        var runner = new SolverRunner(o.Mode, observer);
        var b = builder.Build(p, W, mult, fairness, o.Extension);
        var m = b.Model;
        var x = b.X;
        int nd = p.NumDays;
        double timeLimit = o.TimeLimitSeconds;
        var hint = o.Hint;

        Dictionary<string, ShiftCode[]> ReadSchedule(SolveCall c) =>
            p.Ids.ToDictionary(sid => sid,
                sid => Enumerable.Range(0, nd).Select(d => Shifts.First(sh => c.Value(x[(sid, d, sh)]) != 0)).ToArray());

        // 資深坐鎮優先：先單獨求最少資深缺口並鎖住上限
        if (b.SeniorGaps.Count > 0)
        {
            if (hint != null)
                foreach (var ((sid, d, sh), v) in x)
                    ProtoWriter.AddHint(m, v.GetIndex(), hint[sid][d] == sh ? 1 : 0);
            ProtoWriter.Minimize(m, LinExpr.Sum(b.SeniorGaps));
            var s0 = runner.Solve(m, Math.Max(3.0, timeLimit / 5), o.Workers, o.Seed);
            ProtoWriter.ClearHints(m);
            if (hint != null && !s0.HasSolution)
                _log.LogWarning("資深坐鎮階段連起始班表都沒採用（{Status}）— 起始班表可能違反完整模型的硬約束",
                                SolverRunner.StatusName(s0.Status));
            if (s0.HasSolution)
            {
                ProtoWriter.Le(m, LinExpr.Sum(b.SeniorGaps), PyRound(s0.ObjectiveValue));
                hint = ReadSchedule(s0);
            }
            timeLimit = Math.Max(1.0, timeLimit - s0.ElapsedForBudget);
        }
        ProtoWriter.Minimize(m, b.Objective);

        // 起始班表：assumption 固定 x → 完整解與精確分數 → 全變數提示 + 目標 ≤ 起點分數 → 正式搜尋
        long? hintValue = null;
        bool hintRejected = false;
        if (hint != null)
        {
            var pin = m.NewBoolVar("pin_hint");
            foreach (var sid in p.Ids)
                for (int d = 0; d < nd; d++)
                    foreach (var sh in Shifts)
                        ProtoWriter.OnlyEnforceIf(ProtoWriter.Eq(m, x[(sid, d, sh)], hint[sid][d] == sh ? 1 : 0), pin);
            ProtoWriter.AddAssumption(m, pin);
            var s1 = runner.Solve(m, Math.Max(5.0, timeLimit / 4), o.Workers, seed: null);   // Python 這一步沒設 random_seed
            ProtoWriter.ClearAssumptions(m);
            if (s1.Status == CpSolverStatus.Infeasible)
            {
                hintRejected = true;
                if (o.HintTrusted) _log.LogWarning("內部起始班表固定後不可行 — 完整模型與零權重模型的硬約束不一致（bug）");
                else _log.LogInformation("外部起始班表不合法，改當提示讓 CP-SAT 從附近修");
            }
            if (s1.HasSolution)
            {
                hintValue = PyRound(s1.ObjectiveValue);
                // 不能提示 pin 自己（值 = 1）：LNS 一把 pin 固定在 1，所有 x 都被釘死
                for (int i = 0; i < m.Model.Variables.Count; i++)
                {
                    if (i == pin.GetIndex()) continue;
                    ProtoWriter.AddHint(m, i, s1.Response.Solution[i]);
                }
                ProtoWriter.Eq(m, pin, 0);
                ProtoWriter.Le(m, b.Objective, hintValue.Value);
            }
            else
            {
                ProtoWriter.Eq(m, pin, 0);
                foreach (var ((sid, d, sh), v) in x)
                    ProtoWriter.AddHint(m, v.GetIndex(), hint[sid][d] == sh ? 1 : 0);
            }
            timeLimit = Math.Max(1.0, timeLimit - s1.ElapsedForBudget);
        }

        ct.ThrowIfCancellationRequested();
        var sw = Stopwatch.StartNew();
        var final = runner.Solve(m, timeLimit, o.Workers, o.Seed);
        double elapsed = Math.Round(sw.Elapsed.TotalSeconds, 2);
        if (!final.HasSolution)
        {
            if (hintValue != null)   // 沒找到比起點更好的 → 起點本身就是答案
                return new SolveResult(SolveStatus.HintKept, hint!.ToDictionary(kv => kv.Key, kv => (ShiftCode[])kv.Value.Clone()),
                                       elapsed, 0.0, hintValue, hintValue, hintRejected, Array.Empty<string>());
            return new SolveResult(ToStatus(final.Status), null, elapsed, null, null, null, hintRejected, Array.Empty<string>());
        }
        double obj = final.ObjectiveValue;
        return new SolveResult(ToStatus(final.Status), ReadSchedule(final), elapsed,
                               (obj - final.Response.BestObjectiveBound) / Math.Max(1.0, obj),
                               PyRound(obj), hintValue, hintRejected, Array.Empty<string>());
    }

    private static SolveStatus ToStatus(CpSolverStatus s) => s switch
    {
        CpSolverStatus.Optimal => SolveStatus.Optimal, CpSolverStatus.Feasible => SolveStatus.Feasible,
        CpSolverStatus.Infeasible => SolveStatus.Infeasible, CpSolverStatus.ModelInvalid => SolveStatus.ModelInvalid,
        _ => SolveStatus.Unknown,
    };
}
