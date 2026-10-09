using Aegis.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Aegis.Api.Auth;

// 錯誤代碼沿用 Firebase 的（前端 LoginPanel 已有對應訊息，階段四不必改）
public sealed record LoginResult(bool Ok, string? ErrorCode, string? Message, TokenPair? Tokens, AppUser? User);

public sealed class AuthService(
    AegisDbContext db, IPasswordService passwords, TokenService tokens, PasswordHistoryService history, IAuditLogger audit,
    IOptions<AuthOptions> options, TimeProvider clock)
{
    private AuthOptions O => options.Value;
    public const string InvalidCredential = "auth/invalid-credential", TooMany = "auth/too-many-requests";

    public async Task<LoginResult> LoginAsync(string loginId, string password, bool persistent, HttpContext? http, CancellationToken ct)
    {
        var now = clock.GetUtcNow();
        string login = (loginId ?? "").Trim().ToLowerInvariant();
        var user = await db.Users.FirstOrDefaultAsync(u => u.LoginId == login, ct);
        async Task<LoginResult> Fail(string code, string msg)
        {
            await audit.WriteAsync(new AuditEntry("login-failure", null, null, Extra: new { attempted_login = login, error_code = code }), http, ct);
            return new LoginResult(false, code, msg, null, null);
        }
        // 帳號不存在 / 停用 / 密碼錯一律同一句（不讓人列舉合法工號）
        if (user is null || user.Disabled) return await Fail(InvalidCredential, "帳號或密碼錯誤，或帳號狀態異常，請聯絡管理員。");
        if (user.LockoutUntil is { } until && until > now) return await Fail(TooMany, "失敗次數過多，請稍後再試。");

        var legacy = await db.LegacyHashConfig.AsNoTracking().FirstOrDefaultAsync(ct);
        var check = passwords.Verify(user, password ?? "", legacy);
        if (check == PasswordCheck.Fail)
        {
            user.FailedLogins++;
            if (user.FailedLogins >= O.LockoutThreshold)
            {
                user.LockoutUntil = now.AddMinutes(O.LockoutMinutes);
                user.FailedLogins = 0;
            }
            await db.SaveChangesAsync(ct);
            return await Fail(InvalidCredential, "帳號或密碼錯誤，或帳號狀態異常，請聯絡管理員。");
        }
        if (check == PasswordCheck.OkNeedsRehash) user.PasswordHash = passwords.Hash(password!);   // 舊 Firebase 雜湊 → 新格式
        user.FailedLogins = 0;
        user.LockoutUntil = null;
        user.LastLoginAt = now;
        await db.SaveChangesAsync(ct);
        var staff = user.StaffId is null ? null : await db.Staff.AsNoTracking().FirstOrDefaultAsync(s => s.StaffId == user.StaffId, ct);
        var pair = await tokens.IssueAsync(user, staff, persistent, null, ct);
        await audit.WriteAsync(new AuditEntry("login", user.Id, user.Email), http, ct);
        return new LoginResult(true, null, null, pair, user);
    }

    public async Task<TokenPair?> RefreshAsync(string refresh, CancellationToken ct)
    {
        var consumed = await tokens.ConsumeRefreshAsync(refresh, ct);
        if (consumed is not { } c) return null;
        var staff = c.User.StaffId is null ? null : await db.Staff.AsNoTracking().FirstOrDefaultAsync(s => s.StaffId == c.User.StaffId, ct);
        var pair = await tokens.IssueAsync(c.User, staff, c.Old.Persistent, c.Old.FamilyId, ct);
        c.Old.ReplacedBy = TokenService.Sha256(pair.RefreshToken);
        await db.SaveChangesAsync(ct);
        return pair;
    }

    public async Task LogoutAsync(string refresh, CancellationToken ct)
    {
        var row = await db.RefreshTokens.FirstOrDefaultAsync(r => r.TokenHash == TokenService.Sha256(refresh), ct);
        if (row != null) await tokens.RevokeFamilyAsync(row.FamilyId, ct);
    }

    // 已登入者改密碼（= complete-profile change-password）：強度 → 歷史 → 設定 → 記錄 → 清 must_change_password
    public async Task<string?> ChangePasswordAsync(string userId, string newPassword, HttpContext? http, CancellationToken ct)
    {
        if (PasswordPolicy.Problem(newPassword) is { } p) return p;
        var user = await db.Users.FirstAsync(u => u.Id == userId, ct);
        string key = user.StaffId ?? user.LoginId;
        if (await history.IsReusedAsync(key, newPassword, ct)) return PasswordHistoryService.ReusedMessage;
        user.PasswordHash = passwords.Hash(newPassword);
        await history.RecordAsync(key, newPassword, ct);
        if (user.StaffId != null && await db.Staff.FirstOrDefaultAsync(s => s.StaffId == user.StaffId, ct) is { } st) st.MustChangePassword = false;
        await db.SaveChangesAsync(ct);
        await audit.WriteAsync(new AuditEntry("update-profile", user.Id, user.Email, "staff", user.StaffId, ["password"],
                                              new { source = "auth", mode = "change-password" }), http, ct);
        return null;
    }

    // 一次性連結（啟用 / 重設，= activate-account.js 無 action）：驗 token → 強度 → 歷史 → 設定 → activation 解除停用 → 撤銷舊 session
    public async Task<(bool Ok, string Message)> UseLinkAsync(string token, string newPassword, HttpContext? http, CancellationToken ct)
    {
        if (PasswordPolicy.Problem(newPassword) is { } p) return (false, p);
        var now = clock.GetUtcNow();
        var row = await db.OneTimeTokens.FirstOrDefaultAsync(t => t.TokenHash == TokenService.Sha256(token ?? "") && t.Purpose != "otp", ct);
        if (row is null || row.ExpiresAt <= now) return (false, "連結無效或已過期，請聯絡管理員重新寄送");
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == row.UserId, ct);
        if (user is null) { db.OneTimeTokens.Remove(row); await db.SaveChangesAsync(ct); return (false, "帳號不存在，請聯絡管理員"); }
        string key = user.StaffId ?? user.LoginId;
        if (await history.IsReusedAsync(key, newPassword, ct)) return (false, PasswordHistoryService.ReusedMessage);
        user.PasswordHash = passwords.Hash(newPassword);
        if (row.Purpose == "activation") user.Disabled = false;
        await history.RecordAsync(key, newPassword, ct);
        db.OneTimeTokens.Remove(row);
        await db.SaveChangesAsync(ct);
        await tokens.RevokeAllAsync(user.Id, ct);
        await audit.WriteAsync(new AuditEntry(row.Purpose == "activation" ? "activate" : "password-reset", user.Id, user.Email), http, ct);
        return (true, row.Purpose == "activation" ? "帳號啟用成功" : "密碼已重設");
    }

    // 管理員發一次性連結的 token（明文只回給呼叫端一次；資料庫只存雜湊）
    public async Task<string> IssueLinkTokenAsync(string userId, string purpose, CancellationToken ct)
    {
        var now = clock.GetUtcNow();
        db.OneTimeTokens.RemoveRange(db.OneTimeTokens.Where(t => t.UserId == userId && t.Purpose == purpose));
        string plain = TokenService.NewSecret();
        db.OneTimeTokens.Add(new OneTimeToken { TokenHash = TokenService.Sha256(plain), UserId = userId, Purpose = purpose,
                                                CreatedAt = now, ExpiresAt = now.AddHours(O.OneTimeTokenHours) });
        await db.SaveChangesAsync(ct);
        return plain;
    }
}
