using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using Aegis.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Tokens;

namespace Aegis.Api.Auth;

public sealed record TokenPair(string AccessToken, DateTimeOffset AccessExpiresAt, string RefreshToken, DateTimeOffset RefreshExpiresAt, bool Persistent);

public sealed class TokenService(AegisDbContext db, IOptions<AuthOptions> options, TimeProvider clock)
{
    private AuthOptions O => options.Value;

    public static SymmetricSecurityKey SigningKey(AuthOptions o)
    {
        var key = Convert.FromBase64String(o.JwtSigningKey);
        if (key.Length < 32) throw new InvalidOperationException("Auth:JwtSigningKey 必須是至少 32 bytes 的 base64");
        return new SymmetricSecurityKey(key);
    }

    public static string Sha256(string s) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(s))).ToLowerInvariant();
    public static string NewSecret() => Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    public async Task<TokenPair> IssueAsync(AppUser u, Staff? staff, bool persistent, string? familyId, CancellationToken ct)
    {
        var now = clock.GetUtcNow();
        bool isAdmin = u.IsSuperAdmin || staff?.IsAdmin == true;
        var claims = new List<Claim>
        {
            new(JwtRegisteredClaimNames.Sub, u.Id), new(AegisClaims.Login, u.LoginId),
            new(AegisClaims.Role, isAdmin ? AegisClaims.AdminRole : AegisClaims.StaffRole), new(AegisClaims.Stamp, u.SecurityStamp),
            new(JwtRegisteredClaimNames.Jti, Guid.NewGuid().ToString("N")),
        };
        if (u.StaffId != null) claims.Add(new(AegisClaims.StaffId, u.StaffId));
        if (u.IsSuperAdmin) claims.Add(new(AegisClaims.SuperAdmin, "true"));
        if (staff?.MustChangePassword == true) claims.Add(new(AegisClaims.MustChange, "true"));
        var accessExp = now.AddMinutes(O.AccessTokenMinutes);
        var jwt = new JwtSecurityToken(O.Issuer, O.Audience, claims, now.UtcDateTime, accessExp.UtcDateTime,
                                       new SigningCredentials(SigningKey(O), SecurityAlgorithms.HmacSha256));
        string refresh = NewSecret();
        var refreshExp = now.AddDays(persistent ? O.PersistentRefreshTokenDays : O.RefreshTokenDays);
        db.RefreshTokens.Add(new RefreshToken { TokenHash = Sha256(refresh), UserId = u.Id, FamilyId = familyId ?? Guid.NewGuid().ToString("N"),
                                                Persistent = persistent, CreatedAt = now, ExpiresAt = refreshExp });
        await db.SaveChangesAsync(ct);
        return new TokenPair(new JwtSecurityTokenHandler().WriteToken(jwt), accessExp, refresh, refreshExp, persistent);
    }

    // 輪替：舊的作廢、發新的（同一個 family）。拿已作廢的 token 來換 = 被偷用的跡象 → 整個 family 撤銷
    public async Task<(AppUser User, RefreshToken Old)?> ConsumeRefreshAsync(string refresh, CancellationToken ct)
    {
        var now = clock.GetUtcNow();
        var row = await db.RefreshTokens.FirstOrDefaultAsync(r => r.TokenHash == Sha256(refresh), ct);
        if (row is null) return null;
        if (row.RevokedAt != null)
        {
            await RevokeFamilyAsync(row.FamilyId, ct);
            return null;
        }
        if (row.ExpiresAt <= now) return null;
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == row.UserId, ct);
        if (user is null || user.Disabled) return null;
        row.RevokedAt = now;
        return (user, row);
    }

    public async Task RevokeFamilyAsync(string familyId, CancellationToken ct)
    {
        var now = clock.GetUtcNow();
        foreach (var t in await db.RefreshTokens.Where(r => r.FamilyId == familyId && r.RevokedAt == null).ToListAsync(ct)) t.RevokedAt = now;
        await db.SaveChangesAsync(ct);
    }

    public async Task RevokeAllAsync(string userId, CancellationToken ct)   // = Firebase revokeRefreshTokens
    {
        var now = clock.GetUtcNow();
        foreach (var t in await db.RefreshTokens.Where(r => r.UserId == userId && r.RevokedAt == null).ToListAsync(ct)) t.RevokedAt = now;
        var u = await db.Users.FirstAsync(x => x.Id == userId, ct);
        u.SecurityStamp = Guid.NewGuid().ToString("N");
        await db.SaveChangesAsync(ct);
    }
}
