using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Aegis.Data;
using Aegis.Security;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Xunit;
using Xunit.Abstractions;

namespace Aegis.Api.Tests;

public sealed class ApiTests : IDisposable
{
    private readonly ApiFactory _f = new();
    private readonly ITestOutputHelper _out;
    public ApiTests(ITestOutputHelper output) { _out = output; _f.Seed(); }
    public void Dispose() => _f.Dispose();

    private async Task<(HttpClient Client, string Token)> As(string login, string pw)
    {
        var c = _f.CreateClient();
        var res = await c.PostAsJsonAsync("/api/auth/login", new { loginId = login, password = pw });
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        string token = JsonDocument.Parse(await res.Content.ReadAsStringAsync()).RootElement.GetProperty("accessToken").GetString()!;
        c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return (c, token);
    }
    private Task<(HttpClient, string)> Admin() => As("admin", ApiFactory.AdminPassword);
    private Task<(HttpClient, string)> DelegatedAdmin() => As("n002", "Nurse2pw1");
    private Task<(HttpClient, string)> Staff() => As("n001", ApiFactory.LegacyPassword);

    private static async Task<JsonNode?> Json(HttpResponseMessage r) => JsonNode.Parse(await r.Content.ReadAsStringAsync());
    private T Db<T>(Func<AegisDbContext, T> f) { using var s = _f.Services.CreateScope(); return f(s.ServiceProvider.GetRequiredService<AegisDbContext>()); }

    private HubConnection Hub(string token) => new HubConnectionBuilder()
        .WithUrl(new Uri(_f.Server.BaseAddress, "/hubs/schedule"), o =>
        {
            o.HttpMessageHandlerFactory = _ => _f.Server.CreateHandler();
            o.AccessTokenProvider = () => Task.FromResult<string?>(token);
            o.Transports = HttpTransportType.LongPolling;
        }).Build();

    [Fact]
    public async Task 權限矩陣_匿名_員工_管理員_超級管理員()
    {
        var anon = _f.CreateClient();
        var (staff, _) = await Staff();
        var (admin, _) = await DelegatedAdmin();
        var (super, _) = await Admin();
        Assert.Equal(HttpStatusCode.Unauthorized, (await anon.GetAsync("/api/settings")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await staff.GetAsync("/api/settings")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await staff.GetAsync("/api/staff/public")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await staff.GetAsync("/api/staff")).StatusCode);             // 全院名單只有管理員
        Assert.Equal(HttpStatusCode.Forbidden, (await staff.GetAsync("/api/schedules/2026/11")).StatusCode); // 完整班表（含假別）只有管理員
        Assert.Equal(HttpStatusCode.Forbidden, (await staff.PutAsJsonAsync("/api/settings", new { })).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await staff.GetAsync("/api/audit-logs")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await admin.GetAsync("/api/staff")).StatusCode);                    // 被授權的護理長
        Assert.Equal(HttpStatusCode.Forbidden, (await admin.PutAsJsonAsync("/api/staff/N001/admin", new { admin = true })).StatusCode);   // 授權限超級管理員
        Assert.Equal(HttpStatusCode.OK, (await super.PutAsJsonAsync("/api/staff/N001/admin", new { admin = true })).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await super.GetAsync("/api/me")).StatusCode);                  // 超級管理員沒有員工資料
        Assert.Equal((HttpStatusCode)503, (await staff.PostAsJsonAsync("/api/ai/gemini", new { })).StatusCode);   // AI 未啟用
        // = test_cpsat_service.py 的三項授權檢查（階段一延到這裡）
        Assert.Equal(HttpStatusCode.Forbidden, (await staff.PostAsJsonAsync("/api/engine/staffing-estimate", new { year = 2026, month = 8, reqs = new { D = 3, E = 2, N = 2 } })).StatusCode);   // 員工呼叫人力試算
        Assert.Equal(HttpStatusCode.Forbidden, (await super.PostAsJsonAsync("/api/leave-wishes", new { days = new[] { 8, 9, 15, 16 } })).StatusCode);   // 管理員送預假
        Assert.Equal(HttpStatusCode.Forbidden, (await staff.PostAsJsonAsync("/api/engine/schedule-jobs", new { year = 2026, month = 8, reqs = new { D = 3, E = 2, N = 2 } })).StatusCode);
        Assert.True(Db(db => db.AccessLogs.Any(l => l.Action == "admin-read")));                               // 讀全院名單自動留稽核
    }

    [Fact]
    public async Task 設定_merge語意_ETag衝突409()
    {
        var (admin, _) = await Admin();
        var r0 = await admin.GetAsync("/api/settings");
        string etag = r0.Headers.ETag!.Tag;
        var put = new HttpRequestMessage(HttpMethod.Put, "/api/settings") { Content = JsonContent.Create(new { requirements = new { D = 4, E = 3, N = 2 } }) };
        put.Headers.TryAddWithoutValidation("If-Match", etag);
        var r1 = await admin.SendAsync(put);
        Assert.Equal(HttpStatusCode.OK, r1.StatusCode);
        Assert.Equal(4, (await Json(r1))!["requirements"]!["D"]!.GetValue<int>());
        var stale = new HttpRequestMessage(HttpMethod.Put, "/api/settings") { Content = JsonContent.Create(new { bedConfig = new { bedCount = 60 } }) };
        stale.Headers.TryAddWithoutValidation("If-Match", etag);   // 用舊的 ETag → 別人已改過
        Assert.Equal(HttpStatusCode.Conflict, (await admin.SendAsync(stale)).StatusCode);
        var r2 = await admin.PutAsJsonAsync("/api/settings", new { baseSalary = 42000 });   // 明文底薪 → 伺服器端加密
        var blob = (await Json(r2))!["baseSalary"]!.AsObject();
        Assert.NotNull(blob["ct"]);
        Assert.Equal(4, (await Json(r2))!["requirements"]!["D"]!.GetValue<int>());           // merge：其他欄位不受影響
    }

    // Nginx 壓縮回應時把 ETag 改成 W/"…"，瀏覽器帶回來的就是弱 ETag：內容相同要照樣放行、內容不同照樣 409
    [Fact]
    public async Task 設定_反向代理的弱ETag也能比對()
    {
        var (admin, _) = await Admin();
        string weak = "W/" + (await admin.GetAsync("/api/settings")).Headers.ETag!.Tag;
        var put = new HttpRequestMessage(HttpMethod.Put, "/api/settings") { Content = JsonContent.Create(new { requirements = new { D = 5, E = 3, N = 2 } }) };
        put.Headers.TryAddWithoutValidation("If-Match", weak);
        Assert.Equal(HttpStatusCode.OK, (await admin.SendAsync(put)).StatusCode);
        var stale = new HttpRequestMessage(HttpMethod.Put, "/api/settings") { Content = JsonContent.Create(new { bedConfig = new { bedCount = 61 } }) };
        stale.Headers.TryAddWithoutValidation("If-Match", weak);
        Assert.Equal(HttpStatusCode.Conflict, (await admin.SendAsync(stale)).StatusCode);
    }

    [Fact]
    public async Task 員工名單_漏傳就拒絕_明文個資伺服器端加密_前端不能自封管理員()
    {
        var (admin, _) = await Admin();
        var doc = (await Json(await admin.GetAsync("/api/staff")))!.AsObject();
        var rows = doc["staffData"]!.AsArray();
        var shorter = new JsonObject { ["staffData"] = new JsonArray(rows.Take(2).Select(r => r!.DeepClone()).ToArray()) };
        var bad = await admin.PutAsync("/api/staff", JsonContent.Create(shorter));
        Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);
        Assert.Contains("離職", (await Json(bad))!["error"]!.GetValue<string>());

        var n003 = rows.First(r => r!["staff_id"]!.GetValue<string>() == "N003")!.AsObject();
        n003["idNumber"] = "A223456789";   // 明文
        n003["is_admin"] = true;          // 想自封管理員
        var ok = await admin.PutAsync("/api/staff", JsonContent.Create(doc));
        Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
        var saved = Db(db => db.Staff.Include(s => s.Sensitive).Single(s => s.StaffId == "N003"));
        Assert.False(saved.IsAdmin);
        var crypto = new FieldCrypto(new StaticFieldKeyProvider(ApiFactory.FieldKey));
        Assert.Equal("A223456789", Assert.IsType<FieldPlain.Str>(crypto.Decrypt(saved.Sensitive!.IdNumber!)).Value);
    }

    [Fact]
    public async Task 班表_公開版遮假別_即時推送給訂閱該月的員工()
    {
        var (admin, _) = await Admin();
        var (_, staffToken) = await Staff();
        await using var hub = Hub(staffToken);
        var got = new TaskCompletionSource<JsonObject?>(TaskCreationOptions.RunContinuationsAsynchronously);
        hub.On<int, int, JsonObject?>("SchedulePublicChanged", (y, m, doc) => { if (y == 2026 && m == 11) got.TrySetResult(doc); });
        await hub.StartAsync();
        await hub.InvokeAsync("SubscribeMonth", 2026, 11);

        var body = new JsonObject { ["finalizedSchedule"] = new JsonObject { ["N001"] = new JsonObject {
            ["1"] = new JsonObject { ["type"] = "事假" }, ["2"] = new JsonObject { ["type"] = "N", ["time"] = "23-08" } } } };
        Assert.Equal(HttpStatusCode.OK, (await admin.PutAsync("/api/schedules/2026/11", JsonContent.Create(body))).StatusCode);
        var pushed = await got.Task.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal("OFF", pushed!["finalizedSchedule"]!["N001"]!["1"]!["type"]!.GetValue<string>());   // 同事看不到假別
        var full = (await Json(await admin.GetAsync("/api/schedules/2026/11")))!;
        Assert.Equal("事假", full["finalizedSchedule"]!["N001"]!["1"]!["type"]!.GetValue<string>());     // 管理員看得到
    }

    [Fact]
    public async Task 管理員改名單_員工即時收到自己的資料與同事名單()
    {
        var (admin, _) = await Admin();
        var (_, staffToken) = await Staff();
        await using var hub = Hub(staffToken);
        var mine = new TaskCompletionSource<JsonObject?>(TaskCreationOptions.RunContinuationsAsynchronously);
        var pub = new TaskCompletionSource<JsonObject>(TaskCreationOptions.RunContinuationsAsynchronously);
        var leaked = false;
        hub.On<JsonObject?>("MyProfileChanged", row => mine.TrySetResult(row));
        hub.On<JsonObject>("StaffPublicChanged", doc => pub.TrySetResult(doc));
        hub.On<JsonObject>("StaffChanged", _ => leaked = true);   // 全院完整名單不能推給員工
        await hub.StartAsync();
        var doc = (await Json(await admin.GetAsync("/api/staff")))!.AsObject();
        doc["staffData"]!.AsArray().First(r => r!["staff_id"]!.GetValue<string>() == "N001")!["name"] = "王大明";
        await admin.PutAsync("/api/staff", JsonContent.Create(doc));
        Assert.Equal("王大明", (await mine.Task.WaitAsync(TimeSpan.FromSeconds(10)))!["name"]!.GetValue<string>());
        var p = await pub.Task.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Null(p["staffData"]![0]!["is_pregnant_or_nursing"]);   // 公開名單只有 6 個欄位
        await Task.Delay(300);
        Assert.False(leaked);
    }

    [Fact]
    public async Task 離職_歸檔_帳號停用_登入失敗()
    {
        var (admin, _) = await Admin();
        var r = await admin.DeleteAsync("/api/staff/N003");
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        Assert.True(Db(db => db.ExStaff.Any(x => x.StaffId == "N003")));
        Assert.False(Db(db => db.Staff.Any(x => x.StaffId == "N003")));
        var login = await _f.CreateClient().PostAsJsonAsync("/api/auth/login", new { loginId = "n003", password = "Nurse3pw1" });
        Assert.Equal(HttpStatusCode.Unauthorized, login.StatusCode);
    }

    [Fact]
    public async Task 首登個資_驗證規則與加密_銀行代碼不在清單就拒絕()
    {
        var (staff, _) = await Staff();
        var body = new { name = "王小明", gender = "男", tenure_years = 3, idNumber = "A123456789", bankAccount = "999-1234567890",
                         phone = "0912345678", pdpa_notice_version = "v1" };
        var bad = await staff.PostAsJsonAsync("/api/me/profile", body);
        Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);
        Assert.Contains("銀行代碼 999 不在合法清單內", (await Json(bad))!["error"]!.GetValue<string>());
        var ok = await staff.PostAsJsonAsync("/api/me/profile", body with { bankAccount = "008-1234567890" });
        Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
        var me = (await Json(await staff.GetAsync("/api/me")))!;
        Assert.True(me["profile_completed"]!.GetValue<bool>());
        Assert.Equal("v1", me["pdpa_notice_version"]!.GetValue<string>());
        Assert.NotNull(me["bankAccount"]!["ct"]);   // 存的是密文
    }

    [Fact]
    public async Task 加密欄位_員工只能解自己的_管理員全部_都留稽核()
    {
        var (staff, _) = await Staff();
        await staff.PostAsJsonAsync("/api/me/profile", new { name = "王", gender = "女", tenure_years = 1, idNumber = "B123456789",
                                    bankAccount = "008-1234567890", phone = "0912345678", pdpa_notice_version = "v1" });
        var blob = (await Json(await staff.GetAsync("/api/me")))!["idNumber"]!;
        var own = await staff.PostAsJsonAsync("/api/secure-field/decrypt", new { payload = blob, target = new { kind = "staff", id = "N001" } });
        Assert.Equal("B123456789", (await Json(own))!["value"]!.GetValue<string>());
        var other = await staff.PostAsJsonAsync("/api/secure-field/decrypt", new { payload = blob, target = new { kind = "staff", id = "N003" } });
        Assert.Equal(HttpStatusCode.Forbidden, other.StatusCode);
        var (admin, _) = await Admin();
        Assert.Equal(HttpStatusCode.OK, (await admin.PostAsJsonAsync("/api/secure-field/decrypt", new { payload = blob, target = new { kind = "staff", id = "N001" } })).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await staff.PostAsJsonAsync("/api/secure-field/encrypt", new { payload = "x" })).StatusCode);
        Assert.Equal(2, Db(db => db.AccessLogs.Count(l => l.Action == "decrypt")));
    }

    [Fact]
    public async Task 同步帳號_沒有SMTP就把啟用連結交回_用連結設密碼後可登入()
    {
        using (var scope = _f.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AegisDbContext>();
            db.Staff.Add(new Staff { StaffId = "N020", Name = "新人", Email = "n020@x" });
            db.SaveChanges();
        }
        var (admin, _) = await Admin();
        var r = (await Json(await admin.PostAsync("/api/staff/accounts/sync", null)))!["result"]!;
        Assert.Equal(1, r["invitedCount"]!.GetValue<int>());
        string link = r["manualLinks"]![0]!["link"]!.GetValue<string>();
        string token = link[(link.IndexOf("token=") + 6)..];
        Assert.Equal(HttpStatusCode.Unauthorized, (await _f.CreateClient().PostAsJsonAsync("/api/auth/login", new { loginId = "n020", password = "Newbie1pw" })).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await _f.CreateClient().PostAsJsonAsync("/api/auth/activate", new { token, newPassword = "Newbie1pw" })).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await _f.CreateClient().PostAsJsonAsync("/api/auth/login", new { loginId = "n020", password = "Newbie1pw" })).StatusCode);
    }

    [Fact]
    public async Task 預假_開放後員工送出_每日人數即時推送_未開放時送出被拒()
    {
        _f.SeedSample14();
        var (admin, _) = await Admin();
        var (staff, token) = await As("n004", "Pass1word");
        Assert.Equal(HttpStatusCode.Forbidden, (await staff.PostAsJsonAsync("/api/leave-wishes", new { days = new[] { 8, 9, 15, 16 } })).StatusCode);
        var open = new { open = true, year = 2026, month = 8, quota = 6, days_per_person = 4, reqs = new { D = 3, E = 3, N = 2 } };
        Assert.Equal(HttpStatusCode.OK, (await admin.PutAsJsonAsync("/api/leave-wishes/window", open)).StatusCode);

        await using var hub = Hub(token);
        var counts = new TaskCompletionSource<JsonObject?>(TaskCreationOptions.RunContinuationsAsynchronously);
        hub.On<int, int, JsonObject?>("LeaveWishCountsChanged", (y, m, c) => counts.TrySetResult(c));
        await hub.StartAsync();
        var r = await staff.PostAsJsonAsync("/api/leave-wishes", new { days = new[] { 8, 9, 15, 16 } });
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        Assert.Equal(5, (await Json(r))!["remaining"]!["8"]!.GetValue<int>());
        Assert.Equal(1, (await counts.Task.WaitAsync(TimeSpan.FromSeconds(10)))!["counts"]!["8"]!.GetValue<int>());
        var mine = (await Json(await staff.GetAsync("/api/leave-wishes/2026/8/mine")))!;
        Assert.Equal(new[] { 8, 9, 15, 16 }, mine["days"]!.AsArray().Select(d => d!.GetValue<int>()));
    }

    [Fact]
    public async Task 排班背景工作_202加工作ID_完成時推送結果()
    {
        _f.SeedSample14();
        var (admin, token) = await Admin();
        await using var hub = Hub(token);
        var done = new TaskCompletionSource<JsonObject>(TaskCreationOptions.RunContinuationsAsynchronously);
        hub.On<JsonObject>("ScheduleJobChanged", j => { if (j["state"]!.GetValue<string>() is "Succeeded" or "Failed") done.TrySetResult(j); });
        await hub.StartAsync();
        var r = await admin.PostAsJsonAsync("/api/engine/schedule-jobs", new { year = 2026, month = 8, reqs = new { D = 3, E = 2, N = 2 }, timeLimit = 30 });
        Assert.True(r.StatusCode == HttpStatusCode.Accepted, await r.Content.ReadAsStringAsync());
        string id = (await Json(r))!["jobId"]!.GetValue<string>();
        var job = await done.Task.WaitAsync(TimeSpan.FromMinutes(3));
        _out.WriteLine(job.ToJsonString()[..Math.Min(300, job.ToJsonString().Length)]);
        Assert.Equal("Succeeded", job["state"]!.GetValue<string>());
        Assert.Equal(0, job["result"]!["stats"]!["hard_penalty"]!.GetValue<int>());
        Assert.Equal("Succeeded", (await Json(await admin.GetAsync($"/api/engine/schedule-jobs/{id}")))!["state"]!.GetValue<string>());
    }
}
