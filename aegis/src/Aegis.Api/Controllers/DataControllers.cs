using System.Text.Json.Nodes;
using Aegis.Api.Auth;
using Aegis.Api.Realtime;
using Aegis.Api.Services;
using Aegis.Data;
using Aegis.Engine;
using Aegis.Scheduling;
using Aegis.Scheduling.Hosting;
using Aegis.Security;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.EntityFrameworkCore;

namespace Aegis.Api.Controllers;

// 業務例外 → HTTP（訊息直接給前端顯示）
public sealed class ApiExceptionFilter : IExceptionFilter
{
    public void OnException(ExceptionContext ctx)
    {
        (int status, string msg)? r = ctx.Exception switch
        {
            ConcurrencyConflictException e => (409, e.Message),
            DocumentValidationException e => (400, e.Message),
            ScheduleDomainException e => ((int)e.Kind, e.Message),
            _ => null,
        };
        if (r is not { } x) return;
        // 排班引擎沿用 FastAPI 的 detail 欄位（前端 scheduleEngine.js 讀 detail），其他沿用 Node 的 error
        bool engine = ctx.HttpContext.Request.Path.StartsWithSegments("/api/engine") || ctx.HttpContext.Request.Path.StartsWithSegments("/api/leave-wishes");
        ctx.Result = new ObjectResult(engine ? new { detail = x.msg } : new { error = x.msg }) { StatusCode = x.status };
        ctx.ExceptionHandled = true;
    }
}

public abstract class AegisController : ControllerBase
{
    protected CurrentUser Me => CurrentUser.From(User);
    protected string? IfMatch => Request.Headers.IfMatch.FirstOrDefault();
    protected IActionResult Doc(JsonNode? doc)
    {
        if (doc is null) return Ok((object?)null);
        Response.Headers.ETag = DocumentService.ETagOf(doc);
        return Content(doc.ToJsonString(), "application/json");
    }
}

[ApiController, Route("api/settings"), Authorize]
public sealed class SettingsController(DocumentService docs, RealtimeNotifier rt) : AegisController
{
    [HttpGet] public async Task<IActionResult> Get(CancellationToken ct) => Doc(await docs.GetSettingsAsync(ct));

    [HttpPut, Authorize(Policies.Admin)]
    public async Task<IActionResult> Put([FromBody] JsonObject patch, CancellationToken ct)
    {
        var doc = await docs.MergeSettingsAsync(patch, IfMatch, ct);
        await rt.SettingsAsync(ct);
        return Doc(doc);
    }
}

// 前端依此隱藏地端沒有的功能（決策 3、5）；未登入的登入頁也要讀
[ApiController, Route("api/features"), AllowAnonymous]
public sealed class FeaturesController(IConfiguration cfg) : ControllerBase
{
    [HttpGet]
    public IActionResult Get() => Ok(new
    {
        selfServiceReset = false,                                    // 自助 OTP 重設尚未提供（需院內 SMTP，決策 2A）
        ai = false,                                                  // 未設定語言模型（決策 3A）
        weather = cfg.GetValue("Aegis:Features:Weather", false),     // 隔離網路連不到 OpenWeatherMap（決策 5）
        autoSettleTest = false,
        smtp = !string.IsNullOrEmpty(cfg["Smtp:Host"]),
    });
}

[ApiController, Route("api/announcement"), Authorize]
public sealed class AnnouncementController(DocumentService docs, RealtimeNotifier rt) : AegisController
{
    public sealed record AnnouncementRequest(string Text, string Kind, string? UpdatedByName);

    [HttpGet, AllowAnonymous] public async Task<IActionResult> Get(CancellationToken ct) => Doc(await docs.GetAnnouncementAsync(ct));   // 登入頁（未登入）要顯示公告

    [HttpPut, Authorize(Policies.Admin)]
    public async Task<IActionResult> Put([FromBody] AnnouncementRequest req, CancellationToken ct)
    {
        var doc = await docs.SaveAnnouncementAsync(req.Text ?? "", req.Kind ?? "info", Me.UserId, req.UpdatedByName, ct);
        await rt.AnnouncementAsync(ct);
        return Doc(doc);
    }

    [HttpDelete, Authorize(Policies.Admin)]
    public async Task<IActionResult> Clear(CancellationToken ct)
    {
        var doc = await docs.ClearAnnouncementAsync(ct);
        await rt.AnnouncementAsync(ct);
        return Doc(doc);
    }
}

[ApiController, Route("api/staff"), Authorize]
public sealed class StaffController(DocumentService docs, AccountService accounts, RealtimeNotifier rt, IAuditLogger audit) : AegisController
{
    public sealed record AdminRequest(bool Admin);

    // 讀全院員工（含孕哺 / 個資密文）一律留稽核（= 舊 secure-field logAdminRead，改成伺服器端自動記）
    [HttpGet, Authorize(Policies.Admin)]
    public async Task<IActionResult> Get(CancellationToken ct)
    {
        await audit.WriteAsync(new AuditEntry("admin-read", Me.UserId, Me.LoginId, "staff-collection"), HttpContext, ct);
        return Doc(await docs.GetStaffDocAsync(ct));
    }

    [HttpPut, Authorize(Policies.Admin)]
    public async Task<IActionResult> Put([FromBody] JsonObject body, CancellationToken ct)
    {
        var doc = await docs.SaveStaffDocAsync(body, IfMatch, ct);
        await rt.StaffAsync(null, ct);
        return Doc(doc);
    }

    [HttpGet("public")] public async Task<IActionResult> Public(CancellationToken ct) => Doc(await docs.GetStaffPublicAsync(ct));

    public sealed record SyncRequest(List<string>? StaffIds);

    // staffIds = 前端名單；還沒寫進資料庫的（前端自動存檔有 2 秒延遲）回在 pending，前端稍後再同步一次
    [HttpPost("accounts/sync"), Authorize(Policies.Admin)]
    public async Task<IActionResult> Sync([FromBody] SyncRequest? req, CancellationToken ct)
    {
        var r = await accounts.SyncAsync(HttpContext, ct);
        var pending = await accounts.NotYetSavedAsync(req?.StaffIds, ct);
        return Ok(new { message = "帳號同步作業完成", pending, result = new { invitedCount = r.InvitedCount, existedCount = r.ExistedCount, errorCount = r.ErrorCount, errors = r.Errors, manualLinks = r.ManualLinks } });
    }

    [HttpPost("{id}/reset-link"), Authorize(Policies.Admin)]
    public async Task<IActionResult> ResetLink(string id, CancellationToken ct) => Ok(await accounts.ResetLinkAsync(id.ToUpperInvariant(), HttpContext, ct));

    [HttpDelete("{id}"), Authorize(Policies.Admin)]
    public async Task<IActionResult> Offboard(string id, CancellationToken ct)
    {
        var r = await accounts.OffboardAsync(id.ToUpperInvariant(), Me, HttpContext, ct);
        await rt.StaffAsync([], ct);
        return Ok(r);
    }

    [HttpPut("{id}/admin"), Authorize(Policies.SuperAdmin)]
    public async Task<IActionResult> SetAdmin(string id, [FromBody] AdminRequest req, CancellationToken ct)
    {
        var r = await accounts.SetAdminAsync(id.ToUpperInvariant(), req.Admin, Me, HttpContext, ct);
        await rt.StaffAsync([id], ct);
        return Ok(r);
    }
}

[ApiController, Route("api/me"), Authorize(Policies.Staff)]
public sealed class MeController(DocumentService docs, ProfileService profile, RealtimeNotifier rt) : AegisController
{
    public sealed record ConsentRequest(string? PdpaNoticeVersion);

    [HttpGet] public async Task<IActionResult> Get(CancellationToken ct) => Doc(await docs.GetMyRowAsync(Me.StaffId!, ct));

    [HttpPost("profile")]
    public async Task<IActionResult> First([FromBody] JsonObject body, CancellationToken ct)
    {
        if (await profile.CompleteFirstAsync(Me, body, HttpContext, ct) is { } err) return BadRequest(new { error = err });
        await rt.StaffAsync([Me.StaffId!], ct);
        return Ok(new { ok = true, message = "個人資料儲存成功" });
    }

    [HttpPatch("profile")]
    public async Task<IActionResult> Update([FromBody] JsonObject body, CancellationToken ct)
    {
        var (err, changed) = await profile.UpdateAsync(Me, body, HttpContext, ct);
        if (err != null) return BadRequest(new { error = err });
        if (changed.Count > 0) await rt.StaffAsync([Me.StaffId!], ct);
        return Ok(new { ok = true, message = changed.Count > 0 ? "更新成功" : "沒有變更", changed });
    }

    [HttpPost("consent")]
    public async Task<IActionResult> Consent([FromBody] ConsentRequest req, CancellationToken ct)
    {
        if (await profile.ConsentAsync(Me, req.PdpaNoticeVersion, HttpContext, ct) is { } err) return BadRequest(new { error = err });
        await rt.StaffAsync([Me.StaffId!], ct);
        return Ok(new { ok = true });
    }
}

[ApiController, Route("api/schedules/{year:int}/{month:int}"), Authorize]
public sealed class SchedulesController(DocumentService docs, RealtimeNotifier rt) : AegisController
{
    [HttpGet, Authorize(Policies.Admin)] public async Task<IActionResult> Get(int year, int month, CancellationToken ct) => Doc(await docs.GetScheduleAsync(year, month, ct));
    [HttpGet("public")] public async Task<IActionResult> Public(int year, int month, CancellationToken ct) => Doc(await docs.GetSchedulePublicAsync(year, month, ct));

    [HttpPut, Authorize(Policies.Admin)]
    public async Task<IActionResult> Put(int year, int month, [FromBody] JsonObject body, CancellationToken ct)
    {
        var doc = await docs.SaveScheduleAsync(year, month, body, IfMatch, ct);
        await rt.ScheduleAsync(year, month, ct);
        return Doc(doc);
    }
}

[ApiController, Route("api/archives"), Authorize(Policies.Admin)]
public sealed class ArchivesController(DocumentService docs, RealtimeNotifier rt) : AegisController
{
    [HttpGet] public async Task<IActionResult> Get(CancellationToken ct) => Doc(await docs.GetArchivesAsync(ct));

    [HttpPost("{year:int}/{month:int}")]
    public async Task<IActionResult> Save(int year, int month, [FromBody] JsonObject body, CancellationToken ct)
    {
        var doc = await docs.SaveArchiveAsync(year, month, body, ct);
        await rt.ArchivesAsync(ct);
        return Doc(doc);
    }

    [HttpDelete]
    public async Task<IActionResult> Clear(CancellationToken ct)
    {
        await docs.ClearArchivesAsync(ct);
        await rt.ArchivesAsync(ct);
        return NoContent();
    }
}

[ApiController, Route("api/leave-wishes"), Authorize]
public sealed class LeaveWishesController(DocumentService docs, IScheduleService schedule, RealtimeNotifier rt) : AegisController
{
    public sealed record SubmitRequest(List<int> Days);

    [HttpGet("{year:int}/{month:int}/counts")] public async Task<IActionResult> Counts(int year, int month, CancellationToken ct) => Doc(await docs.GetLeaveWishCountsAsync(year, month, ct));
    [HttpGet("{year:int}/{month:int}/mine"), Authorize(Policies.Staff)] public async Task<IActionResult> Mine(int year, int month, CancellationToken ct) => Doc(await docs.GetMyLeaveWishAsync(year, month, Me.StaffId!, ct));
    [HttpGet("{year:int}/{month:int}/entries"), Authorize(Policies.Admin)] public async Task<IActionResult> Entries(int year, int month, CancellationToken ct) => Doc(await docs.GetLeaveWishEntriesAsync(year, month, ct));

    // 員工送出 4 天預假（= 引擎 /leave_wishes/submit：配額 + CP-SAT 可行性檢查 + 樂觀鎖）
    [HttpPost, Authorize(Policies.Staff)]
    public async Task<IActionResult> Submit([FromBody] SubmitRequest req, CancellationToken ct)
    {
        if (req.Days is null || req.Days.Count is < 1 or > 10 || req.Days.Any(d => d is < 1 or > 31)) return BadRequest(new { detail = "日期需在 1~31" });
        var r = await schedule.SubmitWishAsync(Me.StaffId!, req.Days, ct);
        await rt.LeaveWishAsync(r.Year, r.Month, Me.StaffId, ct);
        return Ok(r);
    }

    // 護理長開放 / 截止（= saveLeaveWishSettings → Settings.leaveWish）
    [HttpPut("window"), Authorize(Policies.Admin)]
    public async Task<IActionResult> Window([FromBody] JsonObject leaveWish, CancellationToken ct)
    {
        var doc = await docs.MergeSettingsAsync(new JsonObject { ["leaveWish"] = leaveWish.DeepClone() }, null, ct);
        await rt.SettingsAsync(ct);
        return Doc(doc);
    }
}

[ApiController, Route("api/engine"), Authorize(Policies.Admin)]
public sealed class EngineController(IScheduleService schedule, IScheduleJobQueue jobs) : AegisController
{
    public sealed record EstimateRequest(int Year, int Month, Dictionary<string, int> Reqs, List<string>? StaffIds);
    public sealed record GenerateRequest(int Year, int Month, Dictionary<string, int> Reqs, List<string>? StaffIds, double TimeLimit = 120,
                                         Dictionary<string, List<string>>? Hint = null, bool UseWishes = true);

    private static ShiftRequirement Reqs(Dictionary<string, int>? raw)
    {
        var r = new Dictionary<string, int>(raw ?? [], StringComparer.OrdinalIgnoreCase);   // 鍵名大小寫不拘
        return r.TryGetValue("D", out var d) && r.TryGetValue("E", out var e) && r.TryGetValue("N", out var n) ? new(d, e, n)
            : throw new ScheduleDomainException(ScheduleErrorKind.BadRequest, "每日人力需求格式錯誤，需要 {D, E, N}");
    }

    [HttpPost("staffing-estimate")]
    public async Task<IActionResult> Estimate([FromBody] EstimateRequest req, CancellationToken ct) =>
        Ok(await schedule.EstimateAsync(req.Year, req.Month, Reqs(req.Reqs), req.StaffIds, ct));

    // 排班是最長約 2 分鐘的背景工作：立刻回 202 + 工作 ID，完成時由 SignalR ScheduleJobChanged 推送
    [HttpPost("schedule-jobs")]
    public async Task<IActionResult> Enqueue([FromBody] GenerateRequest req, CancellationToken ct)
    {
        if (req.TimeLimit is < 5 or > 240) return BadRequest(new { detail = "time_limit 需在 5–240 秒" });
        var cmd = new GenerateCommand(req.Year, req.Month, Reqs(req.Reqs), req.StaffIds, req.TimeLimit,
            req.Hint?.ToDictionary(kv => kv.Key, kv => (IReadOnlyList<string>)kv.Value), req.UseWishes);
        var id = await jobs.EnqueueAsync(cmd, Me.LoginId, ct);
        return Accepted($"/api/engine/schedule-jobs/{id}", new { jobId = id });
    }

    [HttpGet("schedule-jobs/{id:guid}")]
    public IActionResult Job(Guid id) => jobs.Get(id) is { } s ? Content(JobJson.Of(s).ToJsonString(), "application/json") : NotFound();
}

[ApiController, Route("api/secure-field"), Authorize]
public sealed class SecureFieldController(IFieldCrypto crypto, IAuditLogger audit) : AegisController
{
    public sealed record Target(string? Kind, string? Id);
    public sealed record FieldRequest(JsonNode? Payload, Target? Target, List<string>? Fields, JsonObject? Extra);

    // 員工只能碰自己的 staff 資料；管理員全部
    private bool CanAccess(Target? t) => Me.IsAdmin || (t?.Kind == "staff" && t.Id != null && Me.StaffId != null && t.Id.Equals(Me.StaffId, StringComparison.OrdinalIgnoreCase));
    private Task Log(string action, FieldRequest r, object? extra, CancellationToken ct) =>
        audit.WriteAsync(new AuditEntry(action, Me.UserId, Me.LoginId, r.Target?.Kind, r.Target?.Id, r.Fields, extra), HttpContext, ct);

    private static JsonNode? ToJson(FieldPlain p) => p switch
    {
        FieldPlain.Null => null, FieldPlain.Num n => JsonValue.Create(n.Value), FieldPlain.Bool b => JsonValue.Create(b.Value),
        FieldPlain.Str s => JsonValue.Create(s.Value), FieldPlain.Json j => JsonNode.Parse(j.Value.GetRawText()), _ => null,
    };

    private static EncryptedValue? Blob(JsonNode? n) =>
        n is JsonObject o && o["ct"] is not null && o["iv"] is not null && o["tag"] is not null ? DocumentMapper.JsonToEncrypted(o, _ => throw new InvalidOperationException()) : null;

    [HttpPost("encrypt"), Authorize(Policies.Admin)]
    public async Task<IActionResult> Encrypt([FromBody] FieldRequest r, CancellationToken ct)
    {
        var blob = DocumentMapper.JsonToEncrypted(r.Payload ?? JsonValue.Create((string?)null), crypto.Encrypt)
                   ?? crypto.Encrypt(new FieldPlain.Null());
        await Log("encrypt", r, null, ct);
        return Content(new JsonObject { ["blob"] = DocumentMapper.EncryptedToJson(blob) }.ToJsonString(), "application/json");
    }

    [HttpPost("decrypt")]
    public async Task<IActionResult> Decrypt([FromBody] FieldRequest r, CancellationToken ct)
    {
        if (Blob(r.Payload) is not { } blob) return BadRequest(new { error = "無效的密文格式" });
        if (!CanAccess(r.Target)) return StatusCode(403, new { error = "權限不足：無法解密此目標" });
        FieldPlain value;
        try { value = crypto.Decrypt(blob); }
        catch (System.Security.Cryptography.CryptographicException ex) { return StatusCode(500, new { error = ex.Message }); }   // 前端依訊息顯示「舊金鑰」
        await Log("decrypt", r, null, ct);
        return Content(new JsonObject { ["value"] = ToJson(value) }.ToJsonString(), "application/json");
    }

    [HttpPost("batch-decrypt")]
    public async Task<IActionResult> BatchDecrypt([FromBody] FieldRequest r, CancellationToken ct)
    {
        if (r.Payload is not JsonArray arr) return BadRequest(new { error = "批次解密需要陣列 payload" });
        if (!CanAccess(r.Target)) return StatusCode(403, new { error = "權限不足：無法批次解密此目標" });
        var values = new JsonArray();
        int i = 0;
        foreach (var item in arr)
        {
            var o = new JsonObject { ["idx"] = i++ };
            if (Blob(item) is not { } b) o["error"] = "非密文格式";
            else try { o["value"] = ToJson(crypto.Decrypt(b)); } catch (Exception ex) { o["error"] = ex.Message; }
            values.Add(o);
        }
        await Log("decrypt", r, new { batchSize = arr.Count }, ct);
        return Content(new JsonObject { ["values"] = values }.ToJsonString(), "application/json");
    }

    [HttpPost("relock")]
    public async Task<IActionResult> Relock([FromBody] FieldRequest r, CancellationToken ct)
    {
        if (!CanAccess(r.Target)) return StatusCode(403, new { error = "權限不足" });
        await Log("relock", r, r.Extra, ct);
        return Ok(new { ok = true });
    }
}

[ApiController, Route("api/audit-logs"), Authorize(Policies.Admin)]
public sealed class AuditController(AegisDbContext db) : AegisController
{
    [HttpGet]
    public async Task<IActionResult> List([FromQuery] int limit = 200, [FromQuery] string? action = null, [FromQuery] string? actor = null, CancellationToken ct = default)
    {
        var q = db.AccessLogs.AsNoTracking();
        if (!string.IsNullOrEmpty(action) && action != "all") q = q.Where(l => l.Action == action);
        if (!string.IsNullOrEmpty(actor)) q = q.Where(l => (l.ActorEmail ?? "").Contains(actor) || (l.ActorUid ?? "").Contains(actor));
        var rows = (await q.OrderByDescending(l => l.Id).Take(Math.Clamp(limit, 1, 1000)).ToListAsync(ct));
        var logs = new JsonArray(rows.Select(l => (JsonNode)new JsonObject
        {
            ["id"] = l.Id.ToString(), ["ts"] = DocumentMapper.Iso(l.Ts), ["actor"] = new JsonObject { ["uid"] = l.ActorUid, ["email"] = l.ActorEmail },
            ["action"] = l.Action, ["target"] = new JsonObject { ["kind"] = l.TargetKind, ["id"] = l.TargetId },
            ["fields"] = l.FieldsJson is null ? new JsonArray() : JsonNode.Parse(l.FieldsJson), ["ip"] = l.Ip, ["ua"] = l.Ua,
            ["extra"] = l.ExtraJson is null ? null : JsonNode.Parse(l.ExtraJson),
        }).ToArray());
        return Content(new JsonObject { ["logs"] = logs }.ToJsonString(), "application/json");
    }
}

// 決策 3A：地端沒有 Gemini — AI 功能預設關閉；之後可接院內 OpenAI 相容 LLM
[ApiController, Route("api/ai/{**rest}"), Authorize]
public sealed class AiController : ControllerBase
{
    [HttpPost, HttpGet] public IActionResult Disabled() => StatusCode(503, new { error = "AI 功能未啟用（地端未設定語言模型）", code = "ai-disabled" });
}
