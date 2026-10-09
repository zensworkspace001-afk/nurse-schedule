using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;

namespace Aegis.Api.Auth;

public sealed record CurrentUser(string UserId, string LoginId, string? StaffId, bool IsAdmin, bool IsSuperAdmin, bool MustChangePassword)
{
    public static CurrentUser From(ClaimsPrincipal p) => new(
        p.FindFirstValue(JwtRegisteredClaimNames.Sub) ?? p.FindFirstValue(ClaimTypes.NameIdentifier) ?? "",
        p.FindFirstValue(AegisClaims.Login) ?? "", p.FindFirstValue(AegisClaims.StaffId),
        p.FindFirstValue(AegisClaims.Role) == AegisClaims.AdminRole, p.FindFirstValue(AegisClaims.SuperAdmin) == "true",
        p.FindFirstValue(AegisClaims.MustChange) == "true");

    // 給前端的形狀（取代 Firebase user + getIdTokenResult().claims）
    public object ToDto() => new { uid = UserId, login = LoginId, staffId = StaffId, role = IsAdmin ? "admin" : "staff",
                                   superAdmin = IsSuperAdmin, mustChangePassword = MustChangePassword };
}
