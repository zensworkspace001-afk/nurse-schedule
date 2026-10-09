using Aegis.Data;
using Aegis.Security;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Aegis.Api.Auth;

public enum PasswordCheck { Fail, Ok, OkNeedsRehash }

// 新密碼：ASP.NET Core Identity PasswordHasher（PBKDF2）；舊帳號："firebase-scrypt$<salt>$<hash>" → 驗一次就換新格式（方案 A）
public interface IPasswordService
{
    PasswordCheck Verify(AppUser user, string password, LegacyHashConfig? legacy);
    string Hash(string password);
}

public sealed class PasswordService : IPasswordService
{
    private const string FirebasePrefix = "firebase-scrypt$";
    private readonly PasswordHasher<AppUser> _hasher = new();

    public string Hash(string password) => _hasher.HashPassword(null!, password);

    public PasswordCheck Verify(AppUser user, string password, LegacyHashConfig? legacy)
    {
        if (string.IsNullOrEmpty(user.PasswordHash)) return PasswordCheck.Fail;
        if (user.PasswordHash.StartsWith(FirebasePrefix, StringComparison.Ordinal))
        {
            if (legacy is null) return PasswordCheck.Fail;
            var parts = user.PasswordHash[FirebasePrefix.Length..].Split('$');
            if (parts.Length != 2) return PasswordCheck.Fail;
            var p = new FirebaseHashParams(legacy.SignerKey, legacy.SaltSeparator, legacy.Rounds, legacy.MemoryCost);
            return FirebaseScrypt.Verify(password, parts[0], parts[1], p) ? PasswordCheck.OkNeedsRehash : PasswordCheck.Fail;
        }
        return _hasher.VerifyHashedPassword(user, user.PasswordHash, password) switch
        {
            PasswordVerificationResult.Success => PasswordCheck.Ok,
            PasswordVerificationResult.SuccessRehashNeeded => PasswordCheck.OkNeedsRehash,
            _ => PasswordCheck.Fail,
        };
    }
}

// = api/_lib/activationToken.js validatePasswordStrength（訊息相同，前端直接顯示）
public static class PasswordPolicy
{
    public static string? Problem(string? pw)
    {
        if (pw is null) return "密碼格式錯誤";
        if (pw == "123456") return "密碼不可使用預設值";
        if (pw.Length < 6) return "密碼至少 6 碼";
        if (!System.Text.RegularExpressions.Regex.IsMatch(pw, @"^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d!@#$%^&*()_+\-=]{6,}$"))
            return "密碼必須同時包含英文與數字";
        return null;
    }
}

// = api/_lib/passwordHistory.js：最近 N 組密碼的加鹽 scrypt 雜湊（與遷移過來的歷史同格式，舊歷史照樣能比對）
public sealed class PasswordHistoryService(AegisDbContext db, IOptions<AuthOptions> options, TimeProvider clock)
{
    public const string ReusedMessage = "不可使用最近用過的密碼，請換一組新密碼";

    private static string Key(string staffOrLogin) => staffOrLogin.Trim().ToLowerInvariant();

    public async Task<bool> IsReusedAsync(string staffOrLogin, string plain, CancellationToken ct)
    {
        var entries = await db.PasswordHistory.AsNoTracking().Where(h => h.StaffId == Key(staffOrLogin)).ToListAsync(ct);
        return entries.Any(e => Scrypt.Verify(plain, e.Salt, e.Hash));
    }

    public async Task RecordAsync(string staffOrLogin, string plain, CancellationToken ct)
    {
        string key = Key(staffOrLogin);
        var entries = await db.PasswordHistory.Where(h => h.StaffId == key).OrderBy(h => h.Seq).ToListAsync(ct);
        string salt = Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();
        int next = entries.Count == 0 ? 0 : entries.Max(e => e.Seq) + 1;
        db.PasswordHistory.Add(new PasswordHistoryEntry { StaffId = key, Seq = next, Salt = salt, Hash = Scrypt.HashHex(plain, salt), At = clock.GetUtcNow() });
        int keep = options.Value.PasswordHistorySize;
        db.PasswordHistory.RemoveRange(entries.Take(Math.Max(0, entries.Count + 1 - keep)));
    }
}
