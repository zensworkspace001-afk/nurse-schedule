using System.ComponentModel.DataAnnotations;

namespace Aegis.Data;

// 階段三：自有登入（取代 Firebase Auth）。帳號由 ETL 從 Firebase 匯入（方案 A：保留舊密碼雜湊）
public class AppUser
{
    [Key, MaxLength(64)] public string Id { get; set; } = "";              // = Firebase localId（員工 = 工號；admin 是亂數）
    [MaxLength(64)] public string LoginId { get; set; } = "";              // 登入用：工號小寫或 "admin"（唯一）
    [MaxLength(32)] public string? StaffId { get; set; }                   // 對應 Staff；超級管理員為 null
    [MaxLength(256)] public string? Email { get; set; }
    // 密碼雜湊：ASP.NET Core Identity 格式；或 "firebase-scrypt$<salt>$<hash>"（舊帳號，第一次登入成功後自動換成新格式）
    [MaxLength(512)] public string PasswordHash { get; set; } = "";
    public bool Disabled { get; set; }
    public bool IsSuperAdmin { get; set; }
    public int FailedLogins { get; set; }
    public DateTimeOffset? LockoutUntil { get; set; }
    [MaxLength(64)] public string SecurityStamp { get; set; } = Guid.NewGuid().ToString("N");   // 改密碼 / 撤銷時更換
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? LastLoginAt { get; set; }
}

public class RefreshToken
{
    [Key, MaxLength(64)] public string TokenHash { get; set; } = "";       // sha256(明文)，資料庫不存明文
    [MaxLength(64)] public string UserId { get; set; } = "";
    [MaxLength(64)] public string FamilyId { get; set; } = "";             // 同一次登入輪替出來的一串；偵測到重放就整串撤銷
    public bool Persistent { get; set; }                                    // 「記住我」
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset ExpiresAt { get; set; }
    public DateTimeOffset? RevokedAt { get; set; }
    [MaxLength(64)] public string? ReplacedBy { get; set; }
}

public class OneTimeToken
{
    [Key, MaxLength(64)] public string TokenHash { get; set; } = "";       // sha256（啟用 / 重設連結、OTP 都不存明文）
    [MaxLength(64)] public string UserId { get; set; } = "";
    [MaxLength(16)] public string Purpose { get; set; } = "";              // activation | reset | otp
    public DateTimeOffset ExpiresAt { get; set; }
    public int Attempts { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

public class LegacyHashConfig   // 單列：Firebase 改良版 scrypt 參數（ETL 由 Identity Platform config 取得）
{
    public int Id { get; set; } = 1;
    [MaxLength(256)] public string SignerKey { get; set; } = "";
    [MaxLength(64)] public string SaltSeparator { get; set; } = "";
    public int Rounds { get; set; }
    public int MemoryCost { get; set; }
}
