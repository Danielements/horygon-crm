using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
namespace Horygon.Core;

public sealed class TaskMailEvent : Entity
{
    public string TaskId { get; set; } = "";
    public string EmailId { get; set; } = "";
    public DateTimeOffset MailDate { get; set; }
    public string Status { get; set; } = "";
    public string Detail { get; set; } = "";
}

public static class TaskMailSignals
{
    public static string Key(string taskId, EmailMessage mail) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes($"{taskId}\0{mail.AccountId}\0{(string.IsNullOrWhiteSpace(mail.MessageId) ? mail.Id : mail.MessageId)}")));
    public static TaskMailEvent Detect(AITask task, EmailMessage mail, string own)
    {
        // Only inspect the newly written part, not an old quoted problem below the reply.
        var body = Regex.Split(mail.Body, @"(?im)^\s*(?:>|-{2,}\s*(?:messaggio originale|original message)|(?:Da|From):|Il .+ha scritto:|On .+wrote:)", RegexOptions.None, TimeSpan.FromMilliseconds(100))[0];
        body = body[..Math.Min(body.Length, 4000)];
        var isReply = Regex.IsMatch(mail.Subject, @"^(re|r|fw|fwd):", RegexOptions.IgnoreCase);
        var text = ((isReply ? "" : mail.Subject) + "\n" + body).ToLowerInvariant();
        bool Has(string pattern) => Regex.IsMatch(text, pattern, RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));
        string status;
        if (Has(@"\b(call|riunione|appuntamento|meeting|videocall)\b") && Has(@"\b(spost\w*|rinvi\w*|anticip\w*|posticip\w*|riprogramm\w*|reschedul\w*|cambio orario|nuovo orario|annull\w*|cancelled|canceled)\b")) status = "CAMBIO APPUNTAMENTO";
        else if (Has(@"\b(problema|bloccato|bloccata|non funziona|errore|ritardo|reclamo|problem|blocked|failed)\b") && !Has(@"\b(problema risolto|nessun problema|tutto risolto|problem solved|no problem)\b")) status = "PROBLEMA SEGNALATO";
        else if (Has(@"\b(risolto|risolta|completato|completata|concluso|conclusa|resolved|completed)\b") && !Has(@"\b(non|not)\s+(ancora\s+)?(risolto|risolta|completato|completed|resolved)\b")) status = "ESITO DA VERIFICARE";
        else if (Has(@"\b(sollecito|urgente|urgent|reminder|in attesa di risposta)\b")) status = "SOLLECITO";
        else if (MailDirection.IsOutgoing(mail, own)) status = "INVIATA · VERIFICA RISCONTRO";
        else status = "NUOVO MESSAGGIO";
        return new() { Id = Key(task.Id, mail), TaskId = task.Id, EmailId = mail.Id, MailDate = mail.Date, Status = status, Detail = $"{mail.Subject}\n{body[..Math.Min(body.Length, 600)]}" };
    }
}

public sealed class TaskBoardUpdater(IRepository repository)
{
    public async Task UpdateAsync(IReadOnlyList<RoadmapRow> rows, IReadOnlyList<EmailAccount> accounts)
    {
        var known = (await repository.ListAsync<TaskMailEvent>()).Select(x => x.Id).ToHashSet();
        foreach (var row in rows)
        foreach (var task in row.Tasks.Where(x => x.State is not (TaskState.COMPLETED or TaskState.CANCELLED)))
        {
            var changed = false;
            foreach (var mail in row.Emails.Where(x => !MailDirection.IsDraft(x) && x.Classification.Kind == MailKind.Regular).OrderBy(x => x.Date).ThenBy(x => x.Id))
            {
                var key = TaskMailSignals.Key(task.Id, mail);
                if (known.Contains(key)) continue;
                var change = TaskMailSignals.Detect(task, mail, accounts.FirstOrDefault(x => x.Id == mail.AccountId)?.Address ?? "");
                // Persist task first: if event persistence fails, replay repairs the same update.
                if (task.LastMailAt is null || mail.Date >= task.LastMailAt)
                {
                    task.MailStatus = change.Status; task.MailStatusDetail = change.Detail;
                    task.LastMailAt = mail.Date; task.LastMailId = mail.Id;
                    task.UpdatedAt = DateTimeOffset.UtcNow;
                    if (change.Status is "PROBLEMA SEGNALATO" or "SOLLECITO") task.Priority = (Priority)Math.Max((int)task.Priority, (int)Priority.HIGH);
                    await repository.SaveAsync(task); changed = true;
                }
                await repository.SaveAsync(change); known.Add(key);
            }
            if (changed) await repository.SaveAsync(new AuditEvent { Action = "TASK_MAIL_UPDATE", EntityId = task.Id, Result = task.MailStatus + " · " + task.LastMailId });
        }
    }
}
