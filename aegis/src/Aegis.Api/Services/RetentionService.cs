using Aegis.Data;
using Microsoft.EntityFrameworkCore;

namespace Aegis.Api.Services;

// = api/cron/check-timeout.js 的個資保留期限掃除（Vercel Cron 每天一次 → 地端背景服務每天一次）
//   稽核日誌 180 天、歷史封存 7 年（依年月判斷，不依賴可能被覆寫的時間欄位）、過期的一次性 token 與 refresh token
public sealed class RetentionService(IServiceScopeFactory scopes, IConfiguration cfg, TimeProvider clock, ILogger<RetentionService> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        // 啟動後先等一下再掃（不和啟動 / 資料庫初始化搶）
        try { await Task.Delay(TimeSpan.FromMinutes(cfg.GetValue("Aegis:RetentionStartupDelayMinutes", 5)), clock, stop); } catch (OperationCanceledException) { return; }
        while (!stop.IsCancellationRequested)
        {
            try { await SweepAsync(stop); } catch (Exception ex) when (ex is not OperationCanceledException) { log.LogWarning(ex, "保留期限掃除失敗"); }
            try { await Task.Delay(TimeSpan.FromHours(24), clock, stop); } catch (OperationCanceledException) { return; }
        }
    }

    public async Task<(int Logs, int Archives, int Tokens)> SweepAsync(CancellationToken ct)
    {
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AegisDbContext>();
        var now = clock.GetUtcNow();
        var logCutoff = now.AddDays(-cfg.GetValue("Aegis:AccessLogRetentionDays", 180));
        var oldLogs = (await db.AccessLogs.Select(l => new { l.Id, l.Ts }).ToListAsync(ct)).Where(l => l.Ts < logCutoff).Select(l => l.Id).ToList();
        db.AccessLogs.RemoveRange(oldLogs.Select(id => new AccessLog { Id = id }));
        var archiveCutoff = now.AddDays(-cfg.GetValue("Aegis:ArchiveRetentionDays", 2555));
        int cutoffYm = archiveCutoff.Year * 100 + archiveCutoff.Month;
        var oldArchives = await db.ArchiveReports.Where(a => a.Year * 100 + a.Month < cutoffYm).ToListAsync(ct);
        foreach (var a in oldArchives)
            db.ScheduleCells.RemoveRange(db.ScheduleCells.Where(c => c.Kind == ScheduleKind.Archive && c.Year == a.Year && c.Month == a.Month));
        db.ArchiveReports.RemoveRange(oldArchives);
        var tokens = (await db.OneTimeTokens.ToListAsync(ct)).Where(t => t.ExpiresAt < now).ToList();
        db.OneTimeTokens.RemoveRange(tokens);
        var refresh = (await db.RefreshTokens.ToListAsync(ct)).Where(t => t.ExpiresAt < now.AddDays(-7)).ToList();
        db.RefreshTokens.RemoveRange(refresh);
        await db.SaveChangesAsync(ct);
        if (oldLogs.Count + oldArchives.Count + tokens.Count > 0)
            log.LogInformation("保留期限掃除：稽核 {Logs}、封存 {Archives}、一次性 token {Tokens}", oldLogs.Count, oldArchives.Count, tokens.Count);
        return (oldLogs.Count, oldArchives.Count, tokens.Count + refresh.Count);
    }
}
