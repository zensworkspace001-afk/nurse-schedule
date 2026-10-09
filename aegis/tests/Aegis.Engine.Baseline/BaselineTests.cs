using System.Globalization;
using System.Text;
using Aegis.Engine;
using Google.OrTools.Sat;
using Xunit;
using Xunit.Abstractions;

namespace Aegis.Engine.Baseline;

// 階段一基準測試：C# 引擎 vs Python 黃金樣本（決定性模式）
//   1. 每一次 Solve 送進求解器的 CpModelProto 完全相同
//   2. 每一次 Solve 的參數（決定性時間）、狀態、分數、完整解向量完全相同
//   3. 流程最終輸出（班表 / 可行性 / 試算結果）完全相同
public sealed class BaselineTests(ITestOutputHelper output)
{
    public static IEnumerable<object[]> Cases() => GoldenCase.Names().Select(n => new object[] { n });

    [Theory]
    [MemberData(nameof(Cases))]
    public void MatchesPython(string name)
    {
        var g = GoldenCase.Load(name);
        var rec = new RecordingObserver();
        var prechecks = new FeasibilityPrechecks();
        var scheduler = new CpSatScheduler(new ScheduleModelBuilder(), prechecks, rec);
        var inspector = new ScheduleInspector();

        object result = g.Kind switch
        {
            "generate" => RunGenerate(g, scheduler, inspector),
            "wishcheck" => RunWishCheck(g, scheduler, prechecks),
            "staffing" => new StaffingCalculator(scheduler, prechecks, DeterminismMode.Baseline)
                .StaffingRange(g.Year, g.Month, g.Reqs, g.Staff, checkTime: g.TimeLimit, workers: 1),
            _ => throw new InvalidOperationException(g.Kind),
        };

        // —— 1 + 2：逐次求解比對 ——
        var py = g.Calls.EnumerateArray().ToList();
        Assert.True(py.Count == rec.Calls.Count, $"求解次數不同：Python {py.Count}、C# {rec.Calls.Count}");
        for (int i = 0; i < py.Count; i++)
        {
            var pyModel = g.PythonModel(i);
            var cs = rec.Calls[i];
            Assert.True(pyModel.Equals(cs.Model), $"第 {i} 次求解的模型不同：{DescribeDiff(pyModel, cs.Model)}");

            double pyDet = py[i].GetProperty("params").GetProperty("max_deterministic_time").GetDouble();
            Assert.Contains($"max_deterministic_time:{pyDet.ToString("R", CultureInfo.InvariantCulture)} ", cs.Parameters + " ");

            string pySt = py[i].GetProperty("status").GetString()!;
            string csSt = SolverRunner.StatusName(cs.Response.Status);
            Assert.True(pySt == csSt, $"第 {i} 次求解狀態不同：Python {pySt}、C# {csSt}");
            if (py[i].GetProperty("solution").ValueKind != System.Text.Json.JsonValueKind.Null)
            {
                Assert.Equal(py[i].GetProperty("objective").GetDouble(), cs.Response.ObjectiveValue);
                var pySol = py[i].GetProperty("solution").EnumerateArray().Select(v => v.GetInt64()).ToArray();
                Assert.Equal(pySol, cs.Response.Solution.ToArray());
            }
            output.WriteLine($"call {i}: 模型相同（{cs.Model.Variables.Count} 變數 / {cs.Model.Constraints.Count} 約束），{csSt}，" +
                             $"det {cs.Response.DeterministicTime:F3}（Python {py[i].GetProperty("deterministic_time").GetDouble():F3}）");
        }

        // —— 3：最終輸出 ——
        AssertFinal(g, result);
    }

    private static object RunGenerate(GoldenCase g, CpSatScheduler scheduler, ScheduleInspector inspector)
    {
        var staff = g.Staff;
        var ids = staff.Select(s => s.StaffId).ToList();
        int nd = DateTime.DaysInMonth(g.Year, g.Month);
        var wishes = g.Wishes1.Where(kv => ids.Contains(kv.Key))
            .Select(kv => new KeyValuePair<string, IReadOnlyList<int>>(kv.Key, kv.Value.Where(d => d >= 1 && d <= nd).Select(d => d - 1).ToList()))
            .ToList();
        var pin = wishes.Count > 0 ? WishFeasibilityChecker.PinRest(wishes) : null;
        var prob = new Problem(GenerationProfile.ForGeneration(g.Year, g.Month, staff, g.Reqs, wishes.ToDictionary(kv => kv.Key, kv => kv.Value)));
        var zero = new Problem(new ProblemDefinition(g.Year, g.Month, staff, g.Reqs, ids.ToDictionary(i => i, _ => WishSet.Empty),
                                                     BackwardWeight: 0, Mix2Weight: 0, Mix3Weight: 0));
        var mult = ids.ToDictionary(i => i, _ => 1.0);
        var f = scheduler.Solve(zero, FeatureWeights.Zero, mult, 0.0,
                                new SolveOptions(g.TimeLimit * 0.6, Workers: 1, Mode: DeterminismMode.Baseline, Extension: pin));
        if (f.Schedule == null) return ("zero", f);
        var r = scheduler.Solve(prob, GenerationProfile.Weights, mult, 1.0,
                                new SolveOptions(g.TimeLimit, Workers: 1, Mode: DeterminismMode.Baseline, Extension: pin,
                                                 Hint: f.Schedule, HintTrusted: true));
        return ("full", r, prob, inspector);
    }

    private static object RunWishCheck(GoldenCase g, CpSatScheduler scheduler, FeasibilityPrechecks prechecks)
    {
        var staff = g.Staff;
        var ids = staff.Select(s => s.StaffId).ToHashSet();
        var prob = new Problem(GenerationProfile.ForGeneration(g.Year, g.Month, staff, g.Reqs));
        var wishes = g.Wishes1.Where(kv => ids.Contains(kv.Key))
            .Select(kv => new KeyValuePair<string, IReadOnlyList<int>>(kv.Key, kv.Value.Select(d => d - 1).ToList())).ToList();
        return new WishFeasibilityChecker(scheduler, prechecks, DeterminismMode.Baseline).Check(prob, wishes, g.TimeLimit, 1);
    }

    private void AssertFinal(GoldenCase g, object result)
    {
        var R = g.Result;
        switch (result)
        {
            case ("zero", SolveResult f):
                Assert.Equal("zero", R.GetProperty("stage").GetString());
                Assert.Equal(R.GetProperty("zero").GetProperty("status").GetString(), StatusNames.Of(f.Status));
                break;
            case ("full", SolveResult r, Problem prob, ScheduleInspector ins):
                Assert.Equal(R.GetProperty("status").GetString(), StatusNames.Of(r.Status));
                Assert.Equal(R.GetProperty("objective").GetInt64(), r.Objective);
                Assert.Equal(R.GetProperty("hint_value").GetInt64(), r.HintValue);
                foreach (var row in R.GetProperty("schedule").EnumerateObject())
                    Assert.Equal(row.Value.EnumerateArray().Select(v => v.GetString()).ToArray(),
                                 r.Schedule![row.Name].Select(s => s.ToString()).ToArray());
                Assert.Equal(R.GetProperty("senior_gaps").GetInt32(), ins.SeniorGapCount(prob, r.Schedule!));
                Assert.Equal(R.GetProperty("backward_rotations").GetInt32(), r.Schedule!.Sum(kv => ins.BackwardRotations(kv.Value)));
                foreach (var s in prob.Staff)
                {
                    Assert.Equal(R.GetProperty("hard_violations").GetProperty(s.StaffId).GetInt32(),
                                 ins.HardViolations(r.Schedule![s.StaffId], s, prob));
                    Assert.Equal(R.GetProperty("person_cost").GetProperty(s.StaffId).GetDouble(),
                                 ins.PersonCost(r.Schedule![s.StaffId], s.StaffId, prob, GenerationProfile.Weights), 9);
                }
                output.WriteLine($"最終：{StatusNames.Of(r.Status)}，分數 {r.Objective}（起點 {r.HintValue}），資深缺口 {ins.SeniorGapCount(prob, r.Schedule!)}");
                break;
            case WishFeasibility w:
                Assert.Equal(R.GetProperty("feasible").GetBoolean(), w.Feasible);
                Assert.Equal(R.GetProperty("status").GetString(), w.Status);
                Assert.Equal(R.GetProperty("reason").GetString(), w.Reason);
                break;
            case StaffingRange s:
                Assert.Equal(R.GetProperty("min").ValueKind == System.Text.Json.JsonValueKind.Null ? null : R.GetProperty("min").GetInt32(), s.Min);
                Assert.Equal(R.GetProperty("max").GetInt32(), s.Max);
                Assert.Equal(R.GetProperty("approx").GetBoolean(), s.Approx);
                var pyChecks = R.GetProperty("checks").EnumerateArray().Select(c => $"{c[0].GetInt32()}:{c[1].GetString()}:{c[2].GetString()}");
                Assert.Equal(pyChecks, s.Checks.Select(c => $"{c.N}:{c.Status}:{c.Reason}"));
                output.WriteLine($"試算：min {s.Min}{(s.Approx ? "（約略）" : "")}、max {s.Max}、comfort {s.Comfort}");
                break;
            default:
                throw new InvalidOperationException(result.ToString());
        }
    }

    // 模型不同時指出第一個差異（變數數 / 約束數 / 第幾條約束 / 目標 / 提示）
    private static string DescribeDiff(CpModelProto a, CpModelProto b)
    {
        var sb = new StringBuilder();
        if (a.Variables.Count != b.Variables.Count) sb.Append($"變數數 {a.Variables.Count} vs {b.Variables.Count}；");
        for (int i = 0; i < Math.Min(a.Variables.Count, b.Variables.Count); i++)
            if (!a.Variables[i].Equals(b.Variables[i])) { sb.Append($"第一個不同的變數 #{i}：{a.Variables[i]} vs {b.Variables[i]}；"); break; }
        if (a.Constraints.Count != b.Constraints.Count) sb.Append($"約束數 {a.Constraints.Count} vs {b.Constraints.Count}；");
        for (int i = 0; i < Math.Min(a.Constraints.Count, b.Constraints.Count); i++)
            if (!a.Constraints[i].Equals(b.Constraints[i])) { sb.Append($"第一個不同的約束 #{i}：Python {a.Constraints[i]} vs C# {b.Constraints[i]}；"); break; }
        if (!Equals(a.Objective, b.Objective)) sb.Append($"目標不同：{a.Objective} vs {b.Objective}；");
        if (!Equals(a.SolutionHint, b.SolutionHint)) sb.Append($"提示不同（{a.SolutionHint?.Vars.Count} vs {b.SolutionHint?.Vars.Count}）；");
        if (!a.Assumptions.Equals(b.Assumptions)) sb.Append("assumptions 不同；");
        return sb.Length > 0 ? sb.ToString() : "（其他欄位）";
    }
}
