using System.Net;
using System.Net.Mail;
using Aegis.Api.Auth;
using Aegis.Data;
using Microsoft.EntityFrameworkCore;

namespace Aegis.Api.Services;

// 決策 2A：設了院內 SMTP 就寄信；沒設就回 false → 連結交回管理員親自轉交（與現行 Node 版寄信失敗時的行為相同）
public interface IEmailSender
{
    Task<bool> SendAsync(string to, string subject, string html, CancellationToken ct);
}

public sealed class SmtpEmailSender(IConfiguration cfg, ILogger<SmtpEmailSender> log) : IEmailSender
{
    public async Task<bool> SendAsync(string to, string subject, string html, CancellationToken ct)
    {
        string? host = cfg["Smtp:Host"];
        if (string.IsNullOrEmpty(host)) return false;
        try
        {
            using var client = new SmtpClient(host, cfg.GetValue("Smtp:Port", 25)) { EnableSsl = cfg.GetValue("Smtp:EnableSsl", false) };
            if (cfg["Smtp:User"] is { Length: > 0 } user) client.Credentials = new NetworkCredential(user, cfg["Smtp:Password"]);
            using var msg = new MailMessage(cfg["Smtp:From"] ?? "nurse-schedule@localhost", to, subject, html) { IsBodyHtml = true };
            await client.SendMailAsync(msg, ct);
            return true;
        }
        catch (Exception ex)
        {
            log.LogWarning(ex, "寄信失敗：{To}", to);
            return false;
        }
    }
}

public sealed record SyncResult(int InvitedCount, int ExistedCount, int ErrorCount, List<string> Errors, List<object> ManualLinks);

// = api/admin-user.js 的 sync / reset / delete-staff / set-admin
public sealed class AccountService(AegisDbContext db, AuthService auth, TokenService tokens, IEmailSender email, IAuditLogger audit,
                                   IConfiguration cfg, TimeProvider clock)
{
    private string BaseUrl(HttpContext http) => (cfg["Aegis:PublicBaseUrl"] ?? $"{http.Request.Scheme}://{http.Request.Host}").TrimEnd('/');
    private int TtlHours => cfg.GetValue("Auth:OneTimeTokenHours", 2);

    private string LinkHtml(string name, string link, bool reset) => $"""
        <h2>您好 {WebUtility.HtmlEncode(name)}：</h2>
        <p>{(reset ? "管理員已為您觸發密碼重設。請點擊以下連結設定新的登入密碼：" : "管理員已為您建立護理排班系統帳號。請點擊以下連結設定您的登入密碼以啟用帳號：")}</p>
        <p><a href="{link}">{(reset ? "點我重設密碼" : "點我啟用帳號並設定密碼")}</a></p>
        <p>或複製以下網址至瀏覽器開啟：<br/><code>{link}</code></p>
        <hr/><p style="color:#888;font-size:12px;">此連結 {TtlHours} 小時內有效，僅可使用一次。<br/>若您未請求此操作，請忽略此信。</p>
        """;

    // 為還沒有登入帳號的員工建立帳號（停用狀態）並發啟用連結
    public async Task<SyncResult> SyncAsync(HttpContext http, CancellationToken ct)
    {
        int invited = 0, existed = 0;
        var errors = new List<string>();
        var manual = new List<object>();
        var users = await db.Users.Where(u => u.StaffId != null).Select(u => u.StaffId!).ToListAsync(ct);
        foreach (var s in await db.Staff.AsNoTracking().OrderBy(s => s.StaffId).ToListAsync(ct))
        {
            if (users.Contains(s.StaffId, StringComparer.OrdinalIgnoreCase)) { existed++; continue; }
            if (string.IsNullOrWhiteSpace(s.Email)) { errors.Add($"{s.StaffId}: 缺少 email，無法寄送啟用信"); continue; }
            db.Users.Add(new AppUser { Id = s.StaffId, LoginId = s.StaffId.ToLowerInvariant(), StaffId = s.StaffId, Email = s.Email,
                                       Disabled = true, CreatedAt = clock.GetUtcNow() });   // 必須用啟用連結設密碼才能登入
            await db.SaveChangesAsync(ct);
            string token = await auth.IssueLinkTokenAsync(s.StaffId, "activation", ct);
            string link = $"{BaseUrl(http)}/activate?token={token}";
            if (!await email.SendAsync(s.Email, "【護理排班系統】請啟用您的帳號", LinkHtml(s.Name, link, false), ct))
                manual.Add(new { staffId = s.StaffId, name = s.Name, link });
            invited++;
        }
        return new SyncResult(invited, existed, errors.Count, errors, manual);
    }

    public async Task<List<string>> NotYetSavedAsync(IReadOnlyList<string>? staffIds, CancellationToken ct)
    {
        if (staffIds is not { Count: > 0 }) return [];
        var saved = await db.Staff.Select(s => s.StaffId).ToListAsync(ct);
        return staffIds.Where(id => !saved.Contains(id, StringComparer.OrdinalIgnoreCase)).ToList();
    }

    // 重設連結；帳號仍停用（從沒啟用成功）就改發啟用連結，使用時一併解除停用
    public async Task<object> ResetLinkAsync(string staffId, HttpContext http, CancellationToken ct)
    {
        var staff = await db.Staff.AsNoTracking().FirstOrDefaultAsync(s => s.StaffId == staffId, ct)
                    ?? throw new DocumentValidationException($"找不到員工 {staffId}");
        if (string.IsNullOrWhiteSpace(staff.Email)) throw new DocumentValidationException("該員工尚未設定 Email，無法寄送重設信");
        var user = await db.Users.FirstOrDefaultAsync(u => u.StaffId == staffId, ct)
                   ?? throw new DocumentValidationException("在帳號庫中找不到該員工，可能尚未建立帳號（請先儲存員工資料並同步帳號）");
        string purpose = user.Disabled ? "activation" : "reset";
        await tokens.RevokeAllAsync(user.Id, ct);
        string token = await auth.IssueLinkTokenAsync(user.Id, purpose, ct);
        string link = $"{BaseUrl(http)}/activate?token={token}";
        bool sent = await email.SendAsync(staff.Email, purpose == "reset" ? "【護理排班系統】密碼重設請求" : "【護理排班系統】請啟用您的帳號",
                                          LinkHtml(staff.Name, link, purpose == "reset"), ct);
        return new { message = sent ? $"已寄送密碼重設信至 {staff.Email}" : "寄信失敗，請將連結親自交給員工", email = staff.Email, purpose,
                     manualLink = sent ? null : link };
    }

    // 永久離職：歸檔（不含加密個資）→ 刪除員工 → 停用帳號、撤銷登入、清密碼歷史 → 稽核
    public async Task<object> OffboardAsync(string staffId, CurrentUser actor, HttpContext http, CancellationToken ct)
    {
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var s = await db.Staff.Include(x => x.Avatar).FirstOrDefaultAsync(x => x.StaffId == staffId, ct)
                ?? throw new DocumentValidationException($"找不到員工 {staffId}");
        db.ExStaff.Add(new ExStaff { StaffId = s.StaffId, Name = s.Name, Email = s.Email, Level = s.Level, TenureYears = s.TenureYears,
            Avatar = s.Avatar?.Avatar, AvatarThumb = s.Avatar?.AvatarThumb, HadAvatar = s.Avatar?.Avatar != null,
            DeletedAt = clock.GetUtcNow(), DeletedByUid = actor.UserId, DeletedByEmail = actor.LoginId });
        db.Staff.Remove(s);   // StaffSensitive / StaffAvatar / Settlement 串聯刪除
        db.PasswordHistory.RemoveRange(db.PasswordHistory.Where(h => h.StaffId == staffId.ToLower()));
        bool authDisabled = false;
        if (await db.Users.FirstOrDefaultAsync(u => u.StaffId == staffId, ct) is { } user)
        {
            user.Disabled = true;
            user.StaffId = null;
            authDisabled = true;
            await db.SaveChangesAsync(ct);
            await tokens.RevokeAllAsync(user.Id, ct);
        }
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        await audit.WriteAsync(new AuditEntry("delete-staff", actor.UserId, actor.LoginId, "staff", staffId,
            ["avatar", "avatar_thumb", "name", "email", "level", "tenure_years"], new { archived_to = $"ex_staff/{staffId}", auth_disabled = authDisabled }), http, ct);
        return new { message = $"員工 {s.Name} 已永久離職歸檔", archived_to = $"ex_staff/{staffId}", had_avatar = s.Avatar?.Avatar != null, auth_disabled = authDisabled };
    }

    // 授予 / 撤銷管理員（僅超級管理員；Controller 用 SuperAdmin policy 擋）；撤銷對方登入讓變更立即生效
    public async Task<object> SetAdminAsync(string staffId, bool makeAdmin, CurrentUser actor, HttpContext http, CancellationToken ct)
    {
        var s = await db.Staff.FirstOrDefaultAsync(x => x.StaffId == staffId, ct) ?? throw new DocumentValidationException($"找不到員工 {staffId}");
        var user = await db.Users.FirstOrDefaultAsync(u => u.StaffId == staffId, ct)
                   ?? throw new DocumentValidationException("這位員工還沒有登入帳號，請先儲存員工資料建立帳號");
        s.IsAdmin = makeAdmin;
        await db.SaveChangesAsync(ct);
        await tokens.RevokeAllAsync(user.Id, ct);
        await audit.WriteAsync(new AuditEntry("set-admin", actor.UserId, actor.LoginId, "staff", staffId, ["admin"], new { admin = makeAdmin }), http, ct);
        return new { message = makeAdmin ? $"已授予 {s.Name} 管理員權限（對方需重新登入）" : $"已撤銷 {s.Name} 的管理員權限（對方需重新登入）", admin = makeAdmin };
    }
}
