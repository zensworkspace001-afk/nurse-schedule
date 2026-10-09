using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Aegis.Api.Auth;
using Aegis.Data;
using Aegis.Security;
using Microsoft.EntityFrameworkCore;
using static Aegis.Data.DocumentMapper;

namespace Aegis.Api.Services;

// = api/complete-profile.js 的 first / update / consent（驗證規則與錯誤訊息逐字相同）
public sealed class ProfileService(AegisDbContext db, IFieldCrypto crypto, IAuditLogger audit, IConfiguration cfg, TimeProvider clock)
{
    // = complete-profile.js TAIWAN_BANK_CODES（與 src/constants/banks.js 同步）
    private static readonly HashSet<string> BankCodes = ["700", "004", "005", "006", "007", "008", "009", "011", "012", "013",
        "016", "017", "050", "052", "053", "081", "102", "103", "108", "147", "803", "805", "806", "807", "808", "809", "810", "812", "816", "822"];
    private const int AvatarMax = 200 * 1024, ThumbMax = 30 * 1024;
    private static readonly Regex AvatarMime = new(@"^data:image\/(webp|jpeg|png);base64,", RegexOptions.IgnoreCase);
    private string NoticeVersion => cfg["Aegis:PdpaNoticeVersion"] ?? "v1";   // = shared/policy.js PDPA_NOTICE_VERSION

    private async Task<Staff> LoadAsync(string staffId, CancellationToken ct) =>
        await db.Staff.Include(s => s.Sensitive).Include(s => s.Avatar).FirstOrDefaultAsync(s => s.StaffId == staffId, ct)
        ?? throw new DocumentValidationException("找不到您的員工資料，請聯絡管理員");

    // 首登：基本資料 + 加密個資 + 個資告知同意 → profile_completed = true
    public async Task<string?> CompleteFirstAsync(CurrentUser me, JsonObject body, HttpContext http, CancellationToken ct)
    {
        var errors = new List<string>();
        string name = (Str(body, "name") ?? "").Trim();
        if (name.Length == 0) errors.Add("姓名不可為空");
        if (name.Length > 50) errors.Add("姓名長度過長");
        string gender = Str(body, "gender") ?? "";
        if (gender is not ("男" or "女")) errors.Add("性別格式錯誤");
        double tenure = Num(body, "tenure_years") ?? double.NaN;
        if (!double.IsFinite(tenure) || tenure < 0 || tenure > 60) errors.Add("年資需為 0–60 之間的整數");
        string idNumber = (Str(body, "idNumber") ?? "").Trim();
        if (idNumber.Length == 0) errors.Add("身分證 / 居留證號不可為空");
        if (idNumber.Length < 4 || idNumber.Length > 20) errors.Add("身分證號長度異常");
        string bank = (Str(body, "bankAccount") ?? "").Trim();
        if (bank.Length == 0) errors.Add("銀行帳號不可為空");
        var bm = Regex.Match(bank, @"^(\d{3})-(\d{6,16})$");
        if (!bm.Success) errors.Add("銀行帳號格式錯誤（需為「銀行三碼-帳號」如 008-1234567890）");
        else if (!BankCodes.Contains(bm.Groups[1].Value)) errors.Add($"銀行代碼 {bm.Groups[1].Value} 不在合法清單內");
        string phone = (Str(body, "phone") ?? "").Trim();
        if (phone.Length == 0) errors.Add("手機號碼不可為空");
        if (!Regex.IsMatch(phone, @"^09\d{8}$")) errors.Add("手機需為 09 開頭共 10 碼");
        if (Str(body, "pdpa_notice_version") != NoticeVersion) errors.Add("個人資料蒐集告知已更新，請重新整理頁面後重新閱讀並同意");
        if (errors.Count > 0) return string.Join("；", errors);

        var s = await LoadAsync(me.StaffId!, ct);
        var now = clock.GetUtcNow();
        s.Name = name; s.Gender = gender; s.TenureYears = (int)Math.Floor(tenure);
        s.IsPregnantOrNursing = Bool(body, "is_pregnant_or_nursing") ?? false;
        s.CanNightShift = Bool(body, "can_night_shift") != false;
        s.Sensitive ??= new StaffSensitive { StaffId = s.StaffId };
        s.Sensitive.IdNumber = crypto.Encrypt(FieldPlain.Of(idNumber));
        s.Sensitive.BankAccount = crypto.Encrypt(FieldPlain.Of(bank));
        s.Sensitive.Phone = crypto.Encrypt(FieldPlain.Of(phone));
        s.ProfileCompleted = true; s.ProfileCompletedAt = now;
        s.PdpaConsentedAt = now; s.PdpaNoticeVersion = NoticeVersion;   // 同意時間用伺服器時間
        await db.SaveChangesAsync(ct);
        await audit.WriteAsync(new AuditEntry("encrypt", me.UserId, null, "staff", me.StaffId, ["idNumber", "bankAccount", "phone", "pdpa_consent"],
                                              new { source = "complete-profile", mode = "first" }), http, ct);
        return null;
    }

    // 已登入後自助更新（基本資料、頭貼；不碰加密個資與 profile_completed）
    public async Task<(string? Error, List<string> Changed)> UpdateAsync(CurrentUser me, JsonObject body, HttpContext http, CancellationToken ct)
    {
        var errors = new List<string>();
        var s = await LoadAsync(me.StaffId!, ct);
        var changed = new List<string>();
        if (body.ContainsKey("name"))
        {
            string name = (body["name"]?.ToString() ?? "").Trim();
            if (name.Length == 0) errors.Add("姓名不可為空"); else if (name.Length > 50) errors.Add("姓名長度過長");
            else if (name != s.Name) { s.Name = name; changed.Add("name"); }
        }
        if (body.ContainsKey("gender"))
        {
            string g = body["gender"]?.ToString() ?? "";
            if (g is not ("男" or "女")) errors.Add("性別格式錯誤"); else if (g != s.Gender) { s.Gender = g; changed.Add("gender"); }
        }
        if (body.ContainsKey("tenure_years"))
        {
            double t = AsDouble(body["tenure_years"]) ?? (double.TryParse(body["tenure_years"]?.ToString(), out var p) ? p : double.NaN);
            if (!double.IsFinite(t) || t < 0 || t > 60) errors.Add("年資需為 0–60 之間的整數");
            else if ((int)Math.Floor(t) != s.TenureYears) { s.TenureYears = (int)Math.Floor(t); changed.Add("tenure_years"); }
        }
        if (body.ContainsKey("is_pregnant_or_nursing"))
        {
            bool v = Bool(body, "is_pregnant_or_nursing") ?? false;
            if (v != s.IsPregnantOrNursing) { s.IsPregnantOrNursing = v; changed.Add("is_pregnant_or_nursing"); }
        }
        if (body.ContainsKey("can_night_shift"))
        {
            bool v = Bool(body, "can_night_shift") != false;
            if (v != s.CanNightShift) { s.CanNightShift = v; changed.Add("can_night_shift"); }
        }
        foreach (var (key, max, label) in new[] { ("avatar", AvatarMax, "頭貼"), ("avatar_thumb", ThumbMax, "頭貼縮圖") })
        {
            if (!body.ContainsKey(key)) continue;
            string? v = body[key] is null ? "" : Str(body, key);
            if (v is null) { errors.Add(label + "格式錯誤"); continue; }
            if (v.Length > 0 && !AvatarMime.IsMatch(v)) { errors.Add(label + "格式錯誤（僅接受 PNG / JPEG / WebP data URL）"); continue; }
            if (v.Length > max) { errors.Add($"{label}檔案過大（限 {max / 1024} KB 以內）"); continue; }
            s.Avatar ??= new StaffAvatar { StaffId = s.StaffId };
            string? val = v.Length == 0 ? null : v;
            if (key == "avatar" && val != s.Avatar.Avatar) { s.Avatar.Avatar = val; changed.Add(key); }
            if (key == "avatar_thumb" && val != s.Avatar.AvatarThumb) { s.Avatar.AvatarThumb = val; changed.Add(key); }
        }
        if (errors.Count > 0) return (string.Join("；", errors), []);
        if (changed.Count == 0) return (null, changed);
        s.ProfileUpdatedAt = clock.GetUtcNow();
        await db.SaveChangesAsync(ct);
        await audit.WriteAsync(new AuditEntry("update-profile", me.UserId, null, "staff", me.StaffId, changed, new { source = "complete-profile", mode = "update" }), http, ct);
        return (null, changed);
    }

    // 告知升版後重新同意
    public async Task<string?> ConsentAsync(CurrentUser me, string? version, HttpContext http, CancellationToken ct)
    {
        if (version != NoticeVersion) return "個人資料蒐集告知已更新，請重新整理頁面後重新閱讀並同意";
        var s = await LoadAsync(me.StaffId!, ct);
        s.PdpaNoticeVersion = NoticeVersion;
        s.PdpaConsentedAt = clock.GetUtcNow();
        await db.SaveChangesAsync(ct);
        await audit.WriteAsync(new AuditEntry("pdpa-consent", me.UserId, null, "staff", me.StaffId, ["pdpa_notice_version", "pdpa_consented_at"],
                                              new { version = NoticeVersion }), http, ct);
        return null;
    }
}
