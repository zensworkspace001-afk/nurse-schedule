using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Aegis.Data;
using Aegis.Engine;
using Aegis.Security;

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
    private static readonly string[] Pii = ["idNumber", "bankAccount", "phone"];

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
            var st = new Staff
            {
                StaffId = id, Name = Str(r, "name") ?? id, Email = Str(r, "email") ?? "", Gender = Str(r, "gender"),
                Level = Str(r, "level") ?? "N0", IsLeader = Bool(r, "is_leader") ?? false, IsActive = Bool(r, "is_active") ?? true,
                SpecialStatus = Str(r, "special_status") == "BiWeekly" ? SpecialStatus.BiWeekly : SpecialStatus.Standard,
                LeaveStatus = Str(r, "leave_status") ?? "None", IsPregnantOrNursing = Bool(r, "is_pregnant_or_nursing") ?? false,
                CanNightShift = Bool(r, "can_night_shift") ?? true, TenureYears = (int)(Num(r, "tenure_years") ?? 0),
                AccumulatedOt = (int)(Num(r, "accumulated_ot") ?? 0), NightShiftBalance = (int)(Num(r, "night_shift_balance") ?? 0),
                AnnualLeaveUsed = Num(r, "annual_leave_used") is double a ? (int)a : null,
                ProfileCompleted = Bool(r, "profile_completed"), ProfileCompletedAt = Time(r, "profile_completed_at"),
                ProfileUpdatedAt = Time(r, "profile_updated_at"), PdpaConsentedAt = Time(r, "pdpa_consented_at"),
                PdpaNoticeVersion = Str(r, "pdpa_notice_version"), MustChangePassword = Bool(r, "must_change_password") ?? false,
                IsAdmin = (Bool(r, "is_admin") ?? false) || authAdmins.Contains(id.ToUpperInvariant()),
            };
            var sens = new StaffSensitive { StaffId = id };
            sens.IdNumber = Encrypted(r, "idNumber", id, plan, o);
            sens.BankAccount = Encrypted(r, "bankAccount", id, plan, o);
            sens.Phone = Encrypted(r, "phone", id, plan, o);
            if (sens.IdNumber != null || sens.BankAccount != null || sens.Phone != null) st.Sensitive = sens;
            string? avatar = Str(r, "avatar"), thumb = Str(r, "avatar_thumb");
            if (avatar != null || thumb != null) st.Avatar = new StaffAvatar { StaffId = id, Avatar = avatar, AvatarThumb = thumb };
            if (r["settlement_history"] is JsonObject hist)
                foreach (var (period, v) in hist)
                    if (v is JsonObject h)
                        st.Settlements.Add(new SettlementRecord { StaffId = id, Period = period, Annual = (int)(Num(h, "annual") ?? 0),
                                                                  Ot = (int)(Num(h, "ot") ?? 0), Night = (int)(Num(h, "night") ?? 0) });
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
                BaseSalary = Encrypted(set, "baseSalary", "Settings", plan, o),
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
                var reqs = lw["reqs"] as JsonObject;
                plan.Windows.Add(new LeaveWishWindow
                {
                    Year = (int)Num(lw, "year")!, Month = (int)Num(lw, "month")!, Open = Bool(lw, "open") ?? false,
                    ReqD = (int)(Num(reqs, "D") ?? 0), ReqE = (int)(Num(reqs, "E") ?? 0), ReqN = (int)(Num(reqs, "N") ?? 0),
                    Quota = (int)(Num(lw, "quota") ?? 0), DaysPerPerson = (int)(Num(lw, "days_per_person") ?? 4),
                    OpenedAt = Time(lw, "openedAt"), ClosedAt = Time(lw, "closedAt"),
                });
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
            AddCells(plan, y, m, ScheduleKind.Draft, doc.Fields["schedule"] as JsonObject);
            AddCells(plan, y, m, ScheduleKind.Final, doc.Fields["finalizedSchedule"] as JsonObject);
        }
        plan.SourceCounts["Schedules"] = s.Docs("Schedules").Count;
        if (s.Docs("SchedulesPublic").Count > 0) plan.Skipped.Add($"SchedulesPublic（{s.Docs("SchedulesPublic").Count} 份，改由檢視表 vSchedulePublic 產生）");
        if (s.Docs("StaffPublic").Count > 0 || s.Doc("NurseApp", "StaffPublic") != null) plan.Skipped.Add("NurseApp/StaffPublic（改由檢視表 vStaffPublic 產生）");
        foreach (var doc in s.Docs("archive_reports"))
        {
            var (y, m) = YearMonth(doc.Id);
            plan.Archives.Add(new ArchiveReport { Year = y, Month = m, Note = Str(doc.Fields, "note"), Csv = Str(doc.Fields, "csv"),
                                                  BackedUpAt = Time(doc.Fields, "backedUpAt") ?? Time(doc.Fields, "timestamp") });
            AddCells(plan, y, m, ScheduleKind.Archive, doc.Fields["schedule_backup"] as JsonObject);
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
        return plan;
    }

    private static void AddCells(MigrationPlan plan, int y, int m, ScheduleKind kind, JsonObject? rows)
    {
        if (rows is null) return;
        foreach (var (rowKey, row) in rows)
            foreach (var (day, cell) in row as JsonObject ?? [])
            {
                if (!int.TryParse(day, out int d)) continue;
                string? type = cell is JsonObject c ? Str(c, "type") : cell?.GetValueKind() == JsonValueKind.String ? cell.GetValue<string>() : null;
                if (type is null) continue;
                plan.Cells.Add(new ScheduleCell { Year = y, Month = m, Kind = kind, RowKey = rowKey, Day = d, ShiftType = type,
                                                  ShiftTime = cell is JsonObject c2 ? Str(c2, "time") : null });
            }
    }

    // 加密欄位：{ct,iv,tag,v,kid} → 原樣搬（不解密）；明文字串 → 依決策 5 用目前金鑰加密並記錄；null → null
    private EncryptedValue? Encrypted(JsonObject? obj, string field, string owner, MigrationPlan plan, MigrationOptions o)
    {
        var node = obj?[field];
        if (node is null) return null;
        if (node is JsonObject b && b["ct"] is not null)
            return EncryptedValue.FromNode(Str(b, "ct")!, Str(b, "iv")!, Str(b, "tag")!, (int)(Num(b, "v") ?? 1), Str(b, "kid"));
        string plain = node.GetValueKind() == JsonValueKind.String ? node.GetValue<string>() : node.ToJsonString();
        if (!o.EncryptPlaintextPii || crypto is null)
            throw new InvalidOperationException($"{owner}.{field} 是明文，需要 FIELD_ENC_KEY 才能加密後匯入（不會以明文寫進 SQL）");
        plan.PlaintextPiiEncrypted.Add($"{owner}.{field}");
        return node.GetValueKind() == JsonValueKind.Number
            ? crypto.Encrypt(new FieldPlain.Num(AsDouble(node)!.Value))
            : crypto.Encrypt(FieldPlain.Of(plain));
    }

    private static (int, int) YearMonth(string id)
    {
        var p = id.Split('_');
        return (int.Parse(p[0], CultureInfo.InvariantCulture), int.Parse(p[1], CultureInfo.InvariantCulture));
    }

    private static string? Str(JsonObject? o, string k) => o?[k] is JsonValue v && v.GetValueKind() == JsonValueKind.String ? v.GetValue<string>() : null;
    private static bool? Bool(JsonObject? o, string k) => o?[k] is JsonValue v && v.GetValueKind() is JsonValueKind.True or JsonValueKind.False ? v.GetValue<bool>() : null;
    private static double? Num(JsonObject? o, string k) => AsDouble(o?[k]);

    // 數字可能是 CLR long（剛從 Firestore 轉來）或 JsonElement（從快照檔讀回）— 兩種都要能讀
    private static double? AsDouble(JsonNode? n)
    {
        if (n is not JsonValue v || v.GetValueKind() != JsonValueKind.Number) return null;
        if (v.TryGetValue<double>(out var d)) return d;
        if (v.TryGetValue<long>(out var l)) return l;
        if (v.TryGetValue<int>(out var i)) return i;
        return v.TryGetValue<JsonElement>(out var e) ? e.GetDouble() : null;
    }
    private static string? Truncate(string? s, int n) => s is null || s.Length <= n ? s : s[..n];

    // ISO 字串或 {"$ts": ...}；Firestore 裡兩種都有（前端寫字串、Admin SDK 寫 timestamp）
    private static DateTimeOffset? Time(JsonObject? o, string k)
    {
        var n = o?[k];
        string? s = n is JsonObject t ? Str(t, "$ts") : n is JsonValue v && v.GetValueKind() == JsonValueKind.String ? v.GetValue<string>() : null;
        return s != null && DateTimeOffset.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var d) ? d : null;
    }
}
