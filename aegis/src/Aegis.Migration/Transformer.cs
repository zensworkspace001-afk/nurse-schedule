using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Aegis.Data;
using Aegis.Engine;
using Aegis.Security;
using static Aegis.Data.DocumentMapper;

namespace Aegis.Migration;

public sealed class MigrationPlan
{
    public List<Staff> Staff { get; } = [];
    public WardSettings? Ward { get; set; }
    public List<ShiftOption> ShiftOptions { get; } = [];
    public List<LevelBonus> LevelBonuses { get; } = [];
    public Announcement? Announcement { get; set; }
    public List<LeaveWishWindow> Windows { get; } = [];
    public List<LeaveWishEntry> WishEntries { get; } = [];
    public List<ScheduleCell> Cells { get; } = [];
    public List<ScheduleMonth> Months { get; } = [];
    public List<ArchiveReport> Archives { get; } = [];
    public List<MonthlyHealthStat> HealthStats { get; } = [];
    public List<AccessLog> AccessLogs { get; } = [];
    public List<PasswordHistoryEntry> PasswordHistory { get; } = [];
    public List<ExStaff> ExStaff { get; } = [];
    public List<AppUser> Users { get; } = [];
    public LegacyHashConfig? HashConfig { get; set; }
    public Dictionary<string, int> SourceCounts { get; } = new();         // 來源文件 / 列數（報告對帳用）
    public List<string> PlaintextPiiEncrypted { get; } = [];              // 決策 5：明文個資已加密
    public List<string> Skipped { get; } = [];                            // 刻意不遷移的資料
    public List<string> Warnings { get; } = [];                           // 來源資料不一致等
}

public sealed record MigrationOptions(bool EncryptPlaintextPii = true);

public interface ISnapshotTransformer
{
    MigrationPlan Transform(FirestoreSnapshot s, MigrationOptions o);
}

// 純函式：快照 → 實體（不碰資料庫）。欄位對照見 aegis/README.md 階段二
public sealed class SnapshotTransformer(IFieldCrypto? crypto) : ISnapshotTransformer
{
    public MigrationPlan Transform(FirestoreSnapshot s, MigrationOptions o)
    {
        var plan = new MigrationPlan();
        foreach (var (name, n) in s.SkippedCollections) plan.Skipped.Add($"{name}（{n} 份文件，舊流程 / 暫存資料，不遷移）");
        var authAdmins = (s.AuthUsers ?? []).Where(u => u.CustomAttributes?.Contains("\"admin\":true") == true)
                                            .Select(u => u.LocalId.ToUpperInvariant()).ToHashSet();

        // —— 員工：NurseApp/Staff.staffData 是主檔；StaffPrivate/{id} 是副本，只拿來檢查有沒有漂移 ——
        var staffDoc = s.Doc("NurseApp", "Staff")?.Fields;
        var rows = staffDoc?["staffData"]?.AsArray().OfType<JsonObject>().ToList() ?? [];
        plan.SourceCounts["staff"] = rows.Count;
        foreach (var r in rows)
        {
            string id = Str(r, "staff_id") ?? throw new InvalidDataException("staffData 有一列沒有 staff_id");
            var st = StaffFromRow(r, (field, plain) => EncryptPlaintext($"{id}.{field}", plain, plan, o));
            st.IsAdmin = st.IsAdmin || authAdmins.Contains(id.ToUpperInvariant());
            plan.Staff.Add(st);
        }
        // 三份員工資料的漂移檢查（合併成一張表之後就不會再發生）
        var byId = rows.ToDictionary(r => Str(r, "staff_id")!, r => r);
        var privates = s.Docs("StaffPrivate");
        plan.SourceCounts["StaffPrivate"] = privates.Count;
        foreach (var p in privates)
        {
            if (!byId.TryGetValue(p.Id, out var main)) { plan.Warnings.Add($"StaffPrivate/{p.Id} 在主檔沒有對應的員工（孤兒文件，不遷移）"); continue; }
            var diff = p.Fields.Select(kv => kv.Key).Concat(main.Select(kv => kv.Key)).Distinct()
                .Where(k => !JsonNode.DeepEquals(p.Fields[k], main[k])).OrderBy(k => k).ToList();
            if (diff.Count > 0) plan.Warnings.Add($"StaffPrivate/{p.Id} 與主檔不一致的欄位：{string.Join("、", diff)}（以主檔為準）");
        }
        foreach (var id in byId.Keys.Where(id => privates.All(p => p.Id != id)))
            plan.Warnings.Add($"{id} 沒有 StaffPrivate 文件（以主檔為準）");
        if (staffDoc?["healthStats"] is JsonArray hs)
            foreach (var h in hs.OfType<JsonObject>())
                plan.HealthStats.Add(new MonthlyHealthStat { Year = (int)Num(h, "year")!, Month = (int)Num(h, "month")!,
                                                             Avg = (int)(Num(h, "avg") ?? 0), Median = (int)(Num(h, "median") ?? 0) });
        plan.SourceCounts["healthStats"] = plan.HealthStats.Count;

        // —— 全域設定 ——
        if (s.Doc("NurseApp", "Settings")?.Fields is JsonObject set)
        {
            var bed = set["bedConfig"] as JsonObject; var req = set["requirements"] as JsonObject; var pub = set["publishedDate"] as JsonObject;
            plan.Ward = new WardSettings
            {
                BedCount = (int)(Num(bed, "bedCount") ?? 0), HospitalLevel = Str(bed, "hospitalLevel") ?? "",
                RatioD = (int)(Num(bed, "ratioD") ?? 0), RatioE = (int)(Num(bed, "ratioE") ?? 0), RatioN = (int)(Num(bed, "ratioN") ?? 0),
                ReqD = (int)(Num(req, "D") ?? 0), ReqE = (int)(Num(req, "E") ?? 0), ReqN = (int)(Num(req, "N") ?? 0),
                OptimalD = (int?)Num(req, "optimalD"), OptimalE = (int?)Num(req, "optimalE"), OptimalN = (int?)Num(req, "optimalN"),
                BaseSalary = JsonToEncrypted(set["baseSalary"], plain => EncryptPlaintext("Settings.baseSalary", plain, plan, o)),
                PublishedYear = (int?)Num(pub, "year"), PublishedMonth = (int?)Num(pub, "month"),
            };
            int order = 0;
            foreach (var so in (set["shiftOptions"] as JsonArray ?? []).OfType<JsonObject>())
                plan.ShiftOptions.Add(new ShiftOption { Code = Str(so, "code") ?? "", Name = Str(so, "name") ?? "", Time = Str(so, "time") ?? "",
                                                        Color = Str(so, "color") ?? "", SortOrder = order++ });
            foreach (var (lv, amt) in set["levelBonus"] as JsonObject ?? [])
                plan.LevelBonuses.Add(new LevelBonus { Level = lv, Amount = (int)(AsDouble(amt) ?? 0) });
            if (set["leaveWish"] is JsonObject lw)
            {
                var w = new LeaveWishWindow { Year = (int)Num(lw, "year")!, Month = (int)Num(lw, "month")! };
                WindowFromJson(w, lw);
                plan.Windows.Add(w);
            }
            if (set.ContainsKey("priorityConfig")) plan.Skipped.Add("Settings.priorityConfig（舊認領流程的接力設定，不遷移）");
        }
        if (s.Doc("NurseApp", "Announcement")?.Fields is JsonObject an)
            plan.Announcement = new Announcement { Active = Bool(an, "active") ?? false, Kind = Str(an, "kind") ?? "", Text = Str(an, "text") ?? "",
                UpdatedAt = Time(an, "updatedAt"), UpdatedByUid = Str(an["updatedBy"] as JsonObject, "uid"),
                UpdatedByName = Str(an["updatedBy"] as JsonObject, "name") };

        // —— 預假：LeaveWishes/{Y_M}（表頭）+ entries ——
        foreach (var head in s.Docs("LeaveWishes"))
        {
            var (y, m) = YearMonth(head.Id);
            var w = plan.Windows.FirstOrDefault(x => x.Year == y && x.Month == m);
            if (w is null) { w = new LeaveWishWindow { Year = y, Month = m, Open = false }; plan.Windows.Add(w); }
            w.Version = (int)(Num(head.Fields, "version") ?? 0);
            if (Num(head.Fields, "quota") is double q) w.Quota = (int)q;
            var entries = s.Docs($"LeaveWishes/{head.Id}/entries");
            plan.SourceCounts[$"LeaveWishes/{head.Id}/entries"] = entries.Count;
            foreach (var e in entries)
            {
                var sub = Time(e.Fields, "submittedAt") ?? DateTimeOffset.MinValue;
                var entry = new LeaveWishEntry { Year = y, Month = m, StaffId = Str(e.Fields, "staff_id") ?? e.Id,
                                                 SubmittedAt = sub, FirstSubmittedAt = Time(e.Fields, "firstSubmittedAt") ?? sub };
                foreach (var d in (e.Fields["days"] as JsonArray ?? []).Select(x => (int)(AsDouble(x) ?? 0)).Distinct().OrderBy(x => x))
                    entry.Days.Add(new LeaveWishDay { Year = y, Month = m, StaffId = entry.StaffId, Day = d });
                plan.WishEntries.Add(entry);
            }
        }
        plan.SourceCounts["LeaveWishes"] = s.Docs("LeaveWishes").Count;

        // —— 班表：Schedules/{Y_M}.schedule（草稿）/ finalizedSchedule（正式）；SchedulesPublic 改由檢視表產生 ——
        foreach (var doc in s.Docs("Schedules"))
        {
            var (y, m) = YearMonth(doc.Id);
            plan.Months.Add(new ScheduleMonth { Year = y, Month = m });
            plan.Cells.AddRange(CellsFromDoc(y, m, ScheduleKind.Draft, doc.Fields["schedule"] as JsonObject));
            plan.Cells.AddRange(CellsFromDoc(y, m, ScheduleKind.Final, doc.Fields["finalizedSchedule"] as JsonObject));
        }
        plan.SourceCounts["Schedules"] = s.Docs("Schedules").Count;
        if (s.Docs("SchedulesPublic").Count > 0) plan.Skipped.Add($"SchedulesPublic（{s.Docs("SchedulesPublic").Count} 份，改由檢視表 vSchedulePublic 產生）");
        if (s.Docs("StaffPublic").Count > 0 || s.Doc("NurseApp", "StaffPublic") != null) plan.Skipped.Add("NurseApp/StaffPublic（改由檢視表 vStaffPublic 產生）");
        foreach (var doc in s.Docs("archive_reports"))
        {
            var (y, m) = YearMonth(doc.Id);
            plan.Archives.Add(new ArchiveReport { Year = y, Month = m, Note = Str(doc.Fields, "note"), Csv = Str(doc.Fields, "csv"),
                                                  BackedUpAt = Time(doc.Fields, "backedUpAt"), CsvSavedAt = Time(doc.Fields, "timestamp") });
            plan.Cells.AddRange(CellsFromDoc(y, m, ScheduleKind.Archive, doc.Fields["schedule_backup"] as JsonObject));
        }
        plan.SourceCounts["archive_reports"] = s.Docs("archive_reports").Count;

        // —— 稽核、密碼歷史、離職歸檔 ——
        foreach (var doc in s.Docs("access_logs"))
        {
            var f = doc.Fields; var actor = f["actor"] as JsonObject; var target = f["target"] as JsonObject;
            plan.AccessLogs.Add(new AccessLog
            {
                Ts = Time(f, "ts") ?? DateTimeOffset.MinValue, ActorUid = Str(actor, "uid"), ActorEmail = Str(actor, "email"),
                Action = Str(f, "action") ?? "", TargetKind = Str(target, "kind"), TargetId = target?["id"]?.ToString(),
                FieldsJson = f["fields"]?.ToJsonString(), Ip = Str(f, "ip"), Ua = Truncate(Str(f, "ua"), 512),
                ExtraJson = f["extra"]?.ToJsonString(),
            });
        }
        plan.SourceCounts["access_logs"] = s.Docs("access_logs").Count;
        foreach (var doc in s.Docs("password_history"))
        {
            int seq = 0;
            foreach (var e in (doc.Fields["entries"] as JsonArray ?? []).OfType<JsonObject>())
                plan.PasswordHistory.Add(new PasswordHistoryEntry { StaffId = doc.Id, Seq = seq++, Salt = Str(e, "salt") ?? "",
                                                                    Hash = Str(e, "hash") ?? "", At = Time(e, "at") ?? DateTimeOffset.MinValue });
        }
        plan.SourceCounts["password_history"] = s.Docs("password_history").Count;
        foreach (var doc in s.Docs("ex_staff"))
        {
            var f = doc.Fields; var by = f["deleted_by"] as JsonObject;
            plan.ExStaff.Add(new ExStaff { StaffId = doc.Id, Name = Str(f, "name") ?? doc.Id, Email = Str(f, "email"), Level = Str(f, "level"),
                TenureYears = (int?)Num(f, "tenure_years"), Avatar = Str(f, "avatar"), AvatarThumb = Str(f, "avatar_thumb"),
                HadAvatar = Bool(f, "had_avatar") ?? false, DeletedAt = Time(f, "deleted_at"), DeletedByUid = Str(by, "uid"), DeletedByEmail = Str(by, "email") });
        }
        plan.SourceCounts["ex_staff"] = s.Docs("ex_staff").Count;

        // —— 登入帳號（方案 A：保留 Firebase 密碼雜湊，第一次登入成功後換成新格式）——
        if (s.AuthUsers is { } users)
        {
            plan.SourceCounts["auth_users"] = users.Count;
            var staffIds = plan.Staff.Select(x => x.StaffId).ToDictionary(x => x.ToUpperInvariant(), x => x);
            foreach (var u in users)
            {
                string login = (u.Email ?? u.LocalId).Split('@')[0].ToLowerInvariant();
                bool super = string.Equals(u.Email, "admin@hospital.com", StringComparison.OrdinalIgnoreCase);
                string? staffId = staffIds.GetValueOrDefault(u.LocalId.ToUpperInvariant()) ?? staffIds.GetValueOrDefault(login.ToUpperInvariant());
                if (staffId is null && !super) plan.Warnings.Add($"登入帳號 {login} 沒有對應的員工資料（仍匯入、可登入，但看不到員工畫面）");
                if (u.PasswordHash is null || u.Salt is null) plan.Warnings.Add($"登入帳號 {login} 沒有密碼雜湊（需由管理員重設）");
                plan.Users.Add(new AppUser
                {
                    Id = u.LocalId, LoginId = login, StaffId = staffId, Email = u.Email, Disabled = u.Disabled, IsSuperAdmin = super,
                    PasswordHash = u.PasswordHash is null || u.Salt is null ? "" : $"firebase-scrypt${u.Salt}${u.PasswordHash}",
                    CreatedAt = u.CreatedAt ?? s.ExportedAt,
                });
            }
            if (s.AuthHashConfig is { } hc)
                plan.HashConfig = new LegacyHashConfig { SignerKey = hc.SignerKey, SaltSeparator = hc.SaltSeparator, Rounds = hc.Rounds, MemoryCost = hc.MemoryCost };
            else if (users.Count > 0) plan.Warnings.Add("沒有取得 Firebase 雜湊參數：舊密碼無法驗證，所有人都需要重設");
        }
        else plan.Warnings.Add("快照沒有登入帳號（匯出時沒加 --include-auth）：匯入後需由管理員為每個人建立帳號");
        return plan;
    }

    // 明文個資 / 底薪：依決策 5 用目前金鑰加密並記錄；沒有金鑰就拒絕（不以明文寫進 SQL）
    private EncryptedValue EncryptPlaintext(string label, FieldPlain plain, MigrationPlan plan, MigrationOptions o)
    {
        if (!o.EncryptPlaintextPii || crypto is null)
            throw new InvalidOperationException($"{label} 是明文，需要 FIELD_ENC_KEY 才能加密後匯入（不會以明文寫進 SQL）");
        plan.PlaintextPiiEncrypted.Add(label);
        return crypto.Encrypt(plain);
    }

    private static string? Truncate(string? s, int n) => s is null || s.Length <= n ? s : s[..n];
}
