using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Aegis.Api.Auth;
using Aegis.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace Aegis.Api.Tests;

public sealed class AuthTests : IDisposable
{
    private readonly ApiFactory _f = new();
    public AuthTests() => _f.Seed();
    public void Dispose() => _f.Dispose();

    private HttpClient Client() => _f.CreateClient(new() { HandleCookies = true });

    private static async Task<(HttpResponseMessage Res, JsonElement Body)> Login(HttpClient c, string id, string pw, bool remember = false)
    {
        var res = await c.PostAsJsonAsync("/api/auth/login", new { loginId = id, password = pw, rememberMe = remember });
        return (res, JsonDocument.Parse(await res.Content.ReadAsStringAsync()).RootElement.Clone());
    }

    private T Db<T>(Func<AegisDbContext, T> f)
    {
        using var scope = _f.Services.CreateScope();
        return f(scope.ServiceProvider.GetRequiredService<AegisDbContext>());
    }

    [Fact]
    public async Task 舊Firebase密碼可登入_登入後自動換成新格式_之後照樣能登入()
    {
        var c = Client();
        var (res, body) = await Login(c, "N001", ApiFactory.LegacyPassword);   // 工號大小寫不拘
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal("staff", body.GetProperty("user").GetProperty("role").GetString());
        Assert.Equal("N001", body.GetProperty("user").GetProperty("staffId").GetString());
        Assert.DoesNotContain("firebase-scrypt$", Db(db => db.Users.Single(u => u.Id == "N001").PasswordHash));
        Assert.Equal(HttpStatusCode.OK, (await Login(Client(), "n001", ApiFactory.LegacyPassword)).Res.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await Login(Client(), "n001", "user1passworD")).Res.StatusCode);
    }

    [Fact]
    public async Task 密碼錯_帳號不存在_停用帳號_都是同一句訊息與代碼()
    {
        var msgs = new List<string>();
        foreach (var (id, pw) in new[] { ("n002", "wrong1pw"), ("n999", "whatever1"), ("n004", "anything1") })
        {
            var (res, body) = await Login(Client(), id, pw);
            Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
            Assert.Equal(AuthService.InvalidCredential, body.GetProperty("code").GetString());
            msgs.Add(body.GetProperty("error").GetString()!);
        }
        Assert.Single(msgs.Distinct());
        Assert.Equal(3, Db(db => db.AccessLogs.Count(l => l.Action == "login-failure")));
    }

    [Fact]
    public async Task 連錯5次鎖15分鐘_鎖定期間正確密碼也進不去()
    {
        for (int i = 0; i < 5; i++) await Login(Client(), "n002", "wrong1pw");
        var (res, body) = await Login(Client(), "n002", "Nurse2pw1");
        Assert.Equal((HttpStatusCode)429, res.StatusCode);
        Assert.Equal(AuthService.TooMany, body.GetProperty("code").GetString());
        Assert.NotNull(Db(db => db.Users.Single(u => u.Id == "N002").LockoutUntil));
    }

    private static string RefreshCookie(HttpResponseMessage r) =>
        r.Headers.GetValues("Set-Cookie").First(h => h.StartsWith("aegis_rt=")).Split(';')[0]["aegis_rt=".Length..];

    private async Task<HttpResponseMessage> RefreshWith(string rt)
    {
        var raw = _f.CreateClient(new() { HandleCookies = false });
        var m = new HttpRequestMessage(HttpMethod.Post, "/api/auth/refresh");
        m.Headers.Add("Cookie", $"aegis_rt={rt}");
        return await raw.SendAsync(m);
    }

    [Fact]
    public async Task Refresh輪替_記住我是持久cookie_登出後不能再換()
    {
        var c = Client();
        var (login, _) = await Login(c, "n002", "Nurse2pw1", remember: true);
        Assert.Contains("expires=", string.Join(";", login.Headers.GetValues("Set-Cookie")), StringComparison.OrdinalIgnoreCase);
        var (session, _) = await Login(Client(), "n002", "Nurse2pw1", remember: false);
        Assert.DoesNotContain("expires=", string.Join(";", session.Headers.GetValues("Set-Cookie")), StringComparison.OrdinalIgnoreCase);
        Assert.Equal(HttpStatusCode.OK, (await c.PostAsync("/api/auth/refresh", null)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await c.PostAsync("/api/auth/refresh", null)).StatusCode);   // 每次都換新的
        Assert.Equal(HttpStatusCode.NoContent, (await c.PostAsync("/api/auth/logout", null)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await c.PostAsync("/api/auth/refresh", null)).StatusCode);
    }

    [Fact]
    public async Task 重放已使用的refresh_token_拒絕並撤銷整串()
    {
        var (login, _) = await Login(Client(), "n002", "Nurse2pw1");
        string rt1 = RefreshCookie(login);
        var ok = await RefreshWith(rt1);
        Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
        string rt2 = RefreshCookie(ok);
        Assert.Equal(HttpStatusCode.Unauthorized, (await RefreshWith(rt1)).StatusCode);   // 重放舊的 → 拒絕
        Assert.Equal(HttpStatusCode.Unauthorized, (await RefreshWith(rt2)).StatusCode);   // 被偷的跡象 → 新的也一起撤銷
        Assert.True(Db(db => db.RefreshTokens.Where(t => t.UserId == "N002").AsEnumerable().All(t => t.RevokedAt != null)));
    }

    [Fact]
    public async Task Me需要登入_角色正確_管理員與超級管理員()
    {
        Assert.Equal(HttpStatusCode.Unauthorized, (await Client().GetAsync("/api/auth/me")).StatusCode);
        foreach (var (id, pw, role, super) in new[] { ("n002", "Nurse2pw1", "admin", false), ("admin", ApiFactory.AdminPassword, "admin", true), ("n003", "Nurse3pw1", "staff", false) })
        {
            var c = Client();
            var (_, b) = await Login(c, id, pw);
            c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", b.GetProperty("accessToken").GetString());
            var me = JsonDocument.Parse(await c.GetStringAsync("/api/auth/me")).RootElement;
            Assert.Equal(role, me.GetProperty("role").GetString());
            Assert.Equal(super, me.GetProperty("superAdmin").GetBoolean());
        }
    }

    [Fact]
    public async Task 改密碼_強度_歷史_成功後清除強制改密旗標()
    {
        var c = Client();
        var (_, b) = await Login(c, "n003", "Nurse3pw1");
        Assert.True(b.GetProperty("user").GetProperty("mustChangePassword").GetBoolean());
        c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", b.GetProperty("accessToken").GetString());
        async Task<(HttpStatusCode, string?)> Change(string pw)
        {
            var r = await c.PostAsJsonAsync("/api/auth/change-password", new { newPassword = pw });
            var body = JsonDocument.Parse(await r.Content.ReadAsStringAsync()).RootElement;
            return (r.StatusCode, body.TryGetProperty("error", out var e) ? e.GetString() : null);
        }
        Assert.Equal((HttpStatusCode.BadRequest, "密碼必須同時包含英文與數字"), await Change("onlyletters"));
        Assert.Equal(HttpStatusCode.OK, (await Change("Fresh1pass")).Item1);
        Assert.Equal((HttpStatusCode.BadRequest, PasswordHistoryService.ReusedMessage), await Change("Fresh1pass"));   // 剛用過
        var (_, again) = await Login(Client(), "n003", "Fresh1pass");
        Assert.False(again.GetProperty("user").GetProperty("mustChangePassword").GetBoolean());
    }

    [Fact]
    public async Task 啟用連結_停用帳號設定密碼後可登入_連結只能用一次()
    {
        string token;
        using (var scope = _f.Services.CreateScope())
            token = await scope.ServiceProvider.GetRequiredService<AuthService>().IssueLinkTokenAsync("N004", "activation", default);
        var c = Client();
        Assert.Equal(HttpStatusCode.BadRequest, (await c.PostAsJsonAsync("/api/auth/activate", new { token, newPassword = "123456" })).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await c.PostAsJsonAsync("/api/auth/activate", new { token, newPassword = "Welcome1x" })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await c.PostAsJsonAsync("/api/auth/activate", new { token, newPassword = "Another1x" })).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await Login(Client(), "n004", "Welcome1x")).Res.StatusCode);
        Assert.False(Db(db => db.Users.Single(u => u.Id == "N004").Disabled));
    }
}
