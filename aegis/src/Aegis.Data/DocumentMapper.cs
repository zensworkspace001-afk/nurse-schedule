using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Aegis.Engine;
using Aegis.Security;

namespace Aegis.Data;

// Firestore 文件形狀 ↔ SQL 實體的唯一轉換點。ETL（階段二，讀 Firestore 快照）與 API（階段三，前端送來 / 回給前端的 JSON）
// 共用這一份 — 同一個員工列只有一種轉法，不會再出現「多份投影各自漂移」。欄位名稱與時間格式照現行前端。
public static class DocumentMapper
{
    // ———————————— 共用小工具 ————————————
    public static string? Str(JsonObject? o, string k) => o?[k] is JsonValue v && v.GetValueKind() == JsonValueKind.String ? v.GetValue<string>() : null;
    public static bool? Bool(JsonObject? o, string k) => o?[k] is JsonValue v && v.GetValueKind() is JsonValueKind.True or JsonValueKind.False ? v.GetValue<bool>() : null;
    public static double? Num(JsonObject? o, string k) => AsDouble(o?[k]);

    // 數字可能是 CLR long（記憶體裡轉來）或 JsonElement（從檔案 / HTTP 讀來）
    public static double? AsDouble(JsonNode? n)
    {
        if (n is not JsonValue v || v.GetValueKind() != JsonValueKind.Number) return null;
        if (v.TryGetValue<double>(out var d)) return d;
        if (v.TryGetValue<long>(out var l)) return l;
        if (v.TryGetValue<int>(out var i)) return i;
        return v.TryGetValue<JsonElement>(out var e) ? e.GetDouble() : null;
    }

    // ISO 字串或 {"$ts": ...}（Firestore 裡兩種都有：前端寫字串、Admin SDK 寫 timestamp）
    public static DateTimeOffset? Time(JsonObject? o, string k)
    {
        var n = o?[k];
        string? s = n is JsonObject t ? Str(t, "$ts") : n is JsonValue v && v.GetValueKind() == JsonValueKind.String ? v.GetValue<string>() : null;
        return s != null && DateTimeOffset.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var d) ? d : null;
    }

    // = JavaScript Date.prototype.toISOString()
    public static string? Iso(DateTimeOffset? t) => t?.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);

    public static (int Year, int Month) YearMonth(string id)
    {
        var p = id.Split('_');
        return (int.Parse(p[0], CultureInfo.InvariantCulture), int.Parse(p[1], CultureInfo.InvariantCulture));
    }

    // ———————————— 加密欄位 {ct, iv, tag, v, kid} ————————————
    public static JsonObject? EncryptedToJson(EncryptedValue? b) => b is null ? null : new JsonObject
    {
        ["ct"] = Convert.ToBase64String(b.Ciphertext), ["iv"] = Convert.ToBase64String(b.Nonce), ["tag"] = Convert.ToBase64String(b.Tag),
        ["v"] = b.Version, ["kid"] = b.KeyId,
    };

    // blob → 原樣；明文 → onPlaintext 決定（ETL：加密並記錄；API：加密）；null → null
    public static EncryptedValue? JsonToEncrypted(JsonNode? node, Func<FieldPlain, EncryptedValue> onPlaintext)
    {
        if (node is null) return null;
        if (node is JsonObject b && b["ct"] is not null)
            return EncryptedValue.FromNode(Str(b, "ct")!, Str(b, "iv")!, Str(b, "tag")!, (int)(Num(b, "v") ?? 1), Str(b, "kid"));
        if (node.GetValueKind() == JsonValueKind.Number) return onPlaintext(new FieldPlain.Num(AsDouble(node)!.Value));
        if (node.GetValueKind() == JsonValueKind.String) return string.IsNullOrEmpty(node.GetValue<string>()) ? null : onPlaintext(FieldPlain.Of(node.GetValue<string>()));
        return onPlaintext(new FieldPlain.Json(JsonDocument.Parse(node.ToJsonString()).RootElement.Clone()));
    }

    // ———————————— 員工列（= NurseApp/Staff.staffData[*] / StaffPrivate/{id}）————————————
    public static readonly string[] Pii = ["idNumber", "bankAccount", "phone"];

    public static Staff StaffFromRow(JsonObject r, Func<string, FieldPlain, EncryptedValue> onPlaintext)
    {
        string id = Str(r, "staff_id") ?? throw new InvalidDataException("員工列沒有 staff_id");
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
            IsAdmin = Bool(r, "is_admin") ?? false,
        };
        var sens = new StaffSensitive
        {
            StaffId = id,
            IdNumber = JsonToEncrypted(r["idNumber"], p => onPlaintext("idNumber", p)),
            BankAccount = JsonToEncrypted(r["bankAccount"], p => onPlaintext("bankAccount", p)),
            Phone = JsonToEncrypted(r["phone"], p => onPlaintext("phone", p)),
        };
        if (sens.IdNumber != null || sens.BankAccount != null || sens.Phone != null) st.Sensitive = sens;
        string? avatar = Str(r, "avatar"), thumb = Str(r, "avatar_thumb");
        if (!string.IsNullOrEmpty(avatar) || !string.IsNullOrEmpty(thumb))
            st.Avatar = new StaffAvatar { StaffId = id, Avatar = string.IsNullOrEmpty(avatar) ? null : avatar, AvatarThumb = string.IsNullOrEmpty(thumb) ? null : thumb };
        if (r["settlement_history"] is JsonObject hist)
            foreach (var (period, v) in hist)
                if (v is JsonObject h)
                    st.Settlements.Add(new SettlementRecord { StaffId = id, Period = period, Annual = (int)(Num(h, "annual") ?? 0),
                                                              Ot = (int)(Num(h, "ot") ?? 0), Night = (int)(Num(h, "night") ?? 0) });
        return st;
    }

    public static JsonObject StaffToRow(Staff s)
    {
        var row = new JsonObject
        {
            ["staff_id"] = s.StaffId, ["name"] = s.Name, ["email"] = s.Email, ["gender"] = s.Gender, ["level"] = s.Level,
            ["is_leader"] = s.IsLeader, ["is_active"] = s.IsActive, ["special_status"] = s.SpecialStatus.ToString(),
            ["leave_status"] = s.LeaveStatus, ["is_pregnant_or_nursing"] = s.IsPregnantOrNursing, ["can_night_shift"] = s.CanNightShift,
            ["tenure_years"] = s.TenureYears, ["accumulated_ot"] = s.AccumulatedOt, ["night_shift_balance"] = s.NightShiftBalance,
            ["idNumber"] = EncryptedToJson(s.Sensitive?.IdNumber), ["bankAccount"] = EncryptedToJson(s.Sensitive?.BankAccount),
            ["phone"] = EncryptedToJson(s.Sensitive?.Phone), ["avatar"] = s.Avatar?.Avatar, ["avatar_thumb"] = s.Avatar?.AvatarThumb,
            ["is_admin"] = s.IsAdmin, ["must_change_password"] = s.MustChangePassword, ["prevMonthLeave"] = null,
        };
        // 舊資料沒有的欄位就不輸出（前端用 === false / undefined 判斷首登精靈等，要保留三種狀態）
        if (s.AnnualLeaveUsed is int a) row["annual_leave_used"] = a;
        if (s.ProfileCompleted is bool pc) row["profile_completed"] = pc;
        if (s.ProfileCompletedAt != null) row["profile_completed_at"] = Iso(s.ProfileCompletedAt);
        if (s.ProfileUpdatedAt != null) row["profile_updated_at"] = Iso(s.ProfileUpdatedAt);
        if (s.PdpaConsentedAt != null) row["pdpa_consented_at"] = Iso(s.PdpaConsentedAt);
        if (s.PdpaNoticeVersion != null) row["pdpa_notice_version"] = s.PdpaNoticeVersion;
        if (s.Settlements.Count > 0)
            row["settlement_history"] = new JsonObject(s.Settlements.OrderBy(x => x.Period, StringComparer.Ordinal).Select(x =>
                KeyValuePair.Create(x.Period, (JsonNode?)new JsonObject { ["annual"] = x.Annual, ["ot"] = x.Ot, ["night"] = x.Night })));
        return row;
    }

    // ———————————— 班表文件 { rowKey: { "1": {type, time}, ... } } ————————————
    public static IEnumerable<ScheduleCell> CellsFromDoc(int y, int m, ScheduleKind kind, JsonObject? rows)
    {
        if (rows is null) yield break;
        foreach (var (rowKey, row) in rows)
            foreach (var (day, cell) in row as JsonObject ?? [])
            {
                if (!int.TryParse(day, out int d)) continue;
                string? type = cell is JsonObject c ? Str(c, "type") : cell?.GetValueKind() == JsonValueKind.String ? cell.GetValue<string>() : null;
                if (type is null) continue;
                yield return new ScheduleCell { Year = y, Month = m, Kind = kind, RowKey = rowKey, Day = d, ShiftType = type,
                                                ShiftTime = cell is JsonObject c2 ? Str(c2, "time") : null };
            }
    }

    public static JsonObject DocFromCells(IEnumerable<ScheduleCell> cells, Func<string, string>? mask = null)
    {
        var doc = new JsonObject();
        foreach (var g in cells.GroupBy(c => c.RowKey).OrderBy(g => g.Key, StringComparer.Ordinal))
        {
            var row = new JsonObject();
            foreach (var c in g.OrderBy(c => c.Day))
            {
                var cell = new JsonObject { ["type"] = mask is null ? c.ShiftType : mask(c.ShiftType) };
                if (c.ShiftTime != null) cell["time"] = c.ShiftTime;
                row[c.Day.ToString(CultureInfo.InvariantCulture)] = cell;
            }
            doc[g.Key] = row;
        }
        return doc;
    }

    // = buildSchedulePublicProjection：事假 / 病假 / 特休 → OFF
    public static readonly HashSet<string> SensitiveLeaveTypes = ["事假", "病假", "特休"];
    public static string MaskLeave(string t) => SensitiveLeaveTypes.Contains(t) ? "OFF" : t;

    // ———————————— 預假視窗（= Settings.leaveWish）————————————
    public static JsonObject WindowToJson(LeaveWishWindow w) => new()
    {
        ["open"] = w.Open, ["year"] = w.Year, ["month"] = w.Month, ["quota"] = w.Quota, ["days_per_person"] = w.DaysPerPerson,
        ["reqs"] = new JsonObject { ["D"] = w.ReqD, ["E"] = w.ReqE, ["N"] = w.ReqN },
        ["openedAt"] = Iso(w.OpenedAt), ["closedAt"] = Iso(w.ClosedAt),
    };

    public static void WindowFromJson(LeaveWishWindow w, JsonObject lw)
    {
        var reqs = lw["reqs"] as JsonObject;
        w.Open = Bool(lw, "open") ?? false;
        w.ReqD = (int)(Num(reqs, "D") ?? 0); w.ReqE = (int)(Num(reqs, "E") ?? 0); w.ReqN = (int)(Num(reqs, "N") ?? 0);
        w.Quota = (int)(Num(lw, "quota") ?? w.Quota);
        w.DaysPerPerson = (int)(Num(lw, "days_per_person") ?? 4);
        w.OpenedAt = Time(lw, "openedAt") ?? w.OpenedAt;
        w.ClosedAt = Time(lw, "closedAt") ?? w.ClosedAt;
    }
}
