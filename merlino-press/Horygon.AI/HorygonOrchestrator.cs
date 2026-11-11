using Horygon.Core;
namespace Horygon.AI;
public sealed class HorygonOrchestrator(IRepository repository, IAnalyzer analyzer, IRuleService rules, IPermissionValidator permissions)
{
    private readonly SemaphoreSlim gate = new(1, 1);
    public async Task<bool> AnalyzeAsync(EmailMessage mail, CancellationToken ct, IReadOnlyList<EmailMessage>? history = null, bool allowNew = true)
    {
        await gate.WaitAsync(ct);
        try
        {
            if (!permissions.IsAllowed(ActionKind.CLASSIFY_EMAIL)) throw new UnauthorizedAccessException();
            var key = LogicalMail.Key(mail);
            var receipt = await repository.GetAsync<AnalysisReceipt>(key);
            history ??= await repository.ListAsync<EmailMessage>();
            var saved = await repository.GetAsync<EmailMessage>(mail.Id);
            var previous = receipt?.Result ?? saved?.Analysis ?? history.FirstOrDefault(x => x.Analysis != null && LogicalMail.Key(x) == key)?.Analysis;
            if (previous != null)
            {
                mail.Analysis = previous;
                await repository.SaveAsync(new AnalysisReceipt { Id = key, State = "Completata", Result = previous });
                await repository.SaveAsync(mail);
                return false;
            }
            if (receipt != null) throw new InvalidOperationException("Analisi precedente con esito incerto: bloccata per evitare un secondo addebito. Nessun retry automatico.");
            if (!allowNew) throw new InvalidOperationException("Limite raggiunto: 10 nuove analisi in questa lavorazione. Controlla il Report e premi Riprendi solo se vuoi autorizzarne altre 10.");
            ct.ThrowIfCancellationRequested();
            // Durable intent BEFORE any provider request. Uncertain calls are never retried automatically.
            receipt = new AnalysisReceipt { Id = key };
            await repository.SaveAsync(receipt);
            await repository.SaveAsync(new AuditEvent { Action = "ANALYSIS_ATTEMPT", EntityId = mail.Id, Result = "Nuova analisi autorizzata; tentativo registrato prima della chiamata." });
            var result = await analyzer.AnalyzeAsync(mail, history, await rules.ReadAllAsync(), ct);
            receipt.Result = result; receipt.State = "Completata";
            await repository.SaveAsync(receipt);
            mail.Analysis = result;
            await repository.SaveAsync(mail);
            await repository.SaveAsync(new AuditEvent { Action = "CLASSIFY_EMAIL", EntityId = mail.Id, Result = $"{result.Source}: {result.Priority}. {result.Reason}" });
            return true;
        }
        finally { gate.Release(); }
    }
    public async Task<int> RestoreCopiesAsync()
    {
        var history = await repository.ListAsync<EmailMessage>();
        var results = history.Where(x => x.Analysis != null).GroupBy(LogicalMail.Key).ToDictionary(x => x.Key, x => x.First().Analysis!);
        foreach (var receipt in await repository.ListAsync<AnalysisReceipt>()) if (receipt.Result != null) results[receipt.Id] = receipt.Result;
        var count = 0;
        foreach (var mail in history.Where(x => x.Analysis == null))
            if (results.TryGetValue(LogicalMail.Key(mail), out var result)) { mail.Analysis = result; await repository.SaveAsync(mail); count++; }
        if (count > 0) await repository.SaveAsync(new AuditEvent { Action = "RESTORE_ANALYSIS_COPIES", Result = $"{count} copie recuperate localmente, zero chiamate AI." });
        return count;
    }
}
