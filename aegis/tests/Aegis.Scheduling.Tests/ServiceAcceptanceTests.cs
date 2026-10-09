using Aegis.Engine;
using Aegis.Scheduling;
using Xunit;
using Xunit.Abstractions;
using static Aegis.Scheduling.Tests.Harness;

namespace Aegis.Scheduling.Tests;

// local_test/hybrid/test_cpsat_service.py 的 37 項驗收測試，移植到業務層（不經 HTTP）。
// HTTP 狀態碼 → ScheduleErrorKind（400 BadRequest / 403 Forbidden / 409 Conflict / 503 Timeout）。
// 「員工呼叫人力試算 → 403」「管理員送預假 → 403」「被授權的員工可以試算」三項屬於授權層，在階段三的 Controller 測。
public sealed class ServiceAcceptanceTests(ITestOutputHelper output)
{
    private static async Task<ScheduleErrorKind> Fails(Func<Task> act)
    {
        var ex = await Assert.ThrowsAsync<ScheduleDomainException>(act);
        return ex.Kind;
    }

    private static readonly LeaveWishSettings Open8 = new(true, 2026, 8, R(3, 3, 2), Quota: 6, DaysPerPerson: 4);

    // ———————————— 預假 ————————————
    [Fact]
    public async Task 預假_開放前後與基本驗證()
    {
        var h = new Harness();
        Assert.Equal(ScheduleErrorKind.Forbidden, await Fails(() => h.Service.SubmitWishAsync("N001", new[] { 8, 9, 15, 16 })));   // 未開放 → 403
        h.Store.Settings = Open8;
        Assert.Equal(ScheduleErrorKind.BadRequest, await Fails(() => h.Service.SubmitWishAsync("N001", new[] { 8, 9, 15 })));      // 只選 3 天
        Assert.Equal(ScheduleErrorKind.BadRequest, await Fails(() => h.Service.SubmitWishAsync("N001", new[] { 8, 8, 15, 16 })));  // 重複日期
        Assert.Equal(ScheduleErrorKind.Forbidden, await Fails(() => h.Service.SubmitWishAsync("N999", new[] { 8, 9, 15, 16 })));   // 不在名單

        var ok = await h.Service.SubmitWishAsync("N001", new[] { 8, 9, 15, 16 });
        Assert.Equal(5, ok.Remaining["8"]);                                                        // 正常送出
        var changed = await h.Service.SubmitWishAsync("N001", new[] { 1, 2, 3, 4 });
        Assert.Equal(6, changed.Remaining["8"]);                                                   // 本人改選 → 舊日期釋出
    }

    [Fact]
    public async Task 預假_額滿_409()
    {
        var h = new Harness();
        h.Store.Settings = Open8;
        foreach (var sid in new[] { "N002", "N003", "N004", "N005", "N006", "N007" })
            await h.Service.SubmitWishAsync(sid, new[] { 22, 23, 29, 30 });
        var ex = await Assert.ThrowsAsync<ScheduleDomainException>(() => h.Service.SubmitWishAsync("N008", new[] { 22, 5, 6, 7 }));
        Assert.Equal(ScheduleErrorKind.Conflict, ex.Kind);
        output.WriteLine(ex.Message);
    }

    [Fact]
    public async Task 預假_配額內但排不出來_第6位409()
    {
        var h = new Harness();
        h.Store.Settings = Open8;
        var codes = new List<string>();
        string? reason = null;
        foreach (var sid in new[] { "N001", "N003", "N004", "N005", "N006", "N007" })
        {
            try { await h.Service.SubmitWishAsync(sid, new[] { 10, 11, 12, 13 }); codes.Add("200"); }
            catch (ScheduleDomainException ex) { codes.Add(((int)ex.Kind).ToString()); reason = ex.Message; }
        }
        output.WriteLine($"{string.Join(",", codes)}｜{reason}");
        Assert.Equal(new[] { "200", "200", "200", "200", "200", "409" }, codes);
    }

    [Fact]
    public async Task 預假_同時送出自動重試()
    {
        var h = new Harness();
        h.Store.Settings = Open8;
        h.Store.BumpOnce = true;
        await h.Service.SubmitWishAsync("N010", new[] { 3, 4, 5, 6 });
        Assert.Equal(new[] { 3, 4, 5, 6 }, h.Store.EntryOf("N010"));
    }

    [Fact]
    public async Task 預假_超過人數上限_後送者403_且保留先登記者()
    {
        var h = new Harness();
        var small = R(1, 1, 1);   // 上限 = (3×3)×31 ÷ 21 = 13 < 14 人
        h.Store.Settings = new LeaveWishSettings(true, 2026, 8, small, Quota: 3, DaysPerPerson: 4);
        var el = Eligibility.EligibleStaff(h.Store.Staff);
        var core = el.Where(x => Eligibility.IsProtectedRaw(x) || x.SpecialStatus == SpecialStatus.BiWeekly).Select(x => x.StaffId).ToHashSet();
        var others = el.Where(x => !core.Contains(x.StaffId)).Select(x => x.StaffId).ToList();
        int room = h.Staffing.MaxHeadcount(small, 31) - core.Count;
        foreach (var sid in others.Take(room)) h.Store.SetEntry(sid, new[] { 1, 2, 3, 4 });
        string late = others[room];
        var ex = await Assert.ThrowsAsync<ScheduleDomainException>(() => h.Service.SubmitWishAsync(late, new[] { 5, 6, 7, 8 }));
        Assert.Equal(ScheduleErrorKind.Forbidden, ex.Kind);
        Assert.Contains("超過上限", ex.Message);

        var kept = h.Staffing.AdjustHeadcount(el, Samples.Range(0, h.Staffing.MaxHeadcount(small, 31)),
                                              h.Store.Entries.Select(e => e.Key).Append(late).ToList()).Staff.Select(s => s.StaffId).ToHashSet();
        Assert.DoesNotContain(late, kept);
        Assert.True(h.Store.Entries.All(e => kept.Contains(e.Key)));
    }

    // ———————————— 人力試算 ————————————
    [Fact]
    public async Task 試算_D3E2N2_最少12_全員參與()
    {
        var h = new Harness();
        var j = await h.Service.EstimateAsync(2026, 8, R(3, 2, 2), null);
        output.WriteLine(j.Note);
        Assert.Equal(12, j.Min);
        Assert.True(j.Ok);
        Assert.Equal(14, j.Participants.Count);
    }

    [Fact]
    public async Task 試算_D5E4N3_人力不足()
    {
        var h = new Harness();
        var j = await h.Service.EstimateAsync(2026, 8, R(5, 4, 3), null);
        output.WriteLine(j.Note);
        Assert.False(j.Ok);
    }

    [Fact]
    public void 試算_截止時間到_標記timed_out_且接續試算沿用進度()
    {
        var h = new Harness();
        var base_ = Eligibility.EligibleStaff(Samples.Rows());
        var part = h.Staffing.StaffingRange(2026, 9, R(3, 2, 2), base_, checkTime: 20, secondsUntilDeadline: () => 0);
        var note = h.Staffing.AdjustHeadcount(base_, part, Array.Empty<string>()).Note;
        Assert.True(part.TimedOut && part.Min is null && part.Checks[^1].Status == "TIMEOUT");
        Assert.DoesNotContain("None", note);

        var full = h.Staffing.StaffingRange(2026, 9, R(3, 2, 2), base_, checkTime: 20, resume: part);
        var ns = full.Checks.Select(c => c.N).ToList();
        output.WriteLine($"min={full.Min} checks={string.Join(",", ns)}");
        Assert.False(full.TimedOut);
        Assert.NotNull(full.Min);
        Assert.Equal(ns.Count, ns.Distinct().Count());
        Assert.True(part.Checks.Where(c => c.Status != "TIMEOUT").All(c => full.Checks.Contains(c)));
    }

    // ———————————— 人數調整（純邏輯）————————————
    [Fact]
    public void 調整_試算無解_訊息不含None_下限29()
    {
        var h = new Harness();
        var adj = h.Staffing.AdjustHeadcount(Samples.Many(20, "N"),
            Samples.Range(null, 39, checks: new[] { (27, "預檢無解"), (28, "預檢無解"), (29, "UNKNOWN"), (35, "UNKNOWN") }), Array.Empty<string>());
        Assert.False(adj.Ok);
        Assert.DoesNotContain("None", adj.Note);
        Assert.Contains("29 人以上", adj.Note);
    }

    [Fact]
    public void 調整_超過上限_已登記預假的人不會被排除()
    {
        var h = new Harness();
        var kept = h.Staffing.AdjustHeadcount(Samples.Many(10), Samples.Range(1, 8, 1), new[] { "S09" });
        Assert.Contains("S09", kept.Staff.Select(s => s.StaffId));
        Assert.Equal(8, kept.Staff.Count);
    }

    [Theory]
    [InlineData(26, 25)]
    [InlineData(30, 26)]
    public void 調整_要保留的人超過上限_剛好留24人且優先預假者(int n, int wishN)
    {
        var h = new Harness();
        var keep = Enumerable.Range(0, wishN).Select(i => $"S{i:00}").ToList();
        var k = h.Staffing.AdjustHeadcount(Samples.Many(n), Samples.Range(1, 24, 1), keep);
        var ids = k.Staff.Select(s => s.StaffId).ToHashSet();
        Assert.Equal(24, ids.Count);
        Assert.True(ids.IsSubsetOf(keep));
        Assert.Contains("預假失效", k.Note);
    }

    [Fact]
    public void 調整_人太多造成的排不出來不算下限()
    {
        var h = new Harness();
        var note = h.Staffing.AdjustHeadcount(Eligibility.EligibleStaff(Samples.Rows()),
            Samples.Range(null, 24, timedOut: true, checks: new[] { (10, "預檢無解"), (15, "預檢無解"), (16, "UNKNOWN"), (25, "INFEASIBLE"), (28, "INFEASIBLE") }),
            Array.Empty<string>()).Note;
        Assert.Contains("15 人以下", note);
        Assert.DoesNotContain("28", note);
    }

    [Fact]
    public void 調整_目前人數UNKNOWN_不當人力不足()
    {
        var h = new Harness();
        var unk = h.Staffing.AdjustHeadcount(Eligibility.EligibleStaff(Samples.Rows()),
            Samples.Range(null, 30, currentUnknown: true, checks: new[] { (14, "UNKNOWN") }), Array.Empty<string>());
        Assert.True(unk.Ok);
        Assert.Contains("不代表人力不足", unk.Note);
    }

    // ———————————— 排班 ————————————
    private static readonly List<KeyValuePair<string, IReadOnlyList<int>>> Wishes16 = new()
    {
        new("N001", new[] { 8, 9, 15, 16 }), new("N002", new[] { 8, 16, 18, 24 }),
        new("N007", new[] { 2, 8, 9, 16 }), new("N013", new[] { 1, 3, 8, 15 }),
    };

    [Fact]
    public async Task 排班_預假未截止409_截止後0硬違規且預假全滿足()
    {
        var h = new Harness();
        h.Store.Settings = Open8;
        h.Store.Entries = Wishes16.ToList();
        var ex = await Assert.ThrowsAsync<ScheduleDomainException>(() => h.Service.GenerateAsync(new GenerateCommand(2026, 8, R(3, 3, 2), TimeLimit: 30)));
        Assert.Equal(ScheduleErrorKind.Conflict, ex.Kind);
        Assert.Contains("尚未截止", ex.Message);

        h.Store.Settings = Open8 with { Open = false };   // 護理長截止預假
        var j = await h.Service.GenerateAsync(new GenerateCommand(2026, 8, R(3, 3, 2), TimeLimit: 30));
        output.WriteLine($"{j.SolverStatus}，預假 {j.Stats.WishesMet}/{j.Stats.WishesTotal}，班別種類 {string.Join(",", j.Stats.ShiftTypes)}");
        Assert.Equal(0, j.Stats.HardPenalty);
        Assert.Equal(16, j.Stats.WishesTotal);
        Assert.Equal(16, j.Stats.WishesMet);
        Assert.Equal(Samples.Rows().Select(r => r.StaffId).ToHashSet(), j.Schedule.Select(c => c.NurseId).ToHashSet());
    }

    [Fact]
    public async Task 排班_人力不足400()
    {
        var h = new Harness();
        var ex = await Assert.ThrowsAsync<ScheduleDomainException>(() => h.Service.GenerateAsync(new GenerateCommand(2026, 8, R(5, 4, 3))));
        output.WriteLine(ex.Message);
        Assert.Equal(ScheduleErrorKind.BadRequest, ex.Kind);
    }

    [Fact]
    public async Task 排班_每班都有資深坐鎮()
    {
        var h = new Harness();
        var seniors = new HashSet<string> { "N002", "N004", "N005", "N006", "N008", "N010" };
        h.Store.Staff = Samples.Rows().Select(r => r with { Level = seniors.Contains(r.StaffId!) ? "N3" : "N1" }).ToList();
        var j = await h.Service.GenerateAsync(new GenerateCommand(2026, 8, R(3, 3, 2), TimeLimit: 40));
        output.WriteLine($"senior_gaps={j.Stats.SeniorGaps}");
        Assert.Equal(0, j.Stats.SeniorGaps);
        Assert.Equal(0, j.Stats.HardPenalty);
    }

    [Fact]
    public async Task 排班_預假彼此衝突_改軟約束仍合法()
    {
        var h = new Harness();
        h.Store.Settings = Open8 with { Open = false };
        h.Store.Entries = Samples.Rows().Select(r => new KeyValuePair<string, IReadOnlyList<int>>(r.StaffId!, new[] { 1, 2, 3, 4 })).ToList();
        var j = await h.Service.GenerateAsync(new GenerateCommand(2026, 8, R(3, 2, 2), TimeLimit: 40));
        Assert.False(j.Stats.WishesHard);
        Assert.Equal(0, j.Stats.HardPenalty);
    }

    [Fact]
    public async Task 排班_外部起點全員天天白班_修成合法_連續3次()
    {
        var h = new Harness();
        var bad = Samples.Rows().ToDictionary(r => r.StaffId!, _ => (IReadOnlyList<string>)Enumerable.Repeat("D", 31).ToList());
        for (int i = 0; i < 3; i++)
        {
            var j = await h.Service.GenerateAsync(new GenerateCommand(2026, 8, R(3, 2, 2), TimeLimit: 40, Hint: bad));
            Assert.Equal(0, j.Stats.HardPenalty);
            Assert.True(j.Stats.StartRepaired);
        }
    }

    [Fact]
    public async Task 排班_快取說要99人_仍自己求解()
    {
        var h = new Harness();
        var el = Eligibility.EligibleStaff(h.Store.Staff);
        var key = new StaffingKey(2026, 8, R(3, 2, 2), el.Count(Eligibility.IsProtectedRaw), el.Count(s => s.SpecialStatus == SpecialStatus.BiWeekly), el.Count);
        h.Cache.SetComplete(key, Samples.Range(99, 30, 99));
        var j = await h.Service.GenerateAsync(new GenerateCommand(2026, 8, R(3, 2, 2), TimeLimit: 30));
        Assert.Equal("success", j.Status);
    }

    [Fact]
    public async Task 排班_時間預算30秒_要求120秒也會被壓住()
    {
        var h = new Harness(budget: 30);
        var sw = System.Diagnostics.Stopwatch.StartNew();
        try { await h.Service.GenerateAsync(new GenerateCommand(2026, 8, R(3, 3, 2), TimeLimit: 120)); }
        catch (ScheduleDomainException ex) { Assert.Equal(ScheduleErrorKind.Timeout, ex.Kind); }
        output.WriteLine($"{sw.Elapsed.TotalSeconds:F1}s");
        Assert.True(sw.Elapsed.TotalSeconds < 35);
    }
}
