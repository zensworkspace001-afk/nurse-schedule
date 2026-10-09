using System.Collections.Concurrent;
using System.Threading.Channels;
using Aegis.Engine;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Aegis.Scheduling.Hosting;

public enum JobState { Queued, Running, Succeeded, Failed }

public sealed record JobSnapshot(
    Guid Id, JobState State, string RequestedBy, GenerateCommand Command,
    DateTimeOffset CreatedAt, DateTimeOffset? StartedAt = null, DateTimeOffset? FinishedAt = null,
    GenerateResult? Result = null, ScheduleErrorKind? ErrorKind = null, string? Error = null);

// 排班是 CPU 密集、最長約 2 分鐘的工作：API 收到請求只排進佇列、立刻回傳工作 ID；算完由 notifier 推播
// （階段三接 SignalR）。地端的 Nginx 與 SQL 連線都不適合掛著 2 分鐘的 HTTP 請求。
public interface IScheduleJobQueue
{
    ValueTask<Guid> EnqueueAsync(GenerateCommand cmd, string requestedBy, CancellationToken ct = default);
    JobSnapshot? Get(Guid jobId);
}

// 工作狀態變化的出口（階段三：SignalR ScheduleHub 推給前端）
public interface IScheduleJobNotifier
{
    Task OnChangedAsync(JobSnapshot snapshot, CancellationToken ct);
}

public sealed class NullScheduleJobNotifier : IScheduleJobNotifier
{
    public Task OnChangedAsync(JobSnapshot snapshot, CancellationToken ct) => Task.CompletedTask;
}

public sealed class ChannelScheduleJobQueue(TimeProvider? clock = null) : IScheduleJobQueue
{
    private readonly Channel<Guid> _channel = Channel.CreateUnbounded<Guid>(new UnboundedChannelOptions { SingleReader = true });
    private readonly ConcurrentDictionary<Guid, JobSnapshot> _jobs = new();
    private readonly TimeProvider _clock = clock ?? TimeProvider.System;

    public async ValueTask<Guid> EnqueueAsync(GenerateCommand cmd, string requestedBy, CancellationToken ct = default)
    {
        var id = Guid.NewGuid();
        _jobs[id] = new JobSnapshot(id, JobState.Queued, requestedBy, cmd, _clock.GetUtcNow());
        await _channel.Writer.WriteAsync(id, ct);
        return id;
    }

    public JobSnapshot? Get(Guid jobId) => _jobs.TryGetValue(jobId, out var s) ? s : null;

    internal ChannelReader<Guid> Reader => _channel.Reader;
    internal JobSnapshot Update(Guid id, Func<JobSnapshot, JobSnapshot> f) => _jobs.AddOrUpdate(id, _ => throw new KeyNotFoundException(), (_, s) => f(s));
    internal DateTimeOffset UtcNow => _clock.GetUtcNow();
}

// 單一背景工作者：一次只算一個（= Cloud Run concurrency 1；CP-SAT 本身已用多執行緒吃滿 CPU）
public sealed class ScheduleWorker(
    ChannelScheduleJobQueue queue, IServiceScopeFactory scopes, IScheduleJobNotifier notifier,
    ILogger<ScheduleWorker>? logger = null) : BackgroundService
{
    private readonly ILogger _log = logger ?? NullLogger<ScheduleWorker>.Instance;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (var id in queue.Reader.ReadAllAsync(stoppingToken))
        {
            var running = queue.Update(id, s => s with { State = JobState.Running, StartedAt = queue.UtcNow });
            await notifier.OnChangedAsync(running, stoppingToken);
            JobSnapshot done;
            try
            {
                using var scope = scopes.CreateScope();
                var service = scope.ServiceProvider.GetRequiredService<IScheduleService>();
                var result = await service.GenerateAsync(running.Command, stoppingToken);
                done = queue.Update(id, s => s with { State = JobState.Succeeded, FinishedAt = queue.UtcNow, Result = result });
            }
            catch (ScheduleDomainException ex)
            {
                done = queue.Update(id, s => s with { State = JobState.Failed, FinishedAt = queue.UtcNow, ErrorKind = ex.Kind, Error = ex.Message });
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _log.LogError(ex, "排班工作 {Id} 失敗", id);
                done = queue.Update(id, s => s with { State = JobState.Failed, FinishedAt = queue.UtcNow, Error = "排班引擎發生錯誤，請稍後再試" });
            }
            await notifier.OnChangedAsync(done, stoppingToken);
        }
    }
}

public static class SchedulingServiceCollectionExtensions
{
    // 註冊引擎 + 業務層 + 背景佇列。資料存取（IScheduleDataStore）由階段二的 SQL Server 實作註冊。
    public static IServiceCollection AddAegisScheduling(this IServiceCollection services, Action<SchedulingOptions>? configure = null)
    {
        services.AddOptions<SchedulingOptions>().Configure(o => configure?.Invoke(o));
        services.AddSingleton(TimeProvider.System);
        services.AddSingleton<IFeasibilityPrechecks, FeasibilityPrechecks>();
        services.AddSingleton<IScheduleModelBuilder, ScheduleModelBuilder>();
        services.AddSingleton<IScheduleInspector, ScheduleInspector>();
        services.AddSingleton<ICpSatScheduler>(sp => new CpSatScheduler(
            sp.GetRequiredService<IScheduleModelBuilder>(), sp.GetRequiredService<IFeasibilityPrechecks>(),
            logger: sp.GetService<ILogger<CpSatScheduler>>()));
        services.AddSingleton<IStaffingCalculator>(sp => new StaffingCalculator(
            sp.GetRequiredService<ICpSatScheduler>(), sp.GetRequiredService<IFeasibilityPrechecks>(),
            sp.GetRequiredService<Microsoft.Extensions.Options.IOptions<SchedulingOptions>>().Value.Mode));
        services.AddSingleton<IWishFeasibilityChecker>(sp => new WishFeasibilityChecker(
            sp.GetRequiredService<ICpSatScheduler>(), sp.GetRequiredService<IFeasibilityPrechecks>(),
            sp.GetRequiredService<Microsoft.Extensions.Options.IOptions<SchedulingOptions>>().Value.Mode));
        services.AddSingleton<IStaffingCache, InMemoryStaffingCache>();
        services.AddScoped<IScheduleService, ScheduleService>();
        services.AddSingleton<ChannelScheduleJobQueue>();
        services.AddSingleton<IScheduleJobQueue>(sp => sp.GetRequiredService<ChannelScheduleJobQueue>());
        services.AddSingleton<IScheduleJobNotifier, NullScheduleJobNotifier>();   // 階段三換成 SignalR
        services.AddHostedService<ScheduleWorker>();
        return services;
    }
}
