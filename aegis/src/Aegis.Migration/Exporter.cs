using System.Diagnostics;
using System.Net.Http.Headers;
using System.Text.Json;

namespace Aegis.Migration;

public interface IFirestoreExporter
{
    Task<FirestoreSnapshot> ExportAsync(bool includeAuth, CancellationToken ct = default);
}

// 在可連網的機器上跑：Firestore REST 唯讀匯出（用操作者自己的 gcloud 憑證，不需要服務帳號金鑰）
public sealed class FirestoreRestExporter(string project, string accessToken, HttpClient? http = null) : IFirestoreExporter
{
    // 要遷移的集合；LeaveWishes 底下另有 entries 子集合
    public static readonly string[] Migrate = ["NurseApp", "StaffPrivate", "Schedules", "archive_reports", "LeaveWishes",
                                               "access_logs", "password_history", "ex_staff"];
    // 刻意不遷移（只記數量放進報告）：舊認領流程、暫存 token、健康檢查、可由檢視表重建的公開投影
    public static readonly string[] Skip = ["SelectionTurn", "SelectionProgress", "AI_Decision_Logs", "SystemHealth",
                                            "pending_activation", "password_reset_otp", "SchedulesPublic"];

    private readonly HttpClient _http = http ?? new HttpClient();
    private string Base => $"https://firestore.googleapis.com/v1/projects/{project}/databases/(default)/documents";

    public static string GcloudToken()
    {
        var psi = new ProcessStartInfo("gcloud", "auth print-access-token") { RedirectStandardOutput = true, RedirectStandardError = true };
        using var p = Process.Start(psi) ?? throw new InvalidOperationException("找不到 gcloud");
        var t = p.StandardOutput.ReadToEnd().Trim();
        p.WaitForExit();
        if (p.ExitCode != 0 || t.Length == 0) throw new InvalidOperationException("gcloud auth print-access-token 失敗，請先 gcloud auth login");
        return t;
    }

    private async Task<JsonElement> SendAsync(HttpMethod method, string url, string? body, CancellationToken ct)
    {
        using var req = new HttpRequestMessage(method, url);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        req.Headers.Add("x-goog-user-project", project);
        if (body != null) req.Content = new StringContent(body, System.Text.Encoding.UTF8, "application/json");
        using var res = await _http.SendAsync(req, ct);
        var text = await res.Content.ReadAsStringAsync(ct);
        if (!res.IsSuccessStatusCode) throw new HttpRequestException($"{method} {url} → {(int)res.StatusCode}：{text[..Math.Min(300, text.Length)]}");
        return JsonDocument.Parse(text).RootElement.Clone();
    }

    private async Task<List<string>> ListCollectionIdsAsync(string parent, CancellationToken ct)
    {
        var r = await SendAsync(HttpMethod.Post, $"{parent}:listCollectionIds", "{\"pageSize\":300}", ct);
        return r.TryGetProperty("collectionIds", out var ids) ? ids.EnumerateArray().Select(x => x.GetString()!).ToList() : [];
    }

    private async Task<List<SnapshotDoc>> ListDocsAsync(string collectionPath, CancellationToken ct)
    {
        var docs = new List<SnapshotDoc>();
        string? token = null;
        do
        {
            var r = await SendAsync(HttpMethod.Get, $"{Base}/{collectionPath}?pageSize=300{(token != null ? "&pageToken=" + Uri.EscapeDataString(token) : "")}", null, ct);
            if (r.TryGetProperty("documents", out var arr))
                foreach (var d in arr.EnumerateArray())
                    docs.Add(new SnapshotDoc(d.GetProperty("name").GetString()!.Split('/')[^1],
                                             FirestoreValues.Fields(d.TryGetProperty("fields", out var f) ? f : default)));
            token = r.TryGetProperty("nextPageToken", out var t) ? t.GetString() : null;
        } while (!string.IsNullOrEmpty(token));
        return docs;
    }

    // 只抓登入帳號與雜湊參數（check-password 用）
    public async Task<FirestoreSnapshot> ExportAuthOnlyAsync(CancellationToken ct = default)
    {
        var snap = new FirestoreSnapshot { Project = project, ExportedAt = DateTimeOffset.UtcNow };
        await AddAuthAsync(snap, ct);
        return snap;
    }

    public async Task<FirestoreSnapshot> ExportAsync(bool includeAuth, CancellationToken ct = default)
    {
        var snap = new FirestoreSnapshot { Project = project, ExportedAt = DateTimeOffset.UtcNow };
        var all = await ListCollectionIdsAsync(Base, ct);
        foreach (var c in all)
        {
            if (Skip.Contains(c)) { snap.SkippedCollections[c] = (await ListDocsAsync(c, ct)).Count; continue; }
            if (!Migrate.Contains(c)) { snap.SkippedCollections[$"{c}（未知集合，請確認）"] = (await ListDocsAsync(c, ct)).Count; continue; }
            snap.Collections[c] = await ListDocsAsync(c, ct);
        }
        foreach (var head in snap.Docs("LeaveWishes"))
            foreach (var sub in await ListCollectionIdsAsync($"{Base}/LeaveWishes/{head.Id}", ct))
                snap.Collections[$"LeaveWishes/{head.Id}/{sub}"] = await ListDocsAsync($"LeaveWishes/{head.Id}/{sub}", ct);

        if (includeAuth) await AddAuthAsync(snap, ct);
        return snap;
    }

    private async Task AddAuthAsync(FirestoreSnapshot snap, CancellationToken ct)
    {
        {
            snap.AuthUsers = [];
            string? token = null;
            do
            {
                var r = await SendAsync(HttpMethod.Get,
                    $"https://identitytoolkit.googleapis.com/v1/projects/{project}/accounts:batchGet?maxResults=1000{(token != null ? "&nextPageToken=" + Uri.EscapeDataString(token) : "")}", null, ct);
                if (r.TryGetProperty("users", out var users))
                    foreach (var u in users.EnumerateArray())
                        snap.AuthUsers.Add(new AuthUserRecord(
                            u.GetProperty("localId").GetString()!, Opt(u, "email"), u.TryGetProperty("disabled", out var dis) && dis.GetBoolean(),
                            Opt(u, "passwordHash"), Opt(u, "salt"), Opt(u, "customAttributes"),
                            long.TryParse(Opt(u, "createdAt"), out var ms) ? DateTimeOffset.FromUnixTimeMilliseconds(ms) : null));
                token = r.TryGetProperty("nextPageToken", out var t) ? t.GetString() : null;
            } while (!string.IsNullOrEmpty(token));
            var cfg = await SendAsync(HttpMethod.Get, $"https://identitytoolkit.googleapis.com/admin/v2/projects/{project}/config", null, ct);
            if (cfg.TryGetProperty("signIn", out var si) && si.TryGetProperty("hashConfig", out var hc))
                snap.AuthHashConfig = new FirebaseHashConfig(Opt(hc, "algorithm") ?? "", Opt(hc, "signerKey") ?? "", Opt(hc, "saltSeparator") ?? "",
                    hc.TryGetProperty("rounds", out var rr) ? rr.GetInt32() : 0, hc.TryGetProperty("memoryCost", out var mc) ? mc.GetInt32() : 0);
        }
    }

    private static string? Opt(JsonElement e, string k) => e.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
}
