using System.Text.Json;
using Aegis.Data;

namespace Aegis.Api.Auth;

// = api/_lib/accessLog.js writeAccessLog（欄位相同；寫進 AccessLog 表）
public sealed record AuditEntry(string Action, string? ActorUid, string? ActorEmail, string? TargetKind = null, string? TargetId = null,
                                IReadOnlyList<string>? Fields = null, object? Extra = null);

public interface IAuditLogger
{
    Task WriteAsync(AuditEntry e, HttpContext? http, CancellationToken ct);
}

public sealed class EfAuditLogger(AegisDbContext db, TimeProvider clock, ILogger<EfAuditLogger> log) : IAuditLogger
{
    public async Task WriteAsync(AuditEntry e, HttpContext? http, CancellationToken ct)
    {
        try   // 稽核失敗不擋業務（與 Node 版相同）
        {
            db.AccessLogs.Add(new AccessLog
            {
                Ts = clock.GetUtcNow(), Action = e.Action, ActorUid = e.ActorUid, ActorEmail = e.ActorEmail, TargetKind = e.TargetKind,
                TargetId = e.TargetId, FieldsJson = JsonSerializer.Serialize(e.Fields ?? Array.Empty<string>()),
                ExtraJson = e.Extra is null ? null : JsonSerializer.Serialize(e.Extra),
                Ip = http?.Connection.RemoteIpAddress?.ToString(), Ua = Truncate(http?.Request.Headers.UserAgent.ToString(), 512),
            });
            await db.SaveChangesAsync(ct);
        }
        catch (Exception ex) { log.LogWarning(ex, "稽核寫入失敗：{Action}", e.Action); }
    }

    private static string? Truncate(string? s, int n) => s is null || s.Length <= n ? s : s[..n];
}
