namespace Aegis.Api.Auth;

public sealed class AuthOptions
{
    public string JwtSigningKey { get; set; } = "";          // base64，至少 32 bytes（Docker secret 提供）
    public string Issuer { get; set; } = "aegis";
    public string Audience { get; set; } = "aegis";
    public int AccessTokenMinutes { get; set; } = 15;
    public int RefreshTokenDays { get; set; } = 1;            // 不勾「記住我」：關瀏覽器就失效（session cookie），伺服器端最多 1 天
    public int PersistentRefreshTokenDays { get; set; } = 30; // 勾「記住我」
    public int LockoutThreshold { get; set; } = 5;            // 連續錯 5 次
    public int LockoutMinutes { get; set; } = 15;             // 鎖 15 分鐘
    public int OneTimeTokenHours { get; set; } = 2;           // 啟用 / 重設連結（= Node ACTIVATION_TOKEN_TTL_HOURS）
    public int PasswordHistorySize { get; set; } = 5;         // = Node PASSWORD_HISTORY_SIZE
    public string RefreshCookieName { get; set; } = "aegis_rt";
}

public static class AegisClaims
{
    public const string Login = "login", StaffId = "staff_id", Role = "role", SuperAdmin = "super", MustChange = "must_change", Stamp = "sstamp";
    public const string AdminRole = "admin", StaffRole = "staff";
}

public static class Policies
{
    public const string Admin = "Admin", SuperAdmin = "SuperAdmin", Staff = "Staff";
}
