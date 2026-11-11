using Horygon.Core;
namespace Horygon.AI;

public sealed class AnalysisBatch(IRepository repository, HorygonOrchestrator orchestrator)
{
    public async Task<int> RunAsync(WorkProgress work, IProgress<string>? progress, CancellationToken ct)
    {
        var history = await repository.ListAsync<EmailMessage>();
        var pending = history.Where(x => x.Analysis is null).OrderBy(x => x.Date).ToList();
        work.Total = history.Count;
        work.Completed = history.Count - pending.Count;
        await repository.SaveAsync(work);
        var count = 0;
        var newCalls = 0;
        foreach (var mail in pending)
        {
            ct.ThrowIfCancellationRequested();
            if (await orchestrator.AnalyzeAsync(mail, ct, history, newCalls < 10)) newCalls++;
            work.Completed++;
            work.LastEmailId = mail.Id;
            work.UpdatedAt = DateTimeOffset.UtcNow;
            work.Detail = $"Ultima analisi: {mail.Analysis!.Source}";
            await repository.SaveAsync(work);
            progress?.Report(work.Display);
            count++;
        }
        return count;
    }
}
