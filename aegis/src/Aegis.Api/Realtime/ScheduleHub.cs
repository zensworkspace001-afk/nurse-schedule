using System.Text.Json.Nodes;
using Aegis.Api.Auth;
using Aegis.Api.Services;
using Aegis.Scheduling.Hosting;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;

namespace Aegis.Api.Realtime;

// 取代 Firebase onSnapshot：伺服器在寫入後推送「與 GET 相同的文件」，前端 subscribeToX(callback) 的簽章不必改
public interface IScheduleHubClient
{
    Task SettingsChanged(JsonObject settings);
    Task AnnouncementChanged(JsonObject? announcement);
    Task StaffChanged(JsonObject staffDoc);                                   // admins
    Task StaffPublicChanged(JsonObject staffPublic);                          // all
    Task MyProfileChanged(JsonObject? row);                                   // staff:{id}
    Task ScheduleChanged(int year, int month, JsonObject? doc);               // admins
    Task SchedulePublicChanged(int year, int month, JsonObject? doc);         // month:{y}_{m}
    Task ArchivesChanged(JsonObject archives);                                // admins
    Task LeaveWishCountsChanged(int year, int month, JsonObject? counts);     // all
    Task MyLeaveWishChanged(int year, int month, JsonObject? entry);          // staff:{id}
    Task LeaveWishEntriesChanged(int year, int month, JsonObject entries);    // admins
    Task ScheduleJobChanged(JsonObject job);                                  // admins
}

[Authorize]
public sealed class ScheduleHub : Hub<IScheduleHubClient>
{
    public const string All = "all", Admins = "admins";
    public static string StaffGroup(string id) => $"staff:{id.ToUpperInvariant()}";
    public static string MonthGroup(int y, int m) => $"month:{y}_{m}";

    public override async Task OnConnectedAsync()
    {
        var u = CurrentUser.From(Context.User!);
        await Groups.AddToGroupAsync(Context.ConnectionId, All);
        if (u.IsAdmin) await Groups.AddToGroupAsync(Context.ConnectionId, Admins);
        if (u.StaffId != null) await Groups.AddToGroupAsync(Context.ConnectionId, StaffGroup(u.StaffId));
        await base.OnConnectedAsync();
    }

    // 前端切換檢視月份時加入 / 離開（= subscribeToSchedulePublic(year, month, …)）
    public Task SubscribeMonth(int year, int month) => Groups.AddToGroupAsync(Context.ConnectionId, MonthGroup(year, month));
    public Task UnsubscribeMonth(int year, int month) => Groups.RemoveFromGroupAsync(Context.ConnectionId, MonthGroup(year, month));
}

// 寫入之後呼叫：重新讀出文件、推給該收到的群組（推送失敗不影響寫入結果）
public sealed class RealtimeNotifier(IHubContext<ScheduleHub, IScheduleHubClient> hub, DocumentService docs, ILogger<RealtimeNotifier> log)
{
    private async Task Safe(Func<Task> f)
    {
        try { await f(); } catch (Exception ex) { log.LogWarning(ex, "即時推送失敗（資料已寫入，前端重新整理即可）"); }
    }

    public Task SettingsAsync(CancellationToken ct) => Safe(async () => await hub.Clients.Group(ScheduleHub.All).SettingsChanged(await docs.GetSettingsAsync(ct)));
    public Task AnnouncementAsync(CancellationToken ct) => Safe(async () => await hub.Clients.Group(ScheduleHub.All).AnnouncementChanged(await docs.GetAnnouncementAsync(ct)));

    public Task StaffAsync(IEnumerable<string>? onlyStaffIds, CancellationToken ct) => Safe(async () =>
    {
        var doc = await docs.GetStaffDocAsync(ct);
        await hub.Clients.Group(ScheduleHub.Admins).StaffChanged(doc);
        await hub.Clients.Group(ScheduleHub.All).StaffPublicChanged(await docs.GetStaffPublicAsync(ct));
        var only = onlyStaffIds?.Select(x => x.ToUpperInvariant()).ToHashSet();
        foreach (var row in (doc["staffData"] as JsonArray ?? []).OfType<JsonObject>())
        {
            string id = row["staff_id"]!.GetValue<string>();
            if (only is null || only.Contains(id.ToUpperInvariant()))
                await hub.Clients.Group(ScheduleHub.StaffGroup(id)).MyProfileChanged((JsonObject)row.DeepClone());
        }
    });

    public Task ScheduleAsync(int y, int m, CancellationToken ct) => Safe(async () =>
    {
        await hub.Clients.Group(ScheduleHub.Admins).ScheduleChanged(y, m, await docs.GetScheduleAsync(y, m, ct));
        await hub.Clients.Group(ScheduleHub.MonthGroup(y, m)).SchedulePublicChanged(y, m, await docs.GetSchedulePublicAsync(y, m, ct));
    });

    public Task ArchivesAsync(CancellationToken ct) => Safe(async () => await hub.Clients.Group(ScheduleHub.Admins).ArchivesChanged(await docs.GetArchivesAsync(ct)));

    public Task LeaveWishAsync(int y, int m, string? staffId, CancellationToken ct) => Safe(async () =>
    {
        await hub.Clients.Group(ScheduleHub.All).LeaveWishCountsChanged(y, m, await docs.GetLeaveWishCountsAsync(y, m, ct));
        await hub.Clients.Group(ScheduleHub.Admins).LeaveWishEntriesChanged(y, m, await docs.GetLeaveWishEntriesAsync(y, m, ct));
        if (staffId != null) await hub.Clients.Group(ScheduleHub.StaffGroup(staffId)).MyLeaveWishChanged(y, m, await docs.GetMyLeaveWishAsync(y, m, staffId, ct));
    });
}

// 階段一 IScheduleJobNotifier 的 SignalR 實作：排班工作狀態推給管理員
public sealed class SignalRJobNotifier(IHubContext<ScheduleHub, IScheduleHubClient> hub) : IScheduleJobNotifier
{
    public Task OnChangedAsync(JobSnapshot s, CancellationToken ct) => hub.Clients.Group(ScheduleHub.Admins).ScheduleJobChanged(JobJson.Of(s));
}

public static class JobJson
{
    public static JsonObject Of(JobSnapshot s) => new()
    {
        ["id"] = s.Id.ToString(), ["state"] = s.State.ToString(), ["requestedBy"] = s.RequestedBy,
        ["createdAt"] = Data.DocumentMapper.Iso(s.CreatedAt), ["startedAt"] = Data.DocumentMapper.Iso(s.StartedAt), ["finishedAt"] = Data.DocumentMapper.Iso(s.FinishedAt),
        ["result"] = s.Result is null ? null : System.Text.Json.JsonSerializer.SerializeToNode(s.Result),
        ["errorKind"] = s.ErrorKind is null ? null : (int)s.ErrorKind, ["error"] = s.Error,
    };
}
