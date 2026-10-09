using Aegis.Engine;
using Aegis.Scheduling;
using Xunit;
using Xunit.Abstractions;
using static Aegis.Engine.EngineConstants;
using static Aegis.Scheduling.Tests.Harness;

namespace Aegis.Scheduling.Tests;

// 共用：14 人樣本、2026/8 D3/E2/N2，強制某人 D/E/N 都上的零權重合法解（workers 1、seed 0 → 每次相同）
public sealed class ZeroStartFixture
{
    public Problem Mixp { get; }
    public string MixSid { get; }
    public ModelExtension ForceAll3 { get; }
    public SolveResult Zs { get; }

    public ZeroStartFixture()
    {
        var h = new Harness();
        var staff = Eligibility.EligibleStaff(Samples.Rows());
        Mixp = new Problem(GenerationProfile.ForGeneration(2026, 8, staff, R(3, 2, 2)));
        MixSid = Mixp.Staff.First(s => !Problem.IsProtected(s)).StaffId;
        var sid = MixSid;
        ForceAll3 = (b, pr) =>
        {
            foreach (var sh in Work)
                ProtoWriter.Ge(b.Model, LinExpr.Sum(Enumerable.Range(0, pr.NumDays).Select(d => (LinExpr)b.X[(sid, d, sh)])), 1);
            return null;
        };
        var zp = new Problem(new ProblemDefinition(2026, 8, Mixp.Staff, R(3, 2, 2), Mixp.Ids.ToDictionary(i => i, _ => WishSet.Empty),
                                                   BackwardWeight: 0, Mix2Weight: 0, Mix3Weight: 0));
        Zs = h.Scheduler.Solve(zp, FeatureWeights.Zero, zp.Ids.ToDictionary(i => i, _ => 1.0), 0.0,
                               new SolveOptions(60, Seed: 0, Workers: 1, Extension: ForceAll3));
    }
}

public sealed class EngineInvariantTests(ZeroStartFixture z, ITestOutputHelper output) : IClassFixture<ZeroStartFixture>
{
    private Dictionary<string, double> Mult => z.Mixp.Ids.ToDictionary(i => i, _ => 1.0);

    [Fact]
    public void 整月混3種班只扣分_不是禁止()
    {
        var h = new Harness();
        var mr = h.Scheduler.Solve(z.Mixp, GenerationProfile.Weights, Mult, 1.0, new SolveOptions(30, Extension: z.ForceAll3));
        output.WriteLine($"{z.MixSid} → {StatusNames.Of(mr.Status)}");
        Assert.NotEqual(SolveStatus.Infeasible, mr.Status);
    }

    [Fact]
    public void 不變式_零權重模型的解固定進完整模型不可INFEASIBLE()
    {
        var h = new Harness();
        Assert.NotNull(z.Zs.Schedule);
        var zs = z.Zs.Schedule!;
        ModelExtension pinHint = (b, pr) =>
        {
            foreach (var sid in pr.Ids)
                for (int d = 0; d < pr.NumDays; d++)
                    ProtoWriter.Eq(b.Model, b.X[(sid, d, zs[sid][d])], 1);
            return null;
        };
        var pinned = h.Scheduler.Solve(z.Mixp, GenerationProfile.Weights, Mult, 1.0, new SolveOptions(30, Extension: pinHint));
        output.WriteLine($"zero={StatusNames.Of(z.Zs.Status)} pinned={StatusNames.Of(pinned.Status)}");
        Assert.NotEqual(SolveStatus.Infeasible, pinned.Status);
    }

    [Fact]
    public void 從合法起點出發會往更好的方向找_不被釘死在起點()
    {
        var h = new Harness();
        var imp = h.Scheduler.Solve(z.Mixp, GenerationProfile.Weights, Mult, 1.0,
                                    new SolveOptions(30, Hint: z.Zs.Schedule, HintTrusted: true));
        output.WriteLine($"{StatusNames.Of(imp.Status)} {imp.HintValue} → {imp.Objective}");
        Assert.NotNull(imp.HintValue);
        Assert.True((imp.Objective ?? long.MaxValue) < imp.HintValue);
    }

    [Fact]
    public async Task 外部起點格式不齊_合格的列照用_修成合法()
    {
        var h = new Harness();
        var messy = z.Zs.Schedule!.ToDictionary(kv => kv.Key.ToLowerInvariant(),
            kv => (IReadOnlyList<string>)kv.Value.Select(c => IsRest(c) ? "OFF" : c.ToString().ToLowerInvariant()).ToList());
        messy.Remove(messy.Keys.First());
        var j = await h.Service.GenerateAsync(new GenerateCommand(2026, 8, R(3, 2, 2), TimeLimit: 40, Hint: messy));
        output.WriteLine($"rows_used={j.Stats.HintRowsUsed} repaired={j.Stats.StartRepaired}");
        Assert.Equal(0, j.Stats.HardPenalty);
        Assert.Equal(z.Zs.Schedule!.Count - 1, j.Stats.HintRowsUsed);
        Assert.True(j.Stats.StartRepaired);
    }

    [Fact]
    public async Task 外部起點逐人合法_但某天人力不足_走零權重修復()
    {
        var h = new Harness();
        var shortHint = z.Zs.Schedule!.ToDictionary(kv => kv.Key, kv => (ShiftCode[])kv.Value.Clone());
        var reqs = R(3, 2, 2);
        bool done = false;
        foreach (var (d, sh) in Enumerable.Range(0, 31).SelectMany(d => Work.Select(sh => (d, sh))))
        {
            var onD = z.Mixp.Ids.Where(s => shortHint[s][d] == sh).ToList();
            if (onD.Count != reqs[sh]) continue;
            foreach (var s in onD)
            {
                if (shortHint[s].Count(IsWork) <= MinMonthWork) continue;
                var trial = (ShiftCode[])shortHint[s].Clone();
                trial[d] = ShiftCode.RC;
                if (h.Inspector.HardViolations(trial, z.Mixp.Staff.First(x => x.StaffId == s), z.Mixp) == 0)
                {
                    shortHint[s] = trial;
                    done = true;
                    break;
                }
            }
            if (done) break;
        }
        Assert.True(done, "測試前置失敗：造不出「逐人合法但某天人力不足」的起點");
        var j = await h.Service.GenerateAsync(new GenerateCommand(2026, 8, reqs, TimeLimit: 40,
            Hint: shortHint.ToDictionary(kv => kv.Key, kv => (IReadOnlyList<string>)kv.Value.Select(c => c.ToString()).ToList())));
        Assert.Equal(0, j.Stats.HardPenalty);
        Assert.True(j.Stats.StartRepaired);
    }
}
