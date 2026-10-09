using Aegis.Engine;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using static Aegis.Engine.EngineConstants;

namespace Aegis.Scheduling;

public interface IScheduleService
{
    Task<StaffingEstimateResult> EstimateAsync(int year, int month, ShiftRequirement reqs, IReadOnlyList<string>? staffIds,
                                               CancellationToken ct = default);
    Task<WishSubmitResult> SubmitWishAsync(string staffId, IReadOnlyList<int> days, CancellationToken ct = default);
    Task<GenerateResult> GenerateAsync(GenerateCommand cmd, CancellationToken ct = default);
}

// = cpsat_service.py 的 staffing_estimate / submit_wish / generate（與 HTTP 解耦；授權在階段三的 Controller 做）
public sealed class ScheduleService(
    IScheduleDataStore store, IStaffingCache cache, ICpSatScheduler scheduler, IStaffingCalculator staffing,
    IWishFeasibilityChecker wishChecker, IScheduleInspector inspector, IOptions<SchedulingOptions> options,
    TimeProvider? clock = null, ILogger<ScheduleService>? logger = null) : IScheduleService
{
    private readonly SchedulingOptions _o = options.Value;
    private readonly TimeProvider _clock = clock ?? TimeProvider.System;
    private readonly ILogger _log = logger ?? NullLogger<ScheduleService>.Instance;

    private static readonly Dictionary<string, ShiftCode> ShiftByName = Shifts.ToDictionary(sh => sh.ToString());

    private double Now() => _clock.GetTimestamp() / (double)_clock.TimestampFrequency;

    // —— 共用 ——
    private async Task<(List<StaffMember> Staff, StaffingKey Key)> TeamAndKeyAsync(
        int year, int month, ShiftRequirement reqs, IReadOnlyList<string>? staffIds, CancellationToken ct)
    {
        var staff = Eligibility.EligibleStaff(await store.GetStaffRowsAsync(ct));
        if (staffIds is { Count: > 0 })
        {
            var wanted = staffIds.Select(x => x.ToUpperInvariant()).ToHashSet();
            staff = staff.Where(s => wanted.Contains(s.StaffId.ToUpperInvariant())).ToList();
        }
        if (staff.Count == 0) throw new ScheduleDomainException(ScheduleErrorKind.BadRequest, "沒有可排班的員工");
        var key = new StaffingKey(year, month, reqs, staff.Count(Eligibility.IsProtectedRaw),
                                  staff.Count(s => s.SpecialStatus == SpecialStatus.BiWeekly), staff.Count);
        return (staff, key);
    }

    private static StaffingRange CapOnly(int hi, int nd) =>   // = {"min": 0, "max": hi, "comfort": None}
        new(0, hi, null, Array.Empty<int>(), 0, nd, 0, Array.Empty<StaffingCheck>(), false, false, false);

    // ============================================================
    // 人力試算
    // ============================================================
    public async Task<StaffingEstimateResult> EstimateAsync(int year, int month, ShiftRequirement reqs,
                                                            IReadOnlyList<string>? staffIds, CancellationToken ct = default)
    {
        Eligibility.ValidateReqs(reqs);
        var (staff, key) = await TeamAndKeyAsync(year, month, reqs, staffIds, ct);
        if (!cache.TryGet(key, out var rng))
        {
            double deadline = Now() + _o.RequestBudgetSeconds;
            rng = await Task.Run(() => staffing.StaffingRange(year, month, reqs, staff, checkTime: _o.StaffingCheckSeconds,
                                                              secondsUntilDeadline: () => deadline - Now(), workers: _o.Workers,
                                                              resume: cache.GetPartial(key), ct: ct), ct);
            if (rng.TimedOut) cache.SetPartial(key, rng);        // 中途停止：只存進度
            else if (rng.CurrentUnknown) cache.ClearPartial(key); // 目前人數無法判定：不快取，下次重試
            else
            {
                cache.SetComplete(key, rng);
                cache.ClearPartial(key);
            }
        }
        var adj = staffing.AdjustHeadcount(staff, rng, Array.Empty<string>());
        return new StaffingEstimateResult(
            rng.Min, rng.Max, rng.Comfort, rng.Gray, rng.Demand, DateTime.DaysInMonth(year, month), staff.Count,
            adj.Ok, adj.Note, adj.Ok ? adj.Staff.Select(s => s.StaffId).ToList() : new List<string>(),
            adj.Ok ? Math.Max(0, adj.Staff.Count - rng.Demand) : 0,
            rng.Checks.Select(c => new StaffingCheckDto(c.N, c.Status, c.Reason)).ToList());
    }

    // ============================================================
    // 預假送出
    // ============================================================
    public async Task<WishSubmitResult> SubmitWishAsync(string staffId, IReadOnlyList<int> days, CancellationToken ct = default)
    {
        var st = await store.GetLeaveSettingsAsync(ct);
        if (st is null || !st.Open) throw new ScheduleDomainException(ScheduleErrorKind.Forbidden, "目前未開放預假");
        int year = st.Year, month = st.Month, nd = DateTime.DaysInMonth(year, month);
        int need = st.DaysPerPerson ?? _o.DaysPerPersonDefault;
        if (days.Count != need || days.Distinct().Count() != need || !days.All(d => d >= 1 && d <= nd))
            throw new ScheduleDomainException(ScheduleErrorKind.BadRequest, $"請選擇 {need} 個不重複、且在 {month} 月內的日期");
        var reqs = Eligibility.ValidateReqs(st.Reqs);
        var staff = Eligibility.EligibleStaff(await store.GetStaffRowsAsync(ct));
        var match = staff.FirstOrDefault(s => s.StaffId.Equals(staffId, StringComparison.OrdinalIgnoreCase));
        if (match is null) throw new ScheduleDomainException(ScheduleErrorKind.Forbidden, "您本月不在排班名單內（離職、產假或長假）");
        string sid = match.StaffId;
        int hi = staffing.MaxHeadcount(reqs, nd);
        var mine = days.OrderBy(d => d).ToList();

        for (int attempt = 0; attempt < 3; attempt++)
        {
            var state = await store.GetWishStateAsync(year, month, ct);
            var entryIds = state.Entries.Select(e => e.Key).ToList();
            // 用跟排班相同的團隊檢查：孕哺 / 雙週 → 已登記者與本人（先登記的優先；改日期保留原順位）→ 其他
            var keep = entryIds.Contains(sid) ? entryIds : entryIds.Append(sid).ToList();
            var team = staffing.AdjustHeadcount(staff, CapOnly(hi, nd), keep).Staff;
            var teamIds = team.Select(s => s.StaffId).ToHashSet();
            if (!teamIds.Contains(sid))
                throw new ScheduleDomainException(ScheduleErrorKind.Forbidden,
                    $"本月人數超過上限（最多 {hi} 人），已登記預假的同仁優先排班，您本月不在排班名單內，請聯絡護理長");
            int quota = st.Quota ?? Math.Max(0, team.Count - reqs.Total);
            // = {s: ds for s in entries if s in team} 再 wishes[sid] = sorted(days)（已在就原位更新、不在就加到最後）
            var wishes = state.Entries.Where(e => teamIds.Contains(e.Key)).ToList();
            int at = wishes.FindIndex(e => e.Key == sid);
            var mineKv = new KeyValuePair<string, IReadOnlyList<int>>(sid, mine);
            if (at >= 0) wishes[at] = mineKv; else wishes.Add(mineKv);
            var counts = wishes.SelectMany(e => e.Value).GroupBy(d => d).ToDictionary(g => g.Key, g => g.Count());
            var full = mine.Where(d => counts.GetValueOrDefault(d) > quota).OrderBy(d => d).ToList();
            if (full.Count > 0)
                throw new ScheduleDomainException(ScheduleErrorKind.Conflict,
                    $"{string.Join("、", full.Select(d => $"{month}/{d}"))} 已額滿（每日上限 {quota} 人），請改選其他日期");

            var prob = new Problem(GenerationProfile.ForGeneration(year, month, team, reqs));
            var zeroIdx = wishes.Select(e => new KeyValuePair<string, IReadOnlyList<int>>(e.Key, e.Value.Select(d => d - 1).ToList())).ToList();
            var chk = await Task.Run(() => wishChecker.Check(prob, zeroIdx, _o.WishCheckSeconds, _o.Workers, ct), ct);
            if (!chk.Feasible) throw new ScheduleDomainException(ScheduleErrorKind.Conflict, chk.Reason);
            if (await store.CommitWishAsync(year, month, sid, mine, state.Version, quota, ct))
            {
                var remaining = Enumerable.Range(1, nd).ToDictionary(d => d.ToString(), d => quota - counts.GetValueOrDefault(d));
                _log.LogInformation("預假 {Y}_{M} {Sid} {Days} 已登記", year, month, sid, string.Join(",", mine));
                return new WishSubmitResult(true, year, month, mine, quota, remaining);
            }
            // 版本變了（有人同時送出）→ 重讀重算
        }
        throw new ScheduleDomainException(ScheduleErrorKind.Conflict, "同時有其他同仁送出預假，請重新整理後再試一次");
    }

    // ============================================================
    // 排班
    // ============================================================
    public async Task<GenerateResult> GenerateAsync(GenerateCommand cmd, CancellationToken ct = default)
    {
        int year = cmd.Year, month = cmd.Month;
        var reqs = Eligibility.ValidateReqs(cmd.Reqs);
        // 預假還開放就排班 → 之後才登記的人會被告知「保證休假」，但班表已經排好。必須先截止。
        var st = await store.GetLeaveSettingsAsync(ct);
        if (cmd.UseWishes && st is { Open: true } && st.Year == year && st.Month == month)
            throw new ScheduleDomainException(ScheduleErrorKind.Conflict,
                $"{year}/{month} 的預假尚未截止，請先到「人力與預假」截止後再排班（截止前排出的班表不會包含之後才登記的預假）");
        double tStart = Now();
        double deadline = tStart + _o.RequestBudgetSeconds;
        int nd = DateTime.DaysInMonth(year, month);
        // 不在這裡跑人力試算：有快取就沿用顯示，沒有就只截人數上限，可不可行交給下面的輕量求解
        var (team, key) = await TeamAndKeyAsync(year, month, reqs, cmd.StaffIds, ct);
        IReadOnlyList<KeyValuePair<string, IReadOnlyList<int>>> entries = cmd.UseWishes
            ? (await store.GetWishStateAsync(year, month, ct)).Entries
            : Array.Empty<KeyValuePair<string, IReadOnlyList<int>>>();
        bool cached = cache.TryGet(key, out var rng);
        int hi = staffing.MaxHeadcount(reqs, nd);
        var adj = staffing.AdjustHeadcount(team, CapOnly(hi, nd), entries.Select(e => e.Key).ToList());
        string note = adj.Staff.Count < team.Count ? adj.Note : $"參與排班 {team.Count} 人";
        var staffingInfo = new StaffingInfo(cached ? rng.Min : null, hi, cached ? rng.Comfort : null, note);
        var staff = adj.Staff;
        var ids = staff.Select(s => s.StaffId).ToList();
        var idSet = ids.ToHashSet();
        var wishes = entries.Where(e => idSet.Contains(e.Key))
            .Select(e => new KeyValuePair<string, IReadOnlyList<int>>(e.Key, e.Value.Where(d => d >= 1 && d <= nd).Select(d => d - 1).ToList()))
            .ToList();
        var pin = wishes.Count > 0 ? WishFeasibilityChecker.PinRest(wishes) : null;   // 已登記預假 = 硬約束
        var prob = new Problem(GenerationProfile.ForGeneration(year, month, staff, reqs, wishes.ToDictionary(e => e.Key, e => e.Value)));
        var mult = ids.ToDictionary(i => i, _ => 1.0);
        var staffById = staff.ToDictionary(s => s.StaffId);

        // 外部起點：工號大小寫、OFF / 休 / 假別、少列 / 多列、長度不對 — 合格的列保留，其餘格子當 RC
        int hintRowsUsed = 0;
        Dictionary<string, ShiftCode[]>? hint = null;
        if (cmd.Hint is not null)
        {
            var byUpper = new Dictionary<string, IReadOnlyList<string>>();
            foreach (var (k, v) in cmd.Hint) byUpper[k.Trim().ToUpperInvariant()] = v;   // 後者覆蓋，= dict comprehension
            var norm = new Dictionary<string, ShiftCode[]>();
            foreach (var s in ids)
            {
                if (byUpper.TryGetValue(s.ToUpperInvariant(), out var row) && row is not null && row.Count == nd)
                {
                    norm[s] = row.Select(c => ShiftByName.GetValueOrDefault((c ?? "").Trim().ToUpperInvariant(), ShiftCode.RC)).ToArray();
                    hintRowsUsed++;
                }
                else norm[s] = Enumerable.Repeat(ShiftCode.RC, nd).ToArray();
            }
            hint = hintRowsUsed > 0 ? norm : null;
        }

        double t0 = Now();
        ScheduleDomainException Timeout503() => new(ScheduleErrorKind.Timeout,
            $"排班在 {(int)(Now() - tStart)} 秒內沒有找到合法班表，已中止（上限約 2 分鐘）。請再試一次，或增補人力 / 降低每日需求");

        bool wishesHard = wishes.Count > 0;
        bool hintTrusted = false, startRepaired = false;
        Dictionary<string, ShiftCode[]>? start = null;
        if (hint is not null)
        {
            // 合法（含預假、每日人力）就直接用；不合法就交給零權重求解從它附近修
            bool legal = ids.All(s => inspector.HardViolations(hint[s], staffById[s], prob) == 0)
                         && wishes.All(e => e.Value.All(d => IsRest(hint[e.Key][d])))
                         && Enumerable.Range(0, nd).All(d => Work.All(sh =>
                         {
                             int c = ids.Count(s => hint[s][d] == sh);
                             return prob.Reqs[sh] <= c && c <= prob.ReqsMax[sh];
                         }));
            if (!legal) { start = hint; hint = null; }
        }
        if (hint is null)
        {
            var zero = new Problem(new ProblemDefinition(year, month, staff, reqs, ids.ToDictionary(i => i, _ => WishSet.Empty),
                                                         BackwardWeight: 0, Mix2Weight: 0, Mix3Weight: 0));
            Task<SolveResult> Feasible(double limit, bool withWishes) => Task.Run(() => scheduler.Solve(
                zero, FeatureWeights.Zero, mult, 0.0,
                new SolveOptions(limit, Workers: _o.Workers, Mode: _o.Mode, Extension: withWishes ? pin : null, Hint: start), ct), ct);

            var f = await Feasible(Math.Max(5.0, (deadline - Now() - _o.SolveMarginSeconds) * _o.FeasibleShareOfBudget), wishes.Count > 0);
            if (f.Schedule is null && f.Reasons.Count > 0)
                throw new ScheduleDomainException(ScheduleErrorKind.BadRequest, "人力不足：" + string.Join("；", f.Reasons) + "。請增補人力或降低每日需求");
            if (f.Schedule is null && wishes.Count > 0 && f.Status == SolveStatus.Infeasible)
            {
                // 已登記預假彼此衝突（理論上送出時已檢查）：改拿不含預假的起點，預假改當軟約束
                _log.LogWarning("{Y}/{M} 預假當硬約束無解，改為軟約束", year, month);
                wishesHard = false;
                f = await Feasible(Math.Max(5.0, (deadline - Now() - _o.SolveMarginSeconds) * _o.FeasibleShareOnFallback), false);
            }
            if (f.Schedule is not null)
            {
                hint = f.Schedule.ToDictionary(kv => kv.Key, kv => kv.Value);
                hintTrusted = true;
                startRepaired = start is not null;   // 外部起點不合法、已由零權重模型修成合法
            }
            else if (f.Status == SolveStatus.Unknown) throw Timeout503();
            else throw new ScheduleDomainException(ScheduleErrorKind.BadRequest,
                $"目前 {ids.Count} 人排不出合法班表，請到「人力與預假」做人力試算，增補人力或降低每日需求");
        }
        double timeLimit = Math.Max(5.0, Math.Min(cmd.TimeLimit, deadline - Now() - _o.SolveMarginSeconds));
        var hintFinal = hint;
        var r = await Task.Run(() => scheduler.Solve(prob, GenerationProfile.Weights, mult, 1.0,
            new SolveOptions(timeLimit, Workers: _o.Workers, Mode: _o.Mode, Extension: wishesHard ? pin : null,
                             Hint: hintFinal, HintTrusted: hintTrusted), ct), ct);
        if (r.HintRejected && hintTrusted)
            _log.LogWarning("{Y}/{M} 零權重模型的起點被完整模型判定不可行 — 兩個模型的硬約束不一致，請檢查模型", year, month);
        double retryLimit = deadline - Now() - _o.SolveMarginSeconds;
        if (r.Schedule is null && wishesHard && retryLimit >= 5)
        {
            _log.LogWarning("{Y}/{M} 預假當硬約束無解（{Status}），退回軟約束", year, month, StatusNames.Of(r.Status));
            r = await Task.Run(() => scheduler.Solve(prob, GenerationProfile.Weights, mult, 1.0,
                new SolveOptions(retryLimit, Workers: _o.Workers, Mode: _o.Mode, Hint: hintFinal), ct), ct);
            wishesHard = false;
        }
        if (r.Schedule is null)
        {
            if (r.Status == SolveStatus.Unknown) throw Timeout503();
            throw new ScheduleDomainException(ScheduleErrorKind.BadRequest,
                r.Reasons.Count > 0 ? string.Join("；", r.Reasons) : $"找不到合法班表（{StatusNames.Of(r.Status)}），請增補人力或降低需求");
        }

        var S = r.Schedule;
        int hit = wishes.Sum(e => e.Value.Count(d => IsRest(S[e.Key][d])));
        int hard = ids.Sum(s => inspector.HardViolations(S[s], staffById[s], prob));
        var cells = ids.SelectMany(s => Enumerable.Range(0, nd).Select(d =>
            new ScheduleCell(s, $"{year}-{month:00}-{d + 1:00}", S[s][d].ToString()))).ToList();
        var shiftTypes = ids.GroupBy(s => S[s].Where(IsWork).Distinct().Count())
                            .ToDictionary(g => g.Key.ToString(), g => g.Count());
        return new GenerateResult(
            "success",
            hard > 0 ? "INFEASIBLE" : r.Status == SolveStatus.Optimal ? "OPTIMAL" : "FEASIBLE",
            Math.Round(Now() - t0, 2),
            cells,
            new GenerateStats("cpsat", StatusNames.Of(r.Status), r.Gap, r.Objective, r.HintValue, hard, nd, ids.Count,
                              wishes.Sum(e => e.Value.Count), hit, wishesHard, staffingInfo,
                              ids.Sum(s => inspector.BackwardRotations(S[s])), shiftTypes, inspector.SeniorGapCount(prob, S),
                              startRepaired, hintRowsUsed));
    }
}
