using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Aegis.Data;
using Aegis.Security;
using Microsoft.EntityFrameworkCore;
using static Aegis.Data.DocumentMapper;

namespace Aegis.Api.Services;

public sealed class ConcurrencyConflictException(string message) : Exception(message);
public sealed class DocumentValidationException(string message) : Exception(message);

// 「Firestore 文件形狀」的讀寫（API 回應 = 現行 Firestore 文件，前端階段四只換資料來源）。
// ETag = 內容雜湊：PUT 帶 If-Match，內容已被別人改過就 409，取代 Firestore 的「後寫的直接蓋掉」。
public sealed class DocumentService(AegisDbContext db, IFieldCrypto crypto, TimeProvider clock)
{
    public static string ETagOf(JsonNode? doc) =>
        "\"" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(doc?.ToJsonString() ?? "null")))[..16].ToLowerInvariant() + "\"";

    private static void CheckETag(JsonNode? current, string? ifMatch)
    {
        if (ifMatch is null || ifMatch == "*") return;
        // 反向代理壓縮回應時會把 ETag 改成弱驗證（Nginx gzip：W/"…"），瀏覽器就帶 W/"…" 回來。
        // 我們的 ETag 是內容雜湊，強弱比對結果相同 → 去掉 W/ 再比
        if (ifMatch.StartsWith("W/", StringComparison.Ordinal)) ifMatch = ifMatch[2..];
        if (ifMatch != ETagOf(current)) throw new ConcurrencyConflictException("資料已被其他人更新，請重新整理後再儲存（為避免覆蓋別人的修改）");
    }

    // ———————————— 全域設定（= NurseApp/Settings）————————————
    public async Task<LeaveWishWindow?> CurrentWindowAsync(CancellationToken ct)
    {
        var all = await db.LeaveWishWindows.ToListAsync(ct);
        return all.Where(w => w.Open).OrderByDescending(w => w.OpenedAt).FirstOrDefault()
               ?? all.OrderByDescending(w => w.OpenedAt).ThenByDescending(w => w.Year * 12 + w.Month).FirstOrDefault();
    }

    public async Task<JsonObject> GetSettingsAsync(CancellationToken ct)
    {
        var ward = await db.WardSettings.AsNoTracking().FirstOrDefaultAsync(ct) ?? new WardSettings();
        var doc = new JsonObject
        {
            ["shiftOptions"] = new JsonArray((await db.ShiftOptions.AsNoTracking().OrderBy(s => s.SortOrder).ToListAsync(ct))
                .Select(s => (JsonNode)new JsonObject { ["code"] = s.Code, ["name"] = s.Name, ["time"] = s.Time, ["color"] = s.Color }).ToArray()),
            ["requirements"] = new JsonObject { ["D"] = ward.ReqD, ["E"] = ward.ReqE, ["N"] = ward.ReqN, ["optimalD"] = ward.OptimalD, ["optimalE"] = ward.OptimalE, ["optimalN"] = ward.OptimalN },
            ["bedConfig"] = new JsonObject { ["bedCount"] = ward.BedCount, ["ratioD"] = ward.RatioD, ["ratioE"] = ward.RatioE, ["ratioN"] = ward.RatioN, ["hospitalLevel"] = ward.HospitalLevel },
            ["levelBonus"] = new JsonObject((await db.LevelBonuses.AsNoTracking().OrderBy(l => l.Level).ToListAsync(ct))
                .Select(l => KeyValuePair.Create(l.Level, (JsonNode?)l.Amount))),
            ["baseSalary"] = EncryptedToJson(ward.BaseSalary),
        };
        if (ward.PublishedYear is int py && ward.PublishedMonth is int pm) doc["publishedDate"] = new JsonObject { ["year"] = py, ["month"] = pm };
        if (await CurrentWindowAsync(ct) is { } w) doc["leaveWish"] = WindowToJson(w);
        return doc;
    }

    // = setDoc(Settings, data, { merge: true })：只改有送來的欄位
    public async Task<JsonObject> MergeSettingsAsync(JsonObject patch, string? ifMatch, CancellationToken ct)
    {
        CheckETag(await GetSettingsAsync(ct), ifMatch);
        var ward = await db.WardSettings.FirstOrDefaultAsync(ct);
        if (ward is null) { ward = new WardSettings(); db.WardSettings.Add(ward); }
        if (patch["shiftOptions"] is JsonArray so)
        {
            db.ShiftOptions.RemoveRange(db.ShiftOptions);
            int i = 0;
            foreach (var o in so.OfType<JsonObject>())
                db.ShiftOptions.Add(new ShiftOption { Code = Str(o, "code") ?? "", Name = Str(o, "name") ?? "", Time = Str(o, "time") ?? "", Color = Str(o, "color") ?? "", SortOrder = i++ });
        }
        if (patch["requirements"] is JsonObject r)
        {
            ward.ReqD = (int)(Num(r, "D") ?? ward.ReqD); ward.ReqE = (int)(Num(r, "E") ?? ward.ReqE); ward.ReqN = (int)(Num(r, "N") ?? ward.ReqN);
            ward.OptimalD = (int?)Num(r, "optimalD") ?? ward.OptimalD; ward.OptimalE = (int?)Num(r, "optimalE") ?? ward.OptimalE; ward.OptimalN = (int?)Num(r, "optimalN") ?? ward.OptimalN;
        }
        if (patch["bedConfig"] is JsonObject b)
        {
            ward.BedCount = (int)(Num(b, "bedCount") ?? ward.BedCount); ward.HospitalLevel = Str(b, "hospitalLevel") ?? ward.HospitalLevel;
            ward.RatioD = (int)(Num(b, "ratioD") ?? ward.RatioD); ward.RatioE = (int)(Num(b, "ratioE") ?? ward.RatioE); ward.RatioN = (int)(Num(b, "ratioN") ?? ward.RatioN);
        }
        if (patch["levelBonus"] is JsonObject lb)
            foreach (var (level, amt) in lb)
            {
                var row = await db.LevelBonuses.FindAsync([level], ct);
                if (row is null) db.LevelBonuses.Add(new LevelBonus { Level = level, Amount = (int)(AsDouble(amt) ?? 0) });
                else row.Amount = (int)(AsDouble(amt) ?? 0);
            }
        if (patch.ContainsKey("baseSalary")) ward.BaseSalary = JsonToEncrypted(patch["baseSalary"], crypto.Encrypt);   // 明文底薪 → 伺服器端加密
        if (patch.ContainsKey("publishedDate"))
        {
            var pd = patch["publishedDate"] as JsonObject;
            ward.PublishedYear = (int?)Num(pd, "year"); ward.PublishedMonth = (int?)Num(pd, "month");
        }
        if (patch["leaveWish"] is JsonObject lw) await UpsertWindowAsync(lw, ct);
        await db.SaveChangesAsync(ct);
        return await GetSettingsAsync(ct);
    }

    private async Task UpsertWindowAsync(JsonObject lw, CancellationToken ct)
    {
        int y = (int)(Num(lw, "year") ?? throw new DocumentValidationException("leaveWish 缺少 year")), m = (int)(Num(lw, "month") ?? throw new DocumentValidationException("leaveWish 缺少 month"));
        var w = await db.LeaveWishWindows.FindAsync([y, m], ct);
        if (w is null) { w = new LeaveWishWindow { Year = y, Month = m }; db.LeaveWishWindows.Add(w); }
        WindowFromJson(w, lw);
        if (w.Open)   // 同時只會有一個開放中的預假（= 原本 Settings.leaveWish 只有一份）
            foreach (var other in await db.LeaveWishWindows.Where(x => x.Open && !(x.Year == y && x.Month == m)).ToListAsync(ct)) other.Open = false;
    }

    // ———————————— 公告（= NurseApp/Announcement）————————————
    public async Task<JsonObject?> GetAnnouncementAsync(CancellationToken ct)
    {
        var a = await db.Announcements.AsNoTracking().FirstOrDefaultAsync(ct);
        if (a is null) return null;
        var doc = new JsonObject { ["text"] = a.Text, ["kind"] = a.Kind, ["active"] = a.Active, ["updatedAt"] = Iso(a.UpdatedAt) };
        doc["updatedBy"] = a.UpdatedByUid is null && a.UpdatedByName is null ? null : new JsonObject { ["uid"] = a.UpdatedByUid, ["name"] = a.UpdatedByName };
        return doc;
    }

    public async Task<JsonObject?> SaveAnnouncementAsync(string text, string kind, string? byUid, string? byName, CancellationToken ct)
    {
        var a = await db.Announcements.FirstOrDefaultAsync(ct);
        if (a is null) { a = new Announcement(); db.Announcements.Add(a); }
        a.Text = text.Length > 500 ? text[..500] : text;   // 上限 500 字（與前端相同）
        a.Kind = kind is "info" or "warning" or "urgent" ? kind : "info";
        a.Active = true; a.UpdatedAt = clock.GetUtcNow(); a.UpdatedByUid = byUid; a.UpdatedByName = byName;
        await db.SaveChangesAsync(ct);
        return await GetAnnouncementAsync(ct);
    }

    public async Task<JsonObject?> ClearAnnouncementAsync(CancellationToken ct)
    {
        var a = await db.Announcements.FirstOrDefaultAsync(ct);
        if (a is null) return null;
        a.Active = false; a.UpdatedAt = clock.GetUtcNow();
        await db.SaveChangesAsync(ct);
        return await GetAnnouncementAsync(ct);
    }

    // ———————————— 員工（= NurseApp/Staff、StaffPublic、StaffPrivate/{id}）————————————
    private IQueryable<Staff> StaffFull => db.Staff.Include(s => s.Sensitive).Include(s => s.Avatar).Include(s => s.Settlements);

    public async Task<JsonObject> GetStaffDocAsync(CancellationToken ct) => new()
    {
        ["staffData"] = new JsonArray((await StaffFull.AsNoTracking().OrderBy(s => s.StaffId).ToListAsync(ct)).Select(s => (JsonNode)StaffToRow(s)).ToArray()),
        ["healthStats"] = new JsonArray((await db.HealthStats.AsNoTracking().OrderBy(h => h.Year).ThenBy(h => h.Month).ToListAsync(ct))
            .Select(h => (JsonNode)new JsonObject { ["year"] = h.Year, ["month"] = h.Month, ["avg"] = h.Avg, ["median"] = h.Median }).ToArray()),
    };

    public async Task<JsonObject> GetStaffPublicAsync(CancellationToken ct) => new()
    {
        ["staffData"] = new JsonArray((await db.StaffPublic.AsNoTracking().OrderBy(s => s.StaffId).ToListAsync(ct)).Select(s => (JsonNode)new JsonObject
        {
            ["staff_id"] = s.StaffId, ["name"] = s.Name, ["level"] = s.Level, ["is_leader"] = s.IsLeader, ["is_active"] = s.IsActive, ["avatar_thumb"] = s.AvatarThumb,
        }).ToArray()),
    };

    public async Task<JsonObject?> GetMyRowAsync(string staffId, CancellationToken ct) =>
        await StaffFull.AsNoTracking().FirstOrDefaultAsync(s => s.StaffId == staffId, ct) is { } s ? StaffToRow(s) : null;

    // = saveGlobalStaff（setDoc merge）：整份名單；不在名單裡的既有員工 → 拒絕（離職請走離職流程，避免一次漏傳就刪掉人）
    // 伺服器控管的欄位（管理員權限、強制改密、個資同意紀錄）以資料庫為準，前端送什麼都不覆寫
    public async Task<JsonObject> SaveStaffDocAsync(JsonObject body, string? ifMatch, CancellationToken ct)
    {
        CheckETag(await GetStaffDocAsync(ct), ifMatch);
        if (body["staffData"] is JsonArray rows)
        {
            var incoming = rows.OfType<JsonObject>().Select(r => StaffFromRow(r, (_, plain) => crypto.Encrypt(plain))).ToList();
            if (incoming.GroupBy(s => s.StaffId, StringComparer.OrdinalIgnoreCase).FirstOrDefault(g => g.Count() > 1) is { } dup)
                throw new DocumentValidationException($"員工編號重複：{dup.Key}");
            var existing = await StaffFull.ToListAsync(ct);
            var missing = existing.Where(e => incoming.All(i => !i.StaffId.Equals(e.StaffId, StringComparison.OrdinalIgnoreCase))).Select(e => e.StaffId).ToList();
            if (missing.Count > 0) throw new DocumentValidationException($"名單少了 {string.Join("、", missing)}：移除員工請使用「離職」功能");
            foreach (var inc in incoming)
            {
                var cur = existing.FirstOrDefault(e => e.StaffId.Equals(inc.StaffId, StringComparison.OrdinalIgnoreCase));
                if (cur is null)
                {
                    inc.IsAdmin = false; inc.MustChangePassword = false; inc.PdpaConsentedAt = null; inc.PdpaNoticeVersion = null;
                    inc.ProfileCompleted ??= false;   // 新增的員工 → 首登要走精靈（= StaffManagementPanel 新增列的行為）
                    db.Staff.Add(inc);
                    continue;
                }
                cur.Name = inc.Name; cur.Email = inc.Email; cur.Gender = inc.Gender; cur.Level = inc.Level; cur.IsLeader = inc.IsLeader;
                cur.IsActive = inc.IsActive; cur.SpecialStatus = inc.SpecialStatus; cur.LeaveStatus = inc.LeaveStatus;
                cur.IsPregnantOrNursing = inc.IsPregnantOrNursing; cur.CanNightShift = inc.CanNightShift; cur.TenureYears = inc.TenureYears;
                cur.AccumulatedOt = inc.AccumulatedOt; cur.NightShiftBalance = inc.NightShiftBalance; cur.AnnualLeaveUsed = inc.AnnualLeaveUsed;
                cur.ProfileCompleted = inc.ProfileCompleted ?? cur.ProfileCompleted;
                if (inc.Sensitive is { } sens)
                {
                    if (cur.Sensitive is null) cur.Sensitive = new StaffSensitive { StaffId = cur.StaffId };
                    cur.Sensitive.IdNumber = sens.IdNumber; cur.Sensitive.BankAccount = sens.BankAccount; cur.Sensitive.Phone = sens.Phone;
                }
                else if (cur.Sensitive is not null) { cur.Sensitive.IdNumber = null; cur.Sensitive.BankAccount = null; cur.Sensitive.Phone = null; }
                if (inc.Avatar is { } av)
                {
                    if (cur.Avatar is null) cur.Avatar = new StaffAvatar { StaffId = cur.StaffId };
                    cur.Avatar.Avatar = av.Avatar; cur.Avatar.AvatarThumb = av.AvatarThumb;
                }
                else if (cur.Avatar is not null) db.StaffAvatars.Remove(cur.Avatar);
                db.Settlements.RemoveRange(cur.Settlements);
                cur.Settlements = inc.Settlements;
            }
        }
        if (body["healthStats"] is JsonArray hs)
        {
            db.HealthStats.RemoveRange(db.HealthStats);
            foreach (var h in hs.OfType<JsonObject>())
                db.HealthStats.Add(new MonthlyHealthStat { Year = (int)(Num(h, "year") ?? 0), Month = (int)(Num(h, "month") ?? 0), Avg = (int)(Num(h, "avg") ?? 0), Median = (int)(Num(h, "median") ?? 0) });
        }
        await db.SaveChangesAsync(ct);
        return await GetStaffDocAsync(ct);
    }

    // ———————————— 班表（= Schedules/{Y_M}、SchedulesPublic/{Y_M}）————————————
    public async Task<JsonObject?> GetScheduleAsync(int y, int m, CancellationToken ct)
    {
        var cells = await db.ScheduleCells.AsNoTracking().Where(c => c.Year == y && c.Month == m && c.Kind != ScheduleKind.Archive).ToListAsync(ct);
        if (cells.Count == 0 && !await db.ScheduleMonths.AnyAsync(x => x.Year == y && x.Month == m, ct)) return null;
        return new JsonObject
        {
            ["schedule"] = DocFromCells(cells.Where(c => c.Kind == ScheduleKind.Draft)),
            ["finalizedSchedule"] = DocFromCells(cells.Where(c => c.Kind == ScheduleKind.Final)),
        };
    }

    public async Task<JsonObject?> GetSchedulePublicAsync(int y, int m, CancellationToken ct)
    {
        var cells = await db.SchedulePublic.AsNoTracking().Where(c => c.Year == y && c.Month == m).ToListAsync(ct);
        if (cells.Count == 0 && !await db.ScheduleMonths.AnyAsync(x => x.Year == y && x.Month == m, ct)) return null;
        return new JsonObject { ["finalizedSchedule"] = DocFromCells(cells.Select(c => new ScheduleCell { RowKey = c.RowKey, Day = c.Day, ShiftType = c.ShiftType, ShiftTime = c.ShiftTime })) };
    }

    // = saveMonthlySchedule / updateStaffSchedule（updateDoc）：送來的 schedule / finalizedSchedule 整份取代該類
    public async Task<JsonObject> SaveScheduleAsync(int y, int m, JsonObject body, string? ifMatch, CancellationToken ct)
    {
        CheckETag(await GetScheduleAsync(y, m, ct), ifMatch);
        if (!await db.ScheduleMonths.AnyAsync(x => x.Year == y && x.Month == m, ct)) db.ScheduleMonths.Add(new ScheduleMonth { Year = y, Month = m });
        foreach (var (key, kind) in new[] { ("schedule", ScheduleKind.Draft), ("finalizedSchedule", ScheduleKind.Final) })
        {
            if (!body.ContainsKey(key)) continue;
            db.ScheduleCells.RemoveRange(db.ScheduleCells.Where(c => c.Year == y && c.Month == m && c.Kind == kind));
            db.ScheduleCells.AddRange(CellsFromDoc(y, m, kind, body[key] as JsonObject));
        }
        await db.SaveChangesAsync(ct);
        return (await GetScheduleAsync(y, m, ct))!;
    }

    // ———————————— 歷史封存（= archive_reports）————————————
    public async Task<JsonObject> GetArchivesAsync(CancellationToken ct)
    {
        var reports = await db.ArchiveReports.AsNoTracking().ToListAsync(ct);
        var cells = await db.ScheduleCells.AsNoTracking().Where(c => c.Kind == ScheduleKind.Archive).ToListAsync(ct);
        var doc = new JsonObject();
        foreach (var r in reports.OrderBy(r => r.Year).ThenBy(r => r.Month))
        {
            var o = new JsonObject { ["year"] = r.Year, ["month"] = r.Month };
            if (r.Note != null) o["note"] = r.Note;
            if (r.Csv != null) o["csv"] = r.Csv;
            if (r.CsvSavedAt != null) o["timestamp"] = Iso(r.CsvSavedAt);
            if (r.BackedUpAt != null) o["backedUpAt"] = Iso(r.BackedUpAt);
            var mine = cells.Where(c => c.Year == r.Year && c.Month == r.Month).ToList();
            if (mine.Count > 0) o["schedule_backup"] = DocFromCells(mine);
            doc[$"{r.Year}_{r.Month}"] = o;
        }
        return doc;
    }

    // = saveArchiveReport（csv）與 backupScheduleToArchive（schedule_backup + note）：merge
    public async Task<JsonObject> SaveArchiveAsync(int y, int m, JsonObject body, CancellationToken ct)
    {
        var r = await db.ArchiveReports.FindAsync([y, m], ct);
        if (r is null) { r = new ArchiveReport { Year = y, Month = m }; db.ArchiveReports.Add(r); }
        var now = clock.GetUtcNow();
        if (body.ContainsKey("csv")) { r.Csv = Str(body, "csv"); r.CsvSavedAt = now; }
        if (body.ContainsKey("note")) r.Note = Str(body, "note");
        if (body["schedule_backup"] is JsonObject backup)
        {
            db.ScheduleCells.RemoveRange(db.ScheduleCells.Where(c => c.Year == y && c.Month == m && c.Kind == ScheduleKind.Archive));
            db.ScheduleCells.AddRange(CellsFromDoc(y, m, ScheduleKind.Archive, backup));
            r.BackedUpAt = now;
        }
        await db.SaveChangesAsync(ct);
        return await GetArchivesAsync(ct);
    }

    public async Task ClearArchivesAsync(CancellationToken ct)
    {
        db.ScheduleCells.RemoveRange(db.ScheduleCells.Where(c => c.Kind == ScheduleKind.Archive));
        db.ArchiveReports.RemoveRange(db.ArchiveReports);
        await db.SaveChangesAsync(ct);
    }

    // ———————————— 預假（= LeaveWishes/{Y_M} 表頭與 entries）————————————
    public async Task<JsonObject?> GetLeaveWishCountsAsync(int y, int m, CancellationToken ct)
    {
        var w = await db.LeaveWishWindows.AsNoTracking().FirstOrDefaultAsync(x => x.Year == y && x.Month == m, ct);
        var days = await db.LeaveWishDays.AsNoTracking().Where(d => d.Year == y && d.Month == m).Select(d => d.Day).ToListAsync(ct);
        if (w is null && days.Count == 0) return null;
        return new JsonObject
        {
            ["counts"] = new JsonObject(days.GroupBy(d => d).OrderBy(g => g.Key).Select(g => KeyValuePair.Create(g.Key.ToString(), (JsonNode?)g.Count()))),
            ["quota"] = w?.Quota ?? 0, ["version"] = w?.Version ?? 0,
        };
    }

    private static JsonObject EntryToJson(LeaveWishEntry e) => new()
    {
        ["staff_id"] = e.StaffId, ["days"] = new JsonArray(e.Days.Select(d => d.Day).OrderBy(d => d).Select(d => (JsonNode)d).ToArray()),
        ["submittedAt"] = Iso(e.SubmittedAt), ["firstSubmittedAt"] = Iso(e.FirstSubmittedAt),
    };

    public async Task<JsonObject?> GetMyLeaveWishAsync(int y, int m, string staffId, CancellationToken ct) =>
        await db.LeaveWishEntries.AsNoTracking().Include(e => e.Days).FirstOrDefaultAsync(e => e.Year == y && e.Month == m && e.StaffId == staffId, ct) is { } e
            ? EntryToJson(e) : null;

    public async Task<JsonObject> GetLeaveWishEntriesAsync(int y, int m, CancellationToken ct) =>
        new((await db.LeaveWishEntries.AsNoTracking().Include(e => e.Days).Where(e => e.Year == y && e.Month == m).ToListAsync(ct))
            .OrderBy(e => e.StaffId, StringComparer.Ordinal).Select(e => KeyValuePair.Create(e.StaffId, (JsonNode?)EntryToJson(e))));
}
