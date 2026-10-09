using System.Data;
using Aegis.Engine;
using Aegis.Scheduling;
using Microsoft.EntityFrameworkCore;

namespace Aegis.Data;

// 階段一 IScheduleDataStore 的 SQL 實作（= cpsat_service.FirestoreStore）
public sealed class SqlScheduleDataStore(AegisDbContext db, TimeProvider? clock = null) : IScheduleDataStore
{
    private readonly TimeProvider _clock = clock ?? TimeProvider.System;

    // = Settings.leaveWish：目前的預假視窗 = 開放中的那個，否則最近開過的那個
    public async Task<LeaveWishSettings?> GetLeaveSettingsAsync(CancellationToken ct)
    {
        var all = await db.LeaveWishWindows.AsNoTracking().ToListAsync(ct);   // 量很小；DateTimeOffset 排序在 SQLite 不能下推
        var w = all.Where(x => x.Open).OrderByDescending(x => x.OpenedAt).FirstOrDefault()
                ?? all.OrderByDescending(x => x.OpenedAt).ThenByDescending(x => x.Year * 12 + x.Month).FirstOrDefault();
        return w is null ? null
            : new LeaveWishSettings(w.Open, w.Year, w.Month, new ShiftRequirement(w.ReqD, w.ReqE, w.ReqN), w.Quota, w.DaysPerPerson);
    }

    public async Task<IReadOnlyList<StaffRow>> GetStaffRowsAsync(CancellationToken ct) =>
        (await db.Staff.AsNoTracking().OrderBy(s => s.StaffId).ToListAsync(ct))
            .Select(s => new StaffRow(s.StaffId, s.Name, s.IsActive, s.SpecialStatus.ToString(), s.IsPregnantOrNursing,
                                      s.LeaveStatus, s.Level, s.IsLeader))
            .ToList();

    // 依第一次登記時間排序（名額不夠時先登記的優先），同時間再依工號
    public async Task<WishState> GetWishStateAsync(int year, int month, CancellationToken ct)
    {
        var w = await db.LeaveWishWindows.AsNoTracking().FirstOrDefaultAsync(x => x.Year == year && x.Month == month, ct);
        var entries = await db.LeaveWishEntries.AsNoTracking().Include(e => e.Days)
            .Where(e => e.Year == year && e.Month == month).ToListAsync(ct);
        return new WishState(w?.Version ?? 0, entries
            .OrderBy(e => e.FirstSubmittedAt).ThenBy(e => e.StaffId, StringComparer.Ordinal)
            .Select(e => new KeyValuePair<string, IReadOnlyList<int>>(e.StaffId, e.Days.Select(d => d.Day).OrderBy(d => d).ToList()))
            .ToList());
    }

    // 樂觀鎖：版本沒變才寫入；交易內再算一次每日人數，避免兩人同時搶最後一個名額
    public async Task<bool> CommitWishAsync(int year, int month, string staffId, IReadOnlyList<int> days, int expectedVersion,
                                            int quota, CancellationToken ct)
    {
        await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.Serializable, ct);
        var w = await db.LeaveWishWindows.FirstOrDefaultAsync(x => x.Year == year && x.Month == month, ct);
        if ((w?.Version ?? 0) != expectedVersion) return false;
        var others = await db.LeaveWishDays.Where(d => d.Year == year && d.Month == month && d.StaffId != staffId)
                                           .Select(d => d.Day).ToListAsync(ct);
        var counts = others.GroupBy(d => d).ToDictionary(g => g.Key, g => g.Count());
        foreach (var d in days)
            if (counts.GetValueOrDefault(d) + 1 > quota) return false;

        var now = _clock.GetUtcNow();
        if (w is null)
        {
            w = new LeaveWishWindow { Year = year, Month = month };
            db.LeaveWishWindows.Add(w);
        }
        w.Version = expectedVersion + 1;
        w.Quota = quota;
        var entry = await db.LeaveWishEntries.Include(e => e.Days)
            .FirstOrDefaultAsync(e => e.Year == year && e.Month == month && e.StaffId == staffId, ct);
        if (entry is null)
        {
            entry = new LeaveWishEntry { Year = year, Month = month, StaffId = staffId, FirstSubmittedAt = now };   // 改日期保留原順位
            db.LeaveWishEntries.Add(entry);
        }
        entry.SubmittedAt = now;
        db.LeaveWishDays.RemoveRange(entry.Days);
        entry.Days = days.OrderBy(d => d).Distinct()
            .Select(d => new LeaveWishDay { Year = year, Month = month, StaffId = staffId, Day = d }).ToList();
        try
        {
            await db.SaveChangesAsync(ct);
            await tx.CommitAsync(ct);
            return true;
        }
        catch (DbUpdateConcurrencyException)   // 別人同時改了版本 → 由呼叫端重讀重算（ScheduleService 最多重試 3 次）
        {
            await tx.RollbackAsync(ct);
            db.ChangeTracker.Clear();
            return false;
        }
    }
}
