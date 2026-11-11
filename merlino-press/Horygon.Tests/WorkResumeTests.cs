using System.Text.Json;
using Horygon.Core;
using Horygon.AI;
using Xunit;
namespace Horygon.Tests;

public class WorkResumeTests
{
    [Fact]
    public async Task RestartAfterCancellationSkipsPersistedAnalyses()
    {
        var repo = new Repo();
        foreach (var id in new[] { "a", "b", "c" }) await repo.SaveAsync(new EmailMessage { Id = id });
        var analyzer = new FakeAnalyzer();
        var orchestrator = new HorygonOrchestrator(repo, analyzer, new Rules(), new ConservativePermissions());
        var work = new WorkProgress { Id = "work" };
        using var stop = new CancellationTokenSource();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => new AnalysisBatch(repo, orchestrator).RunAsync(work, new Callback(() => stop.Cancel()), stop.Token));
        Assert.Equal(1, (await repo.ListAsync<EmailMessage>()).Count(x => x.Analysis != null));
        // New runner and a reloaded checkpoint simulate a new application process.
        var restored = (await repo.GetAsync<WorkProgress>("work"))!;
        Assert.Equal(2, await new AnalysisBatch(repo, orchestrator).RunAsync(restored, null, CancellationToken.None));
        Assert.Equal(3, restored.Completed);
        Assert.Equal(3, analyzer.Calls);
        Assert.Equal(0, await new AnalysisBatch(repo, orchestrator).RunAsync(restored, null, CancellationToken.None));
        Assert.Equal(3, analyzer.Calls);
    }
    [Fact]
    public async Task EmailCommitBeforeCheckpointFailureIsNotAnalyzedAgain()
    {
        var repo = new Repo(); await repo.SaveAsync(new EmailMessage { Id = "mail" });
        var analyzer = new FakeAnalyzer();
        var orchestrator = new HorygonOrchestrator(repo, analyzer, new Rules(), new ConservativePermissions());
        var work = new WorkProgress { Id = "work" }; repo.FailCheckpointAfterEmail = true;
        await Assert.ThrowsAsync<IOException>(() => new AnalysisBatch(repo, orchestrator).RunAsync(work, null, CancellationToken.None));
        repo.FailCheckpointAfterEmail = false;
        var restored = (await repo.GetAsync<WorkProgress>("work"))!;
        Assert.Equal(0, await new AnalysisBatch(repo, orchestrator).RunAsync(restored, null, CancellationToken.None));
        Assert.Equal(1, restored.Completed); Assert.Equal(1, analyzer.Calls);
    }
    [Fact]
    public void ExpandedHistoryRequiresRescanAndUidValidityChangesIdentity()
    {
        var since = DateTimeOffset.UtcNow.AddDays(-90);
        Assert.True(FolderCheckpoint.CanResume(new() { Since = since }, since.AddDays(1)));
        Assert.False(FolderCheckpoint.CanResume(new() { Since = since }, since.AddDays(-30)));
        Assert.NotEqual(EmailMessage.Identity("a", "INBOX", 1, 0), EmailMessage.Identity("a", "INBOX", 2, 0));
    }
    [Fact]
    public async Task CopiesAcrossFoldersAndRestartUseOneProviderCall()
    {
        var repo = new Repo(); var analyzer = new FakeAnalyzer();
        var first = new EmailMessage { Id = "inbox", AccountId = "a", MessageId = "same" };
        var copy = new EmailMessage { Id = "allmail", AccountId = "a", MessageId = "same" };
        await repo.SaveAsync(first); await repo.SaveAsync(copy);
        await new AnalysisBatch(repo, new(repo, analyzer, new Rules(), new ConservativePermissions())).RunAsync(new() { Id = "work" }, null, CancellationToken.None);
        Assert.Equal(1, analyzer.Calls);
        var moved = new EmailMessage { Id = "new-validity", AccountId = "a", MessageId = "same" }; await repo.SaveAsync(moved);
        var restarted = new HorygonOrchestrator(repo, analyzer, new Rules(), new ConservativePermissions());
        await restarted.AnalyzeAsync(moved, CancellationToken.None);
        await restarted.AnalyzeAsync(moved, CancellationToken.None);
        Assert.Equal(1, analyzer.Calls); Assert.NotNull((await repo.GetAsync<EmailMessage>(moved.Id))!.Analysis);
    }
    [Fact]
    public async Task UncertainIntentPreventsAnyProviderRetry()
    {
        var repo = new Repo(); var analyzer = new FakeAnalyzer();
        var mail = new EmailMessage { Id = "mail", MessageId = "m" }; await repo.SaveAsync(mail);
        await repo.SaveAsync(new AnalysisReceipt { Id = LogicalMail.Key(mail) });
        await Assert.ThrowsAsync<InvalidOperationException>(() => new HorygonOrchestrator(repo, analyzer, new Rules(), new ConservativePermissions()).AnalyzeAsync(mail, CancellationToken.None));
        Assert.Equal(0, analyzer.Calls);
    }
    [Fact]
    public async Task BatchStopsAfterTenNewCalls()
    {
        var repo = new Repo(); var analyzer = new FakeAnalyzer();
        for (var i = 0; i < 12; i++) await repo.SaveAsync(new EmailMessage { Id = i.ToString(), MessageId = i.ToString() });
        await Assert.ThrowsAsync<InvalidOperationException>(() => new AnalysisBatch(repo, new(repo, analyzer, new Rules(), new ConservativePermissions())).RunAsync(new() { Id = "work" }, null, CancellationToken.None));
        Assert.Equal(10, analyzer.Calls);
        Assert.Equal(10, (await repo.ListAsync<EmailMessage>()).Count(x => x.Analysis != null));
    }
    [Fact]
    public async Task ExistingResultsAreRestoredWithoutProviderAndAccountsRemainSeparate()
    {
        var repo = new Repo(); var analyzer = new FakeAnalyzer();
        await repo.SaveAsync(new EmailMessage { Id = "old", AccountId = "a", MessageId = "m", Analysis = new() });
        await repo.SaveAsync(new EmailMessage { Id = "copy", AccountId = "a", MessageId = "m" });
        await repo.SaveAsync(new EmailMessage { Id = "other-account", AccountId = "b", MessageId = "m" });
        Assert.Equal(1, await new HorygonOrchestrator(repo, analyzer, new Rules(), new ConservativePermissions()).RestoreCopiesAsync());
        Assert.Null((await repo.GetAsync<EmailMessage>("other-account"))!.Analysis); Assert.Equal(0, analyzer.Calls);
    }
    sealed class Callback(Action action) : IProgress<string> { public void Report(string value) => action(); }
    sealed class FakeAnalyzer : IAnalyzer
    {
        public int Calls;
        public Task<Analysis> AnalyzeAsync(EmailMessage mail, IReadOnlyList<EmailMessage> history, string rules, CancellationToken ct)
        { Calls++; return Task.FromResult(new Analysis { Source = "test" }); }
        public Task<string> DraftAsync(EmailMessage mail, string rules, CancellationToken ct) => throw new NotSupportedException();
    }
    sealed class Rules : IRuleService
    {
        public Task<string> ReadAsync(string name) => Task.FromResult("");
        public Task<string> ReadAllAsync() => Task.FromResult("");
        public Task ActivateAsync(string name, string text) => Task.CompletedTask;
    }
    sealed class Repo : IRepository
    {
        readonly Dictionary<(Type,string),string> data = [];
        public bool FailCheckpointAfterEmail;
        public Task InitializeAsync() => Task.CompletedTask;
        public Task<List<T>> ListAsync<T>() where T:Entity => Task.FromResult(data.Where(x => x.Key.Item1 == typeof(T)).Select(x => JsonSerializer.Deserialize<T>(x.Value)!).ToList());
        public Task<T?> GetAsync<T>(string id) where T:Entity => Task.FromResult(data.TryGetValue((typeof(T),id), out var s) ? JsonSerializer.Deserialize<T>(s) : null);
        public Task SaveAsync<T>(T item) where T:Entity
        {
            if (FailCheckpointAfterEmail && item is WorkProgress w && w.Completed > 0) throw new IOException("Synthetic checkpoint failure");
            data[(typeof(T),item.Id)] = JsonSerializer.Serialize(item); return Task.CompletedTask;
        }
        public Task<bool> ExistsAsync<T>(string id) where T:Entity => Task.FromResult(data.ContainsKey((typeof(T),id)));
    }
}
