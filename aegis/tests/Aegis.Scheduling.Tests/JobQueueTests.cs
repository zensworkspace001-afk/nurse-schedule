using Aegis.Scheduling;
using Aegis.Scheduling.Hosting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Xunit;
using static Aegis.Scheduling.Tests.Harness;

namespace Aegis.Scheduling.Tests;

// HostedService：排進佇列 → 背景排班 → 狀態依序 Queued → Running → Succeeded / Failed，並通知
public sealed class JobQueueTests
{
    private sealed class RecordingNotifier : IScheduleJobNotifier
    {
        public List<JobState> States { get; } = new();
        public TaskCompletionSource<JobSnapshot> Done { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public Task OnChangedAsync(JobSnapshot s, CancellationToken ct)
        {
            lock (States) States.Add(s.State);
            if (s.State is JobState.Succeeded or JobState.Failed) Done.TrySetResult(s);
            return Task.CompletedTask;
        }
    }

    private static (ServiceProvider Sp, RecordingNotifier Notifier) Build(FakeStore store)
    {
        var notifier = new RecordingNotifier();
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddAegisScheduling();
        services.AddSingleton<IScheduleDataStore>(store);
        services.AddSingleton<IScheduleJobNotifier>(notifier);
        return (services.BuildServiceProvider(), notifier);
    }

    [Fact]
    public async Task 排進佇列後在背景排出合法班表()
    {
        var (sp, notifier) = Build(new FakeStore());
        var worker = sp.GetServices<IHostedService>().Single();
        await worker.StartAsync(default);
        var queue = sp.GetRequiredService<IScheduleJobQueue>();
        var id = await queue.EnqueueAsync(new GenerateCommand(2026, 8, R(3, 2, 2), TimeLimit: 30), "admin@hospital.com");
        Assert.NotNull(queue.Get(id));

        var done = await notifier.Done.Task.WaitAsync(TimeSpan.FromMinutes(3));
        await worker.StopAsync(default);
        Assert.Equal(JobState.Succeeded, done.State);
        Assert.Equal(0, done.Result!.Stats.HardPenalty);
        Assert.Equal(new[] { JobState.Running, JobState.Succeeded }, notifier.States);
        Assert.Equal(JobState.Succeeded, queue.Get(id)!.State);
    }

    [Fact]
    public async Task 業務錯誤會變成Failed並帶錯誤種類()
    {
        var store = new FakeStore { Settings = new LeaveWishSettings(true, 2026, 8, R(3, 2, 2)) };   // 預假未截止 → 409
        var (sp, notifier) = Build(store);
        var worker = sp.GetServices<IHostedService>().Single();
        await worker.StartAsync(default);
        await sp.GetRequiredService<IScheduleJobQueue>().EnqueueAsync(new GenerateCommand(2026, 8, R(3, 2, 2)), "admin@hospital.com");
        var done = await notifier.Done.Task.WaitAsync(TimeSpan.FromMinutes(1));
        await worker.StopAsync(default);
        Assert.Equal(JobState.Failed, done.State);
        Assert.Equal(ScheduleErrorKind.Conflict, done.ErrorKind);
        Assert.Contains("尚未截止", done.Error);
    }
}
